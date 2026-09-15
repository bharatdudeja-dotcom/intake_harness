# Adobe IMS per-user auth — Developer Console setup

This connector authenticates each user with **their own Adobe IMS (Adobe ID) identity**, so
their cookbook data is private to them (own recipes + anyone's approved/CX-admitted content).
That requires **User Authentication** OAuth credentials in the Adobe Developer Console.

> **The Server-to-Server credential you exported (`TapMcpConnector-110557-OAuth Server-to-Server.json`)
> cannot do this.** S2S uses the `client_credentials` grant — it authenticates as one fixed
> *technical account*, with no human sign-in, so every caller collapses to a single machine
> identity (exactly the problem we're removing). It stays useful only for headless/service jobs.
> It is git-ignored; never commit it.

## What to create (org 110557, project **TapMcpConnector**)

Two **User Authentication** credentials — one per client surface. In the Console: open the
project → **Add API / Add credential → User Authentication** (not "Server-to-Server").

### 1. OAuth Web App — for the Claude / MCP connector
- **Type:** OAuth Web App (confidential; has a client secret).
- **Redirect URI:** `https://claude.ai/api/mcp/auth_callback`  *(exact string — this is Claude's
  single callback for web/Desktop/mobile custom connectors; see `knowledge/OAUTH-SPIKE.md` §1).*
- **Scopes:** `openid, AdobeID, email, profile`.
- Gives you a **Client ID** and **Client Secret** → set as `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET`
  in `.env`. A user adding the connector in Claude pastes the connector URL and (Advanced settings)
  the client id + secret.

### 2. OAuth Single-Page App — for the dashboard browser login
- **Type:** OAuth Single-Page App / SPA (public; PKCE S256, **no** secret in the browser).
- **Redirect URI:** the dashboard page URL, exactly —
  `https://110557-tapmcpconnector-stage.adobeio-static.net/index.html`
  (add the production URL too when there is one).
- **Scopes:** `openid, email, profile`.
- Gives you a **Client ID** → set as `DASHBOARD_OAUTH_CLIENT_ID` in `.env` (public; safe to ship
  to the browser). No secret.

> **Org-admin note:** creating *User Authentication* credentials (and binding scopes/product
> profiles) can require Adobe org **System Administrator** rights. If the Console only offers you
> Server-to-Server, that is the same org-admin gate noted in D22/D25/D27 — tell us and we keep the
> current Auth0 user-login path instead (the code is provider-neutral; only these env values change).

## Env values this maps to (`.env`, git-ignored)

```
# IMS as the OIDC provider (userinfo-endpoint validation path — IMS issues no audience-bound JWTs)
OIDC_ISSUER=https://ims-na1.adobelogin.com
OIDC_DISCOVERY_URL=https://ims-na1.adobelogin.com/ims/.well-known/openid-configuration
OIDC_AUDIENCE=                         # MUST be blank for IMS → selects the userinfo path
OIDC_REQUIRED_SCOPE=openid
OAUTH_CLIENT_ID=<OAuth Web App client id>
OAUTH_CLIENT_SECRET=<OAuth Web App client secret>
# Dashboard browser login (public SPA client — PKCE, no secret)
DASHBOARD_OAUTH_CLIENT_ID=<OAuth Single-Page App client id>
```

## How the flow works (no code change needed to switch providers — D21)

- **MCP client (Claude):** unauthenticated request → connector returns `401` +
  `WWW-Authenticate: Bearer resource_metadata=…` (RFC 9728) → Claude reads the PRM doc → discovers
  IMS as the authorization server → Authorization Code + PKCE against IMS → sends the IMS access
  token as `Authorization: Bearer` → connector validates it at `GET /ims/userinfo/v2` and resolves
  the caller's email/sub as the owner.
- **Dashboard:** the SPA runs IMS Authorization Code + PKCE in the browser (SPA client), gets the
  user's IMS token, and sends it to the `dashboard-api` proxy, which forwards it as `Bearer` to the
  MCP server — so the dashboard shows **that signed-in user's** private view, not a shared one.

## Accepted risk (from the spike, unchanged)

IMS issues no RFC 8707 audience-bound tokens, so `userinfo/v2` confirms a token is a *valid IMS
token*, not that it was minted specifically for this connector. Mitigation: the connector enforces
`OAUTH_CLIENT_ID` (rejects tokens whose `client_id`/`azp` ≠ ours). This matches Adobe's own hosted
AEM MCP precedent. See `knowledge/OAUTH-SPIKE.md` §3–4.
