# BACKLOG.md

Everything asked for, tracked, so nothing depends on being remembered.
Ordered by what blocks what.

**Canonical repo: `chaunceyplum/intake_harness`, branch `agent-manager`, PR #8,
at `services/agent-manager/`.** `bharatdudeja-dotcom/agent-manager` is a working
mirror only; every change lands in the PR.

---

## Done

| # | Item | Where |
|---|---|---|
| D1 | Fork the cookbook rather than build fresh | `app/`, `docs/COOKBOOK-FORK.md` |
| D2 | Rename everything a person sees — Programme, Run, Event, Marketer, Hero Agent, Agent, Live Queue, Playbooks, Shared Knowledge Graph | SPA |
| D3 | Drop the Cook-off | SPA |
| D4 | **Hero Agent** is the only name. No "mentor" anywhere | SPA, docs |
| D5 | Agent marks (inbox, magnifier, target, siren, person), decorating registry ids only | `AGENT_MARK` |
| D6 | Host-neutral: Docker, storage drivers (fs/s3/gcs/aio), runs on Cloud Run, ECS, a VM or a laptop | `server.js`, `lib/storage/` |
| D7 | One **Approve** button replacing per-artifact approve + bake; same action available from Claude | SPA |
| D8 | ingredient → **artifact**, domain-neutral for AEM and Campaign later | SPA |
| D9 | Two themes, light and dark. Green one gone | SPA |
| D10 | **Agents** tab, always visible, artifacts segregated per agent, Hero Agent queue folded in | `renderAgents()` |
| D11 | **Data flow fixed** — three stacked Adobe assumptions (API origin, config-as-params, proxy URL) | `server.js`, SPA |
| D12 | Read David's blockers map and Josh's deck; B1–B9 documented | `docs/BRAIN-GAP.md` |
| D13 | Story beats corrected from Josh's actual deck | `docs/STORY.md` |
| D14 | Data-layer decision: our own store, reference not join | `docs/DECISIONS.md` D13 |
| D15 | Remove the client band that read badly | SPA |

---

## Open, in priority order

### 1 · Hosting so Tap can reach it — **blocking everyone else**
Runs only on localhost today. Chauncey's is a public IP.
- [ ] Decide: GCP VM in `agent-x-508719`, or a tunnel for a same-day demo
- [ ] Before it is public: `DASHBOARD_REQUIRE_IDENTITY=true`, real `INTERNAL_TOKEN`
- **Needs:** a VM, or `gcloud auth login` (the CLI install failed twice; the
  official installer is the quicker route)

### 2 · Connect Claude end-to-end — **the thing that proves it works**
- [ ] `docs/CONNECT-CLAUDE.md`: the MCP entry a marketer pastes, and the
      walkthrough from prompt → Workfront brief → logged run
- [ ] Verify a real round trip once hosting exists
- **Blocked by:** 1, and `MCP_ENDPOINT_URL` from Chauncey for any Workfront call

### 3 · Configure agent systems from Settings
Chauncey's, Uday's, and our own Agent 2 MCP, each registerable and
Claude-controllable.
- [ ] `agent_systems` registry — one row per upstream, with its adapter,
      transport and auth (`docs/DECISIONS.md` D15)
- [ ] Settings panel to add/edit one
- [ ] MCP tools so Claude can do the same
- **Rule:** a system named in source outside its own adapter is a mistake

### 4 · Token and model logging from Claude Desktop
Today it logs nothing useful.
- [ ] Capture the client from the MCP `initialize` handshake — this is
      server-side and trustworthy, unlike anything self-reported
- [ ] Make model and token capture reliable, and mark estimates as estimates
      rather than passing them off as measured
- **Honest constraint:** the server cannot see a client's token usage unless the
  client reports it. Worth saying plainly instead of inventing a number.

### 5 · Remaining cookbook wording
Visible in the screenshots and still wrong.
- [ ] "0 recipe(s) visible · 0 in the cookbook" → runs / playbooks
- [ ] Stat tiles: "my recipes", "drafts", "in the cookbook"
- [ ] "Select a recipe to open its Work Log"
- [ ] "Nothing on your bench yet…"
- [ ] Sign-in copy: "the Cookbook shows your work", "Approved recipes and the
      Company CX Graph"
