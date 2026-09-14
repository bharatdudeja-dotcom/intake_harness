import { NextRequest, NextResponse } from "next/server";
import { getRun } from "@/lib/pipeline/orchestrator";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const result = await getRun(runId);
  if (!result) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
