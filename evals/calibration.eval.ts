/**
 * Judge calibration (eval guide §5.3): before trusting the LLM-as-judge
 * (evals/lib/judge.ts) to grade the outcome evals' open-ended answers, measure
 * how often it AGREES with a human label. A judge you haven't calibrated is a
 * second unvalidated model sitting in judgment of the first.
 *
 * Each fixture in fixtures/judge-calibration is a (question, rubric, answer)
 * plus a `humanVerdict` ("pass"/"fail") a person assigned by hand. This runs
 * the real judge over each, compares its verdict to the human's, and reports
 * the agreement rate. A single fixture "passes" here when the judge agrees
 * with the human on it - so the suite's pass rate IS the judge's agreement
 * rate, persisted to /evals like any other suite (under a distinct label).
 *
 * The guide says calibrate on 50-100 examples and re-check when the judge
 * prompt or model changes. The four fixtures here are a starting seed
 * covering the two things the judge actually grades in this app (PQL logic,
 * triage-correction clarity) in both directions (a clear pass, an inverted-
 * logic fail, a targeted correction, a vague non-answer). Grow this set the
 * same way as any other: drop labeled JSON into the fixtures dir.
 *
 * Recorded under suite "audience_creation" with a label that says calibration,
 * because eval_runs.suite has no "calibration" value and this isn't worth its
 * own schema migration - it's a diagnostic on the judge, run occasionally, not
 * a fifth product suite. The label in the console/DB makes clear what it is.
 */

import { describe, it, expect, afterAll } from "vitest";
import { getLlmClient, isLlmConfigured } from "@/lib/llm";
import { judge } from "./lib/judge";
import { loadFixtures } from "./lib/fixtures";
import { report, type EvalOutcome } from "./lib/report";

type CalibrationFixture = {
  id: string;
  question: string;
  rubric: string;
  answer: string;
  humanVerdict: "pass" | "fail";
};

const results: EvalOutcome[] = [];
const startedAt = new Date();
afterAll(() =>
  report("audience_creation", "Judge calibration (judge vs. human agreement)", results, startedAt),
);

describe.skipIf(!isLlmConfigured())("Judge calibration", () => {
  const fixtures = loadFixtures<CalibrationFixture>("judge-calibration");

  it.each(fixtures)("$id", async (fixture) => {
    const client = getLlmClient();
    if (!client) {
      // isLlmConfigured() was true but the client couldn't build - record an
      // honest fail rather than silently skipping one fixture.
      results.push({ id: fixture.id, passed: false, notes: "no LLM client available" });
      expect.soft(false, "no LLM client available").toBe(true);
      return;
    }

    const verdict = await judge(client, fixture.question, fixture.rubric, fixture.answer);
    const judgeVerdict = verdict.pass ? "pass" : "fail";
    const agrees = judgeVerdict === fixture.humanVerdict;
    const notes = agrees
      ? `agreed (both ${judgeVerdict})`
      : `DISAGREED: judge=${judgeVerdict}, human=${fixture.humanVerdict} — ${verdict.reasoning}`;

    results.push({ id: fixture.id, passed: agrees, notes });
    expect.soft(agrees, notes).toBe(true);
  });
});
