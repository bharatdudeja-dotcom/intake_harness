-- Constraint 1, server-side. The ORM guard in log/models.py covers local
-- SQLite; this covers anything that reaches Postgres by another route.
--
-- Corrections append a new event with corrects_event_id set. A record that can
-- be silently rewritten is not evidence.

CREATE OR REPLACE FUNCTION events_are_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'events are append-only: % on event % is not permitted; append a '
        'correcting event with corrects_event_id instead',
        TG_OP, OLD.id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_append_only ON events;
CREATE TRIGGER trg_events_append_only
    BEFORE UPDATE OR DELETE ON events
    FOR EACH ROW EXECUTE FUNCTION events_are_append_only();

-- Constraint 2, the half a CHECK cannot express: promoted_by must resolve to a
-- HUMAN account, not a service principal. The CHECK on graph_nodes already
-- requires promoted_by to be non-null when scope = 'shared'.
CREATE OR REPLACE FUNCTION promoter_must_be_human() RETURNS trigger AS $$
DECLARE human boolean;
BEGIN
    IF NEW.promoted_by IS NULL THEN RETURN NEW; END IF;
    SELECT is_human INTO human FROM users WHERE id = NEW.promoted_by;
    IF human IS NOT TRUE THEN
        RAISE EXCEPTION
            'promoted_by must be a human account; % is a service principal',
            NEW.promoted_by;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_promoter_human ON graph_nodes;
CREATE TRIGGER trg_promoter_human
    BEFORE INSERT OR UPDATE ON graph_nodes
    FOR EACH ROW EXECUTE FUNCTION promoter_must_be_human();

-- Indexes for how the dashboard actually queries.
CREATE INDEX IF NOT EXISTS ix_events_run_seq   ON events (run_id, seq);
CREATE INDEX IF NOT EXISTS ix_events_actor     ON events (actor_type, actor_id, created_at);
CREATE INDEX IF NOT EXISTS ix_runs_marketer    ON runs (marketer_id, status);
CREATE INDEX IF NOT EXISTS ix_gates_open       ON gates (run_id) WHERE decision IS NULL;
