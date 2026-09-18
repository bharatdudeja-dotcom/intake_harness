/**
 * Agent 1's Workfront write, behind one seam.
 *
 * Creating the intake issue is two calls, not one, and the order is the tool's
 * own requirement rather than a preference: `_create` sets the native fields
 * and the `categoryID` that attaches the custom form, and only then can
 * `_set_custom_fields` fill the DE: values.
 *
 * The object model here is **observed, not guessed**. Chauncey's caveat was
 * that the `wf_core_*` usage was "a draft guess, not confirmed against
 * Comcast's real Workfront object model". The form ids below come from the
 * tenant's own forms list:
 *
 *   OPTASK  issue / request   "CSC Intake - Issue"   69cad769...
 *   PROJ    project           "Campaign Brief"       6a7fe8cd...
 *
 * Pluggable and optional, like Agent 2's redraft post. The Workfront routes
 * currently 404 at the gateway, so rather than block B1 on that, this records
 * exactly what it WOULD have created. When a Workfront MCP becomes reachable -
 * the in-house one or Adobe's official connector - it starts writing for real
 * with nothing here rewritten.
 */

import { callMcpTool } from "@/lib/mcp-client";
import { workfrontToolset } from "@/lib/workfront-tools";
import { resolveFieldMap, applyFieldMap, type FieldMap } from "@/lib/agents/intake/workfront-fields";
import { writeCustomFields } from "@/lib/agents/shared/workfront-write";
import { fieldByKey } from "@/lib/agents/shared/campaign-brief";

/**
 * What the intake creates in Workfront.
 *
 * OPTASK (an issue) is what the process map draws at 1.4, and it is what this
 * used to create. Two facts from the live tenant argue for a project instead:
 *
 * 1. Workfront refuses a parentless issue - "projectID cannot be null". An
 *    issue exists INSIDE a project, so creating one first requires choosing a
 *    project, which is a decision nobody has made yet.
 *
 * 2. The brief's own fields are project fields. DE:Name of the Campaign,
 *    DE:Objective of the campaign, DE:Audience_to_be_Targeted and
 *    DE:Requested_Launch_Date all live on project in this tenant; the issue
 *    entity carries none of them.
 *
 * Creating a PROJECT instead was tried, and Workfront settled it: "category
 * 'CSC Intake - Issue' is not configured for object type 'PROJ'". The form is an
 * issue form, so the intake is an issue - which means it needs a parent project,
 * and that is what INTAKE_QUEUE_NAME resolves.
 *
 * WORKFRONT_INTAKE_OBJECT overrides it, because which object an intake should be
 * is a process decision and not ours to settle in code.
 */
export const INTAKE_OBJECT = process.env.WORKFRONT_INTAKE_OBJECT || "OPTASK";

/** "CSC Intake - Issue", from the tenant's forms list. */
export const INTAKE_FORM_ID = "69cad7690002898fbf9d684642dc25bc";

/**
 * Kept as exports because other modules and tests import them, but they are no
 * longer constants: which tool creates an issue depends on which Workfront MCP
 * we are pointed at, and the in-house one this used to name is not deployed.
 * See lib/workfront-tools.ts.
 */
/**
 * The project new intake issues land in.
 *
 * Workfront refuses a parentless issue - "projectID cannot be null" - so an
 * intake needs a home. This tenant has "CSC - Intake Queue" (status CUR), whose
 * name matches the intake form's own ("CSC Intake - Issue"), so that is the
 * queue.
 *
 * Resolved BY NAME at run time, not stored as an id. A hardcoded GUID is right
 * until somebody rebuilds the queue, and then it is silently wrong - it would
 * point at a project that still exists and is no longer the one in use.
 */
export const INTAKE_QUEUE_NAME = process.env.WORKFRONT_INTAKE_QUEUE || "CSC - Intake Queue";

