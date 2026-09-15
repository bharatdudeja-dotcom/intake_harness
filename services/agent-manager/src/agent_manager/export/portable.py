"""Portable export.

Done means: the whole run exports to a file that means something without Agent
Manager running. So the export carries the process definition with it — an
event referencing stage "grounding" is meaningless unless the reader can see
what that stage was for.
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.journey.model import journey
from agent_manager.log.models import GraphNode, Reconciliation, User
from agent_manager.log.repo import elapsed_ms, load_run


def _iso(value: Any) -> Any:
    return value.isoformat() if hasattr(value, "isoformat") else value


def export(s: Session, run_id: str) -> dict | None:
    run, events, recs, gates = load_run(s, run_id)
    if run is None:
        return None

    users = {u.id: u for u in s.scalars(select(User))}
    nodes = list(s.scalars(select(GraphNode).where(GraphNode.source_run_id == run_id)))
    j = journey()

    return {
        "schema": "agent-manager/run-export/1",
        "journey": {
            "key": j.key,
            "name": j.name,
            "client": j.client,
            "version": j.version,
            "acts": [
                {
                    "key": a.key,
                    "title": a.title,
                    "intent": a.intent,
                    "stages": [
                        {
                            "key": st.key,
                            "title": st.title,
                            "artifact": st.artifact,
                            "agent_role": st.agent_role,
                            "approver_role": st.approver_role,
                        }
                        for st in a.stages
                    ],
                }
                for a in j.acts
            ],
        },
        "run": {
            "id": run.id,
            "marketer": run.marketer_id,
            "upstream_run_id": run.upstream_run_id,
            "workfront_request_id": run.workfront_request_id,
            "status": run.status,
            "loop_count": run.loop_count,
            "opened_at": _iso(run.opened_at),
            "closed_at": _iso(run.closed_at),
            "elapsed_ms": elapsed_ms(events),
        },
        "events": [
            {
                "seq": e.seq,
                "kind": e.kind,
                "stage": e.stage_key,
                "actor": {"type": e.actor_type, "id": e.actor_id, "version": e.agent_version},
                "tool": e.tool_name,
                "payload": e.payload,
                "status": e.status,
                "corrects_event_id": e.corrects_event_id,
                "clock_ms": e.clock_ms,
                "upstream_task_run_id": e.upstream_task_run_id,
                # Metadata only. Nothing above branches on these.
                "metadata": {
                    "model": e.model,
                    "client": e.client,
                    "tokens_used": e.tokens_used,
                },
                "created_at": _iso(e.created_at),
            }
            for e in events
        ],
        "reconciliations": [
            {
                "event_seq": next((e.seq for e in events if e.id == r.event_id), None),
                "asserted": r.asserted,
                "observed": r.observed,
                "verdict": r.verdict,
                "detail": r.detail,
                "checked_at": _iso(r.checked_at),
            }
            for r in recs.values()
        ],
        "gates": [
            {
                "stage": g.stage_key,
                "required_role": g.required_role,
                "question": g.question,
                "decision": g.decision,
                "decided_by": (
                    users[g.decided_by].display_name if g.decided_by in users else None
                ),
                "decided_at": _iso(g.decided_at),
                "note": g.note,
            }
            for g in gates
        ],
        "knowledge": [
            {
                "kind": n.kind,
                "scope": n.scope,
                "title": n.title,
                "body": n.body,
                "evidence": n.evidence,
                "status": n.status,
                "proposed_by": n.proposed_by,
                "promoted_by": (
                    users[n.promoted_by].display_name if n.promoted_by in users else None
                ),
                "promoted_at": _iso(n.promoted_at),
            }
            for n in nodes
        ],
    }
