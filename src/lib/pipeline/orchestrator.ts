import { query } from "@/lib/db";
import { PIPELINE } from "./registry";
import type { AgentName, AgentRequest, AgentResponse, AgentStatus, RunRow, TaskRow, TaskRunRow } from "./types";
import * as liveProgress from "@/lib/live-progress";
import { postAgentUpdate } from "./workfront-updates";

/**
 * Runs exactly the NEXT agent for a run over real HTTP to that agent's own
 * route (a dev can `curl localhost:3000/api/agents/audience-creation` on
 * its own without spinning up the rest of the pipeline). Every call is
 * recorded as a task_runs row.
 *
 * A step that completes with more agents left to run either stops the run
 * at "awaiting_approval" (the per-agent equivalent of a tool call waiting
 * for permission before it runs — POST /api/runs/[runId]/continue is what
 * advances it) or, when the NEXT agent's registry entry sets
 * `requiresApproval: false`, chains straight into that agent within this
 * same call instead. Audience Creation is the one agent that opts out
 * today — see registry.ts for why — so completing Review now runs
 * Audience Creation immediately rather than waiting for a click.
 *
 * Each agent only ever receives the slice of `priorOutputs` its registry
 * entry declares via `contextAccess` — filtered from the full accumulated
 * history before every HTTP call, so an agent never receives a prior
 * agent's output it isn't scoped to see (paired with the tool allowlist
 * enforced in lib/mcp-client.ts).
 *
 * A "failed" step just ends the run there — there is no Agent 4 /
 * Escalation any more (removed on explicit product direction; see
 * registry.ts's note where it used to be defined). "needs_input" was
 * already never a failure — an expected, resumable pause — and remains one.
 *
 * An "in_progress" step is the fire-and-poll case: the agent accepted
 * long-running work and returned immediately, so this records the step and
 * leaves the run at "in_progress" without blocking. The work finishes
 * out-of-band via completeInProgressStep (a PATCH to the step's task_run),
 * NOT by this request awaiting it — which is what keeps a quarter-long
 * B4/B5 sub-workflow from stranding the run at "running" past
 * AGENT_CALL_TIMEOUT_MS.
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

  // Everything from here on just RECORDS the outcome above; callAgent's own
  // try/catch already turned an agent failure into an ordinary "failed"
  // response. If recording itself throws (a dropped DB connection, a query
  // timeout), the run must still not be left at "running" — that status
  // accepts neither resumeRun nor continueRun, so a run stuck there has no
  // way back in short of someone hand-editing the database (see the outer
  // catch below).
  // Post "what this agent did" back onto the Workfront issue as a comment,
  // centrally for EVERY agent (see workfront-updates.ts). Best-effort and
  // never throws: the outcome is folded into the step's metadata so it is
  // visible in observability, and a disabled write tool / missing issue can
  // never fail the run being recorded here.
  const workfrontUpdate = await postAgentUpdate(
    agent.name,
    response.status,
    response.message,
    response.output,
    priorOutputs,
  );

  try {
    await query<TaskRunRow>(
      `INSERT INTO task_runs
         (run_id, task_id, step_index, status, input, output, message, metadata,
          tokens_used, model, started_at, finished_at, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
      [
        run.run_id,
        agent.name,
        stepIndex,
        response.status,
        JSON.stringify(currentInput),
        JSON.stringify(response.output ?? null),
        response.message ?? null,
        JSON.stringify({ ...(response.metadata ?? {}), workfrontUpdate }),
        response.usage?.tokens ?? null,
        response.usage?.model ?? null,
        startedAt.toISOString(),
        finishedAt.toISOString(),
        durationMs,
      ],
    );

    if (response.status !== "completed") {
      // Covers "needs_input", "failed", AND "in_progress" identically here:
      // record the step's outcome and set the run to that status at THIS
      // step, then return without chaining. For "in_progress" that is the
      // whole fire-and-poll mechanism — the run now sits at "in_progress" on
      // this step (a durable, pollable state, not the transient "running"),
      // and the agent's later PATCH to this task_run is what advances it (see
      // completeInProgressStep). The task_run's finished_at/duration_ms are
      // the ACCEPT time for an in_progress row; the PATCH overwrites them
      // with the real completion time.
      const [updated] = await query<RunRow>(
        `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
         WHERE run_id = $1 RETURNING *`,
        [run.run_id, response.status, stepIndex],
      );
      return updated;
    }

    const nextStepIndex = stepIndex + 1;
    const isLastStep = nextStepIndex >= PIPELINE.length;

    // No approval gate before the next agent — run it now, within this same
    // call, instead of stopping at "awaiting_approval". See registry.ts's
    // requiresApproval and this file's own docstring.
    if (!isLastStep && PIPELINE[nextStepIndex].requiresApproval === false) {
      const nextPriorOutputs: Partial<Record<AgentName, unknown>> = {
        ...priorOutputs,
        [agent.name]: response.output,
      };
      return advanceOneStep(run, nextStepIndex, response.output, nextPriorOutputs, baseUrl);
    }

    const [updated] = await query<RunRow>(
      `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [run.run_id, isLastStep ? "completed" : "awaiting_approval", nextStepIndex],
    );
    return updated;
  } catch (err) {
    // Recording the step's own result (the try block above) failed — there
    // is nowhere left in the DB to put why (no Escalation task_run any
    // more, and `runs` itself carries no message column), so this is the
    // one place that error is still visible at all.
    console.error(`orchestrator: failed to record task_run for run ${run.run_id} step ${stepIndex}:`, err);
    const [failed] = await query<RunRow>(
      `UPDATE runs SET status = 'failed', current_step = $2, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [run.run_id, stepIndex],
    );
    return failed;
  }
}

/**
 * Recovers a run stuck at "running" — the state resumeRun/continueRun set
 * just before calling advanceOneStep, meant to be transitional within a
 * single request. If that request died before advanceOneStep resolved it
 * (a hung downstream call outliving even AGENT_CALL_TIMEOUT_MS, a killed
 * process), the row is left there with no way back in through either of
 * those functions, since both require a different starting status. This
 * re-attempts `current_step` from scratch using the same "what's already
 * completed" reconstruction resumeRun/continueRun use, so retrying costs
 * nothing but time — it is not a guess at what the dead attempt was doing.
 */
