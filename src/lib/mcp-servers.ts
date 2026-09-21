import { query } from "@/lib/db";
import { refresh as oauthRefresh, type AuthorizationServerMetadata } from "@/lib/mcp-oauth";
import type { McpServerSafe } from "@/lib/mcp-servers-types";

export * from "@/lib/mcp-servers-types";

/**
 * The MCP server registry, ported from Agent Manager's lib/mcp-servers.js
 * — same rule as everywhere else in this file's ancestry: a server named
 * in source outside this module is a mistake. DB-backed instead of a
 * config file + settings override, since this harness's "settings" is
 * already a real database row, not a file plus a JSON blob.
 */
export interface McpServerRow {
  id: string;
  label: string;
  practice: string | null;
  endpoint: string;
  instance: string | null;
  auth: string | null;
  active: boolean;
  gateway: boolean;
  oauth_client_id: string | null;
  oauth_access_token: string | null;
  oauth_refresh_token: string | null;
  oauth_expires_at: string | null;
  oauth_connected_at: string | null;
  oauth_resource: string | null;
  oauth_as_metadata: AuthorizationServerMetadata | null;
  created_at: string;
  updated_at: string;
}

export async function listServers(): Promise<McpServerRow[]> {
  return query<McpServerRow>(`SELECT * FROM mcp_servers ORDER BY id`);
}

export async function getServer(id: string): Promise<McpServerRow | null> {
  const [row] = await query<McpServerRow>(`SELECT * FROM mcp_servers WHERE id = $1`, [id]);
  return row ?? null;
}

/** Resolve `${ENV_VAR}` against the environment; a literal value passes through unchanged. */
function resolveEnvRef(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
  if (!match) return value;
  return process.env[match[1]] || null;
}

export function authSource(server: McpServerRow): McpServerSafe["auth_source"] {
  if (server.oauth_connected_at) return "oauth";
  if (typeof server.auth === "string" && server.auth.startsWith("${")) return "env";
  if (server.auth) return "inline";
  return null;
}

/** Public projection: never returns a resolved secret or token, only whether one is set. */
export function toSafe(server: McpServerRow): McpServerSafe {
  return {
    id: server.id,
    label: server.label || server.id,
    practice: server.practice,
    endpoint: server.endpoint || "",
    instance: server.instance,
    active: server.active,
    gateway: server.gateway,
    auth_configured: !!(resolveEnvRef(server.auth) || server.oauth_access_token),
    auth_source: authSource(server),
    oauth_connected: !!server.oauth_connected_at,
    oauth_connected_at: server.oauth_connected_at,
    oauth_expires_at: server.oauth_expires_at,
  };
}

export async function listServersSafe(): Promise<McpServerSafe[]> {
  return (await listServers()).map(toSafe);
}

/**
 * Create or update a server entry. `auth` is only overwritten when a
 * non-empty value is given — the Settings form's password field sends
 * nothing to mean "keep what is stored" (never round-trips the secret to
 * the browser to be sent back).
 */
export async function upsertServer(fields: {
  id: string;
  label: string;
  practice?: string | null;
  endpoint: string;
  instance?: string | null;
  auth?: string | null;
  active: boolean;
  gateway: boolean;
}): Promise<McpServerRow> {
  const [row] = await query<McpServerRow>(
    `INSERT INTO mcp_servers (id, label, practice, endpoint, instance, auth, active, gateway, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (id) DO UPDATE SET
       label = EXCLUDED.label,
       practice = EXCLUDED.practice,
       endpoint = EXCLUDED.endpoint,
       instance = EXCLUDED.instance,
       auth = COALESCE(EXCLUDED.auth, mcp_servers.auth),
       active = EXCLUDED.active,
       gateway = EXCLUDED.gateway,
       updated_at = NOW()
     RETURNING *`,
    [fields.id, fields.label, fields.practice ?? null, fields.endpoint, fields.instance ?? null, fields.auth || null, fields.active, fields.gateway],
  );
  return row;
}

export async function storeOAuthToken(
  serverId: string,
  token: { access_token: string; refresh_token?: string; expires_in?: number },
  extra: { client_id: string; as: AuthorizationServerMetadata; resource: string },
): Promise<McpServerRow> {
  const expiresAt = token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null;
  const [row] = await query<McpServerRow>(
    `UPDATE mcp_servers SET
       auth = NULL,
       active = true,
       oauth_client_id = $2,
       oauth_access_token = $3,
       oauth_refresh_token = COALESCE($4, oauth_refresh_token),
       oauth_expires_at = $5,
       oauth_connected_at = NOW(),
       oauth_resource = $6,
       oauth_as_metadata = $7::jsonb,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [serverId, extra.client_id, token.access_token, token.refresh_token ?? null, expiresAt, extra.resource, JSON.stringify(extra.as)],
  );
  return row;
}

export async function clearOAuth(serverId: string): Promise<McpServerRow> {
  const [row] = await query<McpServerRow>(
    `UPDATE mcp_servers SET
       oauth_client_id = NULL, oauth_access_token = NULL, oauth_refresh_token = NULL,
       oauth_expires_at = NULL, oauth_connected_at = NULL, oauth_resource = NULL, oauth_as_metadata = NULL,
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [serverId],
  );
  return row;
}

/** Is this server usable right now? */
export function readiness(server: McpServerRow | null): { ready: boolean; reason: string | null } {
  if (!server) return { ready: false, reason: "not registered" };
  if (!server.active) return { ready: false, reason: "registered but not active" };
  if (!server.endpoint) return { ready: false, reason: "no endpoint set" };
  if (typeof server.auth === "string" && server.auth.startsWith("${") && !resolveEnvRef(server.auth) && !server.oauth_access_token) {
    return { ready: false, reason: `${server.auth} is not set in the environment` };
  }
  return { ready: true, reason: null };
}

