/**
 * Eval for Agent 3's PQL synthesis (synthesizePql,
 * src/lib/agents/audience/pql-synth.ts) - run manually with `npm run
 * eval:audience`. decideBuildPath/activateAudience/etc. are deterministic
 * and already unit-tested; this only covers the LLM-drafted expression.
 *
 * Two-tier grading:
 *  1. STRUCTURAL, hard gate - `synthesized`/`unverifiedFields` against the
 *     fixture's `shouldSynthesize` (default true). This is the app's own
 *     verify gate (verifyFields) doing its job; a mismatch here is either a
 *     real regression or the safety gate correctly refusing, never a
 *     "quality" question a judge should weigh in on.
 *  2. JUDGED - only once a synthesis is expected AND produced: is the PQL
 *     logic actually right, per the fixture's rubric.
 */

import { describe, it, expect, afterAll } from "vitest";
import { getLlmClient, isLlmConfigured } from "@/lib/llm";
import { synthesizePql } from "@/lib/agents/audience/pql-synth";
import { fakeSchemaProbe, fakePqlGuidance } from "./lib/fake-aep";
import { loadFixtures } from "./lib/fixtures";
import { report, type EvalOutcome } from "./lib/report";
import { judge } from "./lib/judge";
import { runRepeated } from "./lib/repeat";

type PqlFixture = {
  id: string;
  criteria: string;
  availableFields: string[];
  rubric: string;
  /** Default true: most fixtures expect a verified expression to come back. */
  shouldSynthesize?: boolean;
};

const results: EvalOutcome[] = [];
const startedAt = new Date();
afterAll(() => report("audience_creation", "Audience Creation (synthesizePql)", results, startedAt));

describe.skipIf(!isLlmConfigured())("PQL synthesis eval", () => {
  const fixtures = loadFixtures<PqlFixture>("pql-synth");
  const probeCache = new Map<string, ReturnType<typeof fakeSchemaProbe>>();
  const guidance = fakePqlGuidance();

  it.each(fixtures)("$id", async (fixture) => {
    const expectSynth = fixture.shouldSynthesize ?? true;

    let probe = probeCache.get(fixture.id);
    if (!probe) {
      probe = fakeSchemaProbe(fixture.availableFields);
      probeCache.set(fixture.id, probe);
    }

    const outcome = await runRepeated(async () => {
      const notes: string[] = [];
      let ok = true;

      const synthesis = await synthesizePql(fixture.criteria, probe!, guidance);
      // Surfaced regardless of pass/fail, so a reflection round is visible in
      // /evals whether or not it ended up mattering to the outcome.
      if (synthesis.revised) notes.push(`revised (attempts=${synthesis.attempts})`);

      if (!expectSynth) {
        if (synthesis.synthesized) {
          ok = false;
          notes.push(`expected a decline, but synthesized: "${synthesis.pql}"`);
        }
      } else if (!synthesis.synthesized) {
        ok = false;
        notes.push(`expected a verified expression, got none - reason: ${synthesis.reason ?? "(none given)"}`);
      } else if (synthesis.unverifiedFields.length > 0) {
        ok = false;
        notes.push(`expression referenced unverified field(s): ${synthesis.unverifiedFields.join(", ")}`);
      } else {
        const client = getLlmClient();
        if (client) {
          const verdict = await judge(
            client,
            `Write a PQL expression for: ${fixture.criteria} (available fields: ${fixture.availableFields.join(", ")})`,
            fixture.rubric,
            synthesis.pql ?? "",
          );
          if (!verdict.pass) {
            ok = false;
            notes.push(`judge: ${verdict.reasoning} (pql: ${synthesis.pql})`);
          }
        }
      }

      return { ok, notes: notes.join("; ") };
    });

    results.push({ id: fixture.id, passed: outcome.passed, notes: outcome.notes, attempts: outcome.attempts, passedAttempts: outcome.passedAttempts });
    expect.soft(outcome.passed, outcome.notes).toBe(true);
  });
});
