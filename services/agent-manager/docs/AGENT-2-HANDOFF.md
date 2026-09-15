# Agent 2 — Review / Triage · team handoff

**Team:** Bharat, Dylan, Jeff. Uday has Agent 1 (Intake); Chauncey has Agent 3
(Audience Creation); Agent 2 is ours.

Chauncey's own note: B2 is *"the largest unclaimed gap in the map."*

## What Agent 2 is

**Today:** a pure pass-through. It returns `completed` every time and never
reads its input.

**Needed:** read a rejection reason, map it to the **specific missing field or
wrong source**, decide `needs_input` vs `completed`, and post the redraft via
`wf_comments_create`.

It is the Trickster in the story framing — the agent that introduces friction
deliberately so the system stays honest. See `docs/STORY.md`.

## Where it lives

`github.com/chaunceyplum/intake_harness`, at
`src/app/api/agents/review/route.ts`. TypeScript, a Next.js route handler.
**Do not change the contract** in `src/lib/pipeline/types.ts` — the orchestrator
and Agent 3 depend on it:

```ts
POST  { runId, input, priorOutputs }
  ->  { status: "completed" | "needs_input" | "failed",
        output?, message?, metadata? }
```

`metadata` is persisted alongside the task run but NOT passed to the next
agent — that is where health data goes.

## Tools it may call

Enforced in `src/lib/mcp-client.ts` against `allowedTools` in
`src/lib/pipeline/registry.ts`. A call to anything else throws before it leaves
the process. Agent 2's list:

```
search_knowledge_base
wf_core_project_get      wf_core_project_update
wf_core_issue_get        wf_core_issue_update
wf_comments_list         wf_comments_create
```

Verified against `chaunceyplum/mcp`: these names are real. `make_crud_tools`
generates `_list/_get/_create/_update/_delete/_set_custom_fields` for each
object, so `wf_core_issue_get` exists. Route is picked from the tool-name
prefix; `wf_comments_*` goes to `/mcp/workfront/comments`.

**You need `MCP_ENDPOINT_URL`** — the `McpEndpointUrl` SAM output from the
`chaunceyplum/mcp` deployment. Ask Chauncey. Without it no MCP call works.

## The one thing that must not be repeated

Agent 1 does this, in `intake/route.ts`:

```ts
} catch (err) {
  groundingHits = { error: (err as Error).message };
}
const response: AgentResponse = { status: "completed", ... };
```

The tool failed. The error went into the payload. The status still said
`completed`. Every run in the database records as a clean success while
`search_knowledge_base` has failed every single time, and because `failed` never
fires, Agent 4 is never called.

**Agent 2 must return `failed` when it fails and `needs_input` when it needs a
human.** That is most of B2's value on its own.

## Design already done — reuse it, don't rebuild it

Agent Manager already holds the part of Agent 2 that is genuinely hard: knowing
which field is at fault.

- `config/artifact.campaign-brief.yaml` — the **real** Comcast Campaign Brief
  form (v2, shared 15 Sep), every field with `required`, `required_when`,
  `blocks_submission`, `ambiguous_values`.
- `src/agent_manager/journey/artifact.py` — `validate()` returns `missing`,
  `ambiguous` and `invalid` **as field objects**, and `question()` turns them
  into the sentence a human is actually asked: *"The intake is missing:
  Campaign Name, Launch date. Is it enough for the task?"*

That is Chauncey's question — *"I need someone to validate whether what the
agent created is enough for the task"* — already answered, by field name.

**Suggested split:**

| Who | Piece |
|---|---|
| — | Port `validate()` to TypeScript, or expose it from Agent Manager as an HTTP call |
| — | Rejection-reason parsing: comment text -> which field it is complaining about |
| — | `wf_comments_create` redraft posting, and the `needs_input` return path |

Agree the split between the three of you; the pieces are independent.

## Definition of done

1. Given a rejection comment naming a problem, Agent 2 identifies **the field**,
   not just "incomplete".
2. Returns `needs_input` with a `message` a marketer can act on.
3. Posts the redraft to Workfront via `wf_comments_create`.
4. Returns `failed` — really `failed` — on an unrecoverable error, so Agent 4
   finally has something to classify.
5. Increments nothing silently: whatever it learns goes in `metadata`.

## Check the work in Agent Manager

Run the dashboard, ingest, and the run view shows Agent 2's step under **Road of
Trials** in Act 2. If the badge says `faulted` while the harness says
`completed`, the payload carries an error — that is the dashboard doing its job,
not a bug.
