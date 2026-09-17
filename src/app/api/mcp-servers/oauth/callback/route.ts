import { NextRequest, NextResponse } from "next/server";
import { exchange } from "@/lib/mcp-oauth";
import { storeOAuthToken, takeOAuthTransaction } from "@/lib/mcp-servers";
import { resetCache } from "@/lib/mcp-gateway";

function html(status: number, title: string, message: string, ok: boolean) {
  const colour = ok ? "#166534" : "#991b1b";
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:#fafafa;color:#18181b;
       display:grid;place-items:center;height:100vh;margin:0;padding:24px;text-align:center}
  .card{max-width:480px;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:24px 28px;
        box-shadow:0 4px 12px rgba(0,0,0,.06)}
  h1{font-size:18px;margin:0 0 8px;color:${colour}}
  p{margin:0 0 6px;color:#52525b}
  code{background:#f4f4f5;padding:2px 6px;border-radius:6px;font-size:13px}
</style>
<div class="card"><h1>${title}</h1><p>${message}</p>
<p style="margin-top:12px"><small>You can close this window.</small></p></div>
<script>try{ if (window.opener) { window.opener.postMessage({ type: "mcp-oauth", ok: ${ok} }, "*"); setTimeout(() => window.close(), 1200) } }catch(e){}</script>`;
  return new NextResponse(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

/**
 * Where the provider sends the person back after sign-in. `state` is
 * single-use — takeOAuthTransaction deletes on read, so a replayed
 * callback finds nothing and is refused. The verifier never leaves the
 * server, and the resulting token is written straight to the DB, never
 * returned to this page.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const err = q.get("error");
  if (err) {
    return html(400, "Sign-in refused", `The provider returned <code>${err}</code>${q.get("error_description") ? `: ${q.get("error_description")}` : ""}.`, false);
  }

  const state = q.get("state");
  const code = q.get("code");
  if (!state || !code) return html(400, "Incomplete callback", "The provider did not return a code and state.", false);

  const txn = await takeOAuthTransaction(state);
  if (!txn) return html(400, "Expired or already used", "Start the sign-in again from Settings.", false);
  if (new Date(txn.expires_at).getTime() < Date.now()) {
    return html(400, "Expired", "That sign-in took too long. Start it again from Settings.", false);
  }

  try {
    const token = await exchange({
      as: txn.as_metadata,
      clientId: txn.client_id,
      code,
      verifier: txn.verifier,
      redirectUri: txn.redirect_uri,
      resource: txn.resource || "",
    });
    await storeOAuthToken(txn.server_id, token, { client_id: txn.client_id, as: txn.as_metadata, resource: txn.resource || "" });
    resetCache();
    return html(200, "Connected", `<b>${txn.server_id}</b> is signed in and switched on. Its tools are available now.`, true);
  } catch (e) {
    return html(502, "Could not sign in", (e as Error).message, false);
  }
}
