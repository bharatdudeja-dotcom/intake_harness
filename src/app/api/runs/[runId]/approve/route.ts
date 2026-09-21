import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { isAdmin } from "@/lib/admins";
import type { RunRow } from "@/lib/pipeline/types";
import { apiError } from "@/lib/api-error";

/**
 * POST: an admin marks a completed run worth keeping — tier 1 of the
 * two-tier curation model (see db/schema.sql). Body: { "adminName": string,
 * "note"?: string }. Only a "completed" run can be approved — approving a
 * failed or paused run would just be recording an opinion about noise.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return apiError('Body must include "adminName".', "VALIDATION_ERROR", 400);
  }
  if (!isAdmin(adminName)) {
    return apiError(`"${adminName}" is not in ADMIN_NAMES.`, "FORBIDDEN", 403);
  }

  const [run] = await query<RunRow>(`SELECT * FROM runs WHERE run_id = $1`, [runId]);
  if (!run) {
    return apiError(`No run found for run_id ${runId}.`, "NOT_FOUND", 404);
  }
  if (run.status !== "completed") {
    return apiError(
      `Run ${runId} is "${run.status}", not "completed" — only a completed run can be approved.`,
      "VALIDATION_ERROR",
      400,
    );
  }

  const note = typeof body?.note === "string" ? body.note.trim() || null : null;
  const [updated] = await query<RunRow>(
    `UPDATE runs SET approved = true, approved_by = $2, approved_at = NOW(), approval_note = $3
     WHERE run_id = $1 RETURNING *`,
    [runId, adminName, note],
  );
  return NextResponse.json({ run: updated });
}
