import { query } from "@/lib/db";
import { PIPELINE } from "./registry";
import type { AgentName, AgentRequest, AgentResponse, RunRow, TaskRow, TaskRunRow } from "./types";

/**
 * Runs the pipeline for a single submission: calls each agent's own API
 * route in order over real HTTP (not a direct function call), so every
 * agent stays an independently testable, independently deployable endpoint
 * — a dev can `curl localhost:3000/api/agents/audience-creation` on its own
 * without spinning up the rest of the pipeline.
 *
 * Every call is recorded as a task_runs row (run_id, task_id, step_index,
 * started_at/finished_at) — the traceability trail: what ran, per run, and
 * when. Stops at the first "needs_input" or "failed" step, matching the
 * doc's finding that most of the process is fine and the real problem is
 * silent waiting — a paused run is visible in `runs`, not a black box.
 *
 * Each agent also only ever receives the slice of `priorOutputs` its
 * registry entry declares via `contextAccess` — this function filters the
 * full accumulated history down to that allowlist before every HTTP call,
 * so an agent never receives a prior agent's output it isn't scoped to see
 * (paired with the tool allowlist enforced in lib/mcp-client.ts).
 */
export async function runPipeline(initialInput: unknown, baseUrl: string): Promise<RunRow> {
  const [run] = await query<RunRow>(
    `INSERT INTO runs (input) VALUES ($1::jsonb) RETURNING *`,
    [JSON.stringify(initialInput)],
  );

  let currentInput: unknown = initialInput;
  const priorOutputs: Partial<Record<AgentName, unknown>> = {};

  for (let stepIndex = 0; stepIndex < PIPELINE.length; stepIndex++) {
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
      const [updated] = await query<RunRow>(
        `UPDATE runs SET status = $2, current_step = $3, updated_at = NOW()
         WHERE run_id = $1 RETURNING *`,
        [run.run_id, response.status, stepIndex],
      );
      return updated;
    }

    priorOutputs[agent.name] = response.output;
    currentInput = response.output;
  }

  const [completed] = await query<RunRow>(
    `UPDATE runs SET status = 'completed', current_step = $2, updated_at = NOW()
     WHERE run_id = $1 RETURNING *`,
    [run.run_id, PIPELINE.length],
  );
  return completed;
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
