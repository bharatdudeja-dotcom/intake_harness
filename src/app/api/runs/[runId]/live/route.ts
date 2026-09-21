import { NextRequest, NextResponse } from "next/server";
import { getProgress } from "@/lib/live-progress";

/**
 * GET: what this run's agent is doing RIGHT NOW, for a browser to poll
 * while POST /api/runs, .../continue, .../resume, or .../retry is still in
 * flight — see live-progress.ts for why this exists and why it's in-memory
 * rather than a DB table. Always 200s with an (possibly empty) list; there
 * is nothing to 404 on here — an unrecognised or already-finished run_id
 * just reads back as "nothing in flight," which is honest, not an error.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  return NextResponse.json(getProgress(runId));
}