export async function retryRun(runId: string, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    throw new Error(`No run found for run_id ${runId}.`);
  }
  if (run.status !== "running") {
    throw new Error(`Run ${runId} is "${run.status}", not "running" — nothing to retry.`);
  }

  const { priorOutputs, lastCompleted } = await completedTaskRunsFor(runId);
  const currentInput = lastCompleted ? lastCompleted.output : run.input;

  liveProgress.resetRun(runId);
  try {
    return await advanceOneStep(run, run.current_step, currentInput, priorOutputs, baseUrl);
  } finally {
    liveProgress.clearRun(runId);
  }
}

/** Starts a run and executes only its first agent (Intake). */
export async function runPipeline(initialInput: unknown, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(
    `INSERT INTO runs (input) VALUES ($1::jsonb) RETURNING *`,
    [JSON.stringify(initialInput)],
  );

  liveProgress.resetRun(run.run_id);
  try {
    return await advanceOneStep(run, 0, initialInput, {}, baseUrl);
  } finally {
    liveProgress.clearRun(run.run_id);
  }
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

  liveProgress.resetRun(runId);
  try {
    return await advanceOneStep(running, running.current_step, resumedInput, priorOutputs, baseUrl);
  } finally {
    liveProgress.clearRun(runId);
  }
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

  liveProgress.resetRun(runId);
  try {
    return await advanceOneStep(running, running.current_step, currentInput, priorOutputs, baseUrl);
  } finally {
    liveProgress.clearRun(runId);
  }
}

