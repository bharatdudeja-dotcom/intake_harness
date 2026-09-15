# Connecting a second user (D50, D55)

The connector's data is **owned per-caller**. With a single shared `x-api-key` everyone is
the same owner (`service-account`) — no personal separation. To give a colleague their own
identity (their own personal view: own recipes + everyone's approved ones, never your
drafts), connect them one of two ways. Both use the same **Local MCP server** connection
in Claude Desktop that Increment 12/D50 established for real capture — no org-admin
custom-connector approval needed for either path.

## Option A — per-user OAuth (real identity, recommended)

The second user logs in themselves via the configured OIDC provider (Auth0 in this
deployment) — their `owner` becomes their Auth0 `sub` (and `email`/`username` if the
token carries them). This is the path that makes multi-tenant isolation *real*: nobody
shares a secret, and each person's identity is cryptographically theirs.

1. In Claude Desktop: **Settings → Developer → Local MCP servers → Edit Config**.
2. Add an entry using `mcp-remote` with no `x-api-key` header — this forces the
   Authorization: Bearer / OAuth path:
   ```json
   {
     "mcpServers": {
       "tap-cookbook": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://<namespace>.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server"]
       }
     }
   }
   ```
3. `mcp-remote` opens a browser OAuth flow against the configured provider. The second
   user logs in with **their own** account.
4. Every tool call now carries their Bearer token; `owner` = their `sub`/email — their
   recipes are theirs, and only their *approved* recipes become visible to others (and to
   the Company CX graph).

## Option B — a mapped API key (quick self-serve demo)

For a fast demo without setting up a second OAuth login, give the second user their own
`x-api-key` and map it to an owner label server-side:

1. Generate a key for them (any random string works, e.g. `tap_bob_<random-hex>`).
2. Add it to the connector's `.env` (never commit this file) as a JSON map in
   `API_KEY_OWNERS`, alongside your existing `SERVICE_API_KEY`:
   ```
   API_KEY_OWNERS={"tap_bob_9f2a1c4e...":"bob@example.com"}
   ```
   The default `SERVICE_API_KEY` always still maps to `service-account`, regardless of
   this map — existing automation is unaffected.
3. Redeploy (`npm run deploy`) so the action picks up the new env value.
4. The second user's Local MCP config uses their own key:
   ```json
   {
     "mcpServers": {
       "tap-cookbook": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://<namespace>.adobeioruntime.net/api/v1/web/tap-mcp-connector/mcp-server", "--header", "x-api-key:tap_bob_9f2a1c4e..."]
       }
     }
   }
   ```
5. Every call authenticated with that key now resolves `owner = "bob@example.com"`.

## What isolation actually means today

- **Personal view** (`list_recipes`, `list_resources`, `search_resources`,
  `list_active_tasks`, `list_projects`): a caller sees **their own** recipes/projects plus
  **anyone's approved** recipes. They never see another owner's experimental drafts.
- **Company CX Graph**: cross-owner, **approved-only** — the consent gate (certify/bake) is
  what makes a recipe visible to the whole company, regardless of who owns it.
- **Admin ("All owners") dashboard view**: an explicit toggle that bypasses personal
  scoping entirely (`admin_list_recipes`/`admin_list_projects`) so you can watch a second
  user's data appear live. It is guarded by naming and by being off-by-default, not by a
  real permission check — that's the honest caveat: **real per-user access control lands
  with per-user RBAC / org rollout**, not in this increment. Until then, anyone with
  dashboard access can flip the admin toggle.
- **Direct-by-id reads** (`get_resource`/`get_recipe` given a known id) are **not**
  owner-gated — if you already know a specific id, you can read it regardless of owner.
  Isolation today is a *listing/discovery* boundary, not a hard per-record ACL.

## Scope note

Until org rollout ships per-user OAuth broadly, most callers still use the single shared
`SERVICE_API_KEY` (`service-account`). Both paths above exist so isolation and the CX graph
can be built and verified *now*, with real (or simulated) distinct owners, ahead of that
rollout.
