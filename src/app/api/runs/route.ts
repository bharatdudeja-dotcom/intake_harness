import { NextRequest, NextResponse } from "next/server";
import { runPipeline, listRuns } from "@/lib/pipeline/orchestrator";
import { apiError } from "@/lib/api-error";

/**
 * POST: kicks off a full pipeline run: intake -> review -> audience_creation,
 * calling each agent's own endpoint in order. Runs synchronously and
 * returns the final (or paused/failed) run state.
 *
 * For real Adobe/GTO-backed agents that can take minutes to hours (see the
 * B4/B5/B6 discussion of nightly jobs and cross-team hand-offs), this route
 * will need to move to a fire-and-poll pattern: return the run id
 * immediately and let GET /api/runs/[runId] be the source of truth. The
 * synchronous version here is enough while every agent is a fast stub.
 *
 * GET: lists the most recent runs — the "what has run" observability view.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("input" in body)) {
    return apiError('Body must be { "input": <object> }', "VALIDATION_ERROR", 400);
  }

  const baseUrl = req.nextUrl.origin;
  try {
    const run = await runPipeline(body.input, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;
  try {
    const runs = await listRuns(limit);
    return NextResponse.json({ runs });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
