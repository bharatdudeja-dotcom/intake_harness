# Agent Manager

Cross-run memory, review and a knowledge graph over an agent pipeline.

The pipeline itself already exists — Chauncey's Agentic Harness runs one intake:
orchestration, agent invocation, scoping, per-run observability, `task_runs`.
**Agent Manager does not rebuild any of that.** It owns everything that spans
runs: the append-only log, reconciliation against the system of record, human
gates, and the knowledge that accumulates so the next run starts further along.

## The idea in one screen

A step in the upstream pipeline reported `status: "completed"` while carrying
`Unknown tool: search_knowledge_base` in its output. A per-run view records that
as a clean success. It has now happened on every run.

That is the whole argument. One run cannot see it. Something reading across runs
can.

## Run it

```bash
python -m venv .venv && .venv/Scripts/pip install -e .
python -m agent_manager.ingest                 # pull real runs from the harness
python -m uvicorn agent_manager.dashboard.app:app --port 8080
```

Then http://127.0.0.1:8080. SQLite locally; set `AM_DATABASE_URL` to a
`postgresql+psycopg://` URL for Cloud SQL.

```bash
python -m pytest tests -q                      # the three guarantees
```

## Onboarding a different process

Nothing in `src/` names an act, a stage, an agent or a client. To run a
different process, write YAML and restart:

| File | What it defines |
|---|---|
| `config/journey.*.yaml` | acts, stages, the artifact each stage produces, who approves it, where the gates are |
| `config/artifact.*.yaml` | an artifact's fields, and what makes it complete enough to submit |
| `config/agents.yaml` | agent discovery, plus the overlay of role/version/capabilities |
| `config/workfront.yaml` | the system-of-record object model and custom form ids |

## The three guarantees

1. **Events are append-only.** Updates and deletes raise, at the ORM layer and
   again in a Postgres trigger. Corrections append with `corrects_event_id`.
2. **Only a human promotes.** The Mentor Agent proposes and has no code path
   that approves. A shared node without a human promoter cannot exist.
3. **No code branches on the model or the vendor.** `model`, `client` and
   `tokens_used` are metadata. Swapping the model needs no migration.

Each is a test in `tests/test_guarantees.py`, not a comment.

## Layout

```
config/           the process, as data
src/agent_manager/
  journey/        acts, stages, artifact specs and validation
  gateway/        registry + adapters (chauncey.py is the only file
                  that knows the harness's shape)
  log/            models, append-only repo, reconciliation
  mentor/         proposes; no promotion path
  knowledge/      promotion; human sessions only
  gates/          signed review links, decisions
  dashboard/      FastAPI + Jinja2 + HTMX
  export/         portable JSON that means something on its own
docs/             UPSTREAMS, its corrections, STORY, DECISIONS
```

## Read first

- `docs/UPSTREAMS.md` — what the upstreams actually are
- `docs/UPSTREAMS-CORRECTIONS.md` — what reading the source changed
- `docs/STORY.md` — the naming, and why the hero is the data
- `docs/DECISIONS.md` — decided, why, rejected; plus the data-handling note
