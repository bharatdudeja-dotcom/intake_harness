import { describe, it, expect } from "vitest";
import {
  detectRejectionLlm,
  triageRejectionLlm,
  validateFindings,
  explainRejectedFindings,
  extractJsonObject,
} from "./llm-triage";
import type { LlmClient, LlmCompletionResult } from "@/lib/llm";

function stub(reply: string | Error, model = "stub"): LlmClient {
  return {
    id: `stub:${model}`,
    async complete(): Promise<LlmCompletionResult> {
      if (reply instanceof Error) throw reply;
      return { text: reply, model, usage: null };
    },
  };
}

/** One reply per call, in order - for exercising the reflection/revision path. */
function stubSequence(replies: string[], model = "stub"): LlmClient {
  let i = 0;
  return {
    id: `stub-seq:${model}`,
    async complete(): Promise<LlmCompletionResult> {
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      return { text: reply, model, usage: null };
    },
  };
}

describe("extractJsonObject", () => {
  it("reads a fenced JSON block amid prose", () => {
    expect(extractJsonObject('ok\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("throws on non-JSON", () => {
    expect(() => extractJsonObject("nope")).toThrow();
  });
});

describe("detectRejectionLlm", () => {
  const rows = [{ message: "please hold this until the LOB is sorted", entryDate: "2026-09-20T10:00:00Z" }];

  it("falls back to deterministic when no client", async () => {
    const r = await detectRejectionLlm(rows, null);
    expect(r.source).toBe("deterministic");
  });

  it("uses the LLM's rejection read when it returns a reason", async () => {
    const r = await detectRejectionLlm(rows, stub('{"rejected":true,"reason":"needs the LOB","evidence":"..."}'));
    expect(r.source).toBe("llm");
    expect(r.signal.rejected).toBe(true);
    expect(r.signal.reason).toMatch(/LOB/);
  });

  it("falls back when the LLM flags a rejection but gives no reason", async () => {
    const r = await detectRejectionLlm(rows, stub('{"rejected":true,"reason":null}'));
    expect(r.source).toBe("deterministic");
    expect(r.fallbackReason).toMatch(/no reason text/);
  });

  it("falls back on a thrown error", async () => {
    const r = await detectRejectionLlm(rows, stub(new Error("timeout")));
    expect(r.source).toBe("deterministic");
    expect(r.fallbackReason).toMatch(/failed/);
  });
});

describe("validateFindings - never trust the model raw", () => {
  it("drops invented field keys but keeps the finding shape", () => {
    const out = validateFindings([{ kind: "missing_field", fieldKey: "not_a_field", ask: "x", evidence: "y" }]);
    expect(out[0].fieldKey).toBeNull();
  });

  it("keeps a proposed value only if it validates against real options", () => {
    const good = validateFindings([
      { kind: "invalid_value", fieldKey: "line_of_business", proposed: "Resi", ask: "x", evidence: "y" },
    ]);
    // "Resi" resolves to the real option "Residential (RES)".
    expect(good[0].proposed).toMatch(/Residential/);

    const bad = validateFindings([
      { kind: "invalid_value", fieldKey: "line_of_business", proposed: "Klingon", ask: "x", evidence: "y" },
    ]);
    // No real option matches -> proposed dropped, becomes a plain question.
    expect(bad[0].proposed).toBeNull();
  });

  it("drops findings with an unknown kind", () => {
    expect(validateFindings([{ kind: "vibes", fieldKey: "offer", ask: "x", evidence: "y" }])).toHaveLength(0);
  });
});

describe("triageRejectionLlm", () => {
  const reason = "line of business was submitted as 'Resi', which isn't valid";

  it("falls back to deterministic when no client", async () => {
    const r = await triageRejectionLlm(reason, {}, null);
    expect(r.source).toBe("deterministic");
  });

  it("uses the LLM findings and fills the redraft with the validated value", async () => {
    const client = stub(
      JSON.stringify({
        findings: [
          { kind: "invalid_value", fieldKey: "line_of_business", proposed: "Resi", ask: "confirm", evidence: "Resi" },
        ],
      }),
    );
    const r = await triageRejectionLlm(reason, { line_of_business: "Resi" }, client);
    expect(r.source).toBe("llm");
    expect(r.triage.redraft.line_of_business).toMatch(/Residential/);
    expect(r.triage.changed).toContain("line_of_business");
  });

  it("falls back when the LLM yields no valid findings", async () => {
    const r = await triageRejectionLlm(reason, {}, stub('{"findings":[]}'));
    expect(r.source).toBe("deterministic");
    expect(r.fallbackReason).toMatch(/no valid findings/);
  });

  it("falls back on error", async () => {
    const r = await triageRejectionLlm(reason, {}, stub(new Error("boom")));
    expect(r.source).toBe("deterministic");
  });

  it("a clean first attempt takes exactly one call", async () => {
    const client = stubSequence([
      JSON.stringify({
        findings: [{ kind: "invalid_value", fieldKey: "line_of_business", proposed: "Resi", ask: "confirm", evidence: "Resi" }],
      }),
    ]);
    const r = await triageRejectionLlm(reason, { line_of_business: "Resi" }, client);
    expect(r.source).toBe("llm");
    expect(r.attempts).toBe(1);
    expect(r.revised).toBe(false);
  });
});

describe("explainRejectedFindings - the reflection critic", () => {
  it("is empty when every finding would survive validateFindings", () => {
    expect(
      explainRejectedFindings([{ kind: "invalid_value", fieldKey: "line_of_business", proposed: "Resi", ask: "x", evidence: "y" }]),
    ).toEqual([]);
  });
  it("flags an unknown kind", () => {
    expect(explainRejectedFindings([{ kind: "vibes", fieldKey: "offer", ask: "x", evidence: "y" }])[0]).toMatch(/kind "vibes"/);
  });
  it("flags an invented field key", () => {
    expect(
      explainRejectedFindings([{ kind: "missing_field", fieldKey: "not_a_field", ask: "x", evidence: "y" }])[0],
    ).toMatch(/not_a_field.*not a real field/);
  });
  it("flags a proposed value with no matching allowed option", () => {
    expect(
      explainRejectedFindings([{ kind: "invalid_value", fieldKey: "line_of_business", proposed: "Klingon", ask: "x", evidence: "y" }])[0],
    ).toMatch(/Klingon.*does not match/);
  });
});

describe("triageRejectionLlm - reflection: one chance to fix a rejected finding", () => {
  const reason = "line of business was submitted as 'Resi', which isn't valid";

  it("revises a first attempt with an invalid kind, and accepts a clean second attempt", async () => {
    const client = stubSequence([
      JSON.stringify({ findings: [{ kind: "vibes", fieldKey: "line_of_business", proposed: "Resi", ask: "x", evidence: "y" }] }),
      JSON.stringify({
        findings: [{ kind: "invalid_value", fieldKey: "line_of_business", proposed: "Resi", ask: "confirm", evidence: "Resi" }],
      }),
    ]);
    const r = await triageRejectionLlm(reason, { line_of_business: "Resi" }, client);
    expect(r.source).toBe("llm");
    expect(r.attempts).toBe(2);
    expect(r.revised).toBe(true);
    expect(r.triage.redraft.line_of_business).toMatch(/Residential/);
  });

  it("falls back to deterministic, with attempts:2, when the revision is also invalid", async () => {
    const client = stubSequence([
      JSON.stringify({ findings: [{ kind: "vibes", fieldKey: "line_of_business", proposed: "Resi", ask: "x", evidence: "y" }] }),
      JSON.stringify({ findings: [{ kind: "nonsense", fieldKey: "line_of_business", proposed: "Resi", ask: "x", evidence: "y" }] }),
    ]);
    const r = await triageRejectionLlm(reason, {}, client);
    expect(r.source).toBe("deterministic");
    expect(r.attempts).toBe(2);
    expect(r.revised).toBe(true);
  });
});
