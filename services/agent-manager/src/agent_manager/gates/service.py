"""Gates: anything needing a human mints a review link into the dashboard.

A gate is how the Author edits and approves an artifact as the story
progresses. Chauncey's question — "I need someone to validate whether what the
agent created is enough for the task" — is a gate, and `missing_required`
answers it by naming the field at fault rather than saying "incomplete".
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.config import settings
from agent_manager.journey.model import journey
from agent_manager.log.models import Event, Gate, Run, User, utcnow
from agent_manager.log.repo import append_event


def mint_link(gate: Gate) -> str:
    """A signed, expiring link straight to the decision."""
    cfg = settings()
    jti = gate.token_jti or uuid.uuid4().hex
    gate.token_jti = jti
    expires = datetime.now(timezone.utc) + timedelta(seconds=cfg.gate_link_ttl_seconds)
    gate.expires_at = expires
    token = jwt.encode(
        {
            "gate": gate.id,
            "run": gate.run_id,
            "role": gate.required_role,
            "jti": jti,
            "exp": int(expires.timestamp()),
        },
        cfg.jwt_signing_key,
        algorithm="HS256",
    )
    return f"{cfg.base_url}/gate/{gate.id}?t={token}"


def verify_link(gate: Gate, token: str) -> bool:
    try:
        claims = jwt.decode(token, settings().jwt_signing_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return False
    return claims.get("gate") == gate.id and claims.get("jti") == gate.token_jti


def open_gate(
    s: Session,
    *,
    run: Run,
    stage_key: str,
    question: str,
    proposed: dict | None = None,
    event: Event | None = None,
    assignee: str | None = None,
) -> tuple[Gate, str]:
    stage = journey().stage(stage_key)
    gate = Gate(
        run_id=run.id,
        event_id=event.id if event else None,
        stage_key=stage_key,
        required_role=stage.approver_role if stage else "gate_keeper",
        assignee=assignee,
        question=question,
        proposed=proposed or {},
    )
    s.add(gate)
    s.flush()

    append_event(
        s,
        run_id=run.id,
        kind="gate",
        actor_type="agent",
        actor_id="agent-manager",
        stage_key=stage_key,
        payload={"gate_id": gate.id, "question": question, "proposed": proposed or {}},
    )
    run.status = "blocked"
    return gate, mint_link(gate)


def decide(
    s: Session,
    *,
    gate: Gate,
    user: User,
    approved: bool,
    note: str = "",
    edits: dict | None = None,
) -> Gate:
    """A human decides. Edits append as a correction; nothing is overwritten."""
    if not user.is_human:
        raise PermissionError("a gate decision requires a human account")
    if gate.decision is not None:
        return gate

    gate.decision = "approved" if approved else "rejected"
    gate.decided_by = user.id
    gate.decided_at = utcnow()
    gate.note = note

    payload: dict[str, Any] = {
        "gate_id": gate.id,
        "decision": gate.decision,
        "by": user.display_name,
        "note": note,
    }
    if edits:
        payload["edits"] = edits

    append_event(
        s,
        run_id=gate.run_id,
        kind="gate",
        actor_type="human",
        actor_id=user.email,
        stage_key=gate.stage_key,
        payload=payload,
        status="approved" if approved else "rejected",
        corrects_event_id=gate.event_id if edits else None,
    )

    run = s.get(Run, gate.run_id)
    if run is not None:
        still_open = s.scalars(
            select(Gate).where(Gate.run_id == run.id, Gate.decision.is_(None))
        ).first()
        run.status = "blocked" if still_open else "open"
    s.flush()
    return gate


def open_gates(s: Session, run_id: str | None = None) -> list[Gate]:
    stmt = select(Gate).where(Gate.decision.is_(None))
    if run_id:
        stmt = stmt.where(Gate.run_id == run_id)
    return list(s.scalars(stmt.order_by(Gate.created_at)))
