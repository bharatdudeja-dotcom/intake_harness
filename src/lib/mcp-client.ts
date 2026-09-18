/**
 * Thin JSON-RPC 2.0 client for the MCP Lambdas deployed from chaunceyplum/mcp.
 * Every agent route here should go through this instead of talking to
 * Postgres, Adobe, Workfront, Databricks, or Snowflake directly — those
 * Lambdas already own auth (Adobe IMS, Workfront IMS, SSM-resolved
 * credentials) and the RAG/pgvector layer.
 *
 * That repo is actually MULTIPLE Lambdas behind one API Gateway
 * (template.yaml — they all share one implicit HttpApi, just different
 * routes):
 *   /mcp                       — the original AEC server: 238 Adobe/AWS/
 *                                 Databricks/Snowflake/GitHub tools, no
 *                                 shared name prefix.
 *   /mcp/workfront/core        — wf_core_*        (portfolios, programs,
 *                                 templates, projects, tasks, issues)
 *   /mcp/workfront/users       — wf_users_*        (companies, roles, users,
 *                                 teams, resource pools, allocations)
 *   /mcp/workfront/documents   — wf_docs_*         (folders, documents,
 *                                 versions, approvals, webhooks)
 *   /mcp/workfront/time-approval — wf_time_*       (approval paths,
 *                                 timesheets, hour entries, approvals)
 *   /mcp/workfront/metadata    — wf_metadata_*     (custom fields/forms)
 *   /mcp/workfront/search      — wf_search_*       (object/generic search,
 *                                 named queries, saved reports)
 *   /mcp/workfront/comments    — wf_comments_*     (comments, replies,
 *                                 reactions)
 *   /mcp/workfront/planning    — wf_planning_*     (Planning workspaces,
 *                                 record types, fields, views, records)
 *   /mcp/workfront/misc        — wf_misc_*         (notes, messages, report
 *                                 defs, calendars, prefs, config, journal)
 *   /mcp/fusion/org            — fusion_org_*      (organizations, teams,
 *                                 Fusion users)
 *   /mcp/fusion/connections    — fusion_conn_*     (app connections)
 *   /mcp/fusion/hooks          — fusion_hook_*     (webhooks/triggers)
 *   /mcp/fusion/scenarios      — fusion_scenario_* (scenario CRUD/execute)
 *   /mcp/fusion/executions     — fusion_exec_*     (execution history/logs)
 *
 * resolveMcpPath() below picks the right route from the tool name's prefix,
 * so callers just pass a tool name — they never need to know or care which
 * of the 15 Lambdas actually serves it.
 *
 * Endpoint contract (same for all 15):
 *   POST {route}   body: { jsonrpc: "2.0", method, params, id }
 *   methods: "initialize" | "tools/list" | "tools/call"
 *   tools/call params: { name: <tool name>, arguments: <object> }
 *
 * All tool arguments are sent as JSON-serializable values; the Lambda side
 * auto-parses JSON-encoded strings back into dict/list for legacy MCP
 * clients, but plain objects/arrays work directly.
 *
 * Least privilege: callMcpTool requires the caller's taskId and checks it
 * against that task's `allowedTools` in src/lib/pipeline/registry.ts before
 * the request ever leaves this process. None of these Lambdas has any
 * concept of "which agent is calling" — this is the only enforcement point,
 * so every agent route MUST call through here rather than hitting an MCP
 * route directly.
 */

import { ALL_TASKS } from "./pipeline/registry";
import type { TaskId } from "./pipeline/types";

const MCP_SERVER_ROUTES: Array<{ prefix: string; path: string }> = [
  { prefix: "wf_core_", path: "/mcp/workfront/core" },
  { prefix: "wf_users_", path: "/mcp/workfront/users" },
  { prefix: "wf_docs_", path: "/mcp/workfront/documents" },
  { prefix: "wf_time_", path: "/mcp/workfront/time-approval" },
  { prefix: "wf_metadata_", path: "/mcp/workfront/metadata" },
  { prefix: "wf_search_", path: "/mcp/workfront/search" },
  { prefix: "wf_comments_", path: "/mcp/workfront/comments" },
  { prefix: "wf_planning_", path: "/mcp/workfront/planning" },
  { prefix: "wf_misc_", path: "/mcp/workfront/misc" },
  { prefix: "fusion_org_", path: "/mcp/fusion/org" },
  { prefix: "fusion_conn_", path: "/mcp/fusion/connections" },
  { prefix: "fusion_hook_", path: "/mcp/fusion/hooks" },
  { prefix: "fusion_scenario_", path: "/mcp/fusion/scenarios" },
  { prefix: "fusion_exec_", path: "/mcp/fusion/executions" },
];

