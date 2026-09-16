import { NextRequest, NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";

/**
 * Agent 1 — Intake (owned by Dev 1).
 *
 * From the requirements doc (B1 / step 1.2a): builds a campaign intake from
 * the marketer's prompt, grounded in AEP schemas and the FAC view, rather
 * than bouncing the whole brief back on any gap. Loop count against the
 * marketer is the health metric — more than two rounds means the agent
 * failed, not the marketer.
 *
 * STUB: proves the MCP wiring (a real semantic search call against the
 * `adobe` knowledge namespace in the chaunceyplum/mcp Lambda) and returns a
 * pass-through intake shape. Replace the body of this handler with the real
 * intake logic; keep the request/response contract in lib/pipeline/types.ts
 * unchanged so the orchestrator and Agent 2 don't need to change.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<{ brief: string }>;

  let groundingHits: unknown = null;
  try {
    groundingHits = await callMcpTool("intake", "search_adobe_knowledge", {
      query: body.input.brief,
      agent: "adobe",
      top_k: 3,
    });
  } catch (err) {
    // Non-fatal for the stub — a real implementation would decide whether a
    // grounding failure means "ask the marketer" (needs_input) or a hard fail.
    groundingHits = { error: (err as Error).message };
  }

  const response: AgentResponse = {
    status: "completed",
    output: {
      brief: body.input.brief,
      // TODO(dev-1): replace with the parsed intake (audience intent,
      // required XDM fields, FAC-vs-AEP-native flag) instead of raw hits.
      groundingHits,
    },
    metadata: { loopCount: 0 },
  };

  return NextResponse.json(response);
}
