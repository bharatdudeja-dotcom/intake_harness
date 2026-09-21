import { query } from "@/lib/db";

/**
 * Read side for the eval history evals/lib/report.ts writes to
 * (eval_runs/eval_results, db/schema.sql) - mirrors
 * src/lib/pipeline/orchestrator.ts's getRun/listRuns for the pipeline's own
 * `runs`/`task_runs`, just for `npm run eval:*` invocations instead of
 * pipeline runs.
 */

export interface EvalRunRow {
  eval_run_id: string;
  suite: "intake" | "review" | "audience_creation" | "safety" | "trajectory";
  provider: string | null;
  passed_count: number;
  total_count: number;
  /** How many times each fixture ran this invocation (EVAL_REPEAT, default 1). */
  repeat_count: number;
  /** Fixtures that passed on EVERY attempt (pass^k). Equals passed_count when repeat_count = 1. */
  passk_count: number | null;
  /** 'offline' = graded against a curated fixture; 'online' = sampled from real task_runs. */
  source: "offline" | "online";
  started_at: string;
  finished_at: string;
  created_at: string;
}

export interface EvalResultRow {
  eval_result_id: number;
  eval_run_id: string;
  fixture_id: string;
  passed: boolean;
  notes: string;
  /** Per-fixture pass^k detail — how many attempts ran and how many passed. */
  attempts: number;
  passed_attempts: number | null;
  created_at: string;
}

/** Most recent eval runs across all three suites, newest first. */
export async function listEvalRuns(limit = 50): Promise<EvalRunRow[]> {
  return query<EvalRunRow>(`SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
}

/** One eval run plus every fixture-level result recorded for it. */
export async function getEvalRun(
  evalRunId: string,
): Promise<{ run: EvalRunRow; results: EvalResultRow[] } | null> {
  const [run] = await query<EvalRunRow>(`SELECT * FROM eval_runs WHERE eval_run_id = $1`, [evalRunId]);
  if (!run) return null;
  const results = await query<EvalResultRow>(
    `SELECT * FROM eval_results WHERE eval_run_id = $1 ORDER BY fixture_id`,
    [evalRunId],
  );
  return { run, results };
}
