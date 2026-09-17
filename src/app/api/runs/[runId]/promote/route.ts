import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isAdmin } from "@/lib/admins";
import { canPromote } from "@/lib/settings";
import type { RunRow } from "@/lib/pipeline/types";

/**
 * POST: an admin admits an already-approved run into the cross-run Shared
 * Graph — tier 2 of the two-tier curation model. Body: { "adminName":
 * string, "tags"?: string[] }. Requires `approved` first: promotion is a
 * bigger claim (this is now a company-visible example) than approval (this
 * is worth keeping for myself), and the model only means anything if the
 * two are answered by two separate, deliberate acts. Tags are optional and
 * admin-declared, never inferred — GET /api/graph draws edges from them, so
 * a guessed tag would silently misconnect runs.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
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

  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    return NextResponse.json({ error: `No run found for run_id ${runId}.` }, { status: 404 });
  }
  if (!run.approved) {
    return NextResponse.json(
      { error: `Run ${runId} isn't approved yet — approve it before promoting it to the Shared Graph.` },
      { status: 400 },
    );
  }

  const tags = Array.isArray(body?.tags)
    ? body.tags.map((t: unknown) => String(t).trim()).filter(Boolean)
    : run.tags;

  const [updated] = await query<RunRow>(
    `UPDATE runs SET promoted = true, promoted_by = $2, promoted_at = NOW(), tags = $3
     WHERE run_id = $1 RETURNING *`,
    [runId, adminName, tags],
  );
  return NextResponse.json({ run: updated });
}
