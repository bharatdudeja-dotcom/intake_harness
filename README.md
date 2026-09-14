# intake_harness

A Next.js orchestration layer for the Comcast audience-pipeline agents. It
calls the existing Python MCP server (deployed from **chaunceyplum/mcp**)
over HTTP for everything Adobe/Postgres/vector-search related — it does not
duplicate AEP auth, Postgres access, or the pgvector RAG layer. Every agent
reaches those through `src/lib/mcp-client.ts`.

## Why this shape

Three agents, built by three different developers, run in a fixed order —
Intake → Review/Triage → Audience Creation — passing one agent's output as
the next agent's input.

The requirements doc behind this (blockers B1–B9) found that the process
itself mostly works — the actual failure mode is **silent waiting**:
unbounded marketer round-trips (B1), a nightly job that turns every rework
cycle into a full day (B6), an open cross-team request nobody is tracking
(B4). So instead of each agent calling the next one directly, a single
orchestrator (`src/lib/pipeline/orchestrator.ts`) calls each agent's
endpoint in turn and persists a row to Postgres after every step. That
gives:

- A visible, queryable status for any in-flight run (`GET
  /api/runs/[runId]`) instead of a black box — directly answering B3/B4/B7's
  complaint that the marketer only finds out something is wrong when it's
  already expensive.
- A pause state (`needs_input`) distinct from failure, for the doc's
  human-in-the-loop points (B1's marketer round-trip, B3's validation step)
  — the pipeline stops cleanly rather than erroring out.
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
        │  for each agent in src/lib/pipeline/registry.ts:
        │    POST <agent.path>  { runId, input, priorOutputs }
        │    persist a task_runs row (run_id, task_id, step_index, started_at, finished_at)
        ▼
  /api/agents/intake            (Dev 1)
  /api/agents/review            (Dev 2)
  /api/agents/audience-creation (Dev 3 — you)
        │  each agent, as needed:
        ▼
  src/lib/mcp-client.ts  →  POST {MCP_ENDPOINT_URL}  (JSON-RPC tools/call)
        │
        ▼
  chaunceyplum/mcp Lambda: 238 tools, Adobe IMS auth, pgvector RAG, Postgres
```

`GET /api/runs/[runId]` returns the run plus every task run recorded so
far — poll this for status instead of guessing whether a run is still going.

## Observability: runs, tasks, task runs

Three tables (`db/schema.sql`), matching how the pipeline actually executes:

| Table | Row = | Primary key | What it's for |
|---|---|---|---|
| `runs` | one pipeline invocation | `run_id` | "Did this marketer's request finish? What's its current status?" |
| `tasks` | one task/agent *type* (intake, review, audience_creation) | `task_id` | A static catalog — human label + owner per agent, kept in sync with `src/lib/pipeline/registry.ts`. |
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
{ runId: string, input: <previous agent's output>, priorOutputs: { intake?, review?, audience_creation? } }
```

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

To add a 4th agent: add one entry to `src/lib/pipeline/registry.ts` and
create its route under `src/app/api/agents/<name>/route.ts`. Nothing else
changes.

## Least privilege: scoping tools and context per agent

Three developers, three routes, one shared MCP endpoint with 238+ tools —
without scoping, any agent could call any tool or read any other agent's
raw output. `src/lib/pipeline/registry.ts` is where each agent's
permissions are declared, and both are enforced, not just documented:

- **`allowedTools`** — the MCP tool names a task may call.
  `src/lib/mcp-client.ts`'s `callMcpTool(taskId, name, args)` checks the
  caller's `taskId` against this list before the request ever leaves the
  process; a call to a tool outside it throws immediately. Since agent
  routes don't hold `MCP_ENDPOINT_URL` credentials of their own — they only
  reach the MCP Lambda through this one function — there's no way around
  the check short of editing the registry. A denied call bubbles up as a
  normal agent failure, so it lands in `task_runs.status = 'failed'`
  automatically (see Observability above) rather than failing silently.
- **`contextAccess`** — which prior agents' outputs a task may see via
  `priorOutputs`, beyond its own immediate `input` (always just the
  previous agent's output). `src/lib/pipeline/orchestrator.ts` filters the
  full accumulated `priorOutputs` down to exactly this list before every
  HTTP call — an agent's request body never contains a key it isn't scoped
  to see.

Current allowlists (Intake and Review are placeholders pending real logic;
tighten or widen as each agent's actual needs become concrete):

| Task | `allowedTools` | `contextAccess` |
|---|---|---|
| `intake` | `search_knowledge_base` | *(none)* |
| `review` | `search_knowledge_base` | *(none)* |
| `audience_creation` | `search_knowledge_base`, segment estimate/CRUD, schema read | *(none)* |

`contextAccess` is empty for all three today because none of the current
stubs read `priorOutputs` at all — each agent's `input` already carries
everything the previous agent produced. Widen a task's `contextAccess`
only when its real implementation needs to look back further than its
immediate `input` (e.g. Audience Creation wanting Intake's original,
untransformed grounding rather than whatever Review passed along).

**Open item — Workfront:** the chaunceyplum/mcp tool registry doesn't have
a Workfront module yet (today's tools are Adobe AEP/Reactor/CJA, AWS,
Databricks, Snowflake, GitHub). If Intake and/or Review need Workfront
access, that module needs to be added server-side first — the `allowedTools`
entries above have a `TODO(Workfront)` marker for exactly this.

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
