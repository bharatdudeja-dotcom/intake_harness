-- Agentic harness pipeline state. Applied against the SAME Postgres instance
-- the Python MCP server (chaunceyplum/mcp) uses for pgvector, but
-- deliberately separate tables — this harness's 3-agent pipeline is a
-- different concern from that repo's Python orchestrator (`executions` /
-- `execution_resources`), and the two must never collide on names or
-- semantics.
--
-- Idempotent — safe to re-run. CREATE-only, no data mutations.
--
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql

-- One row per pipeline invocation (a marketer's request moving through
-- intake -> review -> audience creation).
CREATE TABLE IF NOT EXISTS pipeline_runs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status        TEXT NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'completed', 'failed', 'needs_input')),
    current_step  INTEGER NOT NULL DEFAULT 0,
    input         JSONB NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per agent call within a run — the audit trail the requirements
-- doc keeps asking for (B1's loop count, B7's request age, B9's failure
-- classification all read off this table).
CREATE TABLE IF NOT EXISTS pipeline_steps (
    id           BIGSERIAL PRIMARY KEY,
    run_id       UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
    step_index   INTEGER NOT NULL,
    agent_name   TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('completed', 'needs_input', 'failed')),
    input        JSONB NOT NULL,
    output       JSONB,
    message      TEXT,
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    duration_ms  INTEGER NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run ON pipeline_steps(run_id, step_index);
