# LINEAGE.md

**CX Agent Manager is its own product.** This document exists because it did not
start as one: its storage layer, step model and graph renderer came from the TAP
Company Cookbook Connector, and knowing that explains several names that would
otherwise look arbitrary.

What it is now is not a rebranded cookbook. The domain model is different, the
MCP surface is different, the instructions served to connected clients are
different, and the things it does that matter most — reading across runs to
catch an agent reporting success while failing, and gatewaying agent tools
through to Claude — have no counterpart upstream.

**The original is read-only to us.** No commits, no migrations, no config edits,
no republishing against `TAP-CXM/TAP-Cookbook` or its deployed connector. If
something upstream looks broken it goes in `DECISIONS.md` and to Bharat — we do
not fix it here.

## What the engine came with

| | |
|---|---|
| Upstream repo | `https://github.com/TAP-CXM/TAP-Cookbook.git` |
| Upstream path | `tap-portability-layer/connector/` |
| Commit | `98617f6acdafcb92938d2b03df2f0a2cbe83c608` |
| Branch | `feature/demo-hardening-and-setup-docs` |
| Forked to | `app/` in this repo |
| Date | 16 September 2026 |

**Correcting the phase-1 brief:** the correction doc assumed the cookbook source
was not in `C:/Users/BharatDudeja/Documents/aio`. It is — at
`tap-portability-layer/connector/`, named in that repo's own `README.md`. No
wider filesystem search was needed. The `company-cookbook` MCP entry in
`~/.claude.json` points at the *deployed* URL, not a local path, which is why
following the registration alone would not have found the source.

### Excluded from the copy

`node_modules`, `dist`, `coverage`, `.parcel-cache`, `.vscode`, `.aio`, and
every local credential file: `keys.local.json`, `demo-logins.local.md`,
`demo-people.local.json`, `.env`, `.aws.tmp.creds.json`, `.keys.env.tmp`.

Two files still match a secret-shaped grep and are both false positives:
`test/utils.test.js` (a fixture asserting that `client_secret` is redacted) and
`workspace-config.example.json` (`"your-client-secret"`).

## Language and stack

**Node.js >= 18.19 on Adobe I/O Runtime (App Builder), runtime `nodejs:20`.**

This settles the open question from the correction: the earlier brief specified
Python 3.12 because Chauncey's repo is Python. We never import his code — we
call his MCP over the wire — so **Agent Manager takes the cookbook's stack. The
Python scaffold is gone.**

| | |
|---|---|
| Package manager | npm |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.24 |
| Validation | `zod` ^3.23 |
| JWT | `jose` ^4.15 |
| Storage | `@adobe/aio-lib-files` — **blob storage, not SQL** |
| Build | `npm run build` (webpack) |
| Deploy | `npm run deploy` → `aio app deploy` |
| Local | `npm run dev` → `aio app run` |
| Test | `npm test` (jest) |

**You cannot run this without the `aio` CLI and Adobe I/O credentials.** That is
a real constraint on local verification — see *Not yet verified* below.

## Data model

There is no database. Everything is JSON blobs via `aio-lib-files`:

```
resources/index.json        catalog - metadata projection of every recipe
resources/<id>.json         one full recipe document, steps inline
resources/projects.json     project list
resources/work-context.json active project/epic/story per owner
resources/settings.json     retention window, roles, practices
resources/cx-graph.json     compiled company graph
resources/users.json        accounts + credentials (own doc, so a settings
                            write can never clobber it)
assets/<id>.<ext>           binary blobs (images, rendered diagrams)
```

**Project → Recipe → Step.** A recipe is an *ordered container of steps*
(`lib/steps.js`, D45). Step ids are `<recipeId>::s<order>` — parseable, stable,
never reshuffled. The recipe's flat top-level fields (`content`, `status`,
`tokens_used`, ...) are a **composed projection of its steps**, computed on read,
not stored as independent truth. Pre-D45 recipes have no `steps` array;
`ensureSteps()` synthesizes one from the legacy fields, so every tool works
either way.

The catalog is a metadata-only projection (`toMetadata()` in `lib/store.js`) so
list/search/filter never load full documents.

`lib/store.js` is an explicit **swap point** — its docblock says the
implementation can be replaced with SharePoint via Microsoft Graph without
callers changing. Useful to us: our own storage decision is isolated to one file.

## MCP server

`actions/mcp-server/tools.js`, 2425 lines. Tools are declared with
`server.tool(name, description, zodSchema, handler)`. Roughly 60 tools.

**Auth is dual** (`lib/auth/index.js`, D19/D21/D24):

- `Authorization: Bearer` → OIDC validation against the configured provider
- `x-api-key` → headless agent path, mapped to an owner via `API_KEY_OWNERS`
- `x-cookbook-login: user:password` → the direct login header

`resolveRequestAuth()` returns the owner identity. **Everything binds to
`owner`** — recipes, roles, visibility. The `x-api-key` path resolves to a
single service account, which is exactly the attribution problem we hit earlier
in this project.

**Auth provider is pluggable** (D66): `adobe-ims | auth0 | microsoft-entra`.

## Web app

