# DECISIONS.md

Short entries. Decided, why, rejected.

## D0 · Agent Manager is a FORK of the cookbook, not a new build
**Decided.** Agent Manager starts from the Company Cookbook Connector source at
`TAP-CXM/TAP-Cookbook@98617f6`, path `tap-portability-layer/connector/`, copied
into `app/`. See `docs/LINEAGE.md`.
**Why.** This was Bharat's instruction from the start. Both kickoff briefs said
"do not import from, or modify, the cookbook codebase — this is a new build that
reuses its concepts", which was wrong and produced a greenfield Python app that
looked nothing like the cookbook. "Do not hamper the cookbook" meant leave the
original repo, its database and its running connector alone — not build something
new.
**Rejected.** The greenfield FastAPI/Jinja application. It is not deleted yet;
it remains open as PR #8 on `chaunceyplum/intake_harness` until its useful parts
are ported.

## D0a · The original cookbook is never modified
**Decided.** `TAP-CXM/TAP-Cookbook`, its deployed connector, its storage and the
`cookbook-connect` npm package are read-only. No commits, no migrations, no
config edits, no republishing.
**Why.** It is live and other people depend on it. If something there looks
broken it gets written down here and raised with Bharat, not fixed by us.

## D0b · Agent Manager takes the cookbook's stack
**Decided.** Node.js on Adobe I/O Runtime. The Python 3.12 scaffold is gone.
**Why.** Python was chosen because Chauncey's repo is Python. We never import his
code — we call his MCP over the wire — so his language was never relevant to
ours. Where a name is only a label, it is ours to choose; where it is a stored value, it is not.

## D1 · Rename the visible layer; stage the plumbing
**Decided.** Every string a person sees is renamed (Project→Programme,
Recipe→Run, Step→Event, Chef→Marketer, Head Chef→Hero Agent, Practice→Agent,
Company CX Graph→Shared Knowledge Graph, Active Tasks→Live Queue, Cook-off
removed). Storage keys, MCP tool names and JSON field names keep their original
names for now.
**Why.** Tool names are what connected Claude clients call and field names are
what every stored document already uses — renaming them is a migration plus a
client-config change. It buys a client nothing they can see, and it would have
meant ~500 edits across 5,300 lines with no way to run the app and check.
**Verified.** All identifiers intact (`recipe_id`, `data-open-recipe`,
`linked_recipes`, the `head-chef` role value) and the 2256-line inline script
passes `node --check`.
**Rejected.** A blind global find-and-replace, which would have broken
`recipe_id`, `data-open-recipe` and the stored `head-chef` role value.

## D2 · Agents carry a mark, but the registry stays the source of truth
**Decided.** `AGENT_MARK` in the SPA decorates agent ids it recognises — intake,
review/triage, audience creation, escalation, mentor, human.
**Why.** A client watching the dashboard should see at a glance which agent
touched a run and where a human stepped in.
**How the constraint holds.** The map only decorates; the agent list still comes
from the registry at runtime. An agent with no mark still renders. No agent name
is hardcoded as a source of truth.

## D3 · Where a head chef approved, a human gates
**Decided.** The cookbook's two-tier consent stays, but the second tier becomes
a human-only gate. The Hero Agent proposes and has no code path that approves.
`promoted_by` must be a human account and is required for anything shared.
**Why.** If a reviewer asks "who decided this was true", the answer must always
be a person, by name. That is what makes the graph defensible to Comcast.
**Where it lands.** `callerHasRole(context, 'head-chef')` in
`actions/mcp-server/tools.js` and the `cx_approved` flip in `lib/cx-graph.js`.

## D9 · Workfront goes through the in-house MCP estate
**Decided.** `chaunceyplum/mcp` — fifteen Lambdas behind one API Gateway, ten of
them Workfront — not Adobe's official connector.
**Why.** Those Lambdas already authenticate via Workfront IMS, which is published
API access, so the Experience Cloud ToU 8.1 argument does not rule them out.
They are already deployed and already scoped per agent.
**Note.** This contradicts the standing constraint in both kickoff briefs, which
said to use the official Adobe connector. Bharat decided otherwise.

## D10 · The Workfront object model is confirmed, not guessed
**Decided.** OPTASK = CSC Intake Issue, PROJ = Campaign Brief / CSC Campaign,
DOCU = asset, with real custom-form ids.
**Why.** Chauncey's caveat was that the agents' `wf_core_*` usage was "a draft
guess, not confirmed against Comcast's real Workfront object model". The forms
list shared on 15 September settles it.

---

# Open, and owned by a human

1. **`MCP_ENDPOINT_URL`** — the McpEndpointUrl SAM output from
   `chaunceyplum/mcp`. Ask Chauncey. Blocks every Workfront call.
2. **Workfront tenant access** — `taplondonptrsd.my.workfront.com` still 401.
3. **A new App Builder namespace** for CX Agent Manager. Until then it cannot deploy
   without overwriting the original connector — the single most important thing
   to get right before any deploy.
4. **Retention window and access control.** CX Agent Manager keeps the cookbook engine's
   retention. There is no per-marketer access restriction: anyone with dashboard
   access sees every marketer's runs. Both need an answer before real Comcast
   data lands in a Tap-controlled environment.

# Raised upstream, not fixed here

Found in `chaunceyplum/intake_harness` while building. Reported, not touched:

- `search_knowledge_base` fails on every live run with `Unknown tool`, and
  `intake/route.ts` catches it, writes it into the payload, and still returns
  `status: "completed"`. Every run records as a clean success.
- Because `failed` never fires, Agent 4 (Escalation) is never invoked. The
  escalation wiring in `orchestrator.ts` is correct; it is waiting on a status
  that never arrives.
