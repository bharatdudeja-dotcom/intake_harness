import { randomBytes, createHash } from "crypto";

/**
 * Signing in to an upstream MCP server, as a client — ported from Agent
 * Manager's lib/mcp-oauth.js.
 *
 * A protected MCP server answers an unauthorized call with
 * `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728), which
 * leads to its authorization server, which advertises Dynamic Client
 * Registration (RFC 7591). So no pre-provisioned credential is needed:
 * discover, register ourselves, send the person to the provider's own
 * login page, take the code back.
 *
 * No client secret is stored — we register as a public client and use
 * PKCE. The access token IS stored (src/lib/mcp-servers.ts), never
 * returned to the browser and never logged.
 */

const TIMEOUT_MS = 20_000;

export interface AuthorizationServerMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  [key: string]: unknown;
}

export interface DiscoveryResult {
  resource: string;
  scopes: string[];
  as: AuthorizationServerMetadata;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomVerifier(): string {
  return base64url(randomBytes(48));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

async function fetchJson(
  url: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; status: number; headers: Headers; body: Record<string, unknown> | null; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      // handled by the caller
    }
    return { ok: res.ok, status: res.status, headers: res.headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a protected MCP server says its metadata lives — asked the way the
 * spec intends (an unauthorized call and read the challenge), with the
 * conventional well-known path as a fallback, because a server that is
 * merely unconfigured rather than protected will not send the header.
 */
async function resourceMetadataUrl(endpoint: string): Promise<string> {
  const probe = await fetchJson(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }).catch(() => null);

  const challenge = probe?.headers.get("www-authenticate");
  const named = challenge && /resource_metadata="([^"]+)"/i.exec(challenge);
  if (named) return named[1];

  const base = endpoint.replace(/\/+$/, "");
  return `${base}/.well-known/oauth-protected-resource`;
}

/**
 * Follow the chain: MCP endpoint -> protected-resource metadata ->
 * authorization server metadata. The AS metadata path is tried both ways
 * round (RFC 8414 inserts the well-known segment after the origin and
 * keeps the path suffix; plenty of deployments simply append it).
 */
export async function discover(endpoint: string): Promise<DiscoveryResult> {
  const prmUrl = await resourceMetadataUrl(endpoint);
  const prm = await fetchJson(prmUrl);
  if (!prm.ok || !prm.body) {
    throw new Error(
      `No OAuth metadata at ${prmUrl} (HTTP ${prm.status}). This server may not use OAuth — set an Authorization value instead.`,
    );
  }

  const issuer = (prm.body.authorization_servers as string[] | undefined)?.[0];
  if (!issuer) throw new Error(`${prmUrl} lists no authorization_servers.`);

  const u = new URL(issuer);
  const suffix = u.pathname.replace(/\/+$/, "");
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${suffix}`,
    `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`,
    `${u.origin}/.well-known/openid-configuration${suffix}`,
    `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`,
  ];

  const tried: string[] = [];
  for (const url of candidates) {
    const res = await fetchJson(url).catch(() => null);
    if (res?.ok && res.body && res.body.authorization_endpoint) {
      return {
        resource: (prm.body.resource as string) || endpoint,
        scopes: (prm.body.scopes_supported as string[]) || [],
        as: res.body as unknown as AuthorizationServerMetadata,
      };
    }
    tried.push(`${url} (${res ? res.status : "unreachable"})`);
  }
  throw new Error(`Found the authorization server "${issuer}" but none of its metadata URLs answered: ${tried.join(", ")}`);
}

/** Register ourselves with the provider (RFC 7591) — a public client: no secret, PKCE instead. */
export async function register(
  as: AuthorizationServerMetadata,
  redirectUri: string,
  clientName = "Agentic Harness",
): Promise<string> {
  if (!as.registration_endpoint) {
    throw new Error(
      "This provider does not support dynamic client registration. Register a client with them and set its id on the server entry as oauth_client_id.",
    );
  }
  const res = await fetchJson(as.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
    }),
  });
  if (!res.ok || !res.body || !res.body.client_id) {
    throw new Error(`Registration failed at ${as.registration_endpoint} (HTTP ${res.status}): ${res.text.slice(0, 200) || "no body"}`);
  }
  return res.body.client_id as string;
}

export function authorizeUrl(opts: {
  as: AuthorizationServerMetadata;
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes: string[];
  resource: string;
}): string {
  const url = new URL(opts.as.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (opts.scopes.length) url.searchParams.set("scope", opts.scopes.join(" "));
  // RFC 8707 — the provider advertises resource_indicators_supported, and a
  // token minted without it can come back scoped to the wrong audience.
  if (opts.resource) url.searchParams.set("resource", opts.resource);
  return url.toString();
}

export async function exchange(opts: {
  as: AuthorizationServerMetadata;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource: string;
}): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    code_verifier: opts.verifier,
  });
  if (opts.resource) form.set("resource", opts.resource);
  const res = await fetchJson(opts.as.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.text.slice(0, 250) || "no body"}`);
  }
  return res.body as unknown as TokenResponse;
}

/** Swap a refresh token for a new access token. */
export async function refresh(opts: {
  as: AuthorizationServerMetadata;
  clientId: string;
  refreshToken: string;
  resource: string;
}): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
  });
  if (opts.resource) form.set("resource", opts.resource);
  const res = await fetchJson(opts.as.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  if (!res.ok || !res.body || !res.body.access_token) {
    throw new Error(`Refresh failed (HTTP ${res.status}): ${res.text.slice(0, 250) || "no body"}`);
  }
  return res.body as unknown as TokenResponse;
}
