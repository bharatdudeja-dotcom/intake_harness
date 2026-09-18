import { NextRequest, NextResponse } from "next/server";
import { listTaskRuns } from "@/lib/pipeline/orchestrator";
import { apiError } from "@/lib/api-error";

/** Every execution of one task across all pipeline runs — trace a single agent's history independent of any one run_id. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;
  try {
    const taskRuns = await listTaskRuns(taskId, limit);
    return NextResponse.json({ taskRuns });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
