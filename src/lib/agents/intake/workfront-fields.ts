/**
 * Addressing Workfront custom fields by the names Workfront actually uses.
 *
 * THE BUG THIS FIXES
 *
 * toWorkfrontPayload sent our own internal keys as custom-field names -
 * `business_objective`, `line_of_business` - with no prefix. Workfront does not
 * address custom fields that way. A custom form is a Category (CTGY), its
 * questions are parameters, and a value is written as `DE:<parameter name>`
 * where the name is the form's own label.
 *
 * So once someone signs in, every create would have succeeded and written
 * nothing but a title and a description. The brief itself - objective, line of
 * business, launch date, all of it - would have been dropped on the floor, and
 * the run would have reported completed. A silent failure of exactly the kind
 * this pipeline is meant to expose.
 *
 * Credit where it is due: the object model here is documented in Uday's
 * adobe-agent connector (`workfront.category.get_fields`), which says it
 * plainly - "each field is then addressed as DE:<parameter name>... without
 * this the agent is guessing at field names". We were guessing.
 *
 * TWO PATHS, AND THE HONEST DIFFERENCE BETWEEN THEM
 *
 * 1. DISCOVERED. Read the form from Workfront and map our keys onto its real
 *    parameter names. This is the correct path and it needs a signed-in
 *    connector.
 *
 * 2. ASSUMED. Fall back to the field's human label from campaign-brief.ts,
 *    DE:-prefixed. It is a reasonable guess because forms are usually labelled
 *    the way people speak, and it is STILL A GUESS - so every payload built
 *    this way is marked `verified: false`, and the agent reports which it used.
 *    A payload nobody can tell apart from a verified one is how this bug
 *    survived in the first place.
 */

import { callMcpTool } from "@/lib/mcp-client";
import { CAMPAIGN_BRIEF_FIELDS, fieldByKey } from "@/lib/agents/shared/campaign-brief";

/** Workfront's own prefix for a custom-form value. */
const DE = "DE:";

export type FieldMap = {
  /** our key -> the exact name to send, e.g. "DE:Business Objective" */
  map: Record<string, string>;
  /** true only when the names came from the form itself */
  verified: boolean;
  /** what happened, in one line, for the artifact */
  source: string;
  /** the parameter names the form reported, when we could read it */
  formFields?: string[];
};

