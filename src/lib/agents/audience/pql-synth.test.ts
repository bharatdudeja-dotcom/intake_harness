import { describe, it, expect } from "vitest";
import { synthesizePql, verifyFields, isFieldPresent } from "./pql-synth";
import type { SchemaProbe } from "./aep";
import type { PqlGuidance } from "@/lib/agents/review/pql-context";
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

function probe(overrides: Partial<SchemaProbe> = {}): SchemaProbe {
  return {
    read: true, conclusive: true, error: null, sandbox: "sbx",
    schemaCount: 5, schemasInspected: 1, fieldGroupsInspected: 0, fieldCount: 3,
    found: {}, evidence: ["xfinityInternet", "stateProvince"], ...overrides,
  };
}

const pqlRef: PqlGuidance = {
  grounded: true,
  reason: null,
  hits: [],
  localReference: { available: true, path: "docs/pql-reference.md", categoryCount: 12, content: "PQL functions: exists(...)", error: null },
};

describe("isFieldPresent - anchored, leaf-segment match (the 'lob in glob' discipline)", () => {
  it("matches the last dotted path segment case-insensitively", () => {
    expect(isFieldPresent("_tenant.xfinityInternet", ["xfinityInternet"])).toBe(true);
    expect(isFieldPresent("homeAddress.stateProvince", ["stateProvince"])).toBe(true);
  });
  it("does not match a mere substring", () => {
    expect(isFieldPresent("_tenant.xfinity", ["xfinityInternet"])).toBe(false);
  });
  it("rejects a field not in the present list", () => {
    expect(isFieldPresent("_tenant.hasFerrari", ["xfinityInternet"])).toBe(false);
  });
});

describe("verifyFields", () => {
  it("splits confirmed from unverified", () => {
    const { confirmed, unverified } = verifyFields(
      ["a.xfinityInternet", "a.madeUp"],
      ["xfinityInternet", "stateProvince"],
    );
    expect(confirmed).toEqual(["a.xfinityInternet"]);
    expect(unverified).toEqual(["a.madeUp"]);
  });
});

describe("synthesizePql - the verify gate is the whole point", () => {
  const criteria = "customers who have Xfinity Internet in a given state";

  it("no LLM -> not synthesized, honest reason", async () => {
    const r = await synthesizePql(criteria, probe(), pqlRef, null);
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/no LLM/);
  });

  it("inconclusive probe -> refuses to synthesize against an unknown field set", async () => {
    const r = await synthesizePql(criteria, probe({ conclusive: false, error: "undetermined", evidence: [] }), pqlRef, stub("{}"));
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/undetermined|unknown field set/);
  });

  it("accepts an expression whose fields are all verified present", async () => {
    const client = stub(
      JSON.stringify({ pql: "xEvent.xfinityInternet = true", fieldsUsed: ["a.xfinityInternet"], missing: [] }),
    );
    const r = await synthesizePql(criteria, probe(), pqlRef, client);
    expect(r.synthesized).toBe(true);
    expect(r.pql).toMatch(/xfinityInternet/);
    expect(r.fieldsUsed).toEqual(["a.xfinityInternet"]);
  });

  it("REJECTS an expression referencing an unverified field", async () => {
    const client = stub(
      JSON.stringify({ pql: "profile.hasFerrari = true", fieldsUsed: ["profile.hasFerrari"], missing: [] }),
    );
    const r = await synthesizePql(criteria, probe(), pqlRef, client);
    expect(r.synthesized).toBe(false);
    expect(r.unverifiedFields).toContain("profile.hasFerrari");
    expect(r.reason).toMatch(/not verified present/);
  });

  it("reports insufficiency when the model returns an empty expression", async () => {
    const client = stub(JSON.stringify({ pql: "", fieldsUsed: [], missing: ["loyalty tier"] }));
    const r = await synthesizePql(criteria, probe(), pqlRef, client);
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/insufficient|loyalty tier/);
  });

  it("falls back (not synthesized) when the PQL reference is unavailable", async () => {
    const noRef: PqlGuidance = { ...pqlRef, localReference: { ...pqlRef.localReference, available: false, content: null, error: "missing" } };
    const r = await synthesizePql(criteria, probe(), noRef, stub("{}"));
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/reference could not be loaded/);
  });

  it("does not throw on a model error", async () => {
    const r = await synthesizePql(criteria, probe(), pqlRef, stub(new Error("boom")));
    expect(r.synthesized).toBe(false);
    expect(r.reason).toMatch(/failed/);
  });
});
