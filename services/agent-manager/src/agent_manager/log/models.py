"""The append-only cross-run log.

Three things here are constraints, not conventions:

1. events cannot be updated or deleted. Corrections append a new event with
   corrects_event_id set. Enforced at the ORM layer (works everywhere) and by a
   database trigger on Postgres (migrations/001_append_only.sql).
2. a graph_node with scope 'shared' must carry a promoted_by that resolves to a
   human account. Enforced by CHECK constraint plus users.is_human.
3. model / client / tokens_used are metadata. No code branches on them.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    event,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship

Json = JSON().with_variant(JSONB, "postgresql")


def _uuid() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    """A human, or a service principal. Only humans may promote."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    display_name: Mapped[str] = mapped_column(String(200))
    # False for the Mentor Agent and any other service identity.
    is_human: Mapped[bool] = mapped_column(Boolean, default=True)
    author_roles: Mapped[list] = mapped_column(Json, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Programme(Base):
    __tablename__ = "programmes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(200))
    client: Mapped[str] = mapped_column(String(200), default="")
    journey_key: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    programme_id: Mapped[str] = mapped_column(ForeignKey("programmes.id"))
    marketer_id: Mapped[str] = mapped_column(String(320))

    # Phase 0 correction: the upstream's run id is the join key (a UUID, one per
    # intake). task_run_id is per STEP and belongs on events, not here.
    upstream_run_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    workfront_request_id: Mapped[str | None] = mapped_column(String(64))

    status: Mapped[str] = mapped_column(String(32), default="open")
    loop_count: Mapped[int] = mapped_column(Integer, default=0)

    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    events: Mapped[list["Event"]] = relationship(
        back_populates="run", order_by="Event.seq", cascade="all"
    )

    __table_args__ = (
        CheckConstraint(
            "status in ('open','blocked','submitted','closed')", name="ck_run_status"
        ),
        Index("ix_runs_marketer_status", "marketer_id", "status"),
    )


class Event(Base):
    """Append-only. Never updated, never deleted."""

    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    seq: Mapped[int] = mapped_column(Integer)

    kind: Mapped[str] = mapped_column(String(32))
    stage_key: Mapped[str | None] = mapped_column(String(120))

    actor_type: Mapped[str] = mapped_column(String(16))
    actor_id: Mapped[str] = mapped_column(String(320))
    agent_version: Mapped[str | None] = mapped_column(String(64))

    tool_name: Mapped[str | None] = mapped_column(String(200))
    tool_args_hash: Mapped[str | None] = mapped_column(String(80))
    payload: Mapped[dict] = mapped_column(Json, default=dict)

    status: Mapped[str] = mapped_column(String(24), default="captured")
    corrects_event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id"))

    clock_ms: Mapped[int | None] = mapped_column(Integer)
    upstream_task_run_id: Mapped[str | None] = mapped_column(String(64))

    # METADATA ONLY. No code may branch on these three.
    model: Mapped[str | None] = mapped_column(String(120))
    client: Mapped[str | None] = mapped_column(String(120))
    tokens_used: Mapped[int | None] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    run: Mapped[Run] = relationship(back_populates="events")

    __table_args__ = (
        UniqueConstraint("run_id", "seq", name="uq_events_run_seq"),
        CheckConstraint("actor_type in ('human','agent')", name="ck_event_actor"),
        Index("ix_events_run_seq", "run_id", "seq"),
        Index("ix_events_actor", "actor_type", "actor_id", "created_at"),
        Index("ix_events_stage", "stage_key"),
    )


class Reconciliation(Base):
    __tablename__ = "reconciliations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    event_id: Mapped[str] = mapped_column(ForeignKey("events.id"))
    asserted: Mapped[dict] = mapped_column(Json, default=dict)
    observed: Mapped[dict] = mapped_column(Json, default=dict)
    verdict: Mapped[str] = mapped_column(String(16))
    detail: Mapped[str] = mapped_column(Text, default="")
    checked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        CheckConstraint(
            "verdict in ('match','drift','missing')", name="ck_reconcile_verdict"
        ),
    )


