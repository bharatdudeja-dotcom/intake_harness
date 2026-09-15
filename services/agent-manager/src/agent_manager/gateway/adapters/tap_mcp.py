"""Client for the in-house MCP estate (chaunceyplum/mcp).

Decision D9: we use Chauncey's MCP rather than Adobe's official Workfront
connector. This is the only file that knows that estate's shape.

Fifteen Lambdas behind one API Gateway. The base domain comes from the original
AEC endpoint with its trailing /mcp stripped; the route is then chosen from the
tool name's prefix, exactly as src/lib/mcp-client.ts does it upstream. Callers
pass a tool name and never need to know which Lambda serves it.

Auth: none from this side. The Lambdas own it — Adobe IMS, Workfront IMS,
SSM-resolved credentials. That is also why the gateway must not be reachable by
anyone who should not be spending against those credentials; see DECISIONS.md.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import httpx
import yaml

from agent_manager.config import settings

# Tool-name prefix -> Lambda route. Mirrors MCP_SERVER_ROUTES upstream.
# Anything without a known prefix is one of the original AEC tools at /mcp.
ROUTES: tuple[tuple[str, str], ...] = (
    ("wf_core_", "/mcp/workfront/core"),
    ("wf_users_", "/mcp/workfront/users"),
    ("wf_docs_", "/mcp/workfront/documents"),
    ("wf_time_", "/mcp/workfront/time-approval"),
    ("wf_metadata_", "/mcp/workfront/metadata"),
    ("wf_search_", "/mcp/workfront/search"),
    ("wf_comments_", "/mcp/workfront/comments"),
    ("wf_planning_", "/mcp/workfront/planning"),
    ("wf_misc_", "/mcp/workfront/misc"),
    ("fusion_org_", "/mcp/fusion/org"),
    ("fusion_conn_", "/mcp/fusion/connections"),
    ("fusion_hook_", "/mcp/fusion/hooks"),
    ("fusion_scenario_", "/mcp/fusion/scenarios"),
    ("fusion_exec_", "/mcp/fusion/executions"),
)

DEFAULT_ROUTE = "/mcp"


class McpUnavailable(RuntimeError):
    """The estate is not configured or not reachable.

    Never caught-and-faked. An unverifiable call is a state the dashboard has
    to be able to show.
    """


class McpToolError(RuntimeError):
    """The tool ran and returned an error, or does not exist.

    This is the class of failure that produced `Unknown tool:
    search_knowledge_base` upstream. Here it is raised, not embedded in a
    payload that still reports success.
    """


def route_for(tool: str) -> str:
    for prefix, path in ROUTES:
        if tool.startswith(prefix):
            return path
    return DEFAULT_ROUTE


@lru_cache
def _cfg() -> dict[str, Any]:
    path = settings().config_dir / "workfront.yaml"
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def api_base() -> str:
    """The gateway root, with any trailing /mcp removed."""
    url = (_cfg().get("connector", {}) or {}).get("endpoint_url") or ""
    url = (settings().mcp_endpoint_url or url).strip()
    if not url:
        raise McpUnavailable(
            "no MCP endpoint configured. Set AM_MCP_ENDPOINT_URL to the "
            "McpEndpointUrl SAM output from the chaunceyplum/mcp deployment "
            "(the same value the harness puts in MCP_ENDPOINT_URL)."
        )
    return re.sub(r"/mcp/?$", "", url.rstrip("/"))


@dataclass
class ToolCall:
    """What we are about to do, recorded before we do it."""

    tool: str
    arguments: dict[str, Any]

    @property
    def route(self) -> str:
        return route_for(self.tool)


class TapMCP:
    def __init__(self, base: str | None = None, timeout: float = 30.0):
        self._base = base
        self.timeout = timeout
        self._id = 0
        self._tools: dict[str, list[dict]] = {}

    @property
    def base(self) -> str:
        return self._base or api_base()

    @property
    def configured(self) -> bool:
        try:
            return bool(self.base)
        except McpUnavailable:
            return False

    def _rpc(self, route: str, method: str, params: dict | None = None) -> dict:
        self._id += 1
        body: dict[str, Any] = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            body["params"] = params
        try:
            resp = httpx.post(
                f"{self.base}{route}",
                json=body,
                timeout=self.timeout,
                headers={"Content-Type": "application/json"},
            )
        except httpx.HTTPError as exc:
            raise McpUnavailable(f"{route} unreachable: {exc}") from exc

        if resp.status_code >= 400:
            raise McpUnavailable(f"{route} returned HTTP {resp.status_code}")

        data = resp.json()
        if data.get("error"):
            raise McpToolError(data["error"].get("message", str(data["error"])))
        return data.get("result", {})

    def tools(self, route: str = DEFAULT_ROUTE) -> list[dict]:
        """Real discovery. Never guess a tool name."""
        if route not in self._tools:
            self._tools[route] = self._rpc(route, "tools/list").get("tools", [])
        return self._tools[route]

    def has_tool(self, tool: str) -> bool:
        return any(t.get("name") == tool for t in self.tools(route_for(tool)))

    def call(self, tool: str, arguments: dict[str, Any] | None = None) -> Any:
        """Call one tool and unwrap the MCP content envelope."""
        result = self._rpc(
            route_for(tool),
            "tools/call",
            {"name": tool, "arguments": arguments or {}},
        )
        return unwrap(result, tool)


def unwrap(result: dict, tool: str) -> Any:
    """Unwrap `{content:[{type,text}], isError}` into a native value.

    An `isError` envelope raises. Upstream's intake route catches the
    equivalent and writes it into its output while still reporting
    `completed`; we do not repeat that.
    """
    if result.get("isError"):
        text = "\n".join(
            c.get("text", "") for c in (result.get("content") or []) if c.get("text")
        )
        raise McpToolError(f'tool "{tool}" returned an error: {text or "unknown"}')

    content = result.get("content") or []
    first = content[0].get("text") if content else None
    if first is None:
        return result
    try:
        return json.loads(first)
    except (TypeError, ValueError):
        return first
