import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isAdmin } from "@/lib/admins";
import { canPromote } from "@/lib/settings";
import { getResource, type ResourceRow } from "@/lib/resources";

/**
 * POST: admits an already-approved resource into the cross-run Shared
 * Graph — tier 2, same model as runs. Body: { adminName, tags? }.
 * Requires `approved` first, same reasoning as runs/[runId]/promote.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ resourceId: string }> }) {
  const { resourceId } = await params;
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return NextResponse.json({ error: 'Body must include "adminName".' }, { status: 400 });
  }
  if (!isAdmin(adminName)) {
    return NextResponse.json({ error: `"${adminName}" is not in ADMIN_NAMES.` }, { status: 403 });
  }
  if (!(await canPromote(adminName))) {
    return NextResponse.json({ error: `"${adminName}" is not on the Hero Agents roster that may promote.` }, { status: 403 });
  }

  const resource = await getResource(resourceId);
  if (!resource) {
    return NextResponse.json({ error: `No resource found for id ${resourceId}.` }, { status: 404 });
  }
  if (!resource.approved) {
    return NextResponse.json(
      { error: `Resource ${resourceId} isn't approved yet — approve it before promoting it to the Shared Graph.` },
      { status: 400 },
    );
  }

  const tags = Array.isArray(body?.tags)
    ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
    : resource.tags;

  const [updated] = await query<ResourceRow>(
    `UPDATE resources SET promoted = true, promoted_by = $2, promoted_at = NOW(), tags = $3, updated_at = NOW()
     WHERE resource_id = $1 RETURNING *`,
    [resourceId, adminName, tags],
  );
  return NextResponse.json({ resource: updated });
}
