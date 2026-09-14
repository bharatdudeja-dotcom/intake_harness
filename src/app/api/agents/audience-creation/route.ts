import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";

/**
 * Agent 3 — Audience Creation (yours).
 *
 * This is the scaffold, not the build — the output shape below is derived
 * directly from the blockers the requirements doc assigns to this agent, so
 * the next session can fill in real logic field by field instead of
 * re-deriving the shape:
 *
 * B4 (2.7a) — attributes not available in AEP -> a separate agent+GTO
 *   workflow opens. This agent must keep state on that open request,
 *   re-evaluate automatically on completion (not wait for someone to
 *   check), and give the marketer a visible status instead of silence.
 * B5 (3.1) — decide whether a request genuinely needs FAC or can be
 *   satisfied in the AEP rule builder, so the undefined FAC sub-workflow
 *   (3.1b) is only entered when unavoidable.
 * B6 (3.3) — the nightly 9:45pm segmentation job means every rework cycle
 *   costs a full day. Predict the count and validate audience logic BEFORE
 *   that cutoff, and batch fixes into a single night.
 * B8 (3.4/4.3) — reconcile source vs. audience counts via identity
 *   resolution up front, so phase 4 (DPG/GTO manual reconciliation,
 *   escalation) is never entered in the common case.
 */
export interface AudienceCreationInput {
  // Whatever Agent 2 (Review) hands off — the confirmed intake.
  [key: string]: unknown;
}

export interface AudienceCreationOutput {
  /** B5: which build path this request takes. */
  buildPath: "aep_rule_builder" | "fac";
  /** B4: attributes needed for this audience exist in AEP today. */
  attributesAvailable: boolean;
  /** B4: set when attributesAvailable is false and a GTO request is open. */
  openAttributeRequest: {
    status: "not_opened" | "open" | "resolved";
    requestId: string | null;
    ageSeconds: number | null;
  };
  /** B6: predicted membership count before the 9:45pm segmentation cutoff. */
  predictedCount: number | null;
  /** B3/B8: account-vs-profile identity gap the marketer should see, not discover. */
  identityGap: { hasGap: boolean; details: string | null };
  /** Marketer-visible status string — the thing B4 says must never be silence. */
  statusMessage: string;
}

/**
 * STUB: returns a structurally valid AudienceCreationOutput with placeholder
 * values so the pipeline runs end-to-end. Nothing here talks to AEP's rule
 * builder, FAC, or the GTO workflow yet — every field below is a TODO.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<AudienceCreationInput>;

  const output: AudienceCreationOutput = {
    // TODO: real 3.1 decision — call adobe_create_segment_estimate /
    // check attribute availability via MCP before assuming rule builder.
    buildPath: "aep_rule_builder",
    attributesAvailable: true,
    openAttributeRequest: { status: "not_opened", requestId: null, ageSeconds: null },
    predictedCount: null,
    identityGap: { hasGap: false, details: null },
    statusMessage: "Stub: audience creation not yet implemented.",
  };

  const response: AgentResponse<AudienceCreationOutput> = {
    status: "completed",
    output,
    metadata: { input: body.input },
  };

  return NextResponse.json(response);
}
