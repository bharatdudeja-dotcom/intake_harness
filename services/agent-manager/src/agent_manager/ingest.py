"""Pull real runs out of the Agentic Harness into the cross-run log.

Capture here is polled and reconstructed, not intercepted — the orchestrator
calls its agents server-side, so we read /api/runs/{id} and rebuild the
ordered event log from what it reports. See docs/UPSTREAMS.md section 2.3.

Re-running is safe: a run already ingested at the same upstream step count is
skipped, and nothing already written is ever modified.
"""

from __future__ import annotations

import argparse
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.gateway import registry
from agent_manager.gateway.adapters.chauncey import AgenticHarness, CapturedCall
from agent_manager.journey.model import journey
from agent_manager.log.models import Event, Programme, Run, User, utcnow
from agent_manager.log.repo import append_event, init_db, session
from agent_manager.mentor import curator

DEFAULT_MARKETER = "unattributed@tapcxm.com"


def _stage_for(call: CapturedCall) -> str:
    """Map an upstream task_id to a journey stage via the registry.

    No agent name appears in this function. The mapping is agents.yaml ->
    journey YAML, both data.
    """
    desc = registry.by_upstream_task(call.task_id)
    if desc:
        stage = journey().stage_for_agent(desc.id)
        if stage:
            return stage.key
    stage = journey().stage(call.task_id)
    return stage.key if stage else call.task_id


def ensure_user(s: Session, email: str, name: str, *, human: bool = True) -> User:
    user = s.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, display_name=name, is_human=human)
        s.add(user)
        s.flush()
    return user


def ensure_programme(s: Session) -> Programme:
    j = journey()
    p = s.scalar(select(Programme).where(Programme.journey_key == j.key))
    if p is None:
        p = Programme(name=j.name, client=j.client, journey_key=j.key)
        s.add(p)
        s.flush()
    return p


def ingest_run(s: Session, harness: AgenticHarness, upstream_run_id: str) -> Run | None:
    envelope = harness.get_run(upstream_run_id)
    result = harness.to_result(envelope)
    upstream = envelope.get("run") or {}

    existing = s.scalar(select(Run).where(Run.upstream_run_id == upstream_run_id))
    if existing is not None:
        captured = s.scalar(
            select(Event).where(
                Event.run_id == existing.id, Event.kind == "agent_call"
            )
        )
        already = len(
            [e for e in existing.events if e.kind == "agent_call"]
        ) if captured else 0
        if already >= len(result.sub_calls):
            return existing
        run = existing
    else:
        programme = ensure_programme(s)
        run = Run(
            programme_id=programme.id,
            marketer_id=DEFAULT_MARKETER,
            upstream_run_id=upstream_run_id,
            status="open",
            loop_count=result.loop_count or 0,
        )
        s.add(run)
        s.flush()

        # Event 0 is the raw prompt, captured verbatim.
        append_event(
            s,
            run_id=run.id,
            kind="prompt",
            actor_type="human",
            actor_id=run.marketer_id,
            stage_key="brief",
            payload=upstream.get("input") or {},
            client="agentic-harness",
        )

    seen = {e.upstream_task_run_id for e in run.events if e.upstream_task_run_id}
    for call in result.sub_calls:
        if call.task_run_id and call.task_run_id in seen:
            continue
        desc = registry.by_upstream_task(call.task_id)
        ev = append_event(
            s,
            run_id=run.id,
            kind="agent_call",
            actor_type="agent",
            actor_id=desc.id if desc else call.task_id,
            agent_version=desc.version if desc else None,
            stage_key=_stage_for(call),
            payload={
                "upstream_status": call.status,
                "input": call.inputs,
                "output": call.outputs,
                "metadata": call.metadata,
            },
            clock_ms=call.duration_ms,
            upstream_task_run_id=call.task_run_id,
            client="agentic-harness",
        )

        # The upstream said completed. If the payload carries an error, that
        # classification is recorded here and accumulates across runs — the
        # persistent home Agent 4 does not have.
        if call.embedded_error:
            curator.record_escalation(
                s,
                run,
                ev,
                classification="silent_tool_failure",
                failure_mode=call.embedded_error[:200],
            )

    if result.loop_count is not None:
        run.loop_count = result.loop_count
    if upstream.get("status") == "completed":
        run.status = "submitted"
        run.closed_at = run.closed_at or utcnow()
    s.flush()
    return run


def ingest_all(limit: int | None = None) -> list[str]:
    init_db()
    ingested: list[str] = []
    with session() as s:
        registry.refresh(s)
        ensure_user(s, DEFAULT_MARKETER, "Unattributed marketer")
        ensure_user(s, "mentor@agent-manager", "Mentor Agent", human=False)

        with AgenticHarness() as harness:
            runs = harness.list_runs()
            if limit:
                runs = runs[:limit]
            for r in runs:
                rid = r.get("run_id")
                if not rid:
                    continue
                run = ingest_run(s, harness, rid)
                if run is not None:
                    ingested.append(run.id)
                    curator.propose_from_run(s, run)
    return ingested


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest runs from the Agentic Harness")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()
    ids = ingest_all(limit=args.limit)
    print(f"ingested {len(ids)} run(s)")


if __name__ == "__main__":
    main()
