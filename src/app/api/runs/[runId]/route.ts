import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/pipeline/orchestrator";
import { apiError } from "@/lib/api-error";

/** A single run plus every task_runs row recorded for it — full traceability for one run_id. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  try {
    const result = await getRun(runId);
    if (!result) {
      return apiError("Run not found", "NOT_FOUND", 404);
    }
    return NextResponse.json(result);
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
