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

-- Seed/refresh the task catalog from src/lib/pipeline/registry.ts (PIPELINE
-- + ESCALATION, i.e. ALL_TASKS). Keep this block in sync with that file —
-- it's the one place both agree on task_id.
INSERT INTO tasks (task_id, label, owner) VALUES
    ('intake',            'Agent 1 — Intake',              'Dev 1'),
    ('review',            'Agent 2 — Review / Triage',     'Dev 2'),
    ('audience_creation', 'Agent 3 — Audience Creation',   'Dev 3 (you)'),
    ('escalation',        'Agent 4 — Escalation',          'Unassigned')
ON CONFLICT (task_id) DO UPDATE SET label = EXCLUDED.label, owner = EXCLUDED.owner;

-- ---------------------------------------------------------------------------
-- GATES: the approval at 1.5, and every other point the process waits at.
--
-- WHY THIS TABLE EXISTS
--
-- The pipeline used to run intake -> review -> audience_creation in one pass,
-- which meant Agents 2 and 3 ran on a brief nobody had approved. Both reported
-- `completed`. Agent 2's "completed" covered a comment read that had errored;
-- Agent 3's covered building nothing at all. Three green stages, one real one.
--
-- The map does not work that way. 1.5 is a decision - "Approved?" - and phase 2
-- begins at connector A, on the Yes branch only. So the run now STOPS after
-- intake and waits. A gated agent is not called, and writes no task_runs row:
-- it does not appear as pending, or completed, or anything. Nothing can report
-- a status for work it was never handed.
--
-- WHY A TABLE AND NOT A COLUMN
--
-- "Who owns the review queue decision at 1.5, and is the rejection reason
-- captured anywhere structured today?" is an open question in the blockers doc,
-- and B2 depends entirely on the answer. A decision row per gate, with who
-- decided and their reason, is that structure. It also makes the rejection
-- reason a first-class input to Agent 2's triage instead of something the agent
-- has to go fishing for in a comment stream it may not be able to read.
CREATE TABLE IF NOT EXISTS run_gates (
    gate_run_id  BIGSERIAL PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
    -- Which gate, e.g. 'approval_1_5'. Matches a gate id in pipeline/gates.ts.
    gate_id      TEXT NOT NULL,
    -- The pipeline step this gate stands in front of.
    step_index   INTEGER NOT NULL,
    decision     TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    -- A named human. B4/B7 are both about things sitting unowned; an approval
    -- with nobody's name on it is the same failure in miniature.
    decided_by   TEXT NOT NULL,
    -- On a rejection this IS the rework reason, and it is what Agent 2 triages.
    reason       TEXT,
    -- Where the decision came from: the Workfront approval, the dashboard, MCP.
    evidence     JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_gates_run ON run_gates(run_id, decided_at);

-- A run waiting at a gate. Null when it is not waiting.
-- Carries { gate_id, label, step_index, agent, awaiting } so the dashboard can
-- say what is being waited FOR, which B4 insists on: "give the marketer a
-- visible status instead of silence."
ALTER TABLE runs ADD COLUMN IF NOT EXISTS blocked_on JSONB;

-- 'awaiting_approval' is a fourth run state, and it is not 'needs_input'.
--   needs_input       - the agent ran and wants something from the marketer.
--   awaiting_approval - the agent has NOT run, and will not until a gate opens.
-- Collapsing them would lose exactly the distinction this whole change is for.
DO $$
BEGIN
    ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_status_check;
    ALTER TABLE runs ADD CONSTRAINT runs_status_check
        CHECK (status IN ('running', 'completed', 'failed', 'needs_input', 'awaiting_approval'));
END $$;
