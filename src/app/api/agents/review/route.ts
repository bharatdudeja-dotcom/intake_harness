import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";

/**
 * Agent 2 — Review / Triage (owned by Dev 2).
 *
 * From the requirements doc (B2 / step 1.5a): today, a review-queue
 * rejection goes back to the marketer as unstructured rework with nothing
 * reading the rejection reason. This agent should parse the rejection,
 * translate it into the specific missing field or wrong data source, and
 * redraft the intake for the marketer to confirm — described in the doc as
 * "the largest unclaimed gap in the map."
 *
 * STUB: pass-through so the pipeline runs end-to-end before Dev 2's real
 * logic lands. Replace the body; keep the AgentRequest/AgentResponse shape.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<Record<string, unknown>>;

  const response: AgentResponse = {
    status: "completed",
    output: {
      ...body.input,
      // TODO(dev-2): real review-queue triage — parse rejection reason,
      // map to missing field / wrong source, decide "needs_input" (send
      // back to marketer with the specific fix) vs "completed" (approved).
      reviewed: true,
    },
  };

  return NextResponse.json(response);
}
