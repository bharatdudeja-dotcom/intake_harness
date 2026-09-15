"""Agent registry.

Phase 0 found no tools/list and no GET /api/agents upstream, so the registry is
seeded from config rather than from source. Filters read the registry; the four
agent names appear in YAML, never in Python.

When discovery.enabled flips to true, config becomes the fallback.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx
import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from agent_manager.config import settings
from agent_manager.log.models import Agent


@dataclass(frozen=True)
class AgentDescriptor:
    id: str
    name: str
    version: str
    role: str
    capabilities: tuple[str, ...]
    source: str
    owner: str
    invoke_path: str | None
    upstream_task_id: str | None
    active: bool = True


@lru_cache
def _raw() -> dict[str, Any]:
    cfg = settings()
    path = cfg.config_dir / cfg.agents_file
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def upstream(name: str) -> dict[str, Any]:
    return _raw().get("upstreams", {}).get(name, {})


def _from_config() -> list[AgentDescriptor]:
    return [
        AgentDescriptor(
            id=a["id"],
            name=a["name"],
            version=str(a.get("version", "0")),
            role=a.get("role", "ally"),
            capabilities=tuple(a.get("capabilities") or ()),
            source=a.get("source", ""),
            owner=a.get("owner", ""),
            invoke_path=a.get("invoke_path"),
            upstream_task_id=a.get("upstream_task_id"),
            active=bool(a.get("active", True)),
        )
        for a in _raw().get("agents", [])
    ]


def discover() -> list[AgentDescriptor]:
    """Read the upstream's own catalog; enrich from config; never guess in code.

    GET /api/tasks is the harness's `tasks` table, seeded from its own pipeline
    registry. It is authoritative about WHICH agents exist. It carries no
    version, capabilities or role, so those come from the config overlay,
    matched on id. An agent the upstream knows about but this file has never
    heard of still appears — with whatever the upstream said about it.
    """
    disc = _raw().get("discovery", {})
    overlay = {d.id: d for d in _from_config()}

    if not (disc.get("enabled") and disc.get("url")):
        return list(overlay.values())

    try:
        resp = httpx.get(disc["url"], timeout=8.0)
        resp.raise_for_status()
        body = resp.json()
    except Exception:
        # The upstream is unreachable. Serve the last known shape rather than
        # showing an empty registry, and let the dashboard say so.
        return list(overlay.values())

    key = disc.get("collection_key", "agents")
    id_key = disc.get("id_key", "id")
    name_key = disc.get("name_key", "name")
    items = body.get(key, body) if isinstance(body, dict) else body

    found: list[AgentDescriptor] = []
    for i in items:
        agent_id = i.get(id_key) or i.get("id")
        if not agent_id:
            continue
        base = overlay.get(agent_id)
        found.append(
            AgentDescriptor(
                id=agent_id,
                name=i.get(name_key) or (base.name if base else agent_id),
                version=(base.version if base else "unknown"),
                role=(base.role if base else "ally"),
                capabilities=(base.capabilities if base else ()),
                source=(base.source if base else "agentic-harness"),
                owner=i.get("owner") or (base.owner if base else ""),
                invoke_path=(base.invoke_path if base else f"/api/agents/{agent_id}"),
                upstream_task_id=agent_id,
                active=True,
            )
        )

    # Agents that exist only on our side (the Mentor Agent) are not in the
    # upstream catalog and must not disappear because of that.
    seen = {d.id for d in found}
    found.extend(d for d in overlay.values() if d.id not in seen)
    return found or list(overlay.values())


def refresh(s: Session) -> list[AgentDescriptor]:
    found = discover()
    for d in found:
        row = s.get(Agent, d.id)
        if row is None:
            row = Agent(id=d.id)
            s.add(row)
        row.name = d.name
        row.role = d.role
        row.version = d.version
        row.capabilities = list(d.capabilities)
        row.source = d.source
        row.owner = d.owner
        row.active = d.active
    s.flush()
    return found


def by_id(agent_id: str) -> AgentDescriptor | None:
    for d in discover():
        if d.id == agent_id:
            return d
    return None


def by_upstream_task(task_id: str) -> AgentDescriptor | None:
    for d in discover():
        if d.upstream_task_id == task_id:
            return d
    return None


def all_agents(s: Session) -> list[Agent]:
    return list(s.scalars(select(Agent).order_by(Agent.name)))