/**
 * Finalize an "in_progress" step from OUT OF BAND — the fire-and-poll
 * completion path. A long-running agent (Audience Creation's GTO/FAC
 * sub-workflow, B4/B5) returned "in_progress" earlier; the orchestrator
 * recorded that step and left the run sitting at "in_progress" instead of
 * blocking on a multi-hour await. Now the agent (or a webhook it triggered)
 * calls PATCH /api/runs/[runId]/task-runs/[taskRunId] with the real outcome,
 * which lands here.
 *
 * This does NOT call the agent's HTTP route again — the agent has already
 * done the work and is REPORTING it. It overwrites the in_progress task_run
 * with the terminal outcome (real finished_at/duration_ms), then:
 *   - "completed" → advance exactly as a normal completed step does,
 *     including the approval gate and any requiresApproval chaining.
 *   - "needs_input" / "failed" → set the run to that status at this step.
 *
 * Idempotency/guarding: only a task_run currently in 'in_progress' for a run
 * currently at 'in_progress' can be finalized, so a duplicate/late PATCH
 * (e.g. a retried webhook) is rejected rather than double-advancing.
 */
export async function completeInProgressStep(
  runId: string,
  taskRunId: number,
  outcome: { status: AgentStatus; output?: unknown; message?: string; metadata?: Record<string, unknown> },
  baseUrl: string,
): Promise<RunRow> {
  if (outcome.status === "in_progress") {
    throw new Error(`Cannot finalize task_run ${taskRunId} to "in_progress" — supply a terminal status.`);
  }

  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) throw new Error(`No run found for run_id ${runId}.`);
  if (run.status !== "in_progress") {
    throw new Error(`Run ${runId} is "${run.status}", not "in_progress" — nothing to finalize.`);
  }

  const [step] = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE task_run_id = $1 AND run_id = $2`,
    [taskRunId, runId],
  );
  if (!step) throw new Error(`No task_run ${taskRunId} on run ${runId}.`);
  if (step.status !== "in_progress") {
    throw new Error(`task_run ${taskRunId} is "${step.status}", not "in_progress" — already finalized.`);
  }

  const finishedAt = new Date();
  const startedAt = new Date(step.started_at);
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  // Same centralized "what this agent did" comment as advanceOneStep, for the
  // out-of-band completion path. priorOutputs comes from the already-completed
  // steps (Intake/Review carry the Workfront identity); the finishing step's
  // own output is checked first. Best-effort — folded into this step's
  // metadata, never fatal.
  const { priorOutputs: priorForComment } = await completedTaskRunsFor(runId);
  const workfrontUpdate = await postAgentUpdate(
    step.task_id,
    outcome.status,
    outcome.message,
    outcome.output,
    priorForComment,
  );

  await query(
    `UPDATE task_runs
       SET status = $2, output = $3::jsonb, message = $4, metadata = $5::jsonb,
           finished_at = $6, duration_ms = $7
     WHERE task_run_id = $1`,
    [
      taskRunId,
      outcome.status,
      JSON.stringify(outcome.output ?? null),
      outcome.message ?? null,
      JSON.stringify({ ...(outcome.metadata ?? {}), workfrontUpdate }),
      finishedAt.toISOString(),
      durationMs,
    ],
  );

  if (outcome.status !== "completed") {
    const [updated] = await query<RunRow>(
      `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [runId, outcome.status, step.step_index],
    );
    return updated;
  }

  // Completed out-of-band: advance the pipeline as if this step had just
  // returned "completed" synchronously. Rebuild priorOutputs from every
  // completed step (now including this one), and either chain into the next
  // agent (requiresApproval: false) or stop at awaiting_approval / completed.
  const nextStepIndex = step.step_index + 1;
  const isLastStep = nextStepIndex >= PIPELINE.length;

  if (!isLastStep && PIPELINE[nextStepIndex].requiresApproval === false) {
    const { priorOutputs } = await completedTaskRunsFor(runId);
    const [running] = await query<RunRow>(
      `UPDATE runs SET status = 'running', current_step = $2, updated_at = NOW()
       WHERE run_id = $1 RETURNING *`,
      [runId, nextStepIndex],
    );
    liveProgress.resetRun(runId);
    try {
      return await advanceOneStep(running, nextStepIndex, outcome.output, priorOutputs, baseUrl);
    } finally {
      liveProgress.clearRun(runId);
    }
  }

  const [updated] = await query<RunRow>(
    `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [runId, isLastStep ? "completed" : "awaiting_approval", nextStepIndex],
  );
  return updated;
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
 * Past this, give up rather than hang. Without a bound here, an agent
 * whose own MCP call hangs (an unresponsive Workfront/AEP endpoint, a
 * dead TCP connection nothing ever times out) leaves this fetch pending
 * indefinitely — and with it, the run stuck at "running" forever, since
 * neither resumeRun nor continueRun accept that status to try again. A
 * bounded timeout turns that into an ordinary caught error instead, which
 * the caller already converts into a normal "failed" task_run.
 */
const AGENT_CALL_TIMEOUT_MS = 60_000;

async function callAgent(baseUrl: string, path: string, body: AgentRequest): Promise<AgentResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_CALL_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Agent at ${path} did not respond within ${AGENT_CALL_TIMEOUT_MS / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Agent at ${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`);
  }

  return (await res.json()) as AgentResponse;
}

