import { NextRequest, NextResponse } from "next/server";
import { listEvalRuns } from "@/lib/evals";
import { apiError } from "@/lib/api-error";

/** Lists the most recent eval runs (npm run eval:*) across all three suites. */
export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;
  try {
    const evalRuns = await listEvalRuns(limit);
    return NextResponse.json({ evalRuns });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
