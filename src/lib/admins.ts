/**
 * The minimal viable version of "a named human decides." No login, no
 * sessions — just a configured allowlist of names an approve/promote call
 * must match, so `approved_by`/`promoted_by` can never be arbitrary free
 * text. Real identity (SSO/OIDC) is a separate, later step; this exists so
 * that step isn't a prerequisite for the two-tier approval model itself.
 */
function parseAdminNames(raw: string | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function listAdmins(): string[] {
  return parseAdminNames(process.env.ADMIN_NAMES);
}

export function isAdmin(name: string): boolean {
  return listAdmins().includes(name);
}
