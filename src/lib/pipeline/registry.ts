import type { AgentName } from "./types";

/**
 * The pipeline order AND the least-privilege boundary for every agent.
 * This is the ONE place that decides which agent runs next, which MCP
 * tools it may call, and which prior agents' outputs it may see —
 * individual agent routes never call each other directly, and never get to
 * decide their own permissions. To add a 5th sequential agent, add a row to
 * PIPELINE; nothing else in lib/pipeline changes.
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
   * Workfront/Fusion tools now exist in chaunceyplum/mcp (14 servers under
   * mcp_server/workfront/servers/, each its own Lambda route — see the
   * route table atop src/lib/mcp-client.ts). The lists below are a DRAFT
   * first pass, not a confirmed final scope: they're least-privilege
   * guesses at what Intake/Review need for B1/B2 in the requirements doc
   * (create/read the work request; read/update it during triage), not a
   * sign-off on the real Workfront object model this team uses. Confirm
   * and adjust before treating these as final.
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
    // Workfront only (workfront-core), per the stated split: create the
    // work request from the marketer's brief (B1), and list/get to check
    // for an existing duplicate before creating one. No update/delete —
    // intake shouldn't be able to modify or remove existing records.
    allowedTools: [
      "search_knowledge_base",
      "wf_core_project_list",
      "wf_core_project_get",
      "wf_core_project_create",
      "wf_core_issue_list",
      "wf_core_issue_get",
      "wf_core_issue_create",
    ],
    contextAccess: [], // first in the pipeline — nothing prior to see
  },
  {
    name: "review",
    path: "/api/agents/review",
    label: "Agent 2 — Review / Triage",
    owner: "Dev 2",
    // Workfront (workfront-core + workfront-comments) plus other stuff, per
    // the stated split: read/update the work request while triaging a
    // rejection (B2), and read/post comments — that's where a rejection
    // reason and the redraft explanation most likely live.
    allowedTools: [
      "search_knowledge_base",
      "wf_core_project_get",
      "wf_core_project_update",
      "wf_core_issue_get",
      "wf_core_issue_update",
      "wf_comments_list",
      "wf_comments_create",
    ],
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

/**
 * Agent 4 — Escalation. NOT part of PIPELINE: it isn't step 4 of the happy
 * path, it's the handler for when the happy path doesn't happen.
 *
 * From the requirements doc (B9 / step 4.6): "Full escalation. The process
 * terminates without an audience, and nothing is captured... Log the
 * failure and classify it. This is the input to the crawl, walk, run loop
 * in section 10 — without it, the same class of failure recurs
 * indefinitely and the agents never improve."
 *
 * The orchestrator (runPipeline in orchestrator.ts) calls this agent
 * exactly when a run's status becomes "failed" — never on "needs_input",
 * which is an expected, resumable pause (B1's marketer round-trip, B3's
 * validation step), not a terminated-without-an-audience escalation. It
 * needs visibility into every prior agent's output to classify what
 * actually went wrong, which is why contextAccess is broad here — this is
 * the one agent where that's the job, not a scoping gap.
 */
export const ESCALATION: AgentDefinition = {
  name: "escalation",
  path: "/api/agents/escalation",
  label: "Agent 4 — Escalation",
  owner: "Unassigned",
  allowedTools: ["search_knowledge_base"], // TODO: look up prior similar failures once a real classification store exists
  contextAccess: ["intake", "review", "audience_creation"],
};

/** Every task, sequential pipeline + escalation — used to seed db/schema.sql's `tasks` catalog and for tool-allowlist lookups in lib/mcp-client.ts. */
export const ALL_TASKS: AgentDefinition[] = [...PIPELINE, ESCALATION];
