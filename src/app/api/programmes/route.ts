import { NextRequest, NextResponse } from "next/server";
import { listProgrammes, upsertProgrammeByName } from "@/lib/programmes";

/** GET: list programmes. POST: create one, or return the existing one with the same name. */
export async function GET() {
  try {
    const programmes = await listProgrammes();
    return NextResponse.json({ programmes });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: '"name" is required.' }, { status: 400 });
  }
  try {
    const { programme, created } = await upsertProgrammeByName({
      name,
      note: typeof body?.note === "string" ? body.note : null,
      owner: typeof body?.owner === "string" ? body.owner : null,
    });
    return NextResponse.json({ programme, created }, { status: created ? 201 : 200 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
