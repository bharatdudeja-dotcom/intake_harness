# DECISIONS.md

Short entries. Decided, why, rejected.

---

## D1 · The process is data, not code
**Decided.** Acts, stages, artifacts, approver roles and gates live in
`config/*.yaml`. Nothing in `src/` names an act, a stage, an agent or a client.
**Why.** "We should be able to take any as-is process, imagine a future process
and feed it into this solution. Should be highly reusable." A hardcoded Xfinity
intake would have to be rewritten for the second client.
**Rejected.** Python constants per stage; a migration per new process.

## D2 · "Hero Agent" is renamed the Mentor Agent
**Decided.** The curating agent is the Mentor. The **hero is the data**.
**Why.** Josh's deck, principle 3: "The data is the hero; the team is the
author." The brief already described this agent as the mentor; only the label
changed, so that "hero" can mean one thing consistently. Act 3's "return with
new mastery" is then the recursive learning loop, which is the product thesis.
**Rejected.** Keeping "Hero Agent" and having "hero" mean the agent in one place
and the marketer in another.

## D3 · The Mentor Agent has no promotion code path
**Decided.** `mentor/curator.py` contains no function that writes
`status='promoted'` or sets `promoted_by`. Promotion lives in
`knowledge/promote.py` and takes a `HumanSession` that refuses a service
principal. Enforced by a CHECK constraint (`scope='shared'` requires
`promoted_by`), by `users.is_human`, and by a test that asserts the Mentor Agent
is refused.
**Why.** If a reviewer asks "who decided this was true", the answer must always
be a person. That is worth more than the throughput a self-approving agent buys.
**Rejected.** A confidence threshold above which the agent promotes itself.

## D4 · The event log is append-only, enforced twice
**Decided.** A SQLAlchemy `before_flush` guard raises on any update or delete of
an `Event`; a Postgres trigger does the same server-side. Corrections append a
new event with `corrects_event_id`.
**Why.** A record that can be silently rewritten is not evidence. The ORM guard
works on SQLite too, so local development cannot drift from the guarantee.
**Rejected.** Trigger only — it would not fire in local SQLite dev.

## D5 · A stage badge is derived from evidence, not from an upstream status
**Decided.** `stage_state()` walks each event's payload looking for an embedded
error, checks reconciliation verdicts, and only then calls a stage done.
**Why.** Live run `f152405e` reported `status: "completed"` while carrying
`Unknown tool: search_knowledge_base` in its output. Trusting the status field
records that run as a clean success. This is the clearest demonstration of why
the product exists, so the dashboard must not reproduce the error.
**Rejected.** Mapping upstream status straight to a badge colour.

## D6 · Capture is polled and reconstructed, not intercepted
**Decided.** Say so plainly in the docs and the code.
**Why.** The brief claims capture is "a property of the call path" so that "an
agent cannot skip it". That holds for Workfront, which we proxy. It does not
hold intra-pipeline: the harness calls its agents server-side, so we read
`/api/runs/{id}` afterwards. Claiming an interception we do not have would be a
claim a reviewer could disprove.
**Rejected.** Describing the gateway as intercepting agent traffic.

## D7 · The registry reads `GET /api/tasks`, with a config overlay
**Decided.** Discovery is live against the harness's own `tasks` catalog.
`config/agents.yaml` enriches each entry with version, role and capabilities,
matched on id, and supplies agents that exist only on our side.
**Why.** "If you type four agent names into source code, you have made a
mistake." An initial probe of `/api/agents` returned 404 and led to the
conclusion that no discovery endpoint existed; reading the repo showed
`/api/tasks` serves exactly that catalog, seeded from the harness's own pipeline
registry. A fifth agent now appears in the dashboard without anyone editing
anything.
**Rejected.** A config-only registry; scraping the home page HTML.

