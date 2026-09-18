import type { AgentName } from "./types";
import { allWorkfrontToolNames } from "@/lib/workfront-tools";

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
      "search_adobe_knowledge",
      ...allWorkfrontToolNames(),
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
      "search_adobe_knowledge",
      ...allWorkfrontToolNames(),
      // triage.ts's "wrong_data_source" finding (FAC vs. the AEP profile
      // store, the most expensive classification this agent makes) is a
      // guess without being able to check AEP itself: whether the attribute
      // actually lives in a profile-enabled schema, whether an audience
      // already exists for this ask, and roughly how big the candidate
      // profile dataset is. All read-only — Review triages and asks; it
      // does not create/update anything in AEP (that's Agent 3's job).
      //
      // WHEN THIS IS WIRED UP: whatever calls adobe_get_schema must only
      // ever treat a field as present when it is literally named in that
      // response's field list — never inferred from the schema's title, a
      // field's plausible existence, or the marketer's own wording. Agent
      // 3's src/lib/agents/audience/aep.ts hit this exact failure mode
      // (word-boundary matching against real field names, because an
      // unanchored match on "lob" once matched "glob" inside a URL and
      // reported line-of-business as available on nothing) — reuse that
      // discipline here rather than re-learning it. A hallucinated field
      // answers "wrong data source" wrong, silently, which is worse than
      // not answering it at all.
      "adobe_list_schemas",
      "adobe_get_schema",
      // A class-based schema (Profile, ExperienceEvent) rarely carries its
      // fields inline - it composes them from field groups via allOf/$ref,
      // so reading the class schema alone and finding nothing is "asked the
      // wrong document," not "no fields exist." See aep.ts's
      // fieldGroupRefs/FIELD_GROUP_SAMPLE for exactly how this is used and
      // why it's bounded.
      "adobe_get_field_group",
      "adobe_list_segments",
      "adobe_get_segment",
      // Catalog metadata is how you tell a profile-enabled dataset from any
      // other (its schema's union/profile behavior). No Query Service access —
      // that's a much bigger permission (arbitrary SQL) than this stub needs
      // just to triage a rejection.
      "adobe_list_datasets",
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
      "search_adobe_knowledge",
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
      // See registry.ts's note on review's identical grant, and aep.ts's
      // fieldGroupRefs: a class schema's fields usually live in a
      // referenced field group, not inline on the class schema itself.
      "adobe_get_field_group",
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
  // NOTE: the knowledge tool is `search_adobe_knowledge`. `search_knowledge_base`
  // does NOT exist on any server in the estate - it was asked for here and in
  // all three agents above, every call failed, the failure was written into the
  // payload rather than raised, and the run still reported `completed`. That is
  // why escalation has never fired. Verified against the live endpoint, 238 tools.
  allowedTools: ["search_adobe_knowledge"], // TODO: look up prior similar failures once a real classification store exists
  contextAccess: ["intake", "review", "audience_creation"],
};

/** Every task, sequential pipeline + escalation — used to seed db/schema.sql's `tasks` catalog and for tool-allowlist lookups in lib/mcp-client.ts. */
export const ALL_TASKS: AgentDefinition[] = [...PIPELINE, ESCALATION];
