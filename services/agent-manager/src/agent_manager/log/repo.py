"""Append-only writes, and the read-time derivations the dashboard needs.

Every figure in the dashboard derives from events at read time. Nothing here
caches a computed metric into its own table.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker

from agent_manager.config import settings
from agent_manager.journey.model import Stage, journey
from agent_manager.log.models import (
    Base,
    Event,
    Gate,
    GraphNode,
    Programme,
    Reconciliation,
    Run,
    utcnow,
)

_engine = None
_Session: sessionmaker | None = None


def engine():
    global _engine, _Session
    if _engine is None:
        url = settings().database_url
        kwargs: dict[str, Any] = {"future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        _engine = create_engine(url, **kwargs)
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def init_db() -> None:
    Base.metadata.create_all(engine())


@contextmanager
def session() -> Iterator[Session]:
    engine()
    assert _Session is not None
    s = _Session()
    try:
        yield s
        s.commit()
    except Exception:
        s.rollback()
        raise
    finally:
        s.close()


def args_hash(payload: Any) -> str:
    blob = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:32]


def append_event(
    s: Session,
    *,
    run_id: str,
    kind: str,
    actor_type: str,
    actor_id: str,
    stage_key: str | None = None,
    payload: dict | None = None,
    status: str = "captured",
    tool_name: str | None = None,
    agent_version: str | None = None,
    corrects_event_id: str | None = None,
    clock_ms: int | None = None,
    upstream_task_run_id: str | None = None,
    model: str | None = None,
    client: str | None = None,
    tokens_used: int | None = None,
) -> Event:
    """The only way an event enters the log."""
    next_seq = (
        s.scalar(select(func.coalesce(func.max(Event.seq), -1)).where(Event.run_id == run_id))
        + 1
    )
    ev = Event(
        run_id=run_id,
        seq=next_seq,
        kind=kind,
        stage_key=stage_key,
        actor_type=actor_type,
        actor_id=actor_id,
        agent_version=agent_version,
        tool_name=tool_name,
        tool_args_hash=args_hash(payload) if payload is not None else None,
        payload=payload or {},
        status=status,
        corrects_event_id=corrects_event_id,
        clock_ms=clock_ms,
        upstream_task_run_id=upstream_task_run_id,
        model=model,
        client=client,
        tokens_used=tokens_used,
    )
    s.add(ev)
    s.flush()
    return ev


def correct_event(
    s: Session, *, original: Event, payload: dict, actor_id: str, note: str = ""
) -> Event:
    """Corrections append. The original stays exactly as it was."""
    body = dict(payload)
    if note:
        body["_correction_note"] = note
    return append_event(
        s,
        run_id=original.run_id,
        kind="correction",
        actor_type="human",
        actor_id=actor_id,
        stage_key=original.stage_key,
        payload=body,
        corrects_event_id=original.id,
    )


# ---------------------------------------------------------------- derivations


def superseded_ids(events: list[Event]) -> set[str]:
    return {e.corrects_event_id for e in events if e.corrects_event_id}


def elapsed_ms(events: list[Event]) -> int:
    if len(events) < 2:
        return 0
    first, last = events[0].created_at, events[-1].created_at
    if first.tzinfo is None:
        first = first.replace(tzinfo=timezone.utc)
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    return int((last - first).total_seconds() * 1000)


def stage_state(
    events: list[Event],
    recs: dict[str, Reconciliation],
    gates: list[Gate],
) -> dict[str, dict[str, Any]]:
    """Derive each stage's badge. A stage is not green because a status field
    says completed — it is green when nothing contradicts it.

    This is the direct answer to what phase 0 found upstream: a step that
    reported `completed` while carrying an "Unknown tool" error in its payload.
    """
    out: dict[str, dict[str, Any]] = {}
    open_gate_stages = {g.stage_key for g in gates if g.decision is None}

    for st in journey().stages:
        evs = [e for e in events if e.stage_key == st.key]
        if not evs:
            out[st.key] = {"state": "pending", "why": "", "events": []}
            continue

        state, why = "done", ""
        for e in evs:
            body = e.payload or {}
            if _carries_error(body):
                state, why = "faulted", _first_error(body)
                break
            if e.status == "rejected":
                state, why = "faulted", "rejected by a human"
                break

        if state == "done":
            for e in evs:
                r = recs.get(e.id)
                if r and r.verdict != "match":
                    state, why = "drift", f"reconciler: {r.verdict}"
                    break

        if st.key in open_gate_stages:
            state, why = "waiting", "waiting on a human"

        out[st.key] = {"state": state, "why": why, "events": evs}
    return out


def _carries_error(body: Any, depth: int = 0) -> bool:
    return bool(_first_error(body, depth))


def _first_error(body: Any, depth: int = 0) -> str:
    """Find an error embedded anywhere in a payload.

    Upstream does not raise errors, it embeds them and reports completed. So we
    go looking rather than trusting the status field.
    """
    if depth > 6:
        return ""
    if isinstance(body, dict):
        for k, v in body.items():
            if k.lower() in {"error", "err", "exception"} and v:
                return str(v)[:400]
            found = _first_error(v, depth + 1)
            if found:
                return found
    elif isinstance(body, list):
        for v in body:
            found = _first_error(v, depth + 1)
            if found:
                return found
    return ""


def run_health(run: Run, events: list[Event], recs: dict[str, Reconciliation]) -> list[str]:
    """Reasons this run sorts to the top of the queue."""
    flags: list[str] = []
    stage = journey().stage("intake")
    warn_above = (stage.health or {}).get("warn_above", 2) if stage else 2
    if run.loop_count > warn_above:
        flags.append(f"loop count {run.loop_count} — the agent failed, not the marketer")
    for r in recs.values():
        if r.verdict != "match":
            flags.append(f"reconciler says {r.verdict}")
            break
    for e in events:
        err = _first_error(e.payload)
        if err:
            flags.append(f"silent error in {e.stage_key or e.kind}: {err[:120]}")
            break
    if run.status == "blocked":
        flags.append("blocked")
    return flags


def load_run(s: Session, run_id: str) -> tuple[Run | None, list[Event], dict, list[Gate]]:
    run = s.get(Run, run_id)
    if run is None:
        return None, [], {}, []
    events = list(
        s.scalars(select(Event).where(Event.run_id == run_id).order_by(Event.seq))
    )
    recs = {
        r.event_id: r
        for r in s.scalars(
            select(Reconciliation).where(
                Reconciliation.event_id.in_([e.id for e in events] or [""])
            )
        )
    }
    gates = list(s.scalars(select(Gate).where(Gate.run_id == run_id)))
    return run, events, recs, gates


def ensure_programme(s: Session, name: str, client: str, journey_key: str) -> Programme:
    existing = s.scalar(select(Programme).where(Programme.name == name))
    if existing:
        return existing
    p = Programme(name=name, client=client, journey_key=journey_key)
    s.add(p)
    s.flush()
    return p


def close_run(s: Session, run: Run, status: str) -> None:
    run.status = status
    run.closed_at = utcnow()
