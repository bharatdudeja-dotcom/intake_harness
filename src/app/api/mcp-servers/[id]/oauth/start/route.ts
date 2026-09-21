import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admins";
import { getServer, saveOAuthTransaction } from "@/lib/mcp-servers";
import { authorizeUrl, challengeFor, discover, randomState, randomVerifier, register } from "@/lib/mcp-oauth";
import { callbackRedirectUri } from "@/lib/mcp-oauth-redirect";
import { apiError } from "@/lib/api-error";

const TXN_TTL_MS = 10 * 60 * 1000;

/**
 * GET so the browser can do a top-level navigation straight to the
 * provider's login page — an XHR would be blocked from getting there, and
 * a client-constructed redirect would mean trusting the page with the
 * state parameter. It's created here, stored server-side with its
 * verifier, and consumed once by the callback route.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const adminName = req.nextUrl.searchParams.get("adminName")?.trim() || "";
  if (!adminName || !isAdmin(adminName)) {
    return apiError(`"${adminName}" is not in ADMIN_NAMES.`, "FORBIDDEN", 403);
  }

  const server = await getServer(id);
  if (!server) return apiError(`No MCP server registered with id '${id}'.`, "NOT_FOUND", 404);
  if (!server.endpoint) return apiError("Set this server's endpoint before signing in.", "VALIDATION_ERROR", 400);

  try {
    const redirectUri = callbackRedirectUri(req);
    const d = await discover(server.endpoint);
    // A client id we already have (from a prior sign-in) wins; otherwise register one.
    const clientId = server.oauth_client_id || (await register(d.as, redirectUri));

    const verifier = randomVerifier();
    const state = randomState();
    await saveOAuthTransaction({
      state,
      server_id: id,
      client_id: clientId,
      verifier,
      as_metadata: d.as,
      resource: d.resource,
      redirect_uri: redirectUri,
      ttlMs: TXN_TTL_MS,
    });

    const url = authorizeUrl({
      as: d.as,
      clientId,
      redirectUri,
      state,
      challenge: challengeFor(verifier),
      // Ask only for what the resource says it understands — a scope the
      // provider doesn't recognize fails the whole authorization.
      scopes: d.scopes,
      resource: d.resource,
    });
    return NextResponse.redirect(url, { status: 302, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return apiError((err as Error).message, "UPSTREAM_ERROR", 502);
  }
}