/** Resolve the queue project's id, or say why not. */
export async function resolveIntakeQueue(): Promise<{ id: string | null; name: string; reason: string | null }> {
  if (process.env.WORKFRONT_INTAKE_PROJECT_ID) {
    return { id: process.env.WORKFRONT_INTAKE_PROJECT_ID, name: "(from WORKFRONT_INTAKE_PROJECT_ID)", reason: null };
  }
  try {
    const found = await callMcpTool<unknown>("intake", "insights_find_id_by_name", {
      entity: "project",
      name: INTAKE_QUEUE_NAME,
    });
    // The connector answers in prose or in JSON depending on the tool; a 32-char
    // Workfront GUID is unambiguous either way.
    const text = typeof found === "string" ? found : JSON.stringify(found);
    const id = text.match(/\b[0-9a-f]{32}\b/i)?.[0] || null;
    return id
      ? { id, name: INTAKE_QUEUE_NAME, reason: null }
      : { id: null, name: INTAKE_QUEUE_NAME, reason: `could not find a project called "${INTAKE_QUEUE_NAME}"` };
  } catch (err) {
    return { id: null, name: INTAKE_QUEUE_NAME, reason: (err as Error).message };
  }
}

export const CREATE_TOOL = workfrontToolset().create;
export const CUSTOM_FIELDS_TOOL = workfrontToolset().update;

type FieldNames = { verified: boolean; source: string; dropped: string[] };

export type CreateOutcome =
  | {
      created: true;
      objCode: string;
      objId: string;
      customFieldsSet: boolean;
      customFieldsError: string | null;
      /** Exactly which of the brief's fields reached Workfront. */
      customFieldsWritten: string[];
      /** And which did not, with the reason. */
      customFieldsRejected: Array<{ field: string; reason: string }>;
      fieldNames: FieldNames;
    }
  | {
      created: false;
      reason: string;
      wouldHaveCreated: { objCode: string; formId: string; fields: Record<string, unknown>; customFields: Record<string, unknown> };
      fieldNames: FieldNames;
    };

/**
 * Split an intake into the native Workfront fields and the custom-form values.
 * Only `name` and `description` are native on an issue; everything from the
 * Campaign Brief is a custom field.
 */
/**
 * The brief, and what was understood from it, for the person who approves it.
 *
 * A reviewer is approving our READING of the request, not the paragraph - so
 * the reading has to be in front of them. On this tenant the form has four
 * fields and we extract up to fourteen, so without this the other ten exist
 * only inside our own run record, which nobody in Workfront can see.
 *
 * It also states which values reached the form and which had no field to go
 * into. "Recorded here, not on the form" is a fact a reviewer can act on;
 * silence about it is how a request gets approved on less than it appears.
 *
 * Plain text. A Workfront description is not an HTML field.
 */
function describeIntake(
  brief: string,
  values: Record<string, unknown>,
  written: Record<string, unknown>,
  dropped: string[],
): string {
  const lines: string[] = [String(brief || "").trim()];

  const reading = Object.entries(values)
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `- ${fieldByKey(k)?.label || k}: ${String(v).trim()}`);

  if (reading.length) {
    lines.push("", "What was captured from this brief:", ...reading);
  }

  const onForm = Object.keys(written).length;
  if (onForm) {
    lines.push("", `${onForm} of these are also set in the request's own fields.`);
  }
  if (dropped.length) {
    const labels = dropped.map((k) => fieldByKey(k)?.label || k);
    lines.push(
      `${labels.length} have no matching field on this form and are recorded above only: ` +
        `${labels.join(", ")}.`,
    );
  }
  if (!onForm) {
    lines.push(
      "None of the request's own fields could be set - the values are above so nothing is lost.",
    );
  }

  return lines.join("\n");
}

