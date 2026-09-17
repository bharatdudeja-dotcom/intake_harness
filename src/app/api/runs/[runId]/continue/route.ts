import { NextRequest, NextResponse } from "next/server";
import { continueRun } from "@/lib/pipeline/orchestrator";

/**
 * POST: the "approve" action for a run sitting in "awaiting_approval" —
 * runs exactly the next agent and stops again (or finishes, if that was
 * the last one). No body required.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const baseUrl = req.nextUrl.origin;
  try {
    const run = await continueRun(runId, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
