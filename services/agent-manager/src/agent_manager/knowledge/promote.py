"""Promotion into the shared knowledge graph. Humans only.

This is the single code path that can set status='promoted'. It takes an
authenticated human session and refuses a service principal. If a reviewer asks
"who decided this was true", the answer is always a person, by name.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.log.models import GraphEdge, GraphNode, User, utcnow


class NotHuman(PermissionError):
    """A service principal tried to promote. It cannot, by construction."""


@dataclass(frozen=True)
class HumanSession:
    """Proof that a person is on the other end of this call."""

    user_id: str
    email: str
    display_name: str

    @classmethod
    def for_user(cls, s: Session, user_id: str) -> "HumanSession":
        user = s.get(User, user_id)
        if user is None:
            raise NotHuman(f"no such user: {user_id}")
        if not user.is_human:
            raise NotHuman(
                f"{user.display_name} is a service principal. The Mentor Agent "
                f"proposes; it has no path that approves."
            )
        return cls(user_id=user.id, email=user.email, display_name=user.display_name)


def promote(
    s: Session,
    *,
    node_id: str,
    human: HumanSession,
    scope: str = "shared",
    note: str = "",
) -> GraphNode:
    """Promote a proposed node. The only way a node reaches the shared graph."""
    node = s.get(GraphNode, node_id)
    if node is None:
        raise ValueError(f"no such node: {node_id}")
    if node.status == "promoted":
        return node

    # Re-check at the moment of the write, not only at session creation.
    user = s.get(User, human.user_id)
    if user is None or not user.is_human:
        raise NotHuman("promotion requires an authenticated human account")

    node.status = "promoted"
    node.scope = scope
    node.promoted_by = user.id
    node.promoted_at = utcnow()
    body = dict(node.body or {})
    if note:
        body["promotion_note"] = note
    body["promoted_by_name"] = user.display_name
    node.body = body
    s.flush()
    return node


def reject(s: Session, *, node_id: str, human: HumanSession, note: str = "") -> GraphNode:
    node = s.get(GraphNode, node_id)
    if node is None:
        raise ValueError(f"no such node: {node_id}")
    user = s.get(User, human.user_id)
    if user is None or not user.is_human:
        raise NotHuman("rejecting a proposal is also a human decision")
    node.status = "rejected"
    body = dict(node.body or {})
    body["rejected_by_name"] = user.display_name
    if note:
        body["rejection_note"] = note
    node.body = body
    s.flush()
    return node


def link(s: Session, *, from_node: str, to_node: str, relation: str) -> GraphEdge:
    edge = GraphEdge(from_node=from_node, to_node=to_node, relation=relation)
    s.add(edge)
    s.flush()
    return edge


def shared_graph(s: Session) -> tuple[list[GraphNode], list[GraphEdge]]:
    nodes = list(
        s.scalars(
            select(GraphNode)
            .where(GraphNode.scope == "shared", GraphNode.status == "promoted")
            .order_by(GraphNode.promoted_at.desc())
        )
    )
    ids = {n.id for n in nodes}
    edges = [
        e
        for e in s.scalars(select(GraphEdge))
        if e.from_node in ids and e.to_node in ids
    ]
    return nodes, edges


def personal_graph(s: Session, marketer_id: str) -> list[GraphNode]:
    return list(
        s.scalars(
            select(GraphNode)
            .where(GraphNode.owner_id == marketer_id)
            .order_by(GraphNode.created_at.desc())
        )
    )


def pending(s: Session) -> list[GraphNode]:
    return list(
        s.scalars(
            select(GraphNode)
            .where(GraphNode.status == "proposed")
            .order_by(GraphNode.created_at.desc())
        )
    )
