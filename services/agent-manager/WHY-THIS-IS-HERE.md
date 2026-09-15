# Why there is a second app in this repo

`services/agent-manager/` is **not part of the harness**. It does not run inside
it, is not imported by it, and nothing here is needed to build or run the
Next.js app.

It is a separate service that **reads** this system over HTTP and adds the one
thing no single run can provide: memory across runs.

## What it does not touch

Orchestration, scoping, per-run observability and `task_runs` stay exactly where
they are. Agent Manager owns only what spans runs — an append-only log,
reconciliation, human gates, and a knowledge graph.

**This branch changes zero existing files.** Everything is under `services/`.

## What it is

A fork of the TAP Company Cookbook connector (`TAP-CXM/TAP-Cookbook@98617f6`),
rebranded for Comcast/Xfinity intake. Node on Docker — it was Adobe I/O Runtime
and is now host-neutral, so it runs on Cloud Run, ECS, a plain VM or a laptop.

Earlier this directory held a Python app. That was a wrong turn: the brief said
to build fresh, when the instruction had always been to fork the cookbook. The
Python app is gone; this is the real thing.

## How the coupling is kept loose

| Concern | How |
|---|---|
| Code | No imports either way. HTTP only. |
| Agent names | Read from `GET /api/tasks` at runtime — a fifth agent needs no code change |
| This repo's shape | Confined to one adapter file |
| Reads | `GET /api/runs`, `/api/runs/{id}`, `/api/tasks` |
| **Writes** | **None. It never writes to the harness.** |
| Build | Node + Docker, self-contained. `npm run build`, `npm run lint` and `tsc` are unaffected — no `.ts` added |

Delete the folder and the harness behaves identically.

## Run it

```bash
cd services/agent-manager
docker compose up --build      # http://localhost:3000
```

## Read next

`README.md`, then `docs/COOKBOOK-FORK.md`, `docs/BRAIN-GAP.md` (the nine
blockers and what is unclaimed), `docs/DECISIONS.md`, and
`docs/AGENT-2-HANDOFF.md`.
