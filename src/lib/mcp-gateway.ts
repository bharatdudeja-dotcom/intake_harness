import { listServers, listTools, callTool, readiness, type McpServerRow, type McpToolDescriptor } from "@/lib/mcp-servers";

/**
 * The gateway: an upstream MCP server's own tools, re-exposed through this
 * harness's own /api/mcp endpoint — ported from Agent Manager's
 * lib/mcp-gateway.js.
 *
 * Two upstreams could both expose something called `search`, so every
 * proxied tool is namespaced `<server_id>__<tool>` — the name says where
 * the call is going, and a native tool can never be shadowed by an
 * upstream's.
 *
 * A server is proxied only when its registry entry has `gateway: true`.
 * Discovery is a network call; putting one in the path of every single
 * tools/list buys latency and flakiness for a feature most servers don't
 * want, so it's opt-in per server and cached (TTL_MS) once discovered.
 *
 * An upstream that doesn't answer contributes no tools and reports why —
 * it never fails the whole tools/list. The one failure mode that matters
 * is reporting success while something below quietly didn't work, so a
 * missing upstream means missing tools, visibly (catalog()'s `servers`).
 */

export const TTL_MS = 60_000;

interface DiscoverResult {
  tools: McpToolDescriptor[];
  error: string | null;
}

const cache = new Map<string, { at: number; value: DiscoverResult }>();

function cacheKey(server: McpServerRow): string {
  return `${server.id}|${server.endpoint}|${server.instance || ""}`;
}

async function discover(server: McpServerRow, now = Date.now()): Promise<DiscoverResult> {
  const key = cacheKey(server);
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;

  let value: DiscoverResult;
  try {
    value = { tools: await listTools(server), error: null };
  } catch (e) {
    // Cached too, deliberately: a server that's down shouldn't be re-dialled
    // on every tools/list for the next minute.
    value = { tools: [], error: (e as Error).message };
  }
  cache.set(key, { at: now, value });
  return value;
}

/** Used after a Settings edit, so a change is visible at once. */
export function resetCache(): void {
  cache.clear();
}

/** `adobe-aec` + `search_adobe_knowledge` -> `adobe-aec__search_adobe_knowledge` */
export function proxyName(serverId: string, toolName: string): string {
  return `${serverId.replace(/[^a-zA-Z0-9_-]/g, "-")}__${toolName}`;
}

export function parseProxyName(name: string): { serverId: string; tool: string } | null {
  const at = String(name || "").indexOf("__");
  if (at <= 0) return null;
  return { serverId: name.slice(0, at), tool: name.slice(at + 2) };
}

async function gatewayServers(): Promise<McpServerRow[]> {
  const servers = await listServers();
  return servers.filter((s) => s.gateway && readiness(s).ready);
}

export interface CatalogTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
  tool: string;
}

export interface CatalogResult {
  tools: CatalogTool[];
  servers: { id: string; label: string; tool_count: number; error: string | null }[];
}

/** Every upstream tool, flattened and namespaced, with where each came from. */
export async function catalog(): Promise<CatalogResult> {
  const servers = await gatewayServers();
  const results = await Promise.all(
    servers.map(async (s) => {
      const { tools, error } = await discover(s);
      return { server: s, tools, error };
    }),
  );

  const tools: CatalogTool[] = [];
  for (const { server, tools: upstream } of results) {
    for (const t of upstream) {
      tools.push({
        name: proxyName(server.id, t.name),
        // The description says whose tool this is — a model choosing
        // between two similar tools from two vendors needs to know.
        description: `[via ${server.label || server.id}] ${t.description || t.name}`,
        inputSchema: t.inputSchema || { type: "object" },
        server: server.id,
        tool: t.name,
      });
    }
  }
  return {
    tools,
    servers: results.map((r) => ({ id: r.server.id, label: r.server.label || r.server.id, tool_count: r.tools.length, error: r.error })),
  };
}

/**
 * Resolve a BARE tool name to the server that actually has it. Ambiguity
 * is refused, never guessed — two servers exposing the same tool name is
 * exactly the case where picking one silently would send a write to the
 * wrong tenant.
 */
async function resolveBareName(name: string): Promise<{ serverId: string; tool: string }> {
  const servers = await gatewayServers();
  const hits: string[] = [];
  for (const s of servers) {
    const { tools } = await discover(s);
    if (tools.some((t) => t.name === name)) hits.push(s.id);
  }
  if (hits.length === 1) return { serverId: hits[0], tool: name };
  if (hits.length > 1) {
    throw new Error(`"${name}" is exposed by more than one server (${hits.join(", ")}). Call it by its namespaced name, e.g. ${proxyName(hits[0], name)}.`);
  }
  const near: string[] = [];
  for (const s of servers) {
    const { tools } = await discover(s);
    for (const t of tools) {
      if (t.name.includes(name) || name.includes(t.name.split("_")[0])) near.push(proxyName(s.id, t.name));
    }
  }
  throw new Error(`No gateway server exposes a tool called "${name}".` + (near.length ? ` Did you mean: ${near.slice(0, 5).join(", ")}?` : " Check tools/list for what is available."));
}

/**
 * Call a proxied tool, by namespaced or bare name. Errors are THROWN —
 * folding an upstream failure into a result that still looks successful
 * is the exact pattern that has kept parts of this pipeline looking
 * healthy while a downstream call quietly failed.
 */
export async function callProxied(name: string, args: Record<string, unknown>): Promise<unknown> {
  let parsed = parseProxyName(name);
  if (!parsed) parsed = await resolveBareName(name);
  const servers = await listServers();
  const server = servers.find((s) => s.id === parsed!.serverId);
  if (!server) throw new Error(`No MCP server registered with id '${parsed.serverId}'`);
  if (!server.gateway) throw new Error(`${parsed.serverId} is registered but not in the gateway`);
  return callTool(server, parsed.tool, args || {});
}