- [ ] "Projects are created from your AI client (start_project)" → Programmes

### 6 · Comcast branding
- [ ] Replace the TAP CXM mark. **I cannot produce the official Comcast asset** —
      drop the real file in, or I build a neutral placeholder
- [ ] Comcast/Xfinity colours in the header, without the band that read badly

### 7 · Two defects that must not survive
- [ ] Every ingested run shows `unattributed@tapcxm.com`. The fork's `owner`
      resolution fixes it; not yet wired
- [ ] **Runs reach `submitted` carrying a silent intake error.** The Python
      build derived stage state from evidence rather than the upstream status
      field — that logic has to be ported or the fork inherits the bug it exists
      to expose
- [ ] Port the rest: Chauncey adapter, stage mapping, loop count, reconciliation,
      queue filters

### 8 · Credentials — logged, not rotated
Both need a human and neither is safe to do alone. See the credential section in
`docs/DECISIONS.md`.
- [ ] Cookbook `walter.white` — rotating signs Bharat out mid-session and
      invalidates the `~/.claude.json` header
- [ ] Chauncey's RDS string — `intakeagent` is what his harness runs as, so
      rotating breaks his system until his `DATABASE_URL` changes

---

## Waiting on other people

| Who | What | Blocks |
|---|---|---|
| Chauncey | `MCP_ENDPOINT_URL` (SAM output) | every Workfront call |
| Chauncey | Workfront tenant access — still 401 | reconciliation |
| David / Dhanesh | Is there a brain definition I have not seen? Is phase 4 in the first build? **Is the rejection reason at 1.5 structured anywhere?** | `BRAIN-GAP.md` §2; Agent 2's whole design |
| Josh | Story Coach Report 2, Analyst Playbook, Story Coach zip; and a ruling on the Campbell naming problem | UI copy |
| Client | Is the 9:45pm job time fixed? | B6, and the cheapest win on the map |
| Bharat | Hosting target; Comcast logo asset | 1, 6 |

---

## Verified against Chauncey's MCP, 16 Sep 2026

Endpoint: `https://cryuy4x9n5.execute-api.us-east-1.amazonaws.com/mcp` (238 tools).
Recorded in `app/config/agent-systems.json`.

### The intake bug has a one-word cause

The knowledge tool is **`search_adobe_knowledge`**. **`search_knowledge_base` does not
exist** — zero matches across all 238 tools.

`intake/route.ts` calls `search_knowledge_base`, gets `Unknown tool`, writes the error
into its payload and returns `status: "completed"`. So every run has failed its grounding
step since the beginning, every run records as a clean success, and because `failed` never
fires Agent 4 has never once been invoked.

**Fix is one string in Chauncey's repo**, plus the allowlist entry in
`src/lib/pipeline/registry.ts`. Worth raising today — it is the cheapest win on the board.

### No Workfront tools are deployed

`/mcp/workfront/core`, `/comments`, `/search` and `/metadata` all return **zero tools**,
and no `wf_*` name appears among the 238.

So `wf_core_project_*`, `wf_core_issue_*` and `wf_comments_*` — the allowlists for Agents 1
and 2 — reference tools that are not deployed at this endpoint. **This blocks our Agent 2
from posting a redraft via `wf_comments_create`**, which is most of B2.

The code for them exists in `chaunceyplum/mcp` (ten Workfront Lambdas). Either they are
not deployed to this API Gateway, or they are behind a different one. **Ask Chauncey
which.** Until then Agent 2 can parse a rejection and decide `needs_input`, but it cannot
write back to Workfront.

### Agent 3 is genuinely ready

All of its AEP tools are live: `adobe_create_segment_estimate`, `adobe_get_segment_estimate`,
`adobe_list_schemas`, `adobe_get_schema`, `adobe_list_segments`. Chauncey's assessment that
Agent 3 is the most ready of the four is correct.
