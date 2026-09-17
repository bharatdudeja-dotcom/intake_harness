import { NextRequest, NextResponse } from "next/server";
import { createResource, listResources, RESOURCE_TYPES, type ResourceType } from "@/lib/resources";

function isResourceType(v: unknown): v is ResourceType {
  return typeof v === "string" && (RESOURCE_TYPES as readonly string[]).includes(v);
}

/** GET: list resources, optionally filtered by ?type=. POST: create one. */
export async function GET(req: NextRequest) {
  const typeParam = req.nextUrl.searchParams.get("type");
  if (typeParam && !isResourceType(typeParam)) {
    return NextResponse.json({ error: `Unknown type "${typeParam}". Must be one of: ${RESOURCE_TYPES.join(", ")}` }, { status: 400 });
  }
  const type = typeParam && isResourceType(typeParam) ? typeParam : undefined;
  try {
    const resources = await listResources(type ? { type } : {});
    return NextResponse.json({ resources });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }
  const { type, title, content, format, tags, owner, programmeId } = body;
  if (!isResourceType(type)) {
    return NextResponse.json({ error: `"type" must be one of: ${RESOURCE_TYPES.join(", ")}` }, { status: 400 });
  }
  if (typeof title !== "string" || !title.trim()) {
    return NextResponse.json({ error: '"title" is required.' }, { status: 400 });
  }
  if (typeof content !== "string" || !content.trim()) {
    return NextResponse.json({ error: '"content" is required.' }, { status: 400 });
  }

  try {
    const resource = await createResource({
      type,
      title: title.trim(),
      content,
      format: typeof format === "string" ? format : null,
      tags: Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean) : [],
      owner: typeof owner === "string" ? owner : null,
      programmeId: typeof programmeId === "string" ? programmeId : null,
    });
    return NextResponse.json({ resource }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