/** Refresh an expired OAuth token in place, if we can. Silent no-op when there's nothing to refresh. */
async function ensureFreshToken(server: McpServerRow): Promise<McpServerRow> {
  if (!server.oauth_access_token || !server.oauth_refresh_token || !server.oauth_expires_at) return server;
  if (new Date(server.oauth_expires_at).getTime() - Date.now() > 60_000) return server;
  if (!server.oauth_as_metadata || !server.oauth_client_id) return server;
  try {
    const token = await oauthRefresh({
      as: server.oauth_as_metadata,
      clientId: server.oauth_client_id,
      refreshToken: server.oauth_refresh_token,
      resource: server.oauth_resource || "",
    });
    return storeOAuthToken(server.id, token, {
      client_id: server.oauth_client_id,
      as: server.oauth_as_metadata,
      resource: server.oauth_resource || "",
    });
  } catch {
    // A failed refresh should surface at call time (readiness/auth failure),
    // not throw here and turn a background "is anything ready" check into
    // a hard error.
    return server;
  }
}

function headersFor(server: McpServerRow): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  const token = server.oauth_access_token || resolveEnvRef(server.auth);
  if (token) h.Authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  if (server.instance) h["wf-url"] = server.instance;
  return h;
}

/**
 * Read an MCP response body, whichever way the server chose to frame it —
 * MCP's streamable HTTP transport allows plain JSON or Server-Sent Events.
 * An SSE body can carry several events; the JSON-RPC reply is the last
 * `data:` payload that parses as one.
 */
export function parseMcpBody(text: string, contentType = ""): { result?: unknown; error?: { message?: string } } {
  const body = text || "";
  const isSse = /text\/event-stream/i.test(contentType) || /^\s*(event|data|id|retry):/m.test(body);
  if (!isSse) return JSON.parse(body);

  const payloads: string[] = [];
  let current: string | null = null;
  for (const raw of body.split(/\r?\n/)) {
    if (/^data:/i.test(raw)) {
      const chunk = raw.replace(/^data:\s?/i, "");
      current = current == null ? chunk : current + "\n" + chunk;
    } else if (raw.trim() === "") {
      if (current != null) {
        payloads.push(current);
        current = null;
      }
    }
  }
  if (current != null) payloads.push(current);

  for (let i = payloads.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(payloads[i]);
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch {
      // try the one before
    }
  }
  throw new Error(`the server replied with an event stream carrying no JSON-RPC result (${body.slice(0, 120).replace(/\s+/g, " ")})`);
}

let rpcId = 0;

/** Call one tool on one server. Errors are THROWN, never folded into a result that still looks successful. */
export async function callTool(server: McpServerRow, name: string, args: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<unknown> {
  const fresh = await ensureFreshToken(server);
  const state = readiness(fresh);
  if (!state.ready) throw new Error(`${fresh.id}: ${state.reason}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(fresh.endpoint, {
      method: "POST",
      headers: headersFor(fresh),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${fresh.id} returned HTTP ${res.status} for ${name}`);
    const body = parseMcpBody(text, res.headers.get("content-type") ?? undefined) as {
      error?: { message?: string };
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    if (body.error) throw new Error(`${name}: ${body.error.message || "unknown MCP error"}`);
    const result = body.result || {};
    if (result.isError) {
      const detail = (result.content || []).map((c) => c.text).filter(Boolean).join("\n");
      throw new Error(`${name} returned an error: ${detail || "unknown"}`);
    }
    const first = (result.content || [])[0];
    if (first && typeof first.text === "string") {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export interface OAuthTransaction {
  state: string;
  server_id: string;
  client_id: string;
  verifier: string;
  as_metadata: AuthorizationServerMetadata;
  resource: string | null;
  redirect_uri: string;
  expires_at: string;
}

/** One in-flight OAuth attempt, keyed by `state`. Pruned of anything expired on every save. */
export async function saveOAuthTransaction(txn: Omit<OAuthTransaction, "expires_at"> & { ttlMs: number }): Promise<void> {
  await query(`DELETE FROM mcp_oauth_transactions WHERE expires_at < NOW()`);
  await query(
    `INSERT INTO mcp_oauth_transactions (state, server_id, client_id, verifier, as_metadata, resource, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, NOW() + ($8 || ' milliseconds')::interval)
     ON CONFLICT (state) DO NOTHING`,
    [txn.state, txn.server_id, txn.client_id, txn.verifier, JSON.stringify(txn.as_metadata), txn.resource, txn.redirect_uri, txn.ttlMs],
  );
}

/** Single-use: deletes on read, so a replayed callback finds nothing. */
export async function takeOAuthTransaction(state: string): Promise<OAuthTransaction | null> {
  const [row] = await query<OAuthTransaction>(`DELETE FROM mcp_oauth_transactions WHERE state = $1 RETURNING *`, [state]);
  return row ?? null;
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** What a server actually exposes. Used to verify a registry entry from Settings. */
export async function listTools(server: McpServerRow, timeoutMs = 30_000): Promise<McpToolDescriptor[]> {
  const fresh = await ensureFreshToken(server);
  const state = readiness(fresh);
  if (!state.ready) throw new Error(`${fresh.id}: ${state.reason}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(fresh.endpoint, {
      method: "POST",
      headers: headersFor(fresh),
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = parseMcpBody(await res.text(), res.headers.get("content-type") ?? undefined) as {
      error?: { message?: string };
      result?: { tools?: McpToolDescriptor[] };
    };
    if (body.error) throw new Error(body.error.message || "unknown MCP error");
    return body.result?.tools || [];
  } finally {
    clearTimeout(timer);
  }
}