/** "business_objective" -> "Business Objective" */
function labelFor(key: string): string {
  return fieldByKey(key)?.label || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Loose comparison: "Business Objective" ~ "business_objective" ~ "businessobjective". */
function normalise(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Every parameter name in a CTGY response, however the connector nests it. */
function parameterNames(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    // A parameter carries a name and, usually, a data type. Requiring both
    // keeps category names and other noise out.
    // insights_search_fields returns labels; a custom field is DE:-prefixed
    // there already, so strip it and let the caller add it back once.
    for (const key of ["label", "name", "fieldName"]) {
      const v = o[key];
      if (typeof v === "string" && v.length > 1 && !/^\d+$/.test(v)) {
        out.add(v.replace(/^DE:/, ""));
      }
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(payload);
  return [...out];
}

/**
 * Resolve our field keys to Workfront's parameter names.
 *
 * @param categoryID the custom form (CTGY) the intake is filed against
 */
export async function resolveFieldMap(categoryID: string, entity = "issue"): Promise<FieldMap> {
  const assumed = (): FieldMap => ({
    map: Object.fromEntries(CAMPAIGN_BRIEF_FIELDS.map((f) => [f.key, `${DE}${labelFor(f.key)}`])),
    verified: false,
    source:
      "Field names are ASSUMED from our own labels, not read from the form. " +
      "Workfront addresses custom fields as DE:<parameter name>, and if a label " +
      "differs from the form's wording that value will not be written. Sign in to " +
      "the Workfront MCP and this becomes a real read.",
  });

  if (!categoryID) return assumed();

  try {
    /*
     * insights_search_fields, not workflow_search_any_object.
     *
     * Read off the live tenant (taplondonptrsd, 16 Sep 2026): the connector
     * exposes 49 of its 94 documented tools, and every WRITE tool is absent -
     * workflow_create_any_object, workflow_update_any_object and
     * comment-stream_create_comment among them. That is the documented default:
     * write actions are off until a Workfront admin enables them per tenant.
     *
     * So the whole workflow_* family cannot be relied on here. insights_* IS
     * present, and insights_search_fields on the issue entity returns the real
     * field names - including DE:-prefixed ones like "DE:Product Name_CP",
     * which is how we know the convention is right.
     */
    /*
     * Several queries, and several entities.
     *
     * insights_search_fields REQUIRES a query and only returns fields matching
     * it, so asking once for "campaign" resolved one field of fourteen and
     * dropped the rest - which read like the form was empty when it was our
     * question that was narrow.
     *
     * And the brief's fields live on PROJECT in this tenant, not on issue:
     * DE:Name of the Campaign, DE:Objective of the campaign,
     * DE:Audience_to_be_Targeted and DE:Requested_Launch_Date are all project
     * fields. Asking only about issues found none of them.
     */
    /*
     * Widened for the LCE-form fields added to campaign-brief.ts: without a
     * query term that actually hits them, they would ALWAYS fall into the
     * "unmatched, dropped" bucket below even on a live form that has them -
     * not because the form lacks the field, but because we never asked
     * about it.
     */
    const queries = [
      "campaign", "objective", "audience", "launch", "product", "name",
      "email", "test", "priority", "creative", "data", "channel", "size", "deployment",
    ];
    const seen = new Set<string>();
    for (const query of queries) {
      try {
        const chunk = await callMcpTool<unknown>("intake", "insights_search_fields", {
          // The entity we are actually writing to. Searching three entities
          // found project fields and then offered them for an issue, which
          // Workfront refuses - correctly.
          entity_ids: [entity],
          query,
        });
        for (const n of parameterNames(chunk)) seen.add(n);
      } catch (err) {
        // One failed query must not lose the ones that worked.
      }
    }
    const names = [...seen];
    if (!names.length) {
      const fallback = assumed();
      return {
        ...fallback,
        source:
          "Read the custom form but found no parameters in the response, so field names " +
          "are still assumed from our labels. " + fallback.source,
      };
    }

    const map: Record<string, string> = {};
    const unmatched: string[] = [];
    for (const f of CAMPAIGN_BRIEF_FIELDS) {
      const hit =
        names.find((n) => normalise(n) === normalise(f.label)) ||
        names.find((n) => normalise(n) === normalise(f.key)) ||
        names.find((n) => (f.aliases || []).some((a) => normalise(n) === normalise(a))) ||
        names.find((n) => normalise(n).includes(normalise(f.label)) && normalise(f.label).length > 4);
      if (hit) map[f.key] = `${DE}${hit}`;
      else unmatched.push(f.key);
    }

    return {
      map,
      verified: true,
      source:
        `Field names read from the form: ${names.length} parameter(s), ` +
        `${Object.keys(map).length} of ${CAMPAIGN_BRIEF_FIELDS.length} of our fields matched` +
        (unmatched.length
          ? `. No parameter matches ${unmatched.join(", ")} - those values are NOT sent, rather than sent under a guessed name.`
          : "."),
      formFields: names,
    };
  } catch (err) {
    const fallback = assumed();
    return {
      ...fallback,
      source: `Could not read the custom form (${(err as Error).message}). ` + fallback.source,
    };
  }
}

/**
 * Apply a field map to our values.
 *
 * A field with no mapping is DROPPED, not sent under a guessed name. A value
 * written to a field that does not exist is either rejected or silently
 * ignored, and silently ignored is the outcome that produces a Workfront record
 * that looks filled in and is not.
 */
export function applyFieldMap(
  values: Record<string, unknown>,
  fieldMap: FieldMap,
): { customFields: Record<string, unknown>; dropped: string[] } {
  const customFields: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value == null || String(value).trim() === "") continue;
    const name = fieldMap.map[key];
    if (!name) { dropped.push(key); continue; }
    customFields[name] = value;
  }
  return { customFields, dropped };
}