class Gate(Base):
    __tablename__ = "gates"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id"))
    stage_key: Mapped[str | None] = mapped_column(String(120))

    required_role: Mapped[str] = mapped_column(String(40), default="gate_keeper")
    assignee: Mapped[str | None] = mapped_column(String(320))
    question: Mapped[str] = mapped_column(Text, default="")
    proposed: Mapped[dict] = mapped_column(Json, default=dict)

    decision: Mapped[str | None] = mapped_column(String(24))
    decided_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    note: Mapped[str] = mapped_column(Text, default="")

    token_jti: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        CheckConstraint(
            "decision is null or decision in ('approved','rejected')",
            name="ck_gate_decision",
        ),
        Index("ix_gates_open", "run_id", "decision"),
    )


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(24), default="ally")
    version: Mapped[str] = mapped_column(String(64), default="0")
    capabilities: Mapped[list] = mapped_column(Json, default=list)
    source: Mapped[str] = mapped_column(String(120), default="")
    owner: Mapped[str] = mapped_column(String(200), default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    registered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )


class Escalation(Base):
    """Agent 4's cross-run home. The gap Chauncey described without naming us."""

    __tablename__ = "escalations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"))
    event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id"))
    classification: Mapped[str] = mapped_column(String(200))
    failure_mode: Mapped[str] = mapped_column(String(200), default="")
    signature: Mapped[str] = mapped_column(String(300), default="")
    first_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )
    occurrences: Mapped[int] = mapped_column(Integer, default=1)

    __table_args__ = (Index("ix_escalations_sig", "signature"),)


class GraphNode(Base):
    __tablename__ = "graph_nodes"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(32))
    scope: Mapped[str] = mapped_column(String(16), default="personal")
    owner_id: Mapped[str | None] = mapped_column(String(320))
    source_event_id: Mapped[str | None] = mapped_column(ForeignKey("events.id"))
    source_run_id: Mapped[str | None] = mapped_column(ForeignKey("runs.id"))

    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[dict] = mapped_column(Json, default=dict)
    evidence: Mapped[dict] = mapped_column(Json, default=dict)

    status: Mapped[str] = mapped_column(String(16), default="proposed")
    proposed_by: Mapped[str | None] = mapped_column(String(120))
    promoted_by: Mapped[str | None] = mapped_column(ForeignKey("users.id"))
    promoted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        CheckConstraint(
            "status in ('proposed','promoted','rejected')", name="ck_node_status"
        ),
        CheckConstraint("scope in ('personal','shared')", name="ck_node_scope"),
        # Constraint 2: shared scope demands a promoter.
        CheckConstraint(
            "scope <> 'shared' or promoted_by is not null",
            name="ck_shared_requires_human_promoter",
        ),
        Index("ix_nodes_scope_status", "scope", "status"),
    )


class GraphEdge(Base):
    __tablename__ = "graph_edges"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=_uuid)
    from_node: Mapped[str] = mapped_column(ForeignKey("graph_nodes.id"))
    to_node: Mapped[str] = mapped_column(ForeignKey("graph_nodes.id"))
    relation: Mapped[str] = mapped_column(String(60))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AppendOnlyViolation(RuntimeError):
    """Raised when anything tries to rewrite history."""


@event.listens_for(Session, "before_flush")
def _enforce_append_only(session: Session, flush_context, instances) -> None:
    """Constraint 1, at the ORM layer.

    A record that can be silently rewritten is not evidence. The premise of
    showing this to Comcast is that a reviewer can trust what they read.
    """
    for obj in session.dirty:
        if isinstance(obj, Event) and session.is_modified(obj, include_collections=False):
            raise AppendOnlyViolation(
                f"event {obj.id} cannot be updated; append a correcting event "
                f"with corrects_event_id={obj.id} instead"
            )
    for obj in session.deleted:
        if isinstance(obj, Event):
            raise AppendOnlyViolation(f"event {obj.id} cannot be deleted")