/** Everything without a wf_ or fusion_ prefix is one of the original 238 AEC tools. */
function resolveMcpPath(toolName: string): string {
  return MCP_SERVER_ROUTES.find((r) => toolName.startsWith(r.prefix))?.path ?? "/mcp";
}

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

/**
 * All 15 Lambdas share one API Gateway (template.yaml's implicit
 * ServerlessHttpApi), so the base domain is derived from MCP_ENDPOINT_URL
 * (the original .../mcp AEC endpoint) by stripping its trailing /mcp —
 * no separate env var needed per Workfront/Fusion server.
 */
/**
 * A gateway, if one is configured.
 *
 * MCP_GATEWAY_URL points at something that fronts an estate of MCP servers -
 * CX Agent Manager's /mcp, in our deployment. It resolves a bare tool name to
 * whichever registered server actually exposes it, so this client needs no
 * route map and no per-server URL, and the choice of backing server becomes
 * configuration in one place instead of an env var in this app.
 *
 * MCP_GATEWAY_TOKEN is sent as a bearer token when present. It is the gateway's
 * credential, NOT the upstream's: the gateway holds the Adobe tokens, and this
 * app never sees them.
 */
function getGatewayUrl(): string | null {
  const url = process.env.MCP_GATEWAY_URL;
  return url && url.trim() ? url.trim().replace(/\/+$/, "") : null;
}

/**
 * Which gateway-registered server a tool lives on.
 *
 * The gateway namespaces every tool it re-exposes by its source server -
 * `adobe-aec__search_adobe_knowledge` - so two upstreams shipping the same tool
 * name cannot shadow each other, and nothing upstream can shadow one of the
 * gateway's own tools.
 *
 * THIS WAS A SINGLE GLOBAL PREFIX AND THAT WAS WRONG. One prefix assumes the
 * whole estate is one server. It is not: knowledge search is on the Adobe
 * Experience Cloud server and Workfront objects are on the Workfront connector,
 * so prefixing everything with `adobe-aec` produced
 * `adobe-aec__workflow_create_any_object`, which does not exist - and Agent 1's
 * Workfront create failed on it while the run still read as completed.
 *
 * MCP_GATEWAY_ROUTES maps server id to the tool-name prefixes it serves:
 *
 *   adobe-aec:adobe_,search_;workfront-adobe:workflow_,comment-stream_,approvals_
 *
 * MCP_GATEWAY_PREFIX remains the fallback for anything unmatched. Both unset,
 * names go through untouched - which is right for a gateway that resolves bare
 * names itself.
 *
 * Note what is NOT here: any endpoint, credential, or decision about which real
 * MCP backs a server id. That is the gateway's business, which is the point of
 * pointing at one.
 */
