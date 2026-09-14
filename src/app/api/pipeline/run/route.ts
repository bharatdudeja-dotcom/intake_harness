import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline/orchestrator";

/**
 * Kicks off a full pipeline run: intake -> review -> audience_creation,
 * calling each agent's own endpoint in order. Runs synchronously and
 * returns the final (or paused/failed) run state.
 *
 * For real Adobe/GTO-backed agents that can take minutes to hours (see the
 * B4/B5/B6 discussion of nightly jobs and cross-team hand-offs), this route
 * will need to move to a fire-and-poll pattern: return the run id
 * immediately and let GET /api/pipeline/run/[runId] be the source of truth.
 * The synchronous version here is enough while every agent is a fast stub.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("input" in body)) {
    return NextResponse.json({ error: 'Body must be { "input": <object> }' }, { status: 400 });
  }

  const baseUrl = req.nextUrl.origin;
  try {
    const run = await runPipeline(body.input, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
