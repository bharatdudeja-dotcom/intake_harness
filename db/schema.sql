-- Agentic harness observability schema. Applied against the SAME Postgres
-- instance the Python MCP server (chaunceyplum/mcp) uses for pgvector, but
-- deliberately separate tables — this harness's 3-agent pipeline is a
-- different concern from that repo's Python orchestrator (`executions` /
-- `execution_resources`), and the two must never collide on names or
-- semantics.
--
-- Three levels, matching how the pipeline actually runs:
--   runs       — one row per pipeline invocation (a marketer's request).
--   tasks      — a catalog of the task/agent *types* that can run (intake,
--                review, audience_creation, and escalation — the last one
--                invoked only when a run fails, not part of the sequential
--                pipeline). Static reference data, seeded below from the
--                pipeline registry.
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

-- Two-tier human curation, added on top of the CREATE TABLE above via ALTER
-- so this stays safe to re-run against an already-populated `runs` table
-- (CREATE TABLE IF NOT EXISTS is a no-op on an existing table's columns).
--
-- Tier 1, "approved": a named admin marks a completed run worth keeping as
-- an example. Tier 2, "promoted": that same run is additionally admitted
-- into the cross-run Shared Graph (see GET /api/graph). Both always carry
-- who and when — an approval or promotion with no admin behind it isn't a
-- record of anything. Promotion requires prior approval, enforced in
-- src/app/api/runs/[runId]/promote/route.ts rather than a CHECK constraint,
-- to keep this file plain ALTERs.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS approval_note TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS promoted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS promoted_by TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_runs_promoted ON runs(promoted) WHERE promoted;

-- Per-agent human approval gate, mirroring how a tool call waits for
-- permission before it runs. A run now stops after EVERY successfully
-- completed step (not just a "needs_input"/"failed" one) and sits in
-- "awaiting_approval" until POST /api/runs/[runId]/continue advances it to
-- the next agent. Widens the CHECK constraint the original CREATE TABLE
-- shipped with — DROP + re-ADD is the only idempotent way to change a CHECK
-- in place, so this stays safe to re-run.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
    CHECK (status IN ('running', 'completed', 'failed', 'needs_input', 'awaiting_approval'));

-- Model usage, when an agent genuinely reports it. NULL on every agent
-- today — none of the four call a model, they're deterministic parsers and
-- MCP/tool calls — so this stays empty rather than holding a fabricated 0.
-- It exists for the day an agent does call one, via AgentResponse.usage.
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS tokens_used INTEGER;
ALTER TABLE task_runs ADD COLUMN IF NOT EXISTS model TEXT;

-- Seed/refresh the task catalog from src/lib/pipeline/registry.ts (PIPELINE
-- + ESCALATION, i.e. ALL_TASKS). Keep this block in sync with that file —
-- it's the one place both agree on task_id.
INSERT INTO tasks (task_id, label, owner) VALUES
    ('intake',            'Agent 1 — Intake',              'Dev 1'),
    ('review',            'Agent 2 — Review / Triage',     'Dev 2'),
    ('audience_creation', 'Agent 3 — Audience Creation',   'Dev 3 (you)'),
    ('escalation',        'Agent 4 — Escalation',          'Unassigned')
ON CONFLICT (task_id) DO UPDATE SET label = EXCLUDED.label, owner = EXCLUDED.owner;
