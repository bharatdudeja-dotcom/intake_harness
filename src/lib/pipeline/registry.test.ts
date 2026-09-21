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

describe("least-privilege: Workfront grants match actual usage, not the full toolset", () => {
  it("intake cannot search/read/list-comments an arbitrary Workfront object - only what workfront.ts actually calls", () => {
    const agent = PIPELINE.find((a) => a.name === "intake");
    for (const denied of [
      "insights_find_workfront_data", "wf_core_issue_list", // search
      "insights_summarize_object", "wf_core_issue_get", // getOne
      "comment-stream_query_comments", "wf_comments_list", // listComments
    ]) {
      expect(agent?.allowedTools).not.toContain(denied);
    }
  });

  it("review cannot create a Workfront object, look up by name, or resolve field names - it only ever touches the issue in its input", () => {
    const agent = PIPELINE.find((a) => a.name === "review");
    for (const denied of [
      "workflow_create_any_object", "wf_core_issue_create", // create
      "insights_find_workfront_data", "wf_core_issue_list", // search
      "insights_summarize_object", "wf_core_issue_get", // getOne
      "insights_search_fields", // resolveFields
      "insights_find_id_by_name",
    ]) {
      expect(agent?.allowedTools).not.toContain(denied);
    }
  });

  it("no agent is granted adobe_get_segment - grep-verified unused by any agent's code", () => {
    for (const agent of PIPELINE) {
      expect(agent.allowedTools).not.toContain("adobe_get_segment");
    }
  });
});

describe("least-privilege: destination writes stay narrow", () => {
  // destination_update_dataflow has NO segment_selectors field at all
  // (verified live, activation.ts's docstring) - there is still no safe
  // way to add a segment to a dataflow that already has other segments
  // wired to it, for ANY agent. This guard stays absolute.
  it("no agent, ever, is granted destination_update_dataflow", () => {
    for (const agent of PIPELINE) {
      expect(agent.allowedTools).not.toContain("destination_update_dataflow");
    }
  });

  // destination_create_dataflow IS now granted - explicit product
  // direction, 20 Sep 2026 - but ONLY to audience_creation, and only for
  // the safe case (no existing dataflow to clobber - see activation.ts).
  it("destination_create_dataflow is granted to audience_creation only", () => {
    for (const agent of PIPELINE) {
      const expectGranted = agent.name === "audience_creation";
      expect(agent.allowedTools.includes("destination_create_dataflow")).toBe(expectGranted);
    }
  });
});
