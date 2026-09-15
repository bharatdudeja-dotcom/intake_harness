# intake_harness

A Next.js orchestration layer for the Comcast audience-pipeline agents. It
calls the existing Python MCP server (deployed from **chaunceyplum/mcp**)
over HTTP for everything Adobe/Postgres/vector-search related — it does not
duplicate AEP auth, Postgres access, or the pgvector RAG layer. Every agent
reaches those through `src/lib/mcp-client.ts`.

## Why this shape

Four agents: three run in a fixed sequential order — Intake → Review/Triage
→ Audience Creation — passing one agent's output as the next agent's input.
The fourth, Escalation, isn't part of that sequence at all: it's invoked
exactly once, out-of-band, when a run fails.

The requirements doc behind this (blockers B1–B9) found that the process
itself mostly works — the actual failure mode is **silent waiting**:
unbounded marketer round-trips (B1), a nightly job that turns every rework
cycle into a full day (B6), an open cross-team request nobody is tracking
(B4), and — per B9 — a process that can terminate without an audience while
"nothing is captured." So instead of each agent calling the next one
directly, a single orchestrator (`src/lib/pipeline/orchestrator.ts`) calls
each agent's endpoint in turn and persists a row to Postgres after every
step. That gives:

- A visible, queryable status for any in-flight run (`GET
  /api/runs/[runId]`) instead of a black box — directly answering B3/B4/B7's
  complaint that the marketer only finds out something is wrong when it's
  already expensive.
- A pause state (`needs_input`) distinct from failure, for the doc's
  human-in-the-loop points (B1's marketer round-trip, B3's validation step)
  — the pipeline stops cleanly rather than erroring out.
- A real answer to B9: when a run's status becomes `failed` (never on
  `needs_input`, which is an expected pause, not a termination), the
  orchestrator calls Agent 4 — Escalation with the failed task, the step
  index, the error, and every prior agent's output, so the failure is
  logged and classified instead of the run just silently stopping.
- Each agent stays an independent, independently testable endpoint — you
  can `curl localhost:3000/api/agents/audience-creation` on its own without
  running the rest of the pipeline, and a dev can rewrite what's inside
  their route freely as long as the request/response shape holds.

## Architecture

```
POST /api/runs  { input }
        │
        ▼
  src/lib/pipeline/orchestrator.ts
        │  for each agent in src/lib/pipeline/registry.ts's PIPELINE:
        │    POST <agent.path>  { runId, input, priorOutputs }
        │    persist a task_runs row (run_id, task_id, step_index, started_at, finished_at)
        ▼
  /api/agents/intake            (Dev 1)
  /api/agents/review            (Dev 2)
  /api/agents/audience-creation (Dev 3 — you)
        │  each agent, as needed:
        ▼
  src/lib/mcp-client.ts  →  routes by tool-name prefix to one of 15 MCP Lambdas
        │
        ▼
  chaunceyplum/mcp: 238 AEC tools + 9 Workfront + 5 Fusion servers

  ── on any step's status === "failed" (not "needs_input") ──▶

  /api/agents/escalation (Agent 4 — Escalation, unassigned)
        called by the orchestrator directly, NOT as pipeline step 4 —
        gets the failed task, step index, error, and every prior agent's
        output; classifies the failure (B9) instead of the run going silent
```

`GET /api/runs/[runId]` returns the run plus every task run recorded so
far — poll this for status instead of guessing whether a run is still going.

## Observability: runs, tasks, task runs

Three tables (`db/schema.sql`), matching how the pipeline actually executes:

| Table | Row = | Primary key | What it's for |
|---|---|---|---|
| `runs` | one pipeline invocation | `run_id` | "Did this marketer's request finish? What's its current status?" |
| `tasks` | one task/agent *type* (intake, review, audience_creation, escalation) | `task_id` | A static catalog — human label + owner per agent, kept in sync with `src/lib/pipeline/registry.ts`'s `ALL_TASKS`. |
| `task_runs` | one actual execution of a task, inside one run | `task_run_id` | The traceability record: which task, in which run, at which step, with what input/output, and exactly when it started and finished. |

