/**
 * Eval for Agent 2's LLM paths (detectRejectionLlm / triageRejectionLlm,
 * src/lib/agents/review/llm-triage.ts) - run manually with `npm run
 * eval:review`. resolveDataSource (data-source.ts) is NOT covered here: it's
 * pure deterministic regex logic with no LLM involved, already covered by
 * its own unit tests.
 *
 * rejected/kind/fieldKey are graded structurally; `reason`/`ask` quality is
 * judged (evals/lib/judge.ts) where a keyword/exact match can't tell a
 * clear, correctly-targeted explanation from a vague one.
 */

import { describe, it, expect, afterAll } from "vitest";
import { getLlmClient, isLlmConfigured } from "@/lib/llm";
import { detectRejectionLlm, triageRejectionLlm } from "@/lib/agents/review/llm-triage";
import type { CommentLike } from "@/lib/agents/review/rejection";
import { loadFixtures } from "./lib/fixtures";
import { report, type EvalOutcome } from "./lib/report";
import { judge } from "./lib/judge";
import { runRepeated } from "./lib/repeat";

type RejectionFixture = {
  id: string;
  comments: CommentLike[];
  expected: { rejected: boolean; reasonKeywords?: string[] };
};

type TriageFixture = {
  id: string;
  rejectionReason: string;
  current: Record<string, string>;
  expected: {
    findingKinds: string[];
    fieldKey: string;
    proposedOneOf?: string[];
    rubric: string;
  };
};

const results: EvalOutcome[] = [];
const startedAt = new Date();
afterAll(() => report("review", "Review (detectRejectionLlm / triageRejectionLlm)", results, startedAt));

describe.skipIf(!isLlmConfigured())("Rejection detection eval (detectRejectionLlm)", () => {
  const fixtures = loadFixtures<RejectionFixture>("review-rejection");

  it.each(fixtures)("$id", async (fixture) => {
    const outcome = await runRepeated(async () => {
      const notes: string[] = [];
      let ok = true;

      const detected = await detectRejectionLlm(fixture.comments);
      if (detected.source !== "llm") {
        return { ok: false, notes: `fell back to deterministic (${detected.fallbackReason ?? "no reason given"})` };
      }

      if (detected.signal.rejected !== fixture.expected.rejected) {
        ok = false;
        notes.push(`expected rejected=${fixture.expected.rejected}, got ${detected.signal.rejected}`);
      }
      const reasonLower = (detected.signal.reason ?? "").toLowerCase();
      for (const kw of fixture.expected.reasonKeywords ?? []) {
        if (!reasonLower.includes(kw.toLowerCase())) {
          ok = false;
          notes.push(`reason missing expected keyword "${kw}" (got: "${detected.signal.reason ?? ""}")`);
        }
      }

      return { ok, notes: notes.join("; ") };
    });

    results.push({ id: fixture.id, passed: outcome.passed, notes: outcome.notes, attempts: outcome.attempts, passedAttempts: outcome.passedAttempts });
    expect.soft(outcome.passed, outcome.notes).toBe(true);
  });
});

describe.skipIf(!isLlmConfigured())("Triage eval (triageRejectionLlm)", () => {
  const fixtures = loadFixtures<TriageFixture>("review-triage");

  it.each(fixtures)("$id", async (fixture) => {
    const outcome = await runRepeated(async () => {
      const notes: string[] = [];
      let ok = true;

      const triaged = await triageRejectionLlm(fixture.rejectionReason, fixture.current);
      // Surfaced regardless of pass/fail, so a reflection round is visible in
      // /evals whether or not it ended up mattering to the outcome.
      if (triaged.revised) notes.push(`revised (attempts=${triaged.attempts})`);
      if (triaged.source !== "llm") {
        notes.push(`fell back to deterministic (${triaged.fallbackReason ?? "no reason given"})`);
        return { ok: false, notes: notes.join("; ") };
      }

      const finding = triaged.triage.findings.find(
        (f) => fixture.expected.findingKinds.includes(f.kind) && f.fieldKey === fixture.expected.fieldKey,
      );
      if (!finding) {
        ok = false;
        notes.push(
          `no finding matched kind in [${fixture.expected.findingKinds.join(", ")}] + fieldKey "${fixture.expected.fieldKey}" ` +
            `(got: ${triaged.triage.findings.map((f) => `${f.kind}/${f.fieldKey}`).join(", ") || "none"})`,
        );
      } else {
        if (fixture.expected.proposedOneOf && !fixture.expected.proposedOneOf.includes(finding.proposed ?? "")) {
          ok = false;
          notes.push(`proposed "${finding.proposed}" not in [${fixture.expected.proposedOneOf.join(", ")}]`);
        }

        const client = getLlmClient();
        if (client) {
          const verdict = await judge(
            client,
            `Translate this rejection into a field correction: "${fixture.rejectionReason}"`,
            fixture.expected.rubric,
            `ask: ${finding.ask}\nproposed: ${finding.proposed ?? "(none)"}`,
          );
          if (!verdict.pass) {
            ok = false;
            notes.push(`judge: ${verdict.reasoning}`);
          }
        }
      }

      return { ok, notes: notes.join("; ") };
    });

    results.push({ id: fixture.id, passed: outcome.passed, notes: outcome.notes, attempts: outcome.attempts, passedAttempts: outcome.passedAttempts });
    expect.soft(outcome.passed, outcome.notes).toBe(true);
  });
});
