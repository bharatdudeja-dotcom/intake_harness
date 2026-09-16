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

/** Workfront object codes. OPTASK is an issue/request, PROJ a project. */
export const INTAKE_OBJECT = "OPTASK";

/** "CSC Intake - Issue", from the tenant's forms list. */
export const INTAKE_FORM_ID = "69cad7690002898fbf9d684642dc25bc";

export const CREATE_TOOL = "wf_core_issue_create";
export const CUSTOM_FIELDS_TOOL = "wf_core_issue_set_custom_fields";

export type CreateOutcome =
  | { created: true; objCode: string; objId: string; customFieldsSet: boolean }
  | { created: false; reason: string; wouldHaveCreated: { objCode: string; formId: string; fields: Record<string, unknown>; customFields: Record<string, unknown> } };

/**
 * Split an intake into the native Workfront fields and the custom-form values.
 * Only `name` and `description` are native on an issue; everything from the
 * Campaign Brief is a custom field.
 */
export function toWorkfrontPayload(intake: Record<string, unknown>, brief: string) {
  const { campaign_name: campaignName, ...rest } = intake;
  const fields: Record<string, unknown> = {
    name: String(campaignName || "Campaign intake (unnamed)"),
    description: brief,
    categoryID: INTAKE_FORM_ID,
  };
  const customFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v == null || String(v).trim() === "") continue;
    customFields[k] = v;
  }
  if (campaignName) customFields.campaign_name = campaignName;
  return { fields, customFields };
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
  const { fields, customFields } = toWorkfrontPayload(args.intake, args.brief);

  let created: { ID?: string; id?: string } | null = null;
  try {
    const result = await callMcpTool<{ data?: { ID?: string }; ID?: string }>(
      "intake",
      CREATE_TOOL,
      { fields },
    );
    created = (result && (result as { data?: { ID?: string } }).data) || (result as { ID?: string });
  } catch (err) {
    return {
      created: false,
      reason: (err as Error).message,
      wouldHaveCreated: { objCode: INTAKE_OBJECT, formId: INTAKE_FORM_ID, fields, customFields },
    };
  }

  const objId = String(created?.ID || created?.id || "");
  if (!objId) {
    return {
      created: false,
      reason: "Workfront accepted the create but returned no object id",
      wouldHaveCreated: { objCode: INTAKE_OBJECT, formId: INTAKE_FORM_ID, fields, customFields },
    };
  }

  // The custom-form values need the record to exist first. A failure here is
  // reported rather than swallowed: an issue with no brief fields on it looks
  // like a success and is not one.
  let customFieldsSet = false;
  if (Object.keys(customFields).length) {
    try {
      await callMcpTool("intake", CUSTOM_FIELDS_TOOL, { obj_id: objId, values: customFields });
      customFieldsSet = true;
    } catch {
      customFieldsSet = false;
    }
  }

  return { created: true, objCode: INTAKE_OBJECT, objId, customFieldsSet };
}
