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

-- Programmes: a named grouping a run can belong to (ported from Agent
-- Manager's Project, minus its lifecycle machinery — just enough to group
-- runs). upsert-by-name in src/lib/pipeline/programmes.ts, so submitting
-- the same programme name twice reuses the row rather than duplicating it.
CREATE TABLE IF NOT EXISTS programmes (
    programme_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL UNIQUE,
    note          TEXT,
    owner         TEXT,
    status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE runs ADD COLUMN IF NOT EXISTS programme_id UUID REFERENCES programmes(programme_id);
CREATE INDEX IF NOT EXISTS idx_runs_programme ON runs(programme_id);

-- Resources: the generic knowledge-base entries ported from Agent Manager's
-- resource-policy catalog (playbooks, decisions, architecture docs/diagrams,
-- meeting notes, code snippets, configs, handoff-prompts) — content worth
-- keeping that ISN'T a pipeline run. Single content blob per resource, not
-- an ordered step log: Agent Manager needed steps because the same object
-- doubled as both a run record and a doc; here `task_runs` already owns run
-- history, so a resource only needs to be a doc. Same two-tier curation as
-- `runs` (approved -> promoted into the Shared Graph), same admin model.
CREATE TABLE IF NOT EXISTS resources (
    resource_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type           TEXT NOT NULL CHECK (type IN (
                       'playbook', 'decision', 'architecture-doc', 'architecture-diagram',
                       'meeting-notes', 'code-snippet', 'configuration', 'handoff-prompt'
                   )),
    title          TEXT NOT NULL,
    content        TEXT NOT NULL,
    format         TEXT,
    tags           TEXT[] NOT NULL DEFAULT '{}',
    owner          TEXT,
    programme_id   UUID REFERENCES programmes(programme_id),
    approved       BOOLEAN NOT NULL DEFAULT false,
    approved_by    TEXT,
    approved_at    TIMESTAMPTZ,
    approval_note  TEXT,
    promoted       BOOLEAN NOT NULL DEFAULT false,
    promoted_by    TEXT,
    promoted_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_promoted ON resources(promoted) WHERE promoted;

-- Settings: a single editable row (id is always 1 — the CHECK enforces
-- that, so there's exactly one config, never a second competing row).
-- Ported from Agent Manager's settings override (D48): a retention window
-- for unapproved Resources, plus manual purge rather than a cron this app
-- has no scheduler to run. Deliberately does NOT cover Runs — those are
-- this harness's own audit trail (B7's request age, B9's failure
-- classification both read off them), not disposable draft content the
-- way an unapproved Resource is.
CREATE TABLE IF NOT EXISTS settings (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    retention_days  INTEGER NOT NULL DEFAULT 30 CHECK (retention_days > 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by      TEXT
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Parity with Agent Manager's settings override (D48) beyond retention:
-- segmentation_labels/kind_labels rename what things are CALLED (internal
-- keys — "programme", each resources.type value — never change, only their
-- display label, so relabeling never breaks stored data or filters, same
-- principle as that D48 override). promote_admins is the "Hero Agents"
-- roster (D64): the subset of ADMIN_NAMES allowed to promote into the
-- Shared Graph. NULL/empty means "any admin may promote" — today's
-- behavior — so this is purely additive until an admin actually sets one.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS segmentation_labels JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS kind_labels JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS promote_admins TEXT[];

-- The MCP gateway, ported from Agent Manager's lib/mcp-servers.js /
-- lib/mcp-oauth.js / lib/mcp-gateway.js: a registry of upstream MCP
-- servers this harness can call directly and, when `gateway` is on,
-- re-expose (namespaced by id) through this app's own /api/mcp endpoint.
--
-- `auth` is a literal Authorization header value, a "${ENV_VAR}" reference
-- resolved at call time, or NULL when the server uses OAuth instead — see
-- src/lib/mcp-servers.ts's resolveSecret(). The oauth_* columns are the
-- RFC 7591/8707 dance's result (dynamic client registration + PKCE
-- authorization_code): never returned to the browser, only whether one is
-- set (src/lib/mcp-servers-types.ts's McpServerSafe).
CREATE TABLE IF NOT EXISTS mcp_servers (
    id                  TEXT PRIMARY KEY,
    label               TEXT NOT NULL,
    practice            TEXT,
    endpoint            TEXT NOT NULL DEFAULT '',
    instance            TEXT,
    auth                TEXT,
    active              BOOLEAN NOT NULL DEFAULT false,
    gateway             BOOLEAN NOT NULL DEFAULT false,
    oauth_client_id     TEXT,
    oauth_access_token  TEXT,
    oauth_refresh_token TEXT,
    oauth_expires_at    TIMESTAMPTZ,
    oauth_connected_at  TIMESTAMPTZ,
    oauth_resource      TEXT,
    oauth_as_metadata   JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One in-flight OAuth authorization_code+PKCE attempt per row, keyed by the
-- `state` the provider echoes back — single-use (deleted on the callback
-- that consumes it) and short-lived (TXN_TTL_MS in the oauth start route
-- prunes anything older on each new attempt), so a replayed callback finds
-- nothing and the verifier never leaves the server.
CREATE TABLE IF NOT EXISTS mcp_oauth_transactions (
    state        TEXT PRIMARY KEY,
    server_id    TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    verifier     TEXT NOT NULL,
    as_metadata  JSONB NOT NULL,
    resource     TEXT,
    redirect_uri TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed/refresh the task catalog from src/lib/pipeline/registry.ts (PIPELINE
-- + ESCALATION, i.e. ALL_TASKS). Keep this block in sync with that file —
-- it's the one place both agree on task_id.
INSERT INTO tasks (task_id, label, owner) VALUES
    ('intake',            'Agent 1 — Intake',              'Dev 1'),
    ('review',            'Agent 2 — Review / Triage',     'Dev 2'),
    ('audience_creation', 'Agent 3 — Audience Creation',   'Dev 3 (you)'),
    ('escalation',        'Agent 4 — Escalation',          'Unassigned')
ON CONFLICT (task_id) DO UPDATE SET label = EXCLUDED.label, owner = EXCLUDED.owner;
