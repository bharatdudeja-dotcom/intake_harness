/**
 * A scannable summary at the end of an eval file's run - vitest's own
 * pass/fail dots tell you THAT something failed, not which fixture or why.
 * Call once per eval file, after every fixture has run (e.g. in an
 * `afterAll`), with one entry per fixture.
 *
 * Also PERSISTS the same results to Postgres (eval_runs/eval_results, see
 * db/schema.sql) so a suite run against the real, configured provider is
 * browsable at /evals instead of living only in the invoking terminal's
 * scrollback. Persistence is best-effort: a DB failure (no DATABASE_URL in
 * this shell, a dropped connection) is logged and swallowed, never thrown -
 * the console table above is already the source of truth for whoever ran
 * the command, and one broken write shouldn't turn into a red eval run.
 */

import { query } from "@/lib/db";

export type EvalOutcome = {
  id: string;
  passed: boolean;
  /** Why - a score breakdown, a judge's reasoning, a mismatch detail. */
  notes: string;
};

export type EvalSuite = "intake" | "review" | "audience_creation";

export async function report(
  suite: EvalSuite,
  label: string,
  results: EvalOutcome[],
  startedAt: Date,
): Promise<void> {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const rate = total ? Math.round((passed / total) * 100) : 0;

  console.log(`\n=== ${label} eval: ${passed}/${total} (${rate}%) ===`);
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id}${r.notes ? ` — ${r.notes}` : ""}`);
  }
  console.log("");

  // Every fixture skipped (no LLM configured, describe.skipIf) - nothing
  // ran, so there is nothing worth a row in the run history.
  if (total === 0) return;

  try {
    await persist(suite, passed, total, results, startedAt);
  } catch (err) {
    console.error(
      `evals: could not save these results to the database (${(err as Error).message}). ` +
        "The table above is still accurate - only the /evals history is affected.",
    );
  }
}

async function persist(
  suite: EvalSuite,
  passedCount: number,
  totalCount: number,
  results: EvalOutcome[],
  startedAt: Date,
): Promise<void> {
  const [run] = await query<{ eval_run_id: string }>(
    `INSERT INTO eval_runs (suite, provider, passed_count, total_count, started_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING eval_run_id`,
    [suite, process.env.LLM_PROVIDER ?? null, passedCount, totalCount, startedAt.toISOString()],
  );

  // One batched insert (UNNEST over the three parallel arrays) rather than
  // one round trip per fixture - a handful of fixtures today, but no
  // reason to pay N round trips for it.
  await query(
    `INSERT INTO eval_results (eval_run_id, fixture_id, passed, notes)
     SELECT $1, * FROM UNNEST($2::text[], $3::boolean[], $4::text[])`,
    [run.eval_run_id, results.map((r) => r.id), results.map((r) => r.passed), results.map((r) => r.notes)],
  );
}