## D8 · `runs.upstream_run_id`, not `upstream_task_run_id`
**Decided.** The join key is the harness's `run_id` (UUID, one per intake) on
`runs`. Its `task_run_id` is a `BIGSERIAL` per *step* and lives on `events`.
**Why.** The brief put `upstream_task_run_id` on `runs`, which is the wrong
grain — one run has many task_runs. Confirmed against `db/schema.sql`.
**Rejected.** A single upstream id column on `runs`.

## D9 · Workfront connector — OPEN, needs a human decision
**Not decided. Raising it rather than choosing quietly.**
Two real options now exist:
1. **The official Adobe Workfront MCP** (`https://mcp.workfront.adobe.com/mcp/v1/workfront`),
   OAuth as the signed-in user. What the brief mandates. Write tools are OFF by
   default and need a tenant admin; tool names are unpublished and must be read
   from `tools/list`.
2. **Chauncey's own Workfront MCP Lambdas** in `chaunceyplum/mcp` — ten
   Workfront routes (`wf_core_*`, `wf_comments_*`, `wf_docs_*`, `wf_metadata_*`,
   `wf_search_*`, `wf_planning_*`, …) already deployed, already authenticating
   via Workfront IMS, already scoped per agent.
The brief's ToU 8.1 argument does **not** rule out option 2: his Lambdas use
Workfront IMS, which is published API access, not a HAR-derived internal route.
So this is a genuine build-vs-reuse decision about support burden and
permission model, not a compliance one. `adapters/workfront.py` targets option 1
today and is the only file that would change.
**Needs:** a call between Bharat and Chauncey.

## D10 · The Workfront object model is now confirmed, and pinned
**Decided.** `config/workfront.yaml` records the real object codes and custom
form IDs shared on 15 September — `OPTASK` for the CSC intake issue, `PROJ` for
Campaign Brief and CSC Campaign, `DOCU` for assets.
**Why.** Chauncey's caveat was that `wf_core_*` usage was "a draft guess, not
confirmed against Comcast's real Workfront object model". It no longer has to
be a guess.
**Rejected.** Continuing to treat the object model as unknown.

## D11 · The real intake form is a validatable artifact spec
**Decided.** The Campaign Brief form (v2, shared 15 September) is
`config/artifact.campaign-brief.yaml`, with `required`, `required_when`,
`blocks_submission` and `ambiguous_values` per field.
**Why.** Chauncey asked, "I need someone to validate whether what the agent
created is enough for the task." The validator answers by naming the field at
fault, and the gate question is generated from that rather than saying
"incomplete". It also gives the Mentor Agent something concrete to notice —
"Where does this data live today?" came back "Not sure".

---

# Data handling

Required before the first run against real Comcast data, per the brief's
standing constraints. Capture being invisible in the UX is a design goal;
capture being undisclosed is not.

**What is logged.** Every prompt a marketer submits, verbatim, as event 0. Every
agent call and its full input and output, as reported by the harness. Every
Workfront write we make and the object we read back to verify it. Every human
gate decision, with the deciding person's name, timestamp and note. Every
knowledge node, with the person who promoted it.

**Whose work.** The marketer who submits the brief, and every human who approves
a gate or promotes a node. Named, not pseudonymised — attribution is the point.

**Where it sits.** Cloud SQL Postgres in a Tap-controlled GCP project. Comcast
campaign briefs and Workfront object contents will therefore be held by Tap.
**This needs Comcast's explicit agreement before the first real run.**

**Who can see it.** Anyone with dashboard access sees all runs, all marketers and
all promoted knowledge. There is no per-marketer access control in this build.
If that is not acceptable, it must be built before the first real run, not after.

**Retention.** Not yet set. Because the log is append-only, deletion is a
deliberate operation, not a side effect — which is the right default, but it
means a retention period has to be chosen rather than inherited. **Open.**

**Secrets.** The Adobe OAuth credential and the JWT signing key belong in Secret
Manager. Note that a live Postgres connection string for the intake database was
shared in team chat in plaintext; it must not be committed to any repository,
and it should be rotated.

**What is not logged.** Nothing is inferred about a marketer's performance.
`model`, `client` and `tokens_used` are recorded as metadata and no code branches
on them.
