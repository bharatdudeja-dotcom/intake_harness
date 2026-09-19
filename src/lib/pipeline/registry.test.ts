import { describe, it, expect } from "vitest";
import { PIPELINE } from "./registry";

describe("Agent 4 - Escalation stays removed", () => {
  it("PIPELINE has exactly the 3 sequential agents, no escalation entry", () => {
    expect(PIPELINE.map((a) => a.name)).toEqual(["intake", "review", "audience_creation"]);
  });

  it("registry.ts exports no ESCALATION/ALL_TASKS any more", async () => {
    const mod = (await import("./registry")) as Record<string, unknown>;
    expect(mod.ESCALATION).toBeUndefined();
    expect(mod.ALL_TASKS).toBeUndefined();
  });
});

describe("Audience Creation's approval-gate opt-out", () => {
  it("audience_creation sets requiresApproval: false", () => {
    const agent = PIPELINE.find((a) => a.name === "audience_creation");
    expect(agent?.requiresApproval).toBe(false);
  });

  it("intake and review still default to requiring approval (undefined === required)", () => {
    const intake = PIPELINE.find((a) => a.name === "intake");
    const review = PIPELINE.find((a) => a.name === "review");
    expect(intake?.requiresApproval).not.toBe(false);
    expect(review?.requiresApproval).not.toBe(false);
  });
});

describe("Broken segment-estimate tools stay out of Agent 3's allowlist", () => {
  it("audience_creation cannot call adobe_create_segment_estimate/adobe_get_segment_estimate", () => {
    const agent = PIPELINE.find((a) => a.name === "audience_creation");
    expect(agent?.allowedTools).not.toContain("adobe_create_segment_estimate");
    expect(agent?.allowedTools).not.toContain("adobe_get_segment_estimate");
  });
});

describe("least-privilege: no agent can write to AEP destinations", () => {
  it("no agent is granted destination_create_dataflow or destination_update_dataflow", () => {
    for (const agent of PIPELINE) {
      expect(agent.allowedTools).not.toContain("destination_create_dataflow");
      expect(agent.allowedTools).not.toContain("destination_update_dataflow");
    }
  });
});
