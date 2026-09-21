/**
 * pass^k: run one fixture's check k times and count how many attempts passed.
 *
 * WHY (eval guide §5.4): a single run of a non-deterministic model tells you
 * almost nothing. Production reliability is pass^k - the fraction of cases
 * that pass on ALL k attempts - and it drops fast as k grows. This is the one
 * place that reads EVAL_REPEAT (default 1, so the existing suites behave
 * exactly as before until someone sets it) and runs a check that many times.
 *
 * A fixture's headline `passed` is defined as "passed every attempt"
 * (passedAttempts === attempts), so a fixture that passes 2 of 3 reads as a
 * FAIL with the 2/3 visible in its notes - a flaky case is not a green one.
 *
 * The check returns { ok, notes } per attempt rather than throwing, so a
 * thrown error (a transport blip on attempt 2 of 3) counts as a failed
 * attempt with its message captured, not an aborted fixture.
 */

export type AttemptResult = { ok: boolean; notes: string };

export type RepeatOutcome = {
  attempts: number;
  passedAttempts: number;
  /** pass^k for this fixture: passed on every attempt. */
  passed: boolean;
  /** Combined notes - the failing attempts' notes, deduped, plus the k-of-n tally when k > 1. */
  notes: string;
};

/** How many times each fixture runs. EVAL_REPEAT in the environment, clamped to >= 1. */
export function repeatCount(): number {
  const raw = Number(process.env.EVAL_REPEAT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/**
 * Run `check` repeatCount() times and fold the attempts into one RepeatOutcome.
 * `check` should perform the fixture's grading and return { ok, notes } - the
 * same ok/notes an eval file already computes today, just returned instead of
 * pushed straight into `results`.
 */
export async function runRepeated(check: () => Promise<AttemptResult>): Promise<RepeatOutcome> {
  const attempts = repeatCount();
  let passedAttempts = 0;
  const failNotes: string[] = [];

  for (let i = 0; i < attempts; i++) {
    let attempt: AttemptResult;
    try {
      attempt = await check();
    } catch (err) {
      attempt = { ok: false, notes: `attempt threw: ${(err as Error).message}` };
    }
    if (attempt.ok) {
      passedAttempts++;
    } else if (attempt.notes) {
      failNotes.push(attempt.notes);
    }
  }

  const passed = passedAttempts === attempts;
  const tally = attempts > 1 ? `passed ${passedAttempts}/${attempts} attempts` : "";
  // Dedupe fail notes - the same failure repeated k times is one message, not k.
  const uniqueFails = [...new Set(failNotes)];
  const notes = [tally, ...uniqueFails].filter(Boolean).join("; ");

  return { attempts, passedAttempts, passed, notes };
}
