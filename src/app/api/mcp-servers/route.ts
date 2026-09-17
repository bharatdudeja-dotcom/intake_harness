import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admins";
import { listServersSafe, toSafe, upsertServer } from "@/lib/mcp-servers";
import { resetCache } from "@/lib/mcp-gateway";

/** GET: every registered MCP server (safe projection — no secrets). POST: register or edit one. */
export async function GET() {
  try {
    return NextResponse.json({ servers: await listServersSafe() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName) {
    return NextResponse.json({ error: 'Body must include "adminName".' }, { status: 400 });
  }
  if (!isAdmin(adminName)) {
    return NextResponse.json({ error: `"${adminName}" is not in ADMIN_NAMES.` }, { status: 403 });
  }

  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const label = typeof body?.label === "string" ? body.label.trim() : "";
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    return NextResponse.json({ error: '"id" must be a non-empty slug (letters, digits, - or _).' }, { status: 400 });
  }
  if (!label) {
    return NextResponse.json({ error: '"label" must be non-empty.' }, { status: 400 });
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
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
