import { NextRequest, NextResponse } from "next/server";
import { getResource } from "@/lib/resources";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params;
  try {
    const resource = await getResource(resourceId);
    if (!resource) return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    return NextResponse.json({ resource });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
