# Why there is a Python service in this repo

`services/agent-manager/` is **not part of the harness**. It does not run inside
it, is not imported by it, and nothing here needs to be installed to build or
run the Next.js app.

It is a separate service that **reads** this system over HTTP and adds the one
thing no single run can provide: memory across runs.

## What it does not touch

Orchestration, scoping, per-run observability and `task_runs` stay exactly where
they are. Agent Manager owns only what spans runs — an append-only event log,
reconciliation against Workfront, human gates, and a knowledge graph that
accumulates.

**This PR changes zero existing files.** Everything lives under `services/`.

## How the coupling is kept loose

| Concern | How |
|---|---|
| Code | No imports either way. Communication is HTTP only. |
| Agent names | Read from `GET /api/tasks` at runtime. Nothing hardcoded — add a fifth agent and it appears without a code change here. |
| The upstream's shape | Confined to one file, `gateway/adapters/chauncey.py`. Nothing else knows this repo exists. |
| Reads | `GET /api/runs`, `GET /api/runs/{id}`, `GET /api/tasks`. |
| Writes | **None.** It never writes to this system. |
| Workfront | Through the existing `chaunceyplum/mcp` estate, not a second connector. |
| Build | Python, self-contained in this folder. `npm run build`, `npm run lint` and `tsc` are unaffected — there are no `.ts` files here. |
| Ignores | `services/agent-manager/.gitignore` re-includes its own `.env.example`, which the root `.gitignore`'s `.env*` rule would otherwise swallow. The root file is untouched. |

If this directory were deleted, the harness would behave identically.

## Why it lives here rather than in its own repo

When `src/lib/pipeline/types.ts` or `registry.ts` changes, the adapter that
depends on them can change in the same commit. That is the only reason. If that
stops being worth it, the folder lifts out whole — it has its own
`pyproject.toml` and no path dependency on anything above it.

## The thing it already found

Run `f152405e`: `search_knowledge_base` returned `Unknown tool`, and the step
still reported `status: "completed"`. The error travelled downstream as ordinary
data. Every run in the database records as a clean success — and because
`failed` never fires, Agent 4 is never invoked.

`src/app/api/agents/intake/route.ts`:

```ts
} catch (err) { groundingHits = { error: (err as Error).message }; }
const response: AgentResponse = { status: "completed", ... };
```

The escalation wiring in `orchestrator.ts` is correct. It is waiting on a status
that never arrives.

A per-run view cannot see this. Agent Manager badges those stages `faulted`
against the harness's own `completed`, and counts the recurrence across runs —
which is the persistent home for classifications that Agent 4 is described as
needing.

## Read next

`README.md` here, then `docs/UPSTREAMS-CORRECTIONS.md` (what reading this repo's
source corrected in our earlier assumptions), `docs/DECISIONS.md` (D1–D11), and
`docs/AGENT-2-HANDOFF.md` (the Agent 2 brief).
