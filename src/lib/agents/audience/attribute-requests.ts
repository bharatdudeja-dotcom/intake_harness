/**
 * The durable home for an open GTO / attribute request (B4/B7).
 *
 * REPLACES a request that lived only on the run's own output with an
 * `ageSeconds` counter incremented by 1 per pass. That counter measured
 * "how many times did this run advance", not elapsed time, and the whole
 * request evaporated when the run ended. A real GTO attribute request can
 * run for a quarter and B7's complaint is precisely that its age goes
 * unseen - so the age has to be wall-clock, and the record has to outlive
 * the run's in-memory output. This persists it in Postgres
 * (db/schema.sql's attribute_requests) and computes age as NOW() -
 * opened_at at read time.
 *
 * The identity of a request is (run_id, attribute_signature): the same run
 * still missing the same set of attributes is the SAME request being
 * re-evaluated, so its age keeps accruing rather than resetting. A later
 * probe finding the attributes present resolves it - the automatic 2.7
 * re-evaluation, now driven off durable state instead of a value the run
 * happened to still be carrying.
 */

import { query } from "@/lib/db";

export type AttributeRequestStatus = "open" | "resolved";

export type AttributeRequestRow = {
  request_id: string;
  run_id: string;
  attribute_signature: string;
  missing_attributes: string[];
  status: AttributeRequestStatus;
  opened_at: string;
  resolved_at: string | null;
  updated_at: string;
};

/** A stable fingerprint of the missing attribute set - order-independent. */
export function attributeSignature(missing: string[]): string {
  return [...new Set(missing.map((m) => m.trim().toLowerCase()).filter(Boolean))].sort().join("|");
}

/** Wall-clock age of a request in seconds, from opened_at to now (or to resolved_at once resolved). */
export function ageSecondsOf(row: Pick<AttributeRequestRow, "opened_at" | "resolved_at">): number {
  const end = row.resolved_at ? new Date(row.resolved_at).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(row.opened_at).getTime()) / 1000));
}

/** The current open request for this run, if any. */
export async function findOpenRequest(runId: string): Promise<AttributeRequestRow | null> {
  const rows = await query<AttributeRequestRow>(
    `SELECT * FROM attribute_requests WHERE run_id = $1 AND status = 'open' ORDER BY opened_at LIMIT 1`,
    [runId],
  );
  return rows[0] ?? null;
}

/**
 * Open a request for this run's missing attributes, or return the existing
 * one unchanged if the same run already has one open for the same set - so
 * re-evaluating the same ask does NOT reset the clock or duplicate the row.
 * opened_at (and therefore age) is preserved across passes and restarts.
 */
export async function openOrGetRequest(runId: string, missing: string[]): Promise<AttributeRequestRow> {
  const signature = attributeSignature(missing);
  const requestId = `ATTR-${Date.now().toString(36).toUpperCase()}`;
  const rows = await query<AttributeRequestRow>(
    `INSERT INTO attribute_requests (request_id, run_id, attribute_signature, missing_attributes, status)
     VALUES ($1, $2, $3, $4, 'open')
     ON CONFLICT (run_id, attribute_signature) DO UPDATE
       SET missing_attributes = EXCLUDED.missing_attributes, updated_at = NOW()
     RETURNING *`,
    [requestId, runId, signature, missing],
  );
  return rows[0];
}

/**
 * Mark this run's open request resolved - the automatic 2.7 re-evaluation
 * when a later probe finds the attributes present. Returns the resolved row
 * (with resolved_at set) or null if there was nothing open to resolve.
 */
export async function resolveOpenRequest(runId: string): Promise<AttributeRequestRow | null> {
  const rows = await query<AttributeRequestRow>(
    `UPDATE attribute_requests
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
     WHERE run_id = $1 AND status = 'open'
     RETURNING *`,
    [runId],
  );
  return rows[0] ?? null;
}

/**
 * Every currently-open request across all runs, oldest first - the
 * cross-run "what's been waiting, and for how long" view B7 asks for.
 * Age is computed here rather than stored.
 */
export async function listOpenRequests(): Promise<Array<AttributeRequestRow & { ageSeconds: number }>> {
  const rows = await query<AttributeRequestRow>(
    `SELECT * FROM attribute_requests WHERE status = 'open' ORDER BY opened_at ASC`,
  );
  return rows.map((r) => ({ ...r, ageSeconds: ageSecondsOf(r) }));
}