export function toWorkfrontPayload(
  intake: Record<string, unknown>,
  brief: string,
  fieldMap?: FieldMap | null,
) {
  const { campaign_name: campaignName, workfront_project_id: projectIdOverride, ...rest } = intake;
  const fields: Record<string, unknown> = {
    name: String(campaignName || "Campaign intake (unnamed)"),
    description: brief,
    categoryID: INTAKE_FORM_ID,
  };
  // Routing metadata, not a brief field — pulled out here (same as
  // campaign_name) so it lands as the native projectID rather than being
  // sent to Workfront as a bogus DE: custom field. createIntakeRequest
  // skips resolveIntakeQueue entirely when this is set.
  if (projectIdOverride) fields.projectID = String(projectIdOverride);
  /*
   * Custom-field names come from the form, via a FieldMap.
   *
   * This used to send our own internal keys - `business_objective` - as the
   * custom-field name. Workfront addresses custom fields as
   * `DE:<parameter name>`, so every value in the brief would have been dropped
   * while the create still reported success: an issue with a title, a
   * description, and none of the actual brief. See workfront-fields.ts.
   *
   * Passing no map keeps the raw keys, which is only for inspecting the shape -
   * createIntakeRequest always resolves one.
   */
  const customFields: Record<string, unknown> = {};
  const values: Record<string, unknown> = { ...rest };
  if (campaignName) values.campaign_name = campaignName;

  /*
   * Compose the audience sentence from the parts the form cannot hold
   * separately. The tenant's form asks "Audience to be targeted" as one free
   * field, and we extract customer type, region and the exclusion as three -
   * so joining them is how the brief survives the trip, rather than three
   * values being dropped for having nowhere to go.
   */
  if (!values.audience_description) {
    /*
     * The audience sentence has to contain the AUDIENCE.
     *
     * This composed customer type, line of business, region and exclusion, and
     * produced "Subscriber - Existing Customers in Residential (RES) in the
     * Pennsylvania" - which reads badly and, worse, says nothing about what
     * defines the audience. The brief's own clause does: "who have Xfinity TV
     * but no Internet" is the targeting, and it is what a reviewer needs to see
     * in the field labelled "Audience to be targeted".
     *
     * "in the Northeast" is right and "in the Pennsylvania" is not, so the
     * article follows the shape of the value rather than being assumed.
     */
    const region = values.region ? String(values.region) : null;
    const article = region && /^(north|south|east|west|mid|national)/i.test(region) ? "the " : "";
    const holdings = String(brief || "").match(/\bwho\s+(?:have|has|hold|holds)\b[^.;]{0,120}/i)?.[0]?.trim();

    const parts = [
      values.customer_type,
      values.line_of_business ? `in ${values.line_of_business}` : null,
      region ? `in ${article}${region}` : null,
      holdings || null,
      values.exclusion ? `excluding ${values.exclusion}` : null,
    ].filter(Boolean).map(String);
    if (parts.length) values.audience_description = parts.join(", ");
  }

  if (fieldMap) {
    const applied = applyFieldMap(values, fieldMap);
    fields.description = describeIntake(brief, values, applied.customFields, applied.dropped);
    return {
      fields,
      customFields: applied.customFields,
      dropped: applied.dropped,
      // Carried so the artifact can say the launch date's year was inferred,
      // rather than presenting an inferred date as one the marketer gave.
      coerced: applied.coerced,
      uncoercible: applied.uncoercible,
      fieldMap,
    };
  }
  for (const [k, v] of Object.entries(values)) {
    if (v == null || String(v).trim() === "") continue;
    customFields[k] = v;
  }
  return { fields, customFields, dropped: [], coerced: [], uncoercible: [], fieldMap: null };
}

/**
 * Create the intake request in Workfront.
 *
 * Returns what it would have created when the tools are unreachable, so a
 * reviewer can see the exact payload and the run is not blocked on a
 * deployment that is out of our hands.
 */
