"""The dashboard. FastAPI + Jinja2 + HTMX, no JS framework.

Every figure derives from events at read time. Nothing is cached into its own
table in this build.

Views, in the brief's build order: run, queue, marketer, knowledge graph,
programme.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select

from agent_manager.config import settings
from agent_manager.gates import service as gates
from agent_manager.gateway import registry
from agent_manager.journey.model import AUTHOR_ROLES, journey
from agent_manager.knowledge import promote as knowledge
from agent_manager.log import repo
from agent_manager.log.models import Agent, Escalation, Event, Gate, GraphNode, Run, User
from agent_manager.log.repo import init_db, load_run, session

TEMPLATES = Path(__file__).parent / "templates"

app = FastAPI(title="Agent Manager")
templates = Jinja2Templates(directory=str(TEMPLATES))


@app.on_event("startup")
def _startup() -> None:
    init_db()
    with session() as s:
        registry.refresh(s)


def ctx(request: Request, **extra: Any) -> dict:
    base = {"request": request, "journey": journey(), "author_roles": AUTHOR_ROLES}
    base.update(extra)
    return base


# ------------------------------------------------------------------ 2. queue


@app.get("/", response_class=HTMLResponse)
def queue(
    request: Request,
    marketer: str | None = None,
    agent: str | None = None,
    status: str | None = None,
):
    with session() as s:
        stmt = select(Run).order_by(Run.opened_at.desc())
        if marketer:
            stmt = stmt.where(Run.marketer_id == marketer)
        if status:
            stmt = stmt.where(Run.status == status)
        runs = list(s.scalars(stmt))

        rows = []
        for run in runs:
            _, events, recs, run_gates = load_run(s, run.id)
            if agent and not any(
                e.actor_type == "agent" and e.actor_id == agent for e in events
            ):
                continue
            flags = repo.run_health(run, events, recs)
            rows.append(
                {
                    "run": run,
                    "events": events,
                    "flags": flags,
                    "open_gates": [g for g in run_gates if g.decision is None],
                    "elapsed_ms": repo.elapsed_ms(events),
                    "stages": repo.stage_state(events, recs, run_gates),
                }
            )

        # Drift, blocked runs and loop_count > 2 sort to the top.
        rows.sort(key=lambda r: (len(r["flags"]) == 0, r["run"].opened_at), reverse=False)
        rows.sort(key=lambda r: len(r["flags"]), reverse=True)

        marketers = list(s.scalars(select(Run.marketer_id).distinct()))
        agents = registry.all_agents(s)
        pending_nodes = len(knowledge.pending(s))

    return templates.TemplateResponse(
        "queue.html",
        ctx(
            request,
            rows=rows,
            marketers=marketers,
            agents=agents,
            selected={"marketer": marketer, "agent": agent, "status": status},
            pending_nodes=pending_nodes,
        ),
    )


# -------------------------------------------------------------------- 1. run


@app.get("/run/{run_id}", response_class=HTMLResponse)
def run_view(request: Request, run_id: str):
    with session() as s:
        run, events, recs, run_gates = load_run(s, run_id)
        if run is None:
            raise HTTPException(404, "no such run")
        stages = repo.stage_state(events, recs, run_gates)
        nodes = list(
            s.scalars(select(GraphNode).where(GraphNode.source_run_id == run_id))
        )
        agents = {a.id: a for a in registry.all_agents(s)}
        superseded = repo.superseded_ids(events)
        return templates.TemplateResponse(
            "run.html",
            ctx(
                request,
                run=run,
                events=events,
                recs=recs,
                gates=run_gates,
                stages=stages,
                nodes=nodes,
                agents=agents,
                superseded=superseded,
                elapsed_ms=repo.elapsed_ms(events),
                flags=repo.run_health(run, events, recs),
            ),
        )


# ---------------------------------------------------------------- 3. marketer


@app.get("/marketer/{email}", response_class=HTMLResponse)
def marketer_view(request: Request, email: str):
    with session() as s:
        runs = list(
            s.scalars(
                select(Run).where(Run.marketer_id == email).order_by(Run.opened_at.desc())
            )
        )
        nodes = knowledge.personal_graph(s, email)
        return templates.TemplateResponse(
            "marketer.html", ctx(request, email=email, runs=runs, nodes=nodes)
        )


# --------------------------------------------------------------- 4. knowledge


@app.get("/knowledge", response_class=HTMLResponse)
def knowledge_view(request: Request):
    with session() as s:
        nodes, edges = knowledge.shared_graph(s)
        proposed = knowledge.pending(s)
        humans = list(s.scalars(select(User).where(User.is_human.is_(True))))
        promoters = {
            u.id: u for u in s.scalars(select(User)) if u.id
        }
        return templates.TemplateResponse(
            "knowledge.html",
            ctx(
                request,
                nodes=nodes,
                edges=edges,
                proposed=proposed,
                humans=humans,
                promoters=promoters,
            ),
        )


@app.post("/knowledge/{node_id}/promote")
def promote_node(node_id: str, user_id: str = Form(...), note: str = Form("")):
    """The only promotion path. Takes an authenticated human session."""
    with session() as s:
        human = knowledge.HumanSession.for_user(s, user_id)
        knowledge.promote(s, node_id=node_id, human=human, note=note)
    return RedirectResponse("/knowledge", status_code=303)


@app.post("/knowledge/{node_id}/reject")
def reject_node(node_id: str, user_id: str = Form(...), note: str = Form("")):
    with session() as s:
        human = knowledge.HumanSession.for_user(s, user_id)
        knowledge.reject(s, node_id=node_id, human=human, note=note)
    return RedirectResponse("/knowledge", status_code=303)


# --------------------------------------------------------------- 5. programme


@app.get("/programme", response_class=HTMLResponse)
def programme_view(request: Request):
    with session() as s:
        runs = list(s.scalars(select(Run)))
        loop_dist: dict[int, int] = {}
        for r in runs:
            loop_dist[r.loop_count] = loop_dist.get(r.loop_count, 0) + 1

        failures = list(
            s.scalars(select(Escalation).order_by(Escalation.occurrences.desc()))
        )
        by_stage = dict(
            s.execute(
                select(Event.stage_key, func.count(Event.id)).group_by(Event.stage_key)
            ).all()
        )
        time_by_stage = dict(
            s.execute(
                select(Event.stage_key, func.sum(Event.clock_ms)).group_by(Event.stage_key)
            ).all()
        )
        promoted = len(
            list(s.scalars(select(GraphNode).where(GraphNode.status == "promoted")))
        )
        return templates.TemplateResponse(
            "programme.html",
            ctx(
                request,
                runs=runs,
                loop_dist=dict(sorted(loop_dist.items())),
                failures=failures,
                by_stage=by_stage,
                time_by_stage=time_by_stage,
                promoted=promoted,
            ),
        )


# -------------------------------------------------------------------- gates


@app.get("/gate/{gate_id}", response_class=HTMLResponse)
def gate_view(request: Request, gate_id: str, t: str | None = None):
    with session() as s:
        gate = s.get(Gate, gate_id)
        if gate is None:
            raise HTTPException(404, "no such gate")
        if t and not gates.verify_link(gate, t):
            raise HTTPException(403, "this review link is not valid or has expired")
        run, events, recs, _ = load_run(s, gate.run_id)
        humans = list(s.scalars(select(User).where(User.is_human.is_(True))))
        return templates.TemplateResponse(
            "gate.html",
            ctx(request, gate=gate, run=run, events=events, humans=humans, token=t or ""),
        )


@app.post("/gate/{gate_id}/decide")
def gate_decide(
    gate_id: str,
    user_id: str = Form(...),
    decision: str = Form(...),
    note: str = Form(""),
):
    with session() as s:
        gate = s.get(Gate, gate_id)
        user = s.get(User, user_id)
        if gate is None or user is None:
            raise HTTPException(404, "no such gate or user")
        gates.decide(s, gate=gate, user=user, approved=decision == "approve", note=note)
        run_id = gate.run_id
    return RedirectResponse(f"/run/{run_id}", status_code=303)


# -------------------------------------------------------------------- export


@app.get("/run/{run_id}/export")
def export_run(run_id: str):
    """Portable JSON. Must mean something without Agent Manager running."""
    from agent_manager.export.portable import export

    with session() as s:
        payload = export(s, run_id)
    if payload is None:
        raise HTTPException(404, "no such run")
    return JSONResponse(payload)


@app.get("/healthz")
def healthz():
    return {"ok": True, "journey": journey().key, "version": journey().version}
