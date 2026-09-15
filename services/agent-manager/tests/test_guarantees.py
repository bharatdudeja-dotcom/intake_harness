"""The three constraints, tested as constraints.

If any of these ever pass by accident, the product's claim to Comcast is gone.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from agent_manager.knowledge.promote import HumanSession, NotHuman, promote
from agent_manager.log.models import AppendOnlyViolation, Event, GraphNode, User
from agent_manager.log.repo import append_event, correct_event, init_db, session


@pytest.fixture(scope="module", autouse=True)
def _db():
    init_db()


def _any_event(s):
    return s.scalars(select(Event)).first()


def test_events_cannot_be_updated():
    with pytest.raises(AppendOnlyViolation):
        with session() as s:
            ev = _any_event(s)
            assert ev is not None, "ingest some runs first"
            ev.payload = {"tampered": True}
            s.flush()


def test_events_cannot_be_deleted():
    with pytest.raises(AppendOnlyViolation):
        with session() as s:
            ev = _any_event(s)
            s.delete(ev)
            s.flush()


def test_correction_appends_and_leaves_the_original_intact():
    with session() as s:
        original = _any_event(s)
        before = dict(original.payload)
        correction = correct_event(
            s,
            original=original,
            payload={"corrected": True},
            actor_id="tester@tapcxm.com",
            note="the original said something else",
        )
        assert correction.corrects_event_id == original.id
        assert original.payload == before, "the original was rewritten"


def test_the_mentor_agent_cannot_promote():
    """The whole governance claim, in one assertion."""
    with session() as s:
        mentor = s.scalar(select(User).where(User.is_human.is_(False)))
        assert mentor is not None, "expected a service principal for the Mentor Agent"
        with pytest.raises(NotHuman):
            HumanSession.for_user(s, mentor.id)


def test_a_human_can_promote_and_is_named_on_the_node():
    with session() as s:
        node = s.scalars(
            select(GraphNode).where(GraphNode.status == "proposed")
        ).first()
        if node is None:
            pytest.skip("no proposals to promote")
        human = s.scalar(select(User).where(User.is_human.is_(True)))
        promoted = promote(
            s,
            node_id=node.id,
            human=HumanSession.for_user(s, human.id),
            note="verified against the upstream run",
        )
        assert promoted.status == "promoted"
        assert promoted.scope == "shared"
        assert promoted.promoted_by == human.id
        assert promoted.body["promoted_by_name"] == human.display_name


def test_no_shared_node_lacks_a_promoter():
    with session() as s:
        orphans = list(
            s.scalars(
                select(GraphNode).where(
                    GraphNode.scope == "shared", GraphNode.promoted_by.is_(None)
                )
            )
        )
        assert orphans == []
