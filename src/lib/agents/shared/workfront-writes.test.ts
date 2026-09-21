import { describe, it, expect, afterEach } from "vitest";
import { workfrontWritesDisabled } from "./workfront-writes";
import { createIntakeRequest } from "@/lib/agents/intake/workfront";

afterEach(() => delete process.env.WORKFRONT_WRITES_DISABLED);

describe("workfrontWritesDisabled - the kill switch", () => {
  it("is off unless explicitly 'true'", () => {
    expect(workfrontWritesDisabled()).toBe(false);
    process.env.WORKFRONT_WRITES_DISABLED = "yes";
    expect(workfrontWritesDisabled()).toBe(false);
    process.env.WORKFRONT_WRITES_DISABLED = "true";
    expect(workfrontWritesDisabled()).toBe(true);
  });
});

describe("createIntakeRequest respects the kill switch", () => {
  it("skips the create with no MCP call and reports a clean dry-run", async () => {
    process.env.WORKFRONT_WRITES_DISABLED = "true";
    // No MCP mock needed: with the switch on, this must not call any tool.
    const outcome = await createIntakeRequest({
      runId: "test-run",
      intake: { campaign_name: "Test", business_objective: "Retention" },
      brief: "test brief",
    });
    expect(outcome.created).toBe(false);
    if (!outcome.created) {
      expect(outcome.reason).toMatch(/disabled/i);
      expect(outcome.wouldHaveCreated.fields.name).toBe("Test");
    }
  });
});
