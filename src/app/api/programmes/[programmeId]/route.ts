import { NextRequest, NextResponse } from "next/server";
import { getProgramme, listRunsForProgramme } from "@/lib/programmes";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ programmeId: string }> }) {
  const { programmeId } = await params;
  try {
    const programme = await getProgramme(programmeId);
    if (!programme) return NextResponse.json({ error: "Programme not found" }, { status: 404 });
    const runs = await listRunsForProgramme(programmeId);
    return NextResponse.json({ programme, runs });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
