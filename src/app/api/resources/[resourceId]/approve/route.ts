import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isAdmin } from "@/lib/admins";
import { getResource, type ResourceRow } from "@/lib/resources";

/** POST: an admin marks a resource worth keeping — tier 1, same model as runs. Body: { adminName, note? }. */
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

  const resource = await getResource(resourceId);
  if (!resource) {
    return NextResponse.json({ error: `No resource found for id ${resourceId}.` }, { status: 404 });
  }

  const note = typeof body?.note === "string" ? body.note.trim() || null : null;
  const [updated] = await query<ResourceRow>(
    `UPDATE resources SET approved = true, approved_by = $2, approved_at = NOW(), approval_note = $3, updated_at = NOW()
     WHERE resource_id = $1 RETURNING *`,
    [resourceId, adminName, note],
  );
  return NextResponse.json({ resource: updated });
}
