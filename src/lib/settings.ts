import { query } from "@/lib/db";

/**
 * Editable settings, ported from Agent Manager's settings override (D48):
 * a retention window for unapproved Resources, plus a manual purge since
 * this app has no cron scheduler to run one automatically. Deliberately
 * does NOT cover `runs` — see db/schema.sql for why those are exempt.
 */
export interface SettingsRow {
  id: number;
  retention_days: number;
  updated_at: string;
  updated_by: string | null;
}

export async function getSettings(): Promise<SettingsRow> {
  const [row] = await query<SettingsRow>(`SELECT * FROM settings WHERE id = 1`);
  return row;
}

export async function updateRetentionDays(retentionDays: number, adminName: string): Promise<SettingsRow> {
  const [row] = await query<SettingsRow>(
    `UPDATE settings SET retention_days = $1, updated_at = NOW(), updated_by = $2 WHERE id = 1 RETURNING *`,
    [retentionDays, adminName],
  );
  return row;
}

/** How many unapproved resources are currently older than the retention window — the purge preview. */
export async function countPurgeable(): Promise<number> {
  const [row] = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM resources, settings
     WHERE settings.id = 1 AND resources.approved = false
       AND resources.created_at < NOW() - (settings.retention_days || ' days')::interval`,
  );
  return row.count;
}

/**
 * Delete every unapproved resource older than the retention window.
 * Never touches an approved (let alone promoted) resource — an admin
 * choosing to keep something overrides the clock entirely, same as
 * Agent Manager's own "approved" bar for aging out of the Test Kitchen.
 */
export async function purgeExpiredResources(): Promise<{ deleted: number }> {
  const rows = await query<{ resource_id: string }>(
    `DELETE FROM resources
     WHERE approved = false
       AND created_at < NOW() - (SELECT retention_days FROM settings WHERE id = 1) * INTERVAL '1 day'
     RETURNING resource_id`,
  );
  return { deleted: rows.length };
}
