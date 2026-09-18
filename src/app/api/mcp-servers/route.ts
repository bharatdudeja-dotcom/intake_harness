import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admins";
import { listServersSafe, toSafe, upsertServer } from "@/lib/mcp-servers";
import { resetCache } from "@/lib/mcp-gateway";
import { apiError } from "@/lib/api-error";

/** GET: every registered MCP server (safe projection — no secrets). POST: register or edit one. */
export async function GET() {
  try {
    return NextResponse.json({ servers: await listServersSafe() });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return apiError('Body must include "adminName".', "VALIDATION_ERROR", 400);
  }
  if (!isAdmin(adminName)) {
    return apiError(`"${adminName}" is not in ADMIN_NAMES.`, "FORBIDDEN", 403);
  }

  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return apiError('"id" must be a non-empty slug (letters, digits, - or _).', "VALIDATION_ERROR", 400);
  }
  if (!label) {
    return apiError('"label" must be non-empty.', "VALIDATION_ERROR", 400);
  }

  try {
    const server = await upsertServer({
      id,
      label,
      practice: typeof body?.practice === "string" ? body.practice.trim() || null : null,
      endpoint,
      instance: typeof body?.instance === "string" ? body.instance.trim() || null : null,
      // Blank means "keep whatever is stored" — never round-tripped from the browser.
      auth: typeof body?.auth === "string" && body.auth.trim() ? body.auth.trim() : null,
      active: !!body?.active,
      gateway: !!body?.gateway,
    });
    resetCache();
    return NextResponse.json({ server: toSafe(server) });
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
