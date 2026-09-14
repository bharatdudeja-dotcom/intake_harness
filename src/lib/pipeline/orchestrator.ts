import { query } from "@/lib/db";
import { PIPELINE } from "./registry";
import type { AgentName, AgentRequest, AgentResponse, PipelineRunRow, PipelineStepRow } from "./types";

/**
 * Runs the pipeline for a single submission: calls each agent's own API
 * route in order over real HTTP (not a direct function call), so every
 * agent stays an independently testable, independently deployable endpoint
 * — a dev can `curl localhost:3000/api/agents/audience-creation` on its own
 * without spinning up the rest of the pipeline.
 *
 * Stops at the first "needs_input" or "failed" step, matching the doc's
 * finding that most of the process is fine and the real problem is silent
 * waiting — a paused run is visible in pipeline_runs, not a black box.
 */
export async function runPipeline(initialInput: unknown, baseUrl: string): Promise<PipelineRunRow> {
  const [run] = await query<PipelineRunRow>(
    `INSERT INTO pipeline_runs (input) VALUES ($1::jsonb) RETURNING *`,
    [JSON.stringify(initialInput)],
  );

  let currentInput: unknown = initialInput;
  const priorOutputs: Partial<Record<AgentName, unknown>> = {};

  for (let stepIndex = 0; stepIndex < PIPELINE.length; stepIndex++) {
    const agent = PIPELINE[stepIndex];
    const startedAt = Date.now();

    let response: AgentResponse;
    try {
      response = await callAgent(baseUrl, agent.path, {
        runId: run.id,
        input: currentInput,
        priorOutputs,
      });
    } catch (err) {
      response = { status: "failed", message: (err as Error).message };
    }

    const durationMs = Date.now() - startedAt;

    await query<PipelineStepRow>(
      `INSERT INTO pipeline_steps
         (run_id, step_index, agent_name, status, input, output, message, metadata, duration_ms)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9)`,
      [
        run.id,
        stepIndex,
        agent.name,
        response.status,
        JSON.stringify(currentInput),
        JSON.stringify(response.output ?? null),
        response.message ?? null,
        JSON.stringify(response.metadata ?? {}),
        durationMs,
      ],
    );

    if (response.status !== "completed") {
      const [updated] = await query<PipelineRunRow>(
        `UPDATE pipeline_runs SET status = $2, current_step = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [run.id, response.status, stepIndex],
      );
      return updated;
    }

    priorOutputs[agent.name] = response.output;
    currentInput = response.output;
  }

  const [completed] = await query<PipelineRunRow>(
    `UPDATE pipeline_runs SET status = 'completed', current_step = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [run.id, PIPELINE.length],
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

export async function getRun(runId: string): Promise<{ run: PipelineRunRow; steps: PipelineStepRow[] } | null> {
  const [run] = await query<PipelineRunRow>(`SELECT * FROM pipeline_runs WHERE id = $1`, [runId]);
  if (!run) return null;
  const steps = await query<PipelineStepRow>(
    `SELECT * FROM pipeline_steps WHERE run_id = $1 ORDER BY step_index`,
    [runId],
  );
  return { run, steps };
}
