import { NextRequest, NextResponse } from "next/server";
import { getEvalRun } from "@/lib/evals";
import { apiError } from "@/lib/api-error";

/** One eval run plus every fixture-level result recorded for it. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ evalRunId: string }> }) {
  const { evalRunId } = await params;
  try {
    const result = await getEvalRun(evalRunId);
    if (!result) {
      return apiError("Eval run not found", "NOT_FOUND", 404);
    }
    return NextResponse.json(result);
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
