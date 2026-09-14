import type { AgentName } from "./types";

/**
 * The pipeline order AND the least-privilege boundary for every agent.
 * This is the ONE place that decides which agent runs next, which MCP
 * tools it may call, and which prior agents' outputs it may see —
 * individual agent routes never call each other directly, and never get to
 * decide their own permissions. To add a 4th agent, add a row here;
 * nothing else in lib/pipeline changes.
 */
export interface AgentDefinition {
  name: AgentName;
  /** Path relative to the app's own origin — POSTed to by the orchestrator. */
  path: string;
  label: string;
  /** Who owns building out the real logic behind the stub, for the README/status UI. */
  owner: string;
  /**
   * MCP tool names this task may call, enforced inside
   * src/lib/mcp-client.ts — a call to any tool NOT in this list throws
   * immediately rather than silently succeeding. That throw surfaces as a
   * normal failed task_run (the orchestrator already records agent errors
   * that way), so a scoping violation is visible in observability, not a
   * silent hole.
   *
   * TODO(Workfront): Workfront tools aren't in the chaunceyplum/mcp tool
   * registry yet — today's tools are Adobe AEP/Reactor/CJA, AWS,
   * Databricks, Snowflake, and GitHub (see mcp_server/lambda_handler.py in
   * that repo). Add a Workfront tool module there first, then replace
   * these placeholders with the real tool names.
   */
  allowedTools: string[];
  /**
   * Which prior agents' outputs this task may see via `priorOutputs`,
   * beyond its own immediate `input` (always just the previous agent's
   * output). The orchestrator filters `priorOutputs` down to exactly this
   * list before calling the agent — an agent literally never receives a
   * key it isn't scoped to see, not just one it's expected to ignore.
   */
  contextAccess: AgentName[];
}

export const PIPELINE: AgentDefinition[] = [
  {
    name: "intake",
    path: "/api/agents/intake",
    label: "Agent 1 — Intake",
    owner: "Dev 1",
    // TODO(Workfront): swap in the real Workfront intake-queue tool names
    // once that module exists server-side.
    allowedTools: ["search_knowledge_base"],
    contextAccess: [], // first in the pipeline — nothing prior to see
  },
  {
    name: "review",
    path: "/api/agents/review",
    label: "Agent 2 — Review / Triage",
    owner: "Dev 2",
    // TODO(Workfront): review-queue rejections (B2 in the requirements doc)
    // likely live in Workfront — add its tool names here once available,
    // alongside whatever AEP validation tools this agent ends up needing.
    allowedTools: ["search_knowledge_base"],
    // Empty today: this stub doesn't read priorOutputs at all, and its
    // `input` already IS intake's output. Widen this only when a real
    // implementation needs to look back further than its immediate input.
    contextAccess: [],
  },
  {
    name: "audience_creation",
    path: "/api/agents/audience-creation",
    label: "Agent 3 — Audience Creation",
    owner: "Dev 3 (you)",
    allowedTools: [
      "search_knowledge_base",
      // B5 (3.1): decide FAC vs. AEP rule builder, and predict membership
      // count before the nightly cutoff (B6) — segment estimation, not the
      // full segmentation-job tools.
      "adobe_create_segment_estimate",
      "adobe_get_segment_estimate",
      "adobe_list_segments",
      "adobe_get_segment",
      "adobe_create_segment",
      // B4: check whether the attributes an audience needs already exist
      // in AEP before opening a GTO/attribute request.
      "adobe_list_schemas",
      "adobe_get_schema",
    ],
    // Empty today: this stub doesn't read priorOutputs, and Review's output
    // already carries the confirmed intake forward via its `input`. Add
    // "intake" here specifically if the real implementation needs the
    // ORIGINAL brief/grounding, separate from whatever Review transformed.
    contextAccess: [],
  },
];
