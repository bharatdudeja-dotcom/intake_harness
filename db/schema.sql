-- Agentic harness observability schema. Applied against the SAME Postgres
-- instance the Python MCP server (chaunceyplum/mcp) uses for pgvector, but
-- deliberately separate tables — this harness's 3-agent pipeline is a
-- different concern from that repo's Python orchestrator (`executions` /
-- `execution_resources`), and the two must never collide on names or
-- semantics.
--
-- Three levels, matching how the pipeline actually runs:
--   runs       — one row per pipeline invocation (a marketer's request).
--   tasks      — a catalog of the task/agent *types* that can run
--                (intake, review, audience_creation). Static reference data,
--                seeded below from the pipeline registry.
--   task_runs  — one row per actual execution of a task within a run: which
--                task, in which run, at which step, with what status, and
--                exactly when it started/finished. This is the traceability
--                table — "what ran, per run, and when."
--
-- Idempotent — safe to re-run. CREATE-only except for the tasks catalog
-- upsert at the bottom, which only ever reflects the current registry.
--
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql

CREATE TABLE IF NOT EXISTS runs (
    run_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'needs_input')),
    current_step  INTEGER NOT NULL DEFAULT 0,
    input         JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tasks (
    task_id     TEXT PRIMARY KEY,     -- matches AgentName in src/lib/pipeline/types.ts
    label       TEXT NOT NULL,
    owner       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The audit trail the requirements doc keeps asking for (B1's loop count,
-- B7's request age, B9's failure classification all read off this table).
CREATE TABLE IF NOT EXISTS task_runs (
    task_run_id  BIGSERIAL PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    task_id      TEXT NOT NULL REFERENCES tasks(task_id),
    step_index   INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('completed', 'needs_input', 'failed')),
    input        JSONB NOT NULL,
    output       JSONB,
    message      TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    started_at   TIMESTAMPTZ NOT NULL,
    finished_at  TIMESTAMPTZ NOT NULL,
    duration_ms  INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_task_runs_run ON task_runs(run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON task_runs(task_id, started_at);

-- Seed/refresh the task catalog from src/lib/pipeline/registry.ts. Keep this
-- block in sync with that file — it's the one place both agree on task_id.
INSERT INTO tasks (task_id, label, owner) VALUES
    ('intake',            'Agent 1 — Intake',              'Dev 1'),
    ('review',            'Agent 2 — Review / Triage',     'Dev 2'),
    ('audience_creation', 'Agent 3 — Audience Creation',   'Dev 3 (you)')
ON CONFLICT (task_id) DO UPDATE SET label = EXCLUDED.label, owner = EXCLUDED.owner;
