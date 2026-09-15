import { NextRequest, NextResponse } from "next/server";
import { listTaskRuns } from "@/lib/pipeline/orchestrator";

/** Every execution of one task across all pipeline runs — trace a single agent's history independent of any one run_id. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;
  const taskRuns = await listTaskRuns(taskId, limit);
  return NextResponse.json({ taskRuns });
}
