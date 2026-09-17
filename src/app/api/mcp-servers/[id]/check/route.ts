import { NextResponse } from "next/server";
import { getServer, listTools } from "@/lib/mcp-servers";

/** POST: ask a registered server what it actually exposes — read-only, no admin gate needed. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const server = await getServer(id);
  if (!server) {
    return NextResponse.json({ error: `No MCP server registered with id '${id}'.` }, { status: 404 });
  }
  try {
    const tools = await listTools(server);
    return NextResponse.json({ tools });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
