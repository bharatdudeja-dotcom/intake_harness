import { query } from "@/lib/db";
import { ESCALATION, PIPELINE } from "./registry";
import type { AgentName, AgentRequest, AgentResponse, RunRow, TaskRow, TaskRunRow } from "./types";

/**
 * Runs exactly the NEXT agent for a run — never more than one — over real
 * HTTP to that agent's own route (a dev can `curl
 * localhost:3000/api/agents/audience-creation` on its own without spinning
 * up the rest of the pipeline). Every call is recorded as a task_runs row.
 *
 * The pipeline stops after every step, not just a failed/paused one: a
 * step that completes with more agents left to run puts the run into
 * "awaiting_approval" rather than calling the next agent automatically —
 * the per-agent equivalent of a tool call waiting for permission before it
 * runs. POST /api/runs/[runId]/continue is what actually advances it.
 *
 * Each agent only ever receives the slice of `priorOutputs` its registry
 * entry declares via `contextAccess` — filtered from the full accumulated
 * history before every HTTP call, so an agent never receives a prior
 * agent's output it isn't scoped to see (paired with the tool allowlist
 * enforced in lib/mcp-client.ts).
 *
 * A "failed" step additionally triggers Agent 4 — Escalation (B9: "the
 * process terminates without an audience, and nothing is captured").
 * "needs_input" does NOT trigger it — that's an expected, resumable pause.
 */
async function advanceOneStep(
  run: RunRow,
  stepIndex: number,
  currentInput: unknown,
  priorOutputs: Partial<Record<AgentName, unknown>>,
  baseUrl: string,
): Promise<RunRow> {
  const agent = PIPELINE[stepIndex];
  const startedAt = new Date();

  const scopedPriorOutputs: Partial<Record<AgentName, unknown>> = {};
  for (const visibleAgent of agent.contextAccess) {
    if (visibleAgent in priorOutputs) {
      scopedPriorOutputs[visibleAgent] = priorOutputs[visibleAgent];
    }
  }

  let response: AgentResponse;
  try {
    response = await callAgent(baseUrl, agent.path, {
      runId: run.run_id,
      input: currentInput,
      priorOutputs: scopedPriorOutputs,
    });
  } catch (err) {
    response = { status: "failed", message: (err as Error).message };
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  await query<TaskRunRow>(
    `INSERT INTO task_runs
       (run_id, task_id, step_index, status, input, output, message, metadata,
        started_at, finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)`,
    [
      run.run_id,
      agent.name,
      stepIndex,
      response.status,
      JSON.stringify(currentInput),
      JSON.stringify(response.output ?? null),
      response.message ?? null,
      JSON.stringify(response.metadata ?? {}),
      startedAt.toISOString(),
      finishedAt.toISOString(),
      durationMs,
    ],
  );

  if (response.status !== "completed") {
    if (response.status === "failed") {
      await runEscalation(run.run_id, baseUrl, {
        failedTask: agent.name,
        failedStepIndex: stepIndex,
        message: response.message ?? null,
        input: currentInput,
      }, priorOutputs, stepIndex + 1);
    }

    const [updated] = await query<RunRow>(
      `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [run.run_id, response.status, stepIndex],
    );
    return updated;
  }

  const nextStepIndex = stepIndex + 1;
  const isLastStep = nextStepIndex >= PIPELINE.length;
  const [updated] = await query<RunRow>(
    `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [run.run_id, isLastStep ? "completed" : "awaiting_approval", nextStepIndex],
  );
  return updated;
}

/** Starts a run and executes only its first agent (Intake). */
export async function runPipeline(initialInput: unknown, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(
    `INSERT INTO runs (input) VALUES ($1::jsonb) RETURNING *`,
    [JSON.stringify(initialInput)],
  );

  return advanceOneStep(run, 0, initialInput, {}, baseUrl);
}

/**
 * Answers a paused run's "needs_input" step and re-runs that SAME step —
 * the "a human resolves it and the run is resumed" half of the needs_input
 * contract (see types.ts). Re-enters at the exact step that paused
 * (`run.current_step`), rebuilding `priorOutputs` from every already-
 * completed task_run so a resumed run sees the same context a same-request
 * run would have. If the answer resolves it, the run lands in
 * "awaiting_approval" like any other completed step — answering a question
 * is not the same act as approving the next agent.
 */
export async function resumeRun(runId: string, resumedInput: unknown, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    throw new Error(`No run found for run_id ${runId}.`);
  }
  if (run.status !== "needs_input") {
    throw new Error(`Run ${runId} is "${run.status}", not "needs_input" — nothing to resume.`);
  }

  const { priorOutputs } = await completedTaskRunsFor(runId);

  const [running] = await query<RunRow>(
    `UPDATE runs SET status = 'running', updated_at = NOW() WHERE run_id = $1 RETURNING *`,
    [runId],
  );

  return advanceOneStep(running, running.current_step, resumedInput, priorOutputs, baseUrl);
}

/**
 * Approves an "awaiting_approval" run and runs the next agent — the actual
 * "yes, go ahead" action behind the per-agent approval gate. `current_step`
 * already points at the next agent to run (advanceOneStep advanced it past
 * the one that just completed), and its input is that prior agent's output.
 */
export async function continueRun(runId: string, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    throw new Error(`No run found for run_id ${runId}.`);
  }
  if (run.status !== "awaiting_approval") {
    throw new Error(`Run ${runId} is "${run.status}", not "awaiting_approval" — nothing to approve.`);
  }

  const { priorOutputs, lastCompleted } = await completedTaskRunsFor(runId);
  const currentInput = lastCompleted ? lastCompleted.output : run.input;

  const [running] = await query<RunRow>(
    `UPDATE runs SET status = 'running', updated_at = NOW() WHERE run_id = $1 RETURNING *`,
    [runId],
  );

  return advanceOneStep(running, running.current_step, currentInput, priorOutputs, baseUrl);
}

