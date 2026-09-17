import { query } from "@/lib/db";

/**
 * Editable settings, ported from Agent Manager's settings override (D48):
 * a retention window for unapproved Resources, plus a manual purge since
 * this app has no cron scheduler to run one automatically. Deliberately
 * does NOT cover `runs` — see db/schema.sql for why those are exempt.
 *
 * segmentation_labels/kind_labels/promote_admins are the rest of that
 * override, ported for parity: what things are CALLED, and who may
 * promote into the Shared Graph. Internal keys never change, only labels
 * — see db/schema.sql for the full rationale.
 */
export interface SettingsRow {
  id: number;
  retention_days: number;
  segmentation_labels: Record<string, string>;
  kind_labels: Record<string, string>;
  promote_admins: string[] | null;
  updated_at: string;
  updated_by: string | null;
}

export const DEFAULT_PROGRAMME_LABEL = "Programme";

/** This harness has one segmentation level (unlike Agent Manager's Project→Epic→Story) — "programme". */
export function programmeLabel(settings: Pick<SettingsRow, "segmentation_labels">): string {
  return settings.segmentation_labels?.programme?.trim() || DEFAULT_PROGRAMME_LABEL;
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

export async function updateSegmentationLabel(label: string, adminName: string): Promise<SettingsRow> {
  const [row] = await query<SettingsRow>(
    `UPDATE settings
     SET segmentation_labels = jsonb_set(segmentation_labels, '{programme}', to_jsonb($1::text), true),
         updated_at = NOW(), updated_by = $2
     WHERE id = 1 RETURNING *`,
    [label, adminName],
  );
  return row;
}

export async function updateKindLabels(labels: Record<string, string>, adminName: string): Promise<SettingsRow> {
  const [row] = await query<SettingsRow>(
    `UPDATE settings SET kind_labels = $1::jsonb, updated_at = NOW(), updated_by = $2 WHERE id = 1 RETURNING *`,
    [JSON.stringify(labels), adminName],
  );
  return row;
}

/** Empty roster means "any admin may promote" — today's behavior — so clearing it is a safe reset, never a lockout. */
export async function updatePromoteAdmins(names: string[], adminName: string): Promise<SettingsRow> {
  const [row] = await query<SettingsRow>(
    `UPDATE settings SET promote_admins = $1, updated_at = NOW(), updated_by = $2 WHERE id = 1 RETURNING *`,
    [names.length ? names : null, adminName],
  );
  return row;
}

/** Whether `name` may promote a run/resource into the Shared Graph — the "Hero Agents" roster gate. */
export async function canPromote(name: string): Promise<boolean> {
  const settings = await getSettings();
  if (!settings.promote_admins || settings.promote_admins.length === 0) return true;
  return settings.promote_admins.includes(name);
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
