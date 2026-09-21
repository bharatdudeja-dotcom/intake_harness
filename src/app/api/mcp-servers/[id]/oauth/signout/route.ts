import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admins";
import { clearOAuth, getServer, toSafe } from "@/lib/mcp-servers";
import { resetCache } from "@/lib/mcp-gateway";
import { apiError } from "@/lib/api-error";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const adminName = typeof body?.adminName === "string" ? body.adminName.trim() : "";
  if (!adminName || !isAdmin(adminName)) {
    return apiError(`"${adminName}" is not in ADMIN_NAMES.`, "FORBIDDEN", 403);
  }

  const server = await getServer(id);
  if (!server) return apiError(`No MCP server registered with id '${id}'.`, "NOT_FOUND", 404);

  const updated = await clearOAuth(id);
  resetCache();
  return NextResponse.json({ server: toSafe(updated) });
}