export async function createIntakeRequest(args: {
  intake: Record<string, unknown>;
  brief: string;
}): Promise<CreateOutcome> {
  /*
   * Resolve the form's real field names BEFORE building the payload.
   *
   * This is the step whose absence made every custom-field value disappear:
   * Workfront wants DE:<parameter name> and we were sending our own keys. The
   * resolution reports whether it read the form or fell back to assuming, and
   * that flag travels with the outcome - a payload nobody can tell apart from a
   * verified one is how the bug survived.
   */
  const fieldMap = await resolveFieldMap(INTAKE_FORM_ID, INTAKE_OBJECT === "PROJ" ? "project" : "issue", "intake");
  const { fields, customFields, dropped, coerced, uncoercible } = toWorkfrontPayload(args.intake, args.brief, fieldMap);

  /*
   * An issue belongs to a project. `fields.projectID` is already set if the
   * intake specified `workfront_project_id` (see toWorkfrontPayload) - in
   * that case this is the marketer's own routing choice and resolution is
   * skipped entirely, including the MCP lookup. Otherwise resolve the queue
   * and attach it, and if it cannot be found, say THAT rather than sending
   * a create that Workfront will reject for a reason the reader then has to
   * decode.
   */
  const needsQueue = INTAKE_OBJECT === "OPTASK" && !fields.projectID;
  const queue = needsQueue ? await resolveIntakeQueue() : { id: null, name: "", reason: null };
  if (needsQueue) {
    if (!queue.id) {
      return {
        created: false,
        reason: `Cannot create the intake issue: ${queue.reason}. An issue must belong to a project, so set WORKFRONT_INTAKE_QUEUE to the name of the queue, or WORKFRONT_INTAKE_PROJECT_ID to its id.`,
        wouldHaveCreated: { objCode: INTAKE_OBJECT, formId: INTAKE_FORM_ID, fields, customFields },
        fieldNames: { verified: fieldMap.verified, source: fieldMap.source, dropped },
      };
    }
    fields.projectID = queue.id;
  }

  let created: { ID?: string; id?: string } | null = null;
  try {
    const set = workfrontToolset();
    const result = await callMcpTool<{ data?: { ID?: string }; ID?: string }>(
      "intake",
      set.create,
      // The argument shape differs by flavour: Adobe's connector takes an
      // objCode alongside the fields because one tool covers every object type.
      set.createArgs(INTAKE_OBJECT, fields, args.brief),
    );
    created = (result && (result as { data?: { ID?: string } }).data) || (result as { ID?: string });
  } catch (err) {
    const raw = (err as Error).message;
    /*
     * Name the cause, not the symptom.
     *
     * "Tool workflow_create_any_object not found" reads like a bug in this
     * integration, and sent us looking in the wrong place more than once. The
     * tool is absent because WRITE ACTIONS ARE DISABLED ON THE TENANT - 44 of
     * the connector's 94 tools are writes and a Workfront admin enables them in
     * System Preferences. Nothing in this repo can fix that, and saying so
     * plainly is the only useful thing to report.
     */
    const isMissingWriteTool = /not found/i.test(raw) && /workflow_(create|update)|comment-stream_create/i.test(raw);
    return {
      created: false,
      reason: isMissingWriteTool
        ? `${raw} — this tool is absent because WRITE ACTIONS ARE NOT ENABLED on the Workfront tenant. ` +
          "A Workfront admin turns them on in Setup > System > Preferences (44 of the connector's 94 tools " +
          "are writes and they are off by default). Everything up to the write worked: the payload below is " +
          "what would have been created."
        : raw,
      wouldHaveCreated: { objCode: INTAKE_OBJECT, formId: INTAKE_FORM_ID, fields, customFields },
      fieldNames: { verified: fieldMap.verified, source: fieldMap.source, dropped },
    };
  }

  const objId = String(created?.ID || created?.id || "");
  if (!objId) {
    return {
      created: false,
      reason: "Workfront accepted the create but returned no object id",
      wouldHaveCreated: { objCode: INTAKE_OBJECT, formId: INTAKE_FORM_ID, fields, customFields },
      fieldNames: { verified: fieldMap.verified, source: fieldMap.source, dropped },
    };
  }

  // The custom-form values need the record to exist first. A failure here is
  // reported rather than swallowed: an issue with no brief fields on it looks
  // like a success and is not one.
  let customFieldsSet = false;
  let customFieldsError: string | null = null;
  let customFieldsWritten: string[] = [];
  let customFieldsRejected: Array<{ field: string; reason: string }> = [];
  if (Object.keys(customFields).length) {
    // customFields is already keyed by DE:<parameter name>.
    const outcome = await writeCustomFields("intake", INTAKE_OBJECT, objId, customFields, args.brief);
    customFieldsWritten = outcome.written;
    customFieldsRejected = outcome.rejected;
    // "Set" means every value landed. Partial is its own state and says so.
    customFieldsSet = outcome.written.length > 0 && outcome.rejected.length === 0;
    if (outcome.rejected.length) {
      customFieldsError =
        `${outcome.rejected.length} field(s) refused by Workfront: ` +
        outcome.rejected.map((r) => r.field).join(", ") +
        ` — each is not on a custom form attached to this ${INTAKE_OBJECT}. ` +
        `${outcome.written.length} field(s) were written.`;
    }
  }

  return {
    created: true, objCode: INTAKE_OBJECT, objId, customFieldsSet,
    // A create that wrote none of the brief is not a success worth reporting
    // quietly. The reason travels with it.
    customFieldsError,
    customFieldsWritten,
    customFieldsRejected,
    fieldNames: { verified: fieldMap.verified, source: fieldMap.source, dropped },
  };
}
