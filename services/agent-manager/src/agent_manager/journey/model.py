"""The Journey: a process definition loaded from YAML.

The point of this module is that Agent Manager knows nothing about creative
intake, Xfinity, or four agents. It knows about acts, stages and artifacts.
Point it at a different YAML and it runs a different process.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator, Literal

import yaml

from agent_manager.config import settings

AgentRole = Literal["hero", "mentor", "ally", "trickster", "none"]

# The seven human mentor roles. The humans are collectively the Author.
AUTHOR_ROLES = (
    "visionary",
    "governor",
    "steward",
    "driver",
    "informer",
    "gate_keeper",
    "facilitator",
)


@dataclass(frozen=True)
class Stage:
    key: str
    title: str
    artifact: str
    act_key: str
    act_title: str
    seq: int
    agent_role: AgentRole = "none"
    agent_id: str | None = None
    approver_role: str = "gate_keeper"
    gate: bool = False
    reconcile: bool = False
    optional: bool = False
    human_only: bool = False
    description: str = ""
    health: dict[str, Any] = field(default_factory=dict)

    @property
    def qualified(self) -> str:
        return f"{self.act_key}.{self.key}"


@dataclass(frozen=True)
class Act:
    key: str
    title: str
    intent: str
    seq: int
    stages: tuple[Stage, ...]


@dataclass(frozen=True)
class Journey:
    key: str
    name: str
    client: str
    version: str
    executor: dict[str, Any]
    acts: tuple[Act, ...]

    @property
    def stages(self) -> tuple[Stage, ...]:
        return tuple(s for a in self.acts for s in a.stages)

    def stage(self, key: str) -> Stage | None:
        for s in self.stages:
            if s.key == key or s.qualified == key:
                return s
        return None

    def stage_for_agent(self, agent_id: str) -> Stage | None:
        for s in self.stages:
            if s.agent_id == agent_id:
                return s
        return None

    def __iter__(self) -> Iterator[Stage]:
        return iter(self.stages)


def load_journey(path: Path | None = None) -> Journey:
    cfg = settings()
    path = path or (cfg.config_dir / cfg.journey_file)
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))

    acts: list[Act] = []
    seq = 0
    for a_i, a in enumerate(raw.get("acts", [])):
        stages: list[Stage] = []
        for s in a.get("stages", []):
            stages.append(
                Stage(
                    key=s["key"],
                    title=s["title"],
                    artifact=s.get("artifact", ""),
                    act_key=a["key"],
                    act_title=a["title"],
                    seq=seq,
                    agent_role=s.get("agent_role", "none"),
                    agent_id=s.get("agent_id"),
                    approver_role=s.get("approver_role", "gate_keeper"),
                    gate=bool(s.get("gate", False)),
                    reconcile=bool(s.get("reconcile", False)),
                    optional=bool(s.get("optional", False)),
                    human_only=bool(s.get("human_only", False)),
                    description=(s.get("description") or "").strip(),
                    health=s.get("health") or {},
                )
            )
            seq += 1
        acts.append(
            Act(
                key=a["key"],
                title=a["title"],
                intent=(a.get("intent") or "").strip(),
                seq=a_i,
                stages=tuple(stages),
            )
        )

    return Journey(
        key=raw["key"],
        name=raw["name"],
        client=raw.get("client", ""),
        version=str(raw.get("version", "1")),
        executor=raw.get("executor", {}),
        acts=tuple(acts),
    )


@lru_cache
def journey() -> Journey:
    return load_journey()