A **single-file vanilla SPA**: `web-src/index.html`, ~2900 lines, one inline
`<script>` of ~2250 lines. No framework, no build step for the UI, no
`node_modules` at runtime. Lucide for icons, a `render<Panel>()` function per
view, and one delegated click handler keyed on `data-*` attributes.

It never holds a secret. `actions/dashboard-api/` is a server-side proxy that
holds `SERVICE_API_KEY` and forwards an **allowlisted** set of JSON-RPC methods
(D29). `DASHBOARD_REQUIRE_IDENTITY: 'true'` (D79) means every caller identifies
themselves, so each person sees their own cookbook rather than one shared view.

**Styling** is CSS custom properties on `:root` with three themes — light, dark
and a green variant. Warm canvas `#FAF9F5`, terracotta accent `#C96442`,
Fraunces for headings, Inter for body. We kept all of it.

## Approval path — the part the Hero Agent replaces

Two-tier consent (D64):

1. A **chef** (everyone, by default) approves individual steps
   (`approve_step` / `approve_steps`) and **bakes** the recipe once at least one
   step is approved. That finalizes it into that owner's cookbook.
2. A **head chef** then admits a baked recipe into the Company CX Graph
   (`headchef_approve` / `headchef_reject`), flipping `cx_approved`.

`lib/cx-graph.js` compiles the graph from recipes where `cx_approved === true`
only, and builds nodes for recipes, their approved ingredients, and handoffs,
with `lineage` edges between them.

Role checks are `callerHasRole(context, 'head-chef') || callerHasRole(context, 'admin')`.

**This is precisely where our rule lands:** where the cookbook lets a head chef
approve, Agent Manager makes that a human-only gate, and the Hero Agent gets no
code path to it.

## Retention

`lib/retention.js` (D44/D45). A step is purged only while **still experimental
AND past `expires_at`**. Approved content is never touched. A recipe left with
no approved steps goes too. Shared by the `purge_expired` tool and a daily cron
(`0 3 * * *`); the CX graph recompiles daily at `0 4 * * *`. Idempotent.

## Deployment-specific things any new deployment must change

1. **Its own App Builder namespace and package name.** `app.config.yaml`'s
   package key `tap-mcp-connector` sets the deploy URL segment — must change, or
   we deploy over the original.
2. **Its own storage.** `aio-lib-files` is namespace-scoped, so a separate
   namespace gives a separate database for free.
3. **Its own OAuth client** and `SERVICE_API_KEY` / `API_KEY_OWNERS`.
4. **Branding** — done: title, sidebar, sign-in copy.
5. `BOOTSTRAP_ADMINS` for a first admin in the new namespace.
6. The `.env` is not copied; `.env.example` is the template.

## The rename, and what is deliberately staged

Applied to **everything a person sees**, and verified: all identifiers intact
(`recipe_id`, `data-open-recipe`, `linked_recipes`, the `head-chef` role value),
and the 2256-line inline script still passes `node --check`.

| Cookbook | Agent Manager | Where |
|---|---|---|
| Project | Programme | nav, panel title |
| Recipe | Run | panel copy |
| Step / ingredient | Event | Event Log |
| Chef | Marketer | role chip, display copy |
| Head chef | **Hero Agent** | nav, panel title, all copy |
| Practice | **Agent** (with a mark) | graph filter, recipe meta, login form |
| Company CX Graph | Shared Knowledge Graph | nav, panel title |
| Knowledge Graph | My Knowledge Graph | nav |
| Active tasks | Live Queue | nav, panel title |
| Cookbook | Playbooks | nav, panel title |
| Cook-off | **removed** | nav entry deleted |

**Agent marks** — `AGENT_MARK` in the SPA. Inbox tray for intake, magnifier for
review/triage, target for audience creation, siren for escalation, compass for
the mentor, and a person for wherever a human decided. The map only *decorates*
ids it recognises; the agent list still comes from the registry at runtime, so a
fifth agent renders fine without a mark and **no agent name is hardcoded as a
source of truth**.

### Staged on purpose, not forgotten

`recipe` / `ingredient` / `project` are **not** renamed in storage keys, MCP tool
names or JSON field names. Those are the wire contract: tool names are what
connected Claude clients call, and field names are what every stored document
already uses. Renaming them is a migration plus a client-config change, buys a
client nothing they can see, and would have meant editing roughly 500
occurrences across 5,300 lines with no way to run the app and check. The visible
layer is fully renamed; the plumbing keeps its maiden name until we choose to
migrate it.

## Not yet verified

Honest list, because CX Agent Manager has not been deployed:

- **The UI has not been rendered.** Running it needs the `aio` CLI and Adobe I/O
  credentials, neither available here. Verification so far is `node --check` on
  the extracted script plus identifier-integrity greps.
- No deployment to a new namespace, so nothing has exercised storage, auth or
  the dashboard proxy under the new name.
- `renderCookOff()` and its panel markup are still present, now unreachable
  because the nav entry is gone. Dead code to delete, not a behaviour change.
- The Chauncey adapter, the Hero's Journey stage mapping, loop-count surfacing,
  reconciliation and the queue filters from the Python build are **not yet
  ported**. That is the next piece of work.
