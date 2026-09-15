# Corrections to UPSTREAMS.md

Phase 0 was done from the live HTTP surface alone, because the repo was thought
to be unavailable. `github.com/chaunceyplum/intake_harness` was then shared, and
reading it corrects three findings. Recorded here rather than edited silently
into the original, so the reasoning stays auditable.

## C1 — There IS a discovery endpoint: `GET /api/tasks` — **corrects section 2.1**

Phase 0 concluded no registry could be discovered, having probed `/api/agents`
(404). `/api/tasks` was never tried. It exists, it is live, and it serves the
`tasks` catalog seeded from `src/lib/pipeline/registry.ts`:

```json
{"tasks":[{"task_id":"intake","label":"Agent 1 — Intake","owner":"Dev 1", ...}]}
```

Discovery is now enabled (`config/agents.yaml`), and config is an overlay for the
fields the catalog does not carry — version, role, capabilities. The "ask
Chauncey to add GET /api/agents" item is **withdrawn**; he already built it.

Still true: there is no MCP and no `tools/list` **on the harness**. But there is
one next door — see C3.

## C2 — The escalation path is wired correctly; failures simply never fire — **refines section 2.2**

Phase 0 said a failure "cannot currently reach Agent 4". The wiring is in fact
right: `orchestrator.ts` calls Agent 4 exactly when a step returns `failed`, and
deliberately not on `needs_input`, which is a resumable pause. `escalation` is
excluded from `PIPELINE` on purpose — it is the handler for when the happy path
does not happen, not step 4 of it.

The real defect is narrower and better evidenced. In
`src/app/api/agents/intake/route.ts`:

```ts
} catch (err) {
  // Non-fatal for the stub — a real implementation would decide whether a
  // grounding failure means "ask the marketer" (needs_input) or a hard fail.
  groundingHits = { error: (err as Error).message };
}
const response: AgentResponse = { status: "completed", ... };
```

The catch swallows the failure into the payload and the handler still returns
`completed`. So `status` never becomes `failed`, so Agent 4 is never called. The
database even has `CHECK (status IN ('completed','needs_input','failed'))` — the
vocabulary is real and simply unexercised.

`search_knowledge_base` **is** in intake's `allowedTools`, so this is not a
scoping violation being caught. The tool is genuinely missing on the MCP server
being called. Both points go to Chauncey; the second is a bug in a different
repo.

## C3 — There is a large existing MCP estate, including Workfront — **changes section 3**

`src/lib/mcp-client.ts` documents `chaunceyplum/mcp`: fifteen Lambdas behind one
API Gateway. One is the original AEC server (238 Adobe/AWS/Databricks/Snowflake/
GitHub tools). Ten are **Workfront**: `wf_core_*`, `wf_users_*`, `wf_docs_*`,
`wf_time_*`, `wf_metadata_*`, `wf_search_*`, `wf_comments_*`, `wf_planning_*`,
`wf_misc_*`, plus five Fusion routes. They authenticate via Workfront IMS and
Adobe IMS with SSM-resolved credentials.

This changes the Adobe posture question materially. The brief assumed the only
lawful route was Adobe's official connector. But these Lambdas are not
HAR-derived internal endpoints either — they use published API authentication.
So there are now two legitimate options and the choice is about support burden
and permission model, not compliance. See DECISIONS.md D9; it needs a human
decision.

Also worth noting: least privilege is enforced in `callMcpTool` against each
agent's `allowedTools`, and the orchestrator filters `priorOutputs` down to each
agent's declared `contextAccess`, so an agent never receives a key it is not
scoped to see. That is better governance than the brief assumed, and Agent
Manager should surface it rather than duplicate it.

## Unchanged

- `run_id` (UUID) is the join key; `task_run_id` is `BIGSERIAL` **per step**.
  `db/schema.sql` confirms both, and confirms the brief's
  `runs.upstream_task_run_id` is the wrong grain.
- Capture is polled and reconstructed, not intercepted.
- The harness has no authentication on any route.
- `loopCount` is per-step and inconsistently shaped.
- The Workfront tenant is still 401 to us.
