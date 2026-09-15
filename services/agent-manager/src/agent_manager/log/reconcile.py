"""Ensure that what we logged as happening in Workfront actually happened.

After every write: record `asserted`, re-read the object through the official
connector, record `observed`, compute match | drift | missing. Anything other
than match flags the run and sorts it to the top of the queue.

A scheduled sweep re-checks recent runs, so drift introduced later by a human
editing the request directly in Workfront is caught too.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.gateway.adapters.workfront import (
    McpToolError,
    McpUnavailable,
    Workfront,
    reconcile_fields,
)
from agent_manager.log.models import Event, Reconciliation, Run


def _normalise(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip()
    return value


def compare(asserted: dict, observed: dict, fields: list[str]) -> tuple[str, str]:
    """Return (verdict, detail)."""
    if not observed:
        return "missing", "the object could not be read back"

    differences = []
    for f in fields:
        if f not in asserted:
            continue
        a, o = _normalise(asserted.get(f)), _normalise(observed.get(f))
        if a != o:
            differences.append(f"{f}: asserted {a!r}, observed {o!r}")

    if differences:
        return "drift", "; ".join(differences)
    return "match", ""


def reconcile_event(
    s: Session, event: Event, client: Workfront | None = None
) -> Reconciliation:
    """Reconcile one write event. Records a verdict either way."""
    payload = event.payload or {}
    asserted = payload.get("asserted") or payload.get("fields") or {}
    object_code = payload.get("object_code", "OPTASK")
    object_id = payload.get("object_id") or asserted.get("ID")

    observed: dict = {}
    detail = ""
    if not object_id:
        verdict, detail = "missing", "no object id was returned by the write"
    else:
        client = client or Workfront()
        try:
            observed = client.get(object_code, str(object_id))
            verdict, detail = compare(asserted, observed, reconcile_fields(object_code))
        except (McpUnavailable, McpToolError) as exc:
            # Not a match, and not silently swallowed either. An unverifiable
            # write is exactly the state the dashboard must surface.
            verdict, detail = "missing", f"could not verify: {exc}"

    rec = Reconciliation(
        event_id=event.id,
        asserted=asserted,
        observed=observed,
        verdict=verdict,
        detail=detail[:2000],
    )
    s.add(rec)
    s.flush()
    return rec


def sweep(s: Session, within_days: int = 14, limit: int = 200) -> list[Reconciliation]:
    """Cloud Scheduler entry point. Re-checks recent writes for later drift."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=within_days)
    events = list(
        s.scalars(
            select(Event)
            .join(Run, Run.id == Event.run_id)
            .where(Event.kind == "tool_call", Event.created_at >= cutoff)
            .order_by(Event.created_at.desc())
            .limit(limit)
        )
    )
    client = Workfront()
    return [reconcile_event(s, e, client) for e in events if _is_write(e)]


def _is_write(event: Event) -> bool:
    name = (event.tool_name or "").lower()
    return any(k in name for k in ("create", "update", "delete", "comment"))
