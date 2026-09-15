"""The only file that knows the shape of the Agentic Harness.

Everything in here was derived from the live HTTP surface on 15 Sep 2026; see
docs/UPSTREAMS.md. Two facts shape the whole module:

  * There is no MCP and no tools/list. Agents are HTTP POST routes.
  * Capture is POLLED AND RECONSTRUCTED, not intercepted. The orchestrator
    calls its agents server-side, so we read /api/runs/{id} afterwards. We do
    not pretend otherwise.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal

import httpx

from agent_manager.gateway import registry

Status = Literal["completed", "needs_input", "blocked", "failed", "running"]


@dataclass
class CapturedCall:
    """One upstream step, as we observed it."""

    task_run_id: str | None
    task_id: str
    step_index: int
    status: str
    inputs: dict
    outputs: dict
    metadata: dict
    duration_ms: int | None
    started_at: datetime | None
    finished_at: datetime | None
    embedded_error: str | None = None


@dataclass
class AgentResult:
    status: Status
    outputs: dict
    sub_calls: list[CapturedCall] = field(default_factory=list)
    loop_count: int | None = None
    gate_request: dict | None = None
    raw: dict = field(default_factory=dict)


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _embedded_error(body: Any, depth: int = 0) -> str | None:
    """Upstream embeds errors in output and still reports completed.

    Run f152405e is the worked example: search_knowledge_base returned
    "Unknown tool" and the step's status was `completed`. Anything that trusts
    the status field alone records that run as a clean success.
    """
    if depth > 6:
        return None
    if isinstance(body, dict):
        for k, v in body.items():
            if k.lower() in {"error", "err", "exception"} and v:
                return str(v)[:500]
            found = _embedded_error(v, depth + 1)
            if found:
                return found
    elif isinstance(body, list):
        for v in body:
            found = _embedded_error(v, depth + 1)
            if found:
                return found
    return None


class AgenticHarness:
    def __init__(self, base_url: str | None = None, timeout: float = 20.0):
        cfg = registry.upstream("agentic-harness")
        self.base_url = (base_url or cfg.get("base_url", "")).rstrip("/")
        self.runs_path = cfg.get("runs_path", "/api/runs")
        self.run_path = cfg.get("run_path", "/api/runs/{run_id}")
        self.timeout = timeout
        headers = {}
        auth = cfg.get("auth")
        if auth:
            headers["Authorization"] = auth
        self._client = httpx.Client(timeout=timeout, headers=headers)

    # ------------------------------------------------------------------ read

    def list_runs(self) -> list[dict]:
        r = self._client.get(f"{self.base_url}{self.runs_path}")
        r.raise_for_status()
        return r.json().get("runs", [])

    def get_run(self, upstream_run_id: str) -> dict:
        path = self.run_path.format(run_id=upstream_run_id)
        r = self._client.get(f"{self.base_url}{path}")
        r.raise_for_status()
        return r.json()

    # ----------------------------------------------------------------- write

    def start(self, brief: str) -> dict:
        """Open a run upstream. Returns the upstream run envelope."""
        r = self._client.post(
            f"{self.base_url}{self.runs_path}", json={"brief": brief}
        )
        r.raise_for_status()
        return r.json()

    def invoke_agent(self, agent_id: str, payload: dict) -> dict:
        d = registry.by_id(agent_id)
        if d is None or not d.invoke_path:
            raise ValueError(f"agent {agent_id!r} has no invoke path in the registry")
        r = self._client.post(f"{self.base_url}{d.invoke_path}", json=payload)
        r.raise_for_status()
        return r.json()

    # ----------------------------------------------------------- translation

    @staticmethod
    def to_captured(task_run: dict) -> CapturedCall:
        outputs = task_run.get("output") or {}
        return CapturedCall(
            task_run_id=str(task_run.get("task_run_id")) if task_run.get("task_run_id") else None,
            task_id=task_run.get("task_id", ""),
            step_index=int(task_run.get("step_index", 0)),
            status=task_run.get("status", "unknown"),
            inputs=task_run.get("input") or {},
            outputs=outputs,
            metadata=task_run.get("metadata") or {},
            duration_ms=task_run.get("duration_ms"),
            started_at=_parse_ts(task_run.get("started_at")),
            finished_at=_parse_ts(task_run.get("finished_at")),
            embedded_error=_embedded_error(outputs),
        )

    @classmethod
    def to_result(cls, envelope: dict) -> AgentResult:
        run = envelope.get("run") or {}
        calls = [cls.to_captured(t) for t in envelope.get("taskRuns") or []]

        # loopCount is per-step and inconsistent: {"loopCount": 0} on intake,
        # {} on review, an echo of input on audience_creation. Read it
        # defensively rather than assuming a uniform metadata shape.
        loop = None
        for c in calls:
            if isinstance(c.metadata, dict) and "loopCount" in c.metadata:
                loop = c.metadata.get("loopCount")
                break

        status = run.get("status", "running")
        if status == "completed" and any(c.embedded_error for c in calls):
            # The upstream says completed. The payload says otherwise. We record
            # what the upstream asserted and let reconciliation hold the verdict;
            # the stage badge is derived from evidence, not from this field.
            status = "completed"

        return AgentResult(
            status=status,  # type: ignore[arg-type]
            outputs=(calls[-1].outputs if calls else {}),
            sub_calls=calls,
            loop_count=loop,
            raw=envelope,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "AgenticHarness":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
