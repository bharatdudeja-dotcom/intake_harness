"""The Mentor Agent.

Renamed from the brief's "Hero Agent" on Josh's framing: the hero is THE DATA,
the humans are collectively the Author, and the agent roles are Mentor, Ally and
Trickster. This agent is Vogler's Mentor exactly — "all the characters who teach
and protect heroes and give them gifts". It carries what previous runs learned
and hands it over at the moment it is needed.

IT PROPOSES. IT NEVER APPROVES.

There is no function in this module that writes status='promoted' or sets
promoted_by. That is not a policy note; grep this file. Promotion lives in
knowledge/promote.py and takes an authenticated human session.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.journey.model import journey
from agent_manager.log.models import Escalation, Event, GraphNode, Run
from agent_manager.log.repo import _first_error

PROPOSER = "mentor"          # matches config/agents.yaml
MIN_RECURRENCE = 2           # a thing that happened once is an anecdote

SILENT_TOOL_FAILURE = "silent_tool_failure"


def signature(stage_or_kind: str, classification: str) -> str:
    """One definition, used by both the writer and the reader.

    These two must agree or the Mentor Agent never sees a recurrence and never
    proposes anything.
    """
    return f"{stage_or_kind}:{classification[:120]}"


def _existing_titles(s: Session) -> set[str]:
    return set(s.scalars(select(GraphNode.title)))


def propose_from_run(s: Session, run: Run) -> list[GraphNode]:
    """Read one run and propose what should be learned from it.

    Everything proposed is scoped 'personal' and status 'proposed'. Nothing
    here can reach the shared graph without a human.
    """
    events = list(
        s.scalars(select(Event).where(Event.run_id == run.id).order_by(Event.seq))
    )
    proposals: list[GraphNode] = []
    seen = _existing_titles(s)

    for node in _silent_failures(s, run, events) + _loop_pressure(run) + _ambiguities(events):
        if node.title in seen:
            continue
        seen.add(node.title)
        node.proposed_by = PROPOSER
        node.status = "proposed"
        node.scope = "personal"
        node.owner_id = run.marketer_id
        node.source_run_id = run.id
        s.add(node)
        proposals.append(node)

    s.flush()
    return proposals


def _silent_failures(s: Session, run: Run, events: list[Event]) -> list[GraphNode]:
    """The class of finding no single run can see.

    A step reported completed while carrying an error in its payload. One run
    looks like a success. Across runs it is a pattern, and the pattern is the
    knowledge.
    """
    out: list[GraphNode] = []
    for e in events:
        err = _first_error(e.payload)
        if not err:
            continue
        sig = signature(e.stage_key or e.kind, SILENT_TOOL_FAILURE)
        row = s.scalar(select(Escalation).where(Escalation.signature == sig))
        occurrences = row.occurrences if row else 1
        if occurrences < MIN_RECURRENCE:
            continue
        stage = journey().stage(e.stage_key or "")
        out.append(
            GraphNode(
                kind="failure_mode",
                title=f"{(stage.title if stage else e.stage_key)}: reports success while failing",
                source_event_id=e.id,
                body={
                    "observed": err,
                    "why_it_matters": (
                        "The step's status field said completed. The payload "
                        "carried the error downstream as data. A per-run view "
                        "records this as a clean success."
                    ),
                    "occurrences": occurrences,
                },
                evidence={"event_id": e.id, "run_id": run.id, "signature": sig},
            )
        )
    return out


def _loop_pressure(run: Run) -> list[GraphNode]:
    """B1: more than two rounds means the agent failed, not the marketer."""
    stage = journey().stage("intake")
    threshold = (stage.health or {}).get("warn_above", 2) if stage else 2
    if run.loop_count <= threshold:
        return []
    return [
        GraphNode(
            kind="blocker",
            title=f"Intake needed {run.loop_count} rounds to produce a usable brief",
            body={
                "loop_count": run.loop_count,
                "threshold": threshold,
                "reading": (
                    "Above the threshold this is an agent failure, not a "
                    "marketer failure. The question is which field it kept "
                    "failing to extract."
                ),
            },
            evidence={"run_id": run.id},
        )
    ]


AMBIGUOUS = {"not sure", "unknown", "n/a", "tbc", "tbd"}


def _ambiguities(events: list[Event]) -> list[GraphNode]:
    """Fields the marketer could not answer.

    On the real Campaign Brief, "Where does this data live today?" came back
    "Not sure". That is a recurring, fixable blocker, and it is precisely the
    kind of thing worth carrying to the next run.
    """
    counts: Counter[str] = Counter()
    for e in events:
        for field, value in _flat(e.payload or {}):
            if isinstance(value, str) and value.strip().lower() in AMBIGUOUS:
                counts[field] += 1

    return [
        GraphNode(
            kind="blocker",
            title=f"Marketer could not answer: {field}",
            body={
                "field": field,
                "answer_given": "an ambiguous value",
                "suggestion": (
                    "Either the question needs a better default, or the answer "
                    "is discoverable from a system we already read."
                ),
            },
            evidence={"field": field, "times": times},
        )
        for field, times in counts.items()
    ]


def _flat(body: Any, prefix: str = "", depth: int = 0):
    if depth > 6:
        return
    if isinstance(body, dict):
        for k, v in body.items():
            key = f"{prefix}.{k}" if prefix else str(k)
            if isinstance(v, (dict, list)):
                yield from _flat(v, key, depth + 1)
            else:
                yield key, v
    elif isinstance(body, list):
        for i, v in enumerate(body):
            yield from _flat(v, f"{prefix}[{i}]", depth + 1)


def record_escalation(
    s: Session, run: Run, event: Event, classification: str, failure_mode: str = ""
) -> Escalation:
    """Agent 4's cross-run home.

    Chauncey described this gap without knowing he was describing us:
    "somewhere persistent to accumulate classifications across runs, since
    today's version only lives inside that one run's task_runs row."
    """
    sig = signature(event.stage_key or event.kind, classification)
    row = s.scalar(select(Escalation).where(Escalation.signature == sig))
    if row is None:
        row = Escalation(
            run_id=run.id,
            event_id=event.id,
            classification=classification,
            failure_mode=failure_mode,
            signature=sig,
        )
        s.add(row)
    else:
        row.occurrences += 1
        from agent_manager.log.models import utcnow

        row.last_seen_at = utcnow()
    s.flush()
    return row
