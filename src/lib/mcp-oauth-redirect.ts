import type { NextRequest } from "next/server";

/**
 * Where the provider sends the person back to — ported from Agent
 * Manager's mcp-connect redirectUri(). It has to be an absolute URL the
 * provider accepts, and it has to be the SAME string at registration, at
 * /authorize, and at /token: providers compare it literally.
 *
 * An explicit MCP_CONNECT_REDIRECT_URI always wins (behind a proxy or a
 * custom domain it's the only thing that can be right). Otherwise: the
 * Host header is what the browser actually asked for, so it's what the
 * browser can be sent back to — port mappings and localhost-vs-real-host
 * all come out right without being configured.
 */
export function callbackRedirectUri(req: NextRequest): string {
  const explicit = process.env.MCP_CONNECT_REDIRECT_URI;
  if (explicit) return explicit;

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (host) {
    const forwardedProto = req.headers.get("x-forwarded-proto");
    const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(host);
    const proto = forwardedProto || (local ? "http" : "https");
    return `${proto}://${host}/api/mcp-servers/oauth/callback`;
  }
  return "http://127.0.0.1:3000/api/mcp-servers/oauth/callback";
}
