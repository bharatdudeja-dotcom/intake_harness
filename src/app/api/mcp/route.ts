import { NextRequest, NextResponse } from "next/server";
import { callProxied, catalog } from "@/lib/mcp-gateway";

/**
 * This harness's own MCP server — the gateway surface. A client (Claude,
 * or any other MCP client) points at this endpoint and sees the union of
 * every registered server's tools that has `gateway: true`, namespaced
 * `<server_id>__<tool>` (see mcp-gateway.ts). Stateless JSON-RPC over
 * HTTP, one request in, one response out — no session negotiation, same
 * shape as the chaunceyplum/mcp Lambdas this repo already calls as a
 * client (src/lib/mcp-client.ts), just the server side of that contract.
 */

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: number | string | null | undefined, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function POST(req: NextRequest) {
  const body: JsonRpcRequest | null = await req.json().catch(() => null);
  if (!body || typeof body.method !== "string") {
    return rpcError(body?.id, -32600, "Invalid Request: expected a JSON-RPC 2.0 envelope with a string method.");
  }

  switch (body.method) {
    case "initialize":
      return rpcResult(body.id, {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "agentic-harness-gateway", version: "1.0.0" },
        capabilities: { tools: {} },
      });

    case "tools/list": {
      const { tools } = await catalog();
      return rpcResult(
        body.id,
        {
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      );
    }

    case "tools/call": {
      const name = body.params?.name;
      if (!name) return rpcError(body.id, -32602, "Invalid params: \"name\" is required.");
      try {
        const result = await callProxied(name, body.params?.arguments || {});
        return rpcResult(body.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      } catch (err) {
        // A tool failure is reported IN the result (isError), matching the
        // MCP convention that lets a client show the model what went wrong
        // rather than dropping the whole request — never silently folded
        // into a result that looks successful.
        return rpcResult(body.id, { isError: true, content: [{ type: "text", text: (err as Error).message }] });
      }
    }

    default:
      return rpcError(body.id, -32601, `Method not found: "${body.method}".`);
  }
}
