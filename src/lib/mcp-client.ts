/**
 * Thin JSON-RPC 2.0 client for the deployed AEC MCP Lambda that lives in the
 * chaunceyplum/mcp repo (see mcp_server/lambda_handler.py there). Every agent
 * route here should go through this instead of talking to Postgres, Adobe,
 * Databricks, or Snowflake directly — that Lambda already owns auth (Adobe
 * IMS, SSM-resolved credentials) and the RAG/pgvector layer.
 *
 * Endpoint contract:
 *   POST {MCP_ENDPOINT_URL}   body: { jsonrpc: "2.0", method, params, id }
 *   methods: "initialize" | "tools/list" | "tools/call"
 *   tools/call params: { name: <tool name>, arguments: <object> }
 *
 * All tool arguments are sent as JSON-serializable values; the Lambda side
 * auto-parses JSON-encoded strings back into dict/list for legacy MCP
 * clients, but plain objects/arrays work directly.
 *
 * Least privilege: callMcpTool requires the caller's taskId and checks it
 * against that task's `allowedTools` in src/lib/pipeline/registry.ts before
 * the request ever leaves this process. The MCP Lambda itself has no
 * concept of "which agent is calling" — this is the only enforcement point,
 * so every agent route MUST call through here rather than hitting
 * MCP_ENDPOINT_URL directly.
 */

import { PIPELINE } from "./pipeline/registry";
import type { TaskId } from "./pipeline/types";

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function getEndpoint(): string {
  const url = process.env.MCP_ENDPOINT_URL;
  if (!url) {
    throw new McpError(
      "MCP_ENDPOINT_URL is not set. Copy .env.local.example to .env.local " +
        "and paste in the McpEndpointUrl SAM output from the chaunceyplum/mcp deployment.",
    );
  }
  return url;
}

let requestCounter = 0;

function assertToolAllowed(taskId: TaskId, name: string): void {
  const agent = PIPELINE.find((a) => a.name === taskId);
  if (!agent) {
    throw new McpError(`callMcpTool: unknown taskId "${taskId}" — not in the pipeline registry.`);
  }
  if (!agent.allowedTools.includes(name)) {
    throw new McpError(
      `Task "${taskId}" is not allowed to call MCP tool "${name}". ` +
        `If this is intentional, add "${name}" to allowedTools for "${taskId}" ` +
        `in src/lib/pipeline/registry.ts.`,
    );
  }
}

/**
 * Call a single MCP tool by name and return its parsed result, scoped to
 * the calling task's allowlist (see assertToolAllowed above).
 *
 * Throws McpError on a scoping violation, transport failure, JSON-RPC
 * error, or a tool-level error (isError: true in the MCP content envelope).
 */
export async function callMcpTool<T = unknown>(
  taskId: TaskId,
  name: string,
  args: Record<string, unknown> = {},
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<T> {
  assertToolAllowed(taskId, name);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(getEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestCounter,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new McpError(
      `MCP request to tool "${name}" failed: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new McpError(
      `MCP endpoint returned HTTP ${res.status} for tool "${name}"`,
      res.status,
    );
  }

  const body = (await res.json()) as JsonRpcResponse<ToolCallResult>;

  if (body.error) {
    throw new McpError(
      `MCP tool "${name}" failed: ${body.error.message}`,
      body.error.code,
      body.error.data,
    );
  }

  const result = body.result;
  if (result?.isError) {
    const text = result.content?.map((c) => c.text).join("\n") ?? "unknown error";
    throw new McpError(`MCP tool "${name}" returned an error: ${text}`);
  }

  // Tool results come back as MCP content blocks; unwrap the common case of a
  // single JSON text block so callers get native objects, not strings.
  const firstText = result?.content?.[0]?.text;
  if (firstText !== undefined) {
    try {
      return JSON.parse(firstText) as T;
    } catch {
      return firstText as unknown as T;
    }
  }
  return result as unknown as T;
}
