import { NextRequest, NextResponse } from "next/server";
import { retryRun } from "@/lib/pipeline/orchestrator";

/**
 * POST: recovers a run stuck at "running" — the transitional status
 * resumeRun/continueRun set right before calling the agent, meant to
 * resolve within that same request. If that request died first (a hung
 * downstream call, a killed process), this re-attempts the same step from
 * scratch rather than leaving the run permanently unreachable.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const baseUrl = req.nextUrl.origin;
  try {
    const run = await retryRun(runId, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
