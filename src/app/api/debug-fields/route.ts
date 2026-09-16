import { NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";

/** Temporary: what does insights_search_fields actually return through the gateway? */
export async function GET() {
  try {
    const r = await callMcpTool<unknown>("intake", "insights_search_fields", {
      entity_ids: ["project"],
      query: "campaign",
    });
    return NextResponse.json({ ok: true, type: typeof r, isArray: Array.isArray(r), sample: r });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message });
  }
}