`task_runs` is the audit trail the requirements doc keeps asking for — B1's
loop count, B7's request age, B9's failure classification, all read off
this one table, filterable by `run_id` (everything that happened in one
run) or `task_id` (every time one agent has ever run, across all runs).

API surface:

- `POST /api/runs` — start a new run.
- `GET /api/runs` — list recent runs.
- `GET /api/runs/[runId]` — one run plus its task_runs, in step order.
- `GET /api/tasks` — the task catalog.
- `GET /api/tasks/[taskId]/runs` — every execution of one task, across all
  runs, most recent first — useful for "how has Audience Creation been
  doing lately" independent of any single run_id.

The homepage (`src/app/run-dashboard.tsx`) is a thin client over this same
API: a list of recent runs on the left, and the selected run's task_runs
(with `task_run_id`, status, timing, input/output) on the right.

## The agent contract (`src/lib/pipeline/types.ts`)

Every agent route receives:

```ts
{ runId: string, input: <previous agent's output>, priorOutputs: { intake?, review?, audience_creation?, escalation? } }
```

(For Escalation specifically, `input` isn't a "previous agent's output" —
the orchestrator builds it as `{ failedTask, failedStepIndex, message,
input }` describing what failed. Everything else about the contract is
identical.)

and must return:

```ts
{ status: "completed" | "needs_input" | "failed", output?, message?, metadata? }
```

- `completed` → `output` becomes the next agent's `input`.
- `needs_input` → the run pauses (e.g. the marketer needs to confirm
  something); `message` should say what's needed.
- `failed` → the run stops; `message` should say why.
- `metadata` is recorded on the step but never forwarded downstream — use it
  for the health signals the doc calls out (loop counts, request age,
  predicted counts) without polluting the next agent's input.

To add another **sequential** agent: add one entry to `PIPELINE` in
`src/lib/pipeline/registry.ts` and create its route under
`src/app/api/agents/<name>/route.ts`. Nothing else changes. To add another
**failure-handler** agent (alongside Escalation, not instead of it), follow
the same pattern but wire it into `orchestrator.ts`'s failure branch
instead of `PIPELINE` — it won't run unless something explicitly calls it.

## Least privilege: scoping tools and context per agent

Three developers, three routes, and — as of chaunceyplum/mcp#34 — **15
separate MCP Lambdas** (the original 238-tool AEC server plus 9 Workfront
and 5 Fusion servers, see the route table atop `src/lib/mcp-client.ts`).
Without scoping, any agent could call any tool on any of those 15 servers,
or read any other agent's raw output. `src/lib/pipeline/registry.ts` is
where each agent's permissions are declared, and both are enforced, not
just documented:

- **`allowedTools`** — the MCP tool names a task may call, regardless of
  which of the 15 servers actually serves them. `src/lib/mcp-client.ts`'s
  `callMcpTool(taskId, name, args)` checks the caller's `taskId` against
  this list, then resolves the correct server from the tool name's prefix
  (`wf_core_*` → workfront-core, `fusion_scenario_*` → fusion-scenarios,
  etc.) — the request never leaves this process if the tool isn't allowed.
  Since agent routes don't hold Lambda credentials of their own — they only
  reach any of these servers through this one function — there's no way
  around the check short of editing the registry. A denied call bubbles up
  as a normal agent failure, so it lands in `task_runs.status = 'failed'`
  automatically (see Observability above) rather than failing silently.