/**
 * A single run plus every task_runs row recorded for it, in step order.
 *
 * `task_run_id` is a required SECOND sort key, not decoration - Intake's
 * own internal question-loop rounds (parse.ts's nextQuestions/loopCount)
 * all share step_index 0, since none of them advance the pipeline step.
 * `ORDER BY step_index` alone leaves same-step rows in whatever order
 * Postgres happens to return them, which SQL never guarantees is insertion
 * order. Both UI files' `pendingTaskRun` reads `taskRuns[taskRuns.length -
 * 1]` to find the CURRENT pending question - on an unspecified tie order,
 * that could show a stale, already-answered round instead of the real one,
 * which is exactly the confusing "still blank" symptom fixed earlier this
 * session for a different cause (client-side staleness). This is the same
 * failure mode from the server's own query, so it gets the same fix.
 */
export async function getRun(runId: string): Promise<{ run: RunRow; taskRuns: TaskRunRow[] } | null> {
  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) return null;
  const taskRuns = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 ORDER BY step_index, task_run_id`,
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
  inProgress: number;
  awaitingApproval: number;
  completed: number;
  failed: number;
  approved: number;
  promoted: number;
}

/** Dashboard tile counts. Cast to ::int so the pg driver returns numbers, not bigint strings. */
export async function getRunStats(): Promise<RunStats> {
  const [row] = await query<{
    total: number; running: number; needs_input: number; in_progress: number; awaiting_approval: number;
    completed: number; failed: number; approved: number; promoted: number;
  }>(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running,
      COUNT(*) FILTER (WHERE status = 'needs_input')::int AS needs_input,
      COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
      COUNT(*) FILTER (WHERE status = 'awaiting_approval')::int AS awaiting_approval,
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
    inProgress: row.in_progress,
    awaitingApproval: row.awaiting_approval,
    completed: row.completed,
    failed: row.failed,
    approved: row.approved,
    promoted: row.promoted,
  };
}

export interface TaskCounts {
  total: number;
  completed: number;
  needsInput: number;
  failed: number;
}

/** Per-task execution counts across every run — the Agents page's "how has each one done" row. */
export async function getTaskCounts(): Promise<Record<string, TaskCounts>> {
  const rows = await query<{ task_id: string; total: number; completed: number; needs_input: number; failed: number }>(`
    SELECT
      task_id,
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
      COUNT(*) FILTER (WHERE status = 'needs_input')::int AS needs_input,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
    FROM task_runs
    GROUP BY task_id
  `);
  const byTask: Record<string, TaskCounts> = {};
  for (const row of rows) {
    byTask[row.task_id] = { total: row.total, completed: row.completed, needsInput: row.needs_input, failed: row.failed };
  }
  return byTask;
}
