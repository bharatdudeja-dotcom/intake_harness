/**
 * Which Workfront MCP the agents are talking to, and what its tools are called.
 *
 * THE PROBLEM THIS SOLVES
 *
 * The agents used to name in-house tools directly - `wf_core_issue_create`,
 * `wf_comments_list` - from the estate in chaunceyplum/mcp. Every one of those
 * routes returns HTTP 404 at the deployed gateway (verified 16 Sep 2026:
 * /mcp/workfront/core, /comments, /search, /metadata and /mcp/fusion/* all 404;
 * only /mcp, the 238-tool AEC server, answers). So nothing the agents asked of
 * Workfront has ever reached Workfront.
 *
 * Adobe ships an official Workfront MCP that does answer, and it names things
 * differently: one generic object tool rather than one per object type, and a
 * separate comment-stream server. So the flavour cannot be a URL swap - the tool
 * NAMES and the argument shapes differ.
 *
 * WHAT WE LOSE BY GOING OFFICIAL
 *
 * Measured against what the agents actually allowlist, nothing. Every operation
 * they use - read/create/update a project or issue, list/create comments - has a
 * documented official equivalent, mapped below. What the in-house estate has and
 * Adobe's does not:
 *
 *   - raw REST escape hatches (wf_get/wf_post/wf_put/wf_delete, wf_search_generic)
 *   - running a saved Workfront report or named query by id
 *   - document webhooks (wf_docs_webhook_*)
 *   - the Fusion tools (fusion_org_*, fusion_scenario_*, ...)
 *
 * None of those are allowlisted by any agent today. Against that we gain: it
 * actually works; OAuth as the signed-in person, so an approval is attributable
 * to a human rather than to a service account; ~25 approval tools, which matters
 * for a review and triage pipeline; and AEM folder linkage.
 *
 * ARGUMENT SHAPES ARE NOT YET VERIFIED AGAINST A LIVE TENANT
 *
 * The tool NAMES below are verbatim from Adobe's published tool list. The
 * argument shapes are inferred from the Workfront API's own conventions and have
 * NOT been checked against the live schemas, because listing them requires an
 * OAuth token and nobody has signed in yet. Until that happens, treat a write
 * through this adapter as unverified: createIntakeRequest already reports what
 * it WOULD have created when a call fails, so an unverified payload surfaces as
 * a visible dry run rather than a wrong record in a client's Workfront. Verify
 * with `check_mcp_server` in Agent Manager once authenticated, then delete this
 * paragraph.
 */

export type WorkfrontFlavour = "adobe-official" | "inhouse";

export interface WorkfrontToolset {
  flavour: WorkfrontFlavour;
  /** Create one object. */
  create: string;
  /** Update one object - also how custom-form values are set. */
  update: string;
  /** Find objects of a type. */
  search: string;
  /** Read one object by id. */
  getOne: string;
  /** Turn human field labels into the API's field names. */
  resolveFields: string | null;
  listComments: string;
  createComment: string;
  /** Build the arguments for a create, for this flavour. */
  createArgs: (objCode: string, fields: Record<string, unknown>) => Record<string, unknown>;
  /** Build the arguments for setting custom-form values on an existing object. */
  customFieldArgs: (
    objCode: string,
    objId: string,
    values: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * Adobe's official connector.
 *
 * The shape of it is one generic tool per verb plus an objCode, rather than a
 * tool per object type - so `workflow_create_any_object` covers what
 * wf_core_project_create and wf_core_issue_create did separately.
 */
const ADOBE_OFFICIAL: WorkfrontToolset = {
  flavour: "adobe-official",
  create: "workflow_create_any_object",
  update: "workflow_update_any_object",
  search: "workflow_search_any_object",
  getOne: "insights_summarize_object",
  resolveFields: "workflow_resolve_field_names_any_object",
  listComments: "comment-stream_query_comments",
  createComment: "comment-stream_create_comment",
  createArgs: (objCode, fields) => ({ objCode, fields }),
  // Workfront treats custom-form values as ordinary parameters on the object,
  // so setting them is an update rather than a distinct call. That is why this
  // flavour needs no separate custom-fields tool.
  customFieldArgs: (objCode, objId, values) => ({ objCode, objID: objId, fields: values }),
};

/** The in-house estate. Kept so the flavour can be switched back, not because it works. */
const INHOUSE: WorkfrontToolset = {
  flavour: "inhouse",
  create: "wf_core_issue_create",
  update: "wf_core_issue_update",
  search: "wf_core_issue_list",
  getOne: "wf_core_issue_get",
  resolveFields: null,
  listComments: "wf_comments_list",
  createComment: "wf_comments_create",
  createArgs: (_objCode, fields) => ({ fields }),
  customFieldArgs: (_objCode, objId, values) => ({ obj_id: objId, values }),
};

/**
 * Which flavour to use.
 *
 * Defaults to Adobe's official connector, because the in-house Workfront routes
 * are not deployed and defaulting to something that returns 404 is not a
 * default, it is a trap. WORKFRONT_MCP_FLAVOUR=inhouse restores the old names.
 */
export function workfrontToolset(): WorkfrontToolset {
  const raw = String(process.env.WORKFRONT_MCP_FLAVOUR || "").trim().toLowerCase();
  return raw === "inhouse" ? INHOUSE : ADOBE_OFFICIAL;
}

/** Every tool name a flavour can reach, for the pipeline allowlists. */
export function workfrontToolNames(set: WorkfrontToolset): string[] {
  return [
    set.create,
    set.update,
    set.search,
    set.getOne,
    set.listComments,
    set.createComment,
    ...(set.resolveFields ? [set.resolveFields] : []),
  ];
}

/** Both flavours' names, so an allowlist does not have to change with the flavour. */
export function allWorkfrontToolNames(): string[] {
  return [...new Set([...workfrontToolNames(ADOBE_OFFICIAL), ...workfrontToolNames(INHOUSE)])];
}