function gatewayRoutes(): Array<{ server: string; prefixes: string[] }> {
  const raw = String(process.env.MCP_GATEWAY_ROUTES || "").trim();
  if (!raw) return [];
  return raw
    .split(";")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => {
      const [server, list] = group.split(":");
      return {
        server: (server || "").trim(),
        prefixes: String(list || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
    })
    .filter((r) => r.server && r.prefixes.length);
}

function applyGatewayPrefix(toolName: string): string {
  if (!getGatewayUrl()) return toolName;
  if (toolName.includes("__")) return toolName; // already namespaced

  // Longest prefix wins, so a specific rule beats a general one.
  const matches = gatewayRoutes()
    .flatMap((r) => r.prefixes.map((prefix) => ({ server: r.server, prefix })))
    .filter((m) => toolName.startsWith(m.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  if (matches.length) return `${matches[0].server}__${toolName}`;

  const fallback = String(process.env.MCP_GATEWAY_PREFIX || "").trim();
  return fallback ? `${fallback}__${toolName}` : toolName;
}

function getApiBase(): string {
  const url = process.env.MCP_ENDPOINT_URL;
  if (!url) {
    throw new McpError(
      "MCP_ENDPOINT_URL is not set. Copy .env.local.example to .env.local " +
        "and paste in the McpEndpointUrl SAM output from the chaunceyplum/mcp deployment.",
    );
  }
  return url.replace(/\/mcp\/?$/, "");
}

function getEndpointForTool(toolName: string): string {
  // One endpoint for everything when a gateway is configured. The prefix-to-path
  // map below describes ONE deployment's topology; a gateway's whole job is that
  // its callers do not need to know any topology.
  const gateway = getGatewayUrl();
  if (gateway) return gateway;
  return `${getApiBase()}${resolveMcpPath(toolName)}`;
}

/**
 * Headers for an MCP call. A bare estate needs none; a gateway usually does.
 *
 * MCP_GATEWAY_HEADER names the header, because gateways genuinely differ:
 * Authorization/Bearer is the common case, but a service-to-service key is
 * often its own header - CX Agent Manager takes `x-api-key`. Defaulting to
 * Authorization and offering no way to change it meant the only credential the
 * gateway accepted could not be sent, and every call came back 401.
 */
function mcpHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = process.env.MCP_GATEWAY_TOKEN;
  if (!getGatewayUrl() || !token || !token.trim()) return headers;

  const name = (process.env.MCP_GATEWAY_HEADER || "Authorization").trim();
  headers[name] = name.toLowerCase() === "authorization" && !token.startsWith("Bearer ")
    ? `Bearer ${token}`
    : token;
  return headers;
}

let requestCounter = 0;

function assertToolAllowed(taskId: TaskId, name: string): void {
  const agent = ALL_TASKS.find((a) => a.name === taskId);
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
/**
 * The same arguments, with numbers as strings.
 *
 * Several tools on both connectors declare numeric arguments as strings -
 * `limit`, `max_rows`, `sample_records` - and refuse a number outright:
 *
 *     "code": "invalid_type", "expected": "string", "received": "number"
 *
 * That is not a fault we can fix upstream, and it has cost us a comment-stream
 * read inside a stage that then reported success. Retrying with strings is
 * cheap and only happens on the calls that need it.
 */
function stringifyNumbers(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === "number" ? String(v) : v;
  }
  return out;
}

/** Was this refused for sending a number where a string was declared? */
function wantsStringArgs(message: string): boolean {
  return /invalid_type/i.test(message) &&
    /expected"?\s*:?\s*"?string/i.test(message) &&
    /received"?\s*:?\s*"?number/i.test(message);
}

/**
 * Call a tool, and retry once with string arguments if that is what it wanted.
 *
 * Several tools on both connectors declare numeric arguments as strings and
 * refuse a number outright. A stage that hits one reports "a tooling error"
 * that nobody can act on - it cost us the comment-stream read on the NY run,
 * inside a stage that then reported success.
 */
export async function callMcpTool<T = unknown>(
  taskId: TaskId,
  name: string,
  args: Record<string, unknown> = {},
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await callMcpToolOnce<T>(taskId, name, args, opts);
  } catch (err) {
    const message = (err as Error).message || "";
    const hasNumbers = Object.values(args).some((v) => typeof v === "number");
    if (!hasNumbers || !wantsStringArgs(message)) throw err;
    // The contract is ambiguous, not broken. One retry, and if it fails again
    // the original error stands.
    return await callMcpToolOnce<T>(taskId, name, stringifyNumbers(args), opts);
  }
}

async function callMcpToolOnce<T = unknown>(
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
    res = await fetch(getEndpointForTool(name), {
      method: "POST",
      headers: mcpHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestCounter,
        method: "tools/call",
        // The prefixed name goes on the wire. assertToolAllowed above has
        // already run against the BARE name: the allowlist is a statement about
        // what this agent is permitted to do, and must not change meaning
        // because of how the call happens to be routed.
        params: { name: applyGatewayPrefix(name), arguments: args },
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
