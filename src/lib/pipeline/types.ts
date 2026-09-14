/**
 * The contract every agent endpoint implements. Each of the three agents
 * (Intake, Review/Triage, Audience Creation) is a standalone Next.js route
 * handler — this is the ONLY shape the orchestrator, and every other agent,
 * needs to agree on. An agent can be rewritten entirely internally as long
 * as it keeps this request/response shape.
 */

export const AGENT_NAMES = ["intake", "review", "audience_creation"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
/** A task_id in the `tasks` table is just an AgentName — same vocabulary, DB column name. */
export type TaskId = AgentName;

/**
 * "completed"    — normal success, output feeds the next agent.
 * "needs_input"  — the agent hit one of the doc's human-in-the-loop points
 *                  (e.g. B1's marketer round-trip, B3's marketer validation
 *                  at 2.5). The pipeline pauses here rather than failing;
 *                  a human resolves it and the run is resumed.
 * "failed"       — unrecoverable error for this run.
 */
export type AgentStatus = "completed" | "needs_input" | "failed";

export interface AgentRequest<TInput = unknown> {
  /** The runs.run_id this call belongs to. */
  runId: string;
  /** Output of the previous agent (or the original submission for the first agent). */
  input: TInput;
  /** Every prior agent's output in this run, keyed by agent name, for agents that need earlier context (e.g. Audience Creation re-checking the original intake). */
  priorOutputs: Partial<Record<AgentName, unknown>>;
}

export interface AgentResponse<TOutput = unknown> {
  status: AgentStatus;
  /** Present when status is "completed"; becomes the next agent's `input`. */
  output?: TOutput;
  /** Present when status is "failed" or "needs_input". */
  message?: string;
  /**
   * Free-form health/observability data, persisted alongside the task run
   * but NOT passed to the next agent. Use this for the metrics the
   * requirements doc calls out explicitly, e.g. { loopCount } for B1,
   * { predictedCount, identityGap } for B3/B6, { requestAgeSeconds } for B7.
   */
  metadata?: Record<string, unknown>;
}

/** One row in `runs` — a single pipeline invocation. */
export interface RunRow {
  run_id: string;
  status: "running" | "completed" | "failed" | "needs_input";
  current_step: number;
  input: unknown;
  created_at: string;
  updated_at: string;
}

/** One row in `tasks` — the static catalog of task/agent types (seeded from registry.ts). */
export interface TaskRow {
  task_id: TaskId;
  label: string;
  owner: string | null;
  created_at: string;
}

/** One row in `task_runs` — a single execution of a task inside a run. The traceability record: what ran, in which run, at what step, and when. */
export interface TaskRunRow {
  task_run_id: number;
  run_id: string;
  task_id: TaskId;
  step_index: number;
  status: AgentStatus;
  input: unknown;
  output: unknown;
  message: string | null;
  metadata: Record<string, unknown>;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  created_at: string;
}
