import { describe, it, expect, beforeEach } from "vitest";
import { resetRun, setCurrentAgent, startCall, finishCall, getProgress, clearRun } from "./live-progress";

const RUN_A = "run-a";
const RUN_B = "run-b";

beforeEach(() => {
  clearRun(RUN_A);
  clearRun(RUN_B);
});

describe("an untracked run reads back as empty, never throws", () => {
  it("getProgress on a run nothing has reset yet", () => {
    expect(getProgress("never-seen")).toEqual({ calls: [], currentTaskId: null });
  });

  it("startCall/finishCall/setCurrentAgent on an untracked run are silent no-ops", () => {
    expect(startCall("never-seen", "intake", "search_adobe_knowledge", {})).toBe(-1);
    expect(() => finishCall("never-seen", -1, { status: "success", durationMs: 10 })).not.toThrow();
    expect(() => setCurrentAgent("never-seen", "intake")).not.toThrow();
    expect(getProgress("never-seen")).toEqual({ calls: [], currentTaskId: null });
  });
});

describe("the lifecycle of one tracked run", () => {
  it("resetRun starts empty, setCurrentAgent sets who's running", () => {
    resetRun(RUN_A);
    expect(getProgress(RUN_A)).toEqual({ calls: [], currentTaskId: null });
    setCurrentAgent(RUN_A, "review");
    expect(getProgress(RUN_A).currentTaskId).toBe("review");
  });

  it("a call appears as pending immediately, then resolves in place", () => {
    resetRun(RUN_A);
    const id = startCall(RUN_A, "review", "adobe_list_schemas", { limit: "50" });
    expect(id).toBeGreaterThanOrEqual(0);

    const midFlight = getProgress(RUN_A).calls;
    expect(midFlight).toHaveLength(1);
    expect(midFlight[0]).toMatchObject({ id, taskId: "review", name: "adobe_list_schemas", status: "pending" });
    expect(midFlight[0].durationMs).toBeUndefined();

    finishCall(RUN_A, id, { status: "success", durationMs: 340 });
    const done = getProgress(RUN_A).calls;
    expect(done).toHaveLength(1); // same call, updated in place - not a second entry
    expect(done[0]).toMatchObject({ id, status: "success", durationMs: 340 });
  });

  it("a failed call carries its error, not a result", () => {
    resetRun(RUN_A);
    const id = startCall(RUN_A, "audience_creation", "adobe_list_segments", {});
    finishCall(RUN_A, id, { status: "error", durationMs: 12, error: "MCP_ENDPOINT_URL is not set." });
    expect(getProgress(RUN_A).calls[0]).toMatchObject({ status: "error", error: "MCP_ENDPOINT_URL is not set." });
  });

  it("accumulates calls across several agent steps chained under one action (the approval-gate removal case)", () => {
    // Review, then Audience Creation, in the same top-level action - see
    // orchestrator.ts's advanceOneStep chaining when requiresApproval is
    // false. resetRun happens once, at the TOP of the action; each agent's
    // own withToolCallLog just calls setCurrentAgent again as it starts.
    resetRun(RUN_A);
    setCurrentAgent(RUN_A, "review");
    const reviewCall = startCall(RUN_A, "review", "adobe_get_schema", {});
    finishCall(RUN_A, reviewCall, { status: "success", durationMs: 50 });

    setCurrentAgent(RUN_A, "audience_creation");
    const audienceCall = startCall(RUN_A, "audience_creation", "adobe_list_segments", {});

    const progress = getProgress(RUN_A);
    expect(progress.currentTaskId).toBe("audience_creation");
    expect(progress.calls.map((c) => c.taskId)).toEqual(["review", "audience_creation"]);
    expect(progress.calls[0].status).toBe("success");
    expect(progress.calls[1].status).toBe("pending");

    finishCall(RUN_A, audienceCall, { status: "success", durationMs: 80 });
    expect(getProgress(RUN_A).calls.every((c) => c.status === "success")).toBe(true);
  });

  it("clearRun removes tracking entirely - reads back as untracked, not merely empty", () => {
    resetRun(RUN_A);
    startCall(RUN_A, "intake", "search_adobe_knowledge", {});
    clearRun(RUN_A);
    expect(getProgress(RUN_A)).toEqual({ calls: [], currentTaskId: null });
  });

  it("two different runs never see each other's calls", () => {
    resetRun(RUN_A);
    resetRun(RUN_B);
    startCall(RUN_A, "intake", "search_adobe_knowledge", {});
    expect(getProgress(RUN_A).calls).toHaveLength(1);
    expect(getProgress(RUN_B).calls).toHaveLength(0);
  });
});