- The harness at `34.203.238.63:3000` has no authentication on any route,
  including `POST /api/runs`.

---

## D13 · Keep our own store. Do not share Chauncey's RDS.
**Decided** (Bharat, 16 Sep). Agent Manager persists through `lib/storage/`.
The upstream run is held as a typed reference `{system_id, upstream_run_id}`,
resolved through the adapter — **never a database foreign key across the
boundary.**
**Why.** It dissolves the boundary if two services write the same tables; the
lifecycles differ (his schema mutates as agents get built, ours is append-only
evidence); the record has to outlive the agent system; a multi-domain hub cannot
live inside one domain's agent store; and his RDS is on AWS while we deploy to
Cloud Run.
**Checked before committing to it.** His schema is three tables — `runs`,
`tasks` (a static 4-row catalog), `task_runs`. No classification store, no
history, no aggregates. `task_runs.metadata` is per-step JSONB that dies with
its run. **We are adding, not duplicating.** Chauncey said the same himself:
Agent 4 needs *"somewhere persistent to accumulate classifications across runs."*

## D14 · No Postgres. CX Agent Manager keeps the cookbook engine's store.
**Decided** (Bharat, 16 Sep, correcting the v2 brief). The v2 brief specified
Cloud SQL Postgres; it was written before we knew the cookbook persists to
object storage through `lib/store.js`. Bolting a relational database alongside
is exactly the re-architecting CX Agent Manager exists to avoid.
**On filtering.** Queue filters by marketer, agent, status and date read fine
from object storage at the volumes expected for months.
**Trigger condition, written down now so it is deliberate rather than
rediscovered under pressure:** add a read-model index when a single view needs
more than ~2s at p95, or when a filtered query has to scan more than ~2,000
recipe documents to render one page. When that day comes it arrives as **another
driver behind the same interface**, not a second persistence layer beside it.
**Rejected.** Adding Postgres speculatively.

## D15 · Multi-domain uses the axis the cookbook already has
**Decided.** No `domain` table. `practice` is already the domain axis, already
wired through recipes, filters and the graph.

```
practice            (domain)    aem | aep | campaign | workfront-intake ...
  └── agent_system  (upstream)  one row per executing system, with its adapter
        └── agents              discovered from that system, never hardcoded
programme -> run -> event       (the record)
```

- **`agent_systems` is a registry, not an enum.** One row per upstream, each
  carrying its adapter, transport and auth. Chauncey's Workfront agent system is
  the first row. Same rule as agent names: **a system named in source outside
  its own adapter is a mistake.**
- **A practice may have zero or many agent systems**, and an agent belongs to a
  *system*, not directly to a practice — otherwise the second domain reshapes
  the table again.
- Extend the practice registry with what a domain needs that the cookbook did
  not: its adapter, default segmentation labels, active flag. Existing values
  keep working.

## D16 · Service accounts for deployment
**Decided.** A dedicated service account, never default compute, which holds
Editor.
- Cloud Run SA: `roles/storage.objectAdmin` **scoped to the bucket**, and
  `roles/secretmanager.secretAccessor` **scoped to the named secrets**.
- `roles/cloudsql.client` is **not granted** — D14 means no relational store.
- Cloud Scheduler gets its **own** SA with `roles/run.invoker` and nothing else.
- The token guard on `/internal/purge` and `/internal/cx-refresh` stays. IAM and
  the token are independent controls and both are cheap.

## D17 · Story beats corrected; the UI naming question is open
**Decided.** `docs/STORY.md` is rewritten from Josh's deck. "Meeting with the
Mentor" was mine, not Josh's — it is Vogler's Act 1 beat. Josh's Act 2 beat in
that position is "Meeting w/ the Goddess", and "Belly of the Whale" closes
Act 1, not Act 2.
**Open, and not mine to settle.** Two of Josh's Act 2 beats are Campbell's
originals — *"Woman as Temptress"* and *"Atonement w/ the Father"*. Correct in a
methodology deck; not viable as headings on a dashboard a Comcast marketer opens
daily. Recommendation: keep the beats as internal methodology and give the UI
plain process names. `config/` carries both, so it is a label swap.
**Needs:** Bharat and Josh.

---

# Credential exposure — logged, per the brief

**Exposed in session transcript, scrollback and on disk (15–16 Sep 2026):**

1. **Cookbook login** `walter.white` — pasted in chat to reconfigure the MCP
   server, and now stored **in plaintext** in `~/.claude.json` as an
   `x-cookbook-login` header. Note `cookbook-jesse`'s credential sits in the
   same file the same way, and `~/Downloads` holds several
   `cookbook-login-*.txt` handouts.
2. **Chauncey's intake Postgres connection string** — pasted into team chat.
   `postgresql://intakeagent:***@postgres.***.us-east-1.rds.amazonaws.com:5432/intake`.
   It is in **no file in this repo**.

**Rotation status: NOT DONE. Both need a human.**

- The cookbook password: I am authenticated *as* `walter.white`, so changing it
  would sign Bharat out mid-session and invalidate the `~/.claude.json` header I
  was asked to write. **It must be changed by Bharat, and `~/.claude.json`
  updated in the same pass, or the MCP connection breaks.**
- The RDS credential is **Chauncey's**, not ours. `intakeagent` is the account
  the harness itself runs as, so rotating it **will break his running system**
  until his `DATABASE_URL` is updated. It has to be his change, coordinated —
  raising it now rather than after.

**Neither is safe to rotate silently, and both must be rotated before this
holds Comcast data.** Recorded here because an undocumented exposure is worse
than the exposure.