/** Every completed task_run for a run, as the `priorOutputs` map plus the most recent one — shared by resumeRun/continueRun. */
async function completedTaskRunsFor(
  runId: string,
): Promise<{ priorOutputs: Partial<Record<AgentName, unknown>>; lastCompleted: TaskRunRow | undefined }> {
  const completedTaskRuns = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 AND status = 'completed' ORDER BY step_index`,
    [runId],
  );
  const priorOutputs: Partial<Record<AgentName, unknown>> = {};
  for (const taskRun of completedTaskRuns) {
    priorOutputs[taskRun.task_id] = taskRun.output;
  }
  return { priorOutputs, lastCompleted: completedTaskRuns[completedTaskRuns.length - 1] };
}

/**
 * Best-effort call to the Escalation agent when a run fails. Never throws:
 * a broken escalation path must not mask the original failure, but it IS
 * still recorded as its own task_run — even escalation failing is
 * something B9 says must be captured, not silently dropped.
 */
async function runEscalation(
  runId: string,
  baseUrl: string,
  failure: { failedTask: AgentName; failedStepIndex: number; message: string | null; input: unknown },
  priorOutputs: Partial<Record<AgentName, unknown>>,
  stepIndex: number,
): Promise<void> {
  const scopedPriorOutputs: Partial<Record<AgentName, unknown>> = {};
  for (const visibleAgent of ESCALATION.contextAccess) {
    if (visibleAgent in priorOutputs) {
      scopedPriorOutputs[visibleAgent] = priorOutputs[visibleAgent];
    }
  }

  const startedAt = new Date();
  let response: AgentResponse;
  try {
    response = await callAgent(baseUrl, ESCALATION.path, {
      runId,
      input: failure,
      priorOutputs: scopedPriorOutputs,
    });
  } catch (err) {
    response = { status: "failed", message: (err as Error).message };
  }
  const finishedAt = new Date();

  await query<TaskRunRow>(
    `INSERT INTO task_runs
       (run_id, task_id, step_index, status, input, output, message, metadata,
        started_at, finished_at, duration_ms)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11)`,
    [
      runId,
      ESCALATION.name,
      stepIndex,
      response.status,
      JSON.stringify(failure),
      JSON.stringify(response.output ?? null),
      response.message ?? null,
      JSON.stringify(response.metadata ?? {}),
      startedAt.toISOString(),
      finishedAt.toISOString(),
      finishedAt.getTime() - startedAt.getTime(),
    ],
  );
}

async function callAgent(baseUrl: string, path: string, body: AgentRequest): Promise<AgentResponse> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent at ${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return (await res.json()) as AgentResponse;
}

/** A single run plus every task_runs row recorded for it, in step order. */
export async function getRun(runId: string): Promise<{ run: RunRow; taskRuns: TaskRunRow[] } | null> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) return null;
  const taskRuns = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 ORDER BY step_index`,
    [runId],
  );
  return { run, taskRuns };
}

/** Most recent runs, for a status/observability listing. */
export async function listRuns(limit = 50): Promise<RunRow[]> {
  return query<RunRow>(`SELECT * FROM runs ORDER BY created_at DESC LIMIT $1`, [limit]);
}

/** The static task catalog (see db/schema.sql — kept in sync with registry.ts). */
export async function listTasks(): Promise<TaskRow[]> {
  return query<TaskRow>(`SELECT * FROM tasks ORDER BY task_id`);
}

/** Every execution of a single task across all runs — "when did audience_creation run, and how did it go each time." */
export async function listTaskRuns(taskId: string, limit = 50): Promise<TaskRunRow[]> {
  return query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE task_id = $1 ORDER BY started_at DESC LIMIT $2`,
    [taskId, limit],
  );
}

export interface RunStats {
  total: number;
  running: number;
  needsInput: number;
  completed: number;
  failed: number;
  approved: number;
  promoted: number;
}

/** Dashboard tile counts. Cast to ::int so the pg driver returns numbers, not bigint strings. */
export async function getRunStats(): Promise<RunStats> {
  const [row] = await query<{
    total: number; running: number; needs_input: number;
    completed: number; failed: number; approved: number; promoted: number;
  }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE status = 'needs_input')::int AS needs_input,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE approved)::int AS approved,
      COUNT(*) FILTER (WHERE promoted)::int AS promoted
    FROM runs
  `);
  return {
    total: row.total,
    running: row.running,
    needsInput: row.needs_input,
    completed: row.completed,
    failed: row.failed,
    approved: row.approved,
    promoted: row.promoted,
  };
}
