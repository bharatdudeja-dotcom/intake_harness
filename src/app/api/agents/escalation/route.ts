import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";

/**
 * Agent 4 — Escalation (unassigned).
 *
 * From the requirements doc (B9 / step 4.6): "Full escalation. The process
 * terminates without an audience, and nothing is captured... Log the
 * failure and classify it. This is the input to the crawl, walk, run loop
 * in section 10 — without it, the same class of failure recurs
 * indefinitely and the agents never improve."
 *
 * This is NOT part of the sequential pipeline — the orchestrator
 * (src/lib/pipeline/orchestrator.ts) calls it exactly once, when a run's
 * status becomes "failed", passing which task failed, at which step, its
 * error message, and (per its contextAccess in registry.ts) every prior
 * agent's output — everything needed to classify what actually went wrong.
 *
 * STUB: does the minimum B9 asks for — logs the failure and returns a
 * best-effort classification — without a real taxonomy or a persistent
 * "crawl, walk, run" store yet. The real classification categories below
 * are a starting guess drawn from the doc's own blockers (B4's attribute
 * gap, B5's FAC-vs-native ambiguity, B8's identity mismatch, B1/B2's
 * unbounded marketer loop) — refine as real failures are observed.
 */
export interface EscalationInput {
  failedTask: string;
  failedStepIndex: number;
  message: string | null;
  input: unknown;
}

export type FailureClassification =
  | "attribute_gap" // B4: AEP doesn't have the attributes this audience needs
  | "fac_ambiguous" // B5: couldn't determine rule-builder vs. FAC path
  | "identity_mismatch" // B8: account-vs-profile reconciliation failed
  | "marketer_loop_exceeded" // B1/B2: too many intake/review round-trips
  | "mcp_tool_denied" // this harness's own scoping rejected a tool call
  | "transport_error" // network/HTTP failure calling an agent or MCP tool
  | "unclassified";

export interface EscalationOutput {
  classification: FailureClassification;
  summary: string;
  failedTask: string;
  failedStepIndex: number;
}

function classify(message: string | null): FailureClassification {
  if (!message) return "unclassified";
  const m = message.toLowerCase();
  if (m.includes("is not allowed to call mcp tool")) return "mcp_tool_denied";
  if (m.includes("returned http") || m.includes("failed:")) return "transport_error";
  // TODO: real classification once Audience Creation's actual error shapes
  // exist — today's stub never actually throws these, so there's nothing
  // real to pattern-match against yet.
  return "unclassified";
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<EscalationInput>;
  const { failedTask, failedStepIndex, message } = body.input;

  // TODO: persist this classification somewhere queryable across runs (the
  // "crawl, walk, run loop" input B9 describes) — today it only lives in
  // this run's task_runs row via the orchestrator's own insert.
  const output: EscalationOutput = {
    classification: classify(message),
    summary: `Task "${failedTask}" failed at step ${failedStepIndex}: ${message ?? "no error message captured"}`,
    failedTask,
    failedStepIndex,
  };

  const response: AgentResponse<EscalationOutput> = {
    status: "completed",
    message: output.summary,
    output,
  };

  return NextResponse.json(response);
}
