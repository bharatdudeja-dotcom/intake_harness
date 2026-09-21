import { NextResponse } from "next/server";
import { getServer, listTools } from "@/lib/mcp-servers";
import { apiError } from "@/lib/api-error";

/** POST: ask a registered server what it actually exposes — read-only, no admin gate needed. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = await getServer(id);
  if (!server) {
    return apiError(`No MCP server registered with id '${id}'.`, "NOT_FOUND", 404);
  }
  try {
    const tools = await listTools(server);
    return NextResponse.json({ tools });
  } catch (err) {
    return apiError((err as Error).message, "UPSTREAM_ERROR", 502);
  }
}