- **`contextAccess`** — which prior agents' outputs a task may see via
  `priorOutputs`, beyond its own immediate `input` (always just the
  previous agent's output). `src/lib/pipeline/orchestrator.ts` filters the
  full accumulated `priorOutputs` down to exactly this list before every
  HTTP call — an agent's request body never contains a key it isn't scoped
  to see.

Current allowlists — **Intake and Review's Workfront tools are a first
draft**, not a confirmed final scope. They're a least-privilege guess at
what B1/B2 in the requirements doc need (create/read the work request;
read/update + comment during triage), picked from the real tool names in
`mcp_server/workfront/servers/core/tools/core.py` and
`.../comments/tools/comments.py`. Confirm the actual Workfront object model
this team uses before treating these as final:

| Task | `allowedTools` | `contextAccess` |
|---|---|---|
| `intake` | `search_knowledge_base`; `wf_core_project_{list,get,create}`; `wf_core_issue_{list,get,create}` | *(none)* |
| `review` | `search_knowledge_base`; `wf_core_project_{get,update}`; `wf_core_issue_{get,update}`; `wf_comments_{list,create}` | *(none)* |
| `audience_creation` | `search_knowledge_base`, segment estimate/CRUD, schema read | *(none)* |
| `escalation` | `search_knowledge_base` | `intake`, `review`, `audience_creation` |

`escalation`'s broad `contextAccess` is deliberate, not a scoping gap — its
entire job (B9) is classifying what went wrong across the whole run, which
requires seeing everything that ran before the failure.

Note what's deliberately absent: no `_delete` tool anywhere, no Fusion
tools for either Workfront-scoped agent (Fusion is workflow automation, not
work-item data), and no `wf_users_*`/`wf_planning_*`/etc. — add them only
when a real implementation needs that specific server.

`contextAccess` is empty for all three today because none of the current
stubs read `priorOutputs` at all — each agent's `input` already carries
everything the previous agent produced. Widen a task's `contextAccess`
only when its real implementation needs to look back further than its
immediate `input` (e.g. Audience Creation wanting Intake's original,
untransformed grounding rather than whatever Review passed along).

## Setup

```bash
cp .env.local.example .env.local   # fill in MCP_ENDPOINT_URL and DATABASE_URL
psql "$DATABASE_URL" -f db/schema.sql
npm install
npm run dev
```

Open `http://localhost:3000` — it has a form that POSTs to `/api/runs`, a
list of recent runs, and a detail view of the selected run's task_runs.

### Migrating from the pre-observability schema

If you already applied an earlier copy of `db/schema.sql` (tables named
`pipeline_runs` / `pipeline_steps`), those are superseded by `runs` /
`tasks` / `task_runs` above and are safe to drop — nothing in this repo
reads them anymore:

```sql
DROP TABLE IF EXISTS pipeline_steps;
DROP TABLE IF EXISTS pipeline_runs;
```

## What's a stub right now

- **Intake** (`/api/agents/intake`): calls `search_knowledge_base` against
  the MCP endpoint's `adobe` namespace to prove the wiring, then passes the
  raw hits through. Real parsing (audience intent, required XDM fields, the
  FAC-vs-native flag) is Dev 1's.
- **Review** (`/api/agents/review`): pure pass-through. Real
  rejection-parsing/triage is Dev 2's — see B2 in the requirements doc.
- **Audience Creation** (`/api/agents/audience-creation`): returns a
  structurally complete `AudienceCreationOutput` (build path, attribute
  availability, open-request tracking, predicted count, identity gap) with
  placeholder values — the fields are derived directly from B4/B5/B6/B8 in
  the requirements doc so the next session can implement field by field
  instead of re-deriving the shape.
- **Escalation** (`/api/agents/escalation`, unassigned): does the minimum
  B9 asks for — logs the failure and returns a best-effort
  `FailureClassification` — with a starting taxonomy (`attribute_gap`,
  `fac_ambiguous`, `identity_mismatch`, `marketer_loop_exceeded`,
  `mcp_tool_denied`, `transport_error`, `unclassified`) drawn from the
  doc's own blockers. No persistent cross-run store yet — see the TODO in
  the route for the "crawl, walk, run loop" B9 describes.

## Known limitation: synchronous execution

`runPipeline` currently awaits every agent call and returns the final
state in one request/response cycle. That's fine while every agent is a
fast stub. Once Audience Creation is doing real work — especially the
GTO/FAC sub-workflow in B4/B5, which the doc says can run for a quarter —
this needs to become fire-and-poll: `POST /api/runs` returns `{ run_id }`
immediately, and the agent whose work is long-running updates its own
task_runs row out-of-band (e.g. a webhook callback into a
`PATCH /api/runs/[runId]/task-runs/[taskRunId]` route) while the
marketer-facing UI keeps polling `GET /api/runs/[runId]`.
