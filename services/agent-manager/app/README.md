# Company Cookbook Connector (Tap MCP Connector)

A portable [Model Context Protocol](https://modelcontextprotocol.io/) server, deployed on
Adobe I/O Runtime, that gives any connected AI client a shared **company cookbook**: an
ordered, human-approved log of an engagement's work (decisions, code, diagrams, docs,
steering) that any AI tool can read from and write to.

See [`../README.md`](../README.md) for the wider Tap Portability Layer context, and
[`../../knowledge/DECISION-LOG.md`](../../knowledge/DECISION-LOG.md) for the full decision
trail this connector was built against (referenced by `D<n>` below).

## What it is

- **Job = task, Step = ingredient (D45/D47).** `start_job` opens an ordered thread for
  a task; `append_step` appends each output as you produce it (message/code/diagram/image/
  decision/doc/handoff/config/steering), tagged with `source`, `model`, and `tokens_used`.
  Steps are never reordered. A human `approve_step`s the ones worth keeping; only approved
  steps join the cookbook. `bake_job` finalizes a job once the task is done.
- **Projects → Jobs → Work Log → Cookbook.** Project records are the source of truth
  (`start_project`); the Cookbook is the approved-steps-only, followable view across a
  project's jobs.
- **Steering capture (D41/D47).** A human's allow/deny/edit is captured as its own
  `kind:"steering"` step (`affirm`/`reject`/`correct`) — deterministically for Claude Code via
  the hook kit in [`hooks/`](hooks/) (or `npx @tap/cookbook-connect`, see
  [`../../tools/cookbook-connect/`](../../tools/cookbook-connect/)), cooperatively elsewhere.
- **Company CX Knowledge Graph.** A cross-owner, approved-only compiled graph
  (`get_cx_graph`/`rebuild_cx_graph`) plus a per-project graph, both rendered live in the
  dashboard.
- **Multi-tenant by owner**, `x-api-key`-mapped today (`API_KEY_OWNERS`); full per-user OAuth
  identity is future work (org rollout).
- **Replay as a skill.** `export_as_skill` on a baked job emits the ordered, approved
  end-to-end walkthrough (prompts/decisions/code/diagrams) as a portable prompt / `SKILL.md`
  — any AI can redo the task from it.
- **Infra-/IdP-/AI-agnostic core (D21).** `lib/**` and `actions/mcp-server/tools.js` have no
  hardcoded dependency on Adobe I/O Runtime, a specific identity provider, or a specific AI
  vendor — those are adapters (`lib/store.js`, `lib/auth/config.js`,
  `lib/skills/vendor-adapters.js`). Enforced by `scripts/portability-check.mjs` (run it before
  every deploy; see `npm run` below).
- **No-secret dashboard.** `web-src/` is a static SPA; it never holds `SERVICE_API_KEY`. It
  calls a same-origin `dashboard-api` proxy action that injects the key server-side, behind a
  method/tool allowlist (D37/D58) — verified by downloading the deployed bundle and asserting
  the secret string is absent, not just by reading the source.

## Tools (MCP)

Cookbook: `get_resource_policy`, `list_resource_types`, `save_resource`, `approve_resource`,
`certify`, `find_similar`, `list_resources`, `search_resources`, `get_resource`,
`export_as_skill`.

Job/Step model: `start_job`, `append_step`, `approve_step`, `approve_steps`,
`discard_step`, `get_job`, `list_jobs`, `list_steps`, `get_active_job`, `bake_job`.

Projects: `start_project`, `set_work_context`, `bake_project`, `set_project_status`,
`list_projects`, `get_segmentation_config`.

Tasks/handoffs: `list_active_tasks`, `set_task_status`, `link_jobs`.

Settings/admin: `get_settings`, `update_settings`, `purge_expired`, `admin_list_jobs`,
`admin_list_projects`, `admin_reset_data` (guarded, not exposed on the dashboard proxy).

CX Graph: `get_cx_graph`, `rebuild_cx_graph`.

Run `get_resource_policy` (or open the dashboard's Settings panel) for the current, live
list of resource kinds, required fields, and approval rules — this README is a map, not the
source of truth for that policy.

## Dashboard

`web-src/index.html` — Home / Projects / Work Log / Cookbook / Active Tasks / Settings /
Company CX Graph. Client-side PDF export per job. Diagrams (mermaid or exact captured SVG)
and images render inline; see `D57/D58/D60/D61` for the diagram-capture and rendering fixes.

## Authentication

Dual auth, both optional independently (`lib/auth/`):

- **OAuth (per-user identity, D19/D21/D23/D24).** Pluggable OIDC provider — set `OIDC_ISSUER`
  (+ `OIDC_AUDIENCE` for full JWKS signature+audience verification, or leave it blank to fall
  back to a provider's userinfo endpoint, e.g. Adobe IMS). Reference deployment uses Auth0.
  `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` register a confidential "Regular Web App" client for
  the defense-in-depth client-binding check.
- **`x-api-key` (headless agents / service-to-service).** Set `SERVICE_API_KEY`. Additional
  keys can be mapped to distinct owners via `API_KEY_OWNERS` (multi-tenant demo path, D55).
- **`MCP_AUTH_MODE=none`** disables auth entirely — development only, never in a shared
  deployment.

See [`.env.example`](.env.example) for every variable, with inline docs. Copy it to `.env`
and fill in your own values — **never commit `.env`** (already `.gitignore`d).

## Local development

```bash
npm install
npm test          # jest — 298+ tests
npm run lint       # eslint actions/ lib/
node scripts/portability-check.mjs   # fails the build if core logic gained infra/IdP/AI coupling
npm run dev        # aio app run
npm run deploy     # aio app build && deploy
```

Requires the [Adobe I/O CLI](https://github.com/adobe/aio-cli) (`aio`) authenticated against
your own Adobe Developer Console workspace — this repo's own workspace credentials are not
included (see `.gitignore`: `*-Stage.json`, `*-Production.json`, `.env`).

## Layout

```
connector/
├─ actions/            # Adobe I/O Runtime actions (mcp-server, dashboard-api proxy, cron jobs)
├─ lib/                # portable core logic (store, auth, policy, segmentation, skills, steps)
├─ web-src/            # static dashboard SPA (no secrets)
├─ hooks/               # Claude Code steering-capture hook kit (D41/D47) — see hooks/README.md
├─ scripts/            # portability-check.mjs, reset-data.mjs, etc.
├─ config/              # resource-policy.json, segmentation.json
└─ test/                # jest test suite
```
