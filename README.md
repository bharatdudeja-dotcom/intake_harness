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
  /api/pipeline/run/[runId]`) instead of a black box — directly answering
  B3/B4/B7's complaint that the marketer only finds out something is wrong
  when it's already expensive.
- A pause state (`needs_input`) distinct from failure, for the doc's
  human-in-the-loop points (B1's marketer round-trip, B3's validation step)
  — the pipeline stops cleanly rather than erroring out.
- Each agent stays an independent, independently testable endpoint — you
  can `curl localhost:3000/api/agents/audience-creation` on its own without
  running the rest of the pipeline, and a dev can rewrite what's inside
  their route freely as long as the request/response shape holds.

## Architecture

```
POST /api/pipeline/run  { input }
        │
        ▼
  src/lib/pipeline/orchestrator.ts
        │  for each agent in src/lib/pipeline/registry.ts:
        │    POST <agent.path>  { runId, input, priorOutputs }
        │    persist a pipeline_steps row
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

`GET /api/pipeline/run/[runId]` returns the run plus every step recorded so
far — poll this for status instead of guessing whether a run is still going.

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

## Setup

```bash
cp .env.local.example .env.local   # fill in MCP_ENDPOINT_URL and DATABASE_URL
psql "$DATABASE_URL" -f db/schema.sql
npm install
npm run dev
```

Open `http://localhost:3000` — it has a form that POSTs to
`/api/pipeline/run` and renders each step's status live.

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
this needs to become fire-and-poll: `POST /api/pipeline/run` returns
`{ runId }` immediately, and the agent whose work is long-running updates
its own step out-of-band (e.g. a webhook callback into a
`PATCH /api/pipeline/run/[runId]/steps/[stepIndex]` route) while the
marketer-facing UI keeps polling `GET /api/pipeline/run/[runId]`.
