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
  /**
   * pass^k detail, when the fixture ran under runRepeated (evals/lib/repeat.ts).
   * Omitted for a plain single-run fixture, which reads as attempts=1 /
   * passedAttempts = (passed ? 1 : 0) - so `passed` stays the headline and
   * existing suites persist exactly as before.
   */
  attempts?: number;
  passedAttempts?: number;
};

export type EvalSuite = "intake" | "review" | "audience_creation" | "safety" | "trajectory";

/** 'offline' = graded against a curated fixture (every npm run eval:*); 'online' = sampled from real task_runs (Phase 4). */
export type EvalSource = "offline" | "online";

export async function report(
  suite: EvalSuite,
  label: string,
  results: EvalOutcome[],
  startedAt: Date,
  source: EvalSource = "offline",
): Promise<void> {
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const rate = total ? Math.round((passed / total) * 100) : 0;

  // repeat_count is uniform across a run (EVAL_REPEAT is read once), so take
  // it from the first fixture that reported attempts; default 1.
  const repeatCount = results.find((r) => r.attempts)?.attempts ?? 1;
  const passkLine = repeatCount > 1 ? ` [pass^${repeatCount}]` : "";

  console.log(`\n=== ${label} eval: ${passed}/${total} (${rate}%)${passkLine} ===`);
  for (const r of results) {
    console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id}${r.notes ? ` — ${r.notes}` : ""}`);
  }
  console.log("");

  // Every fixture skipped (no LLM configured, describe.skipIf) - nothing
  // ran, so there is nothing worth a row in the run history.
  if (total === 0) return;

  try {
    await persist(suite, passed, total, results, startedAt, source, repeatCount);
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
  source: EvalSource,
  repeatCount: number,
): Promise<void> {
  // pass^k at the run level: fixtures that passed every attempt. With
  // repeatCount === 1 this equals passedCount, so single-run rows are
  // unchanged. `passed` on each outcome is already defined as "passed all
  // attempts" (see repeat.ts), so counting passed outcomes IS pass^k.
  const passkCount = passedCount;

  const [run] = await query<{ eval_run_id: string }>(
    `INSERT INTO eval_runs
       (suite, provider, passed_count, total_count, started_at, finished_at, repeat_count, passk_count, source)
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7, $8)
     RETURNING eval_run_id`,
    [
      suite,
      process.env.LLM_PROVIDER ?? null,
      passedCount,
      totalCount,
      startedAt.toISOString(),
      repeatCount,
      passkCount,
      source,
    ],
  );

  // One batched insert (UNNEST over the parallel arrays) rather than one
  // round trip per fixture. attempts/passed_attempts default to the fixture's
  // own reported values, or (1, passed?1:0) for a plain single-run fixture.
  await query(
    `INSERT INTO eval_results (eval_run_id, fixture_id, passed, notes, attempts, passed_attempts)
     SELECT $1, * FROM UNNEST($2::text[], $3::boolean[], $4::text[], $5::int[], $6::int[])`,
    [
      run.eval_run_id,
      results.map((r) => r.id),
      results.map((r) => r.passed),
      results.map((r) => r.notes),
      results.map((r) => r.attempts ?? 1),
      results.map((r) => r.passedAttempts ?? (r.passed ? 1 : 0)),
    ],
  );
}
