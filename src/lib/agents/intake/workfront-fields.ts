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
import type { TaskId } from "@/lib/pipeline/types";

/** Workfront's own prefix for a custom-form value. */
const DE = "DE:";

export type FieldMap = {
  /** our key -> the exact name to send, e.g. "DE:Requested_Launch_Date" */
  map: Record<string, string>;
  /**
   * our key -> Workfront's dataType for that field ("string", "date", ...).
   *
   * Needed because a value has to be in the type the field expects. The brief
   * says "1 November" and DE:Requested_Launch_Date is a DATE field, so sending
   * the words got "Invalid Parameter: conversion to type DATE value
   * \"1 November\"" - and because that error names no field, the retry loop
   * could not tell which value was at fault and dropped all of them. One
   * unconvertible date lost the whole brief.
   */
  types: Record<string, string>;
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

type FormField = { name: string; label: string; dataType: string };

/**
 * Every field the form reports, as name + label + type.
 *
 * THIS USED TO RETURN A FLAT SET OF STRINGS AND IT WAS WRONG.
 *
 * It collected `label`, `name` and `fieldName` into one set and treated them as
 * interchangeable. They are not. On this tenant:
 *
 *   label "Requested Launch Date"   name "DE:Requested_Launch_Date"
 *   label "Audience to be Targeted" name "DE:Audience_to_be_Targeted"
 *
 * The label has spaces, the name has underscores, and only the NAME is a valid
 * data key. Matching our field against the label - which is exactly what a
 * label-shaped match is for - then produced the key "DE:Requested Launch Date",
 * a field that does not exist. Adobe's own tool description says it plainly:
 * "Use a field's `name` from insights_search_fields as the data key; if `name`
 * is not set, fall back to its `label`."
 *
 * So labels are kept for MATCHING and names are used for WRITING, and the two
 * are no longer allowed to be confused for one another.
 */
function parameterFields(payload: unknown): FormField[] {
  const out = new Map<string, FormField>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;

    const name = typeof o.name === "string" ? o.name : typeof o.fieldName === "string" ? o.fieldName : "";
    const label = typeof o.label === "string" ? o.label : "";
    // A field record carries at least one of the two. Requiring one keeps
    // category names and other noise out.
    if ((name || label) && !/^\d+$/.test(name || label)) {
      const key = name || label;
      if (key.length > 1 && !out.has(key)) {
        out.set(key, {
          // Adobe's rule: the name is the data key, the label only a fallback.
          name: name || label,
          label: label || name,
          dataType: typeof o.dataType === "string" ? o.dataType : "",
        });
      }
    }

    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(payload);
  return [...out.values()];
}

/**
 * Resolve our field keys to Workfront's parameter names.
 *
 * @param categoryID the custom form (CTGY) the intake is filed against
 */
export async function resolveFieldMap(
  categoryID: string,
  entity = "issue",
  /** Which agent is reading, for the MCP tool allowlist. */
  taskId: TaskId = "intake",
): Promise<FieldMap> {
  const assumed = (): FieldMap => ({
    map: Object.fromEntries(CAMPAIGN_BRIEF_FIELDS.map((f) => [f.key, `${DE}${labelFor(f.key)}`])),
    // No types, because we never read the form. A value is then sent as-is,
    // which is the honest consequence of not knowing what the field expects.
    types: {},
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
    const queries = ["campaign", "objective", "audience", "launch", "product", "name"];
    const seen = new Map<string, FormField>();
    for (const query of queries) {
      try {
        const chunk = await callMcpTool<unknown>(taskId, "insights_search_fields", {
          // The entity we are actually writing to. Searching three entities
          // found project fields and then offered them for an issue, which
          // Workfront refuses - correctly.
          entity_ids: [entity],
          query,
        });
        for (const f of parameterFields(chunk)) if (!seen.has(f.name)) seen.set(f.name, f);
      } catch (err) {
        // One failed query must not lose the ones that worked.
      }
    }
    const fields = [...seen.values()];
    if (!fields.length) {
      const fallback = assumed();
      return {
        ...fallback,
        source:
          "Read the custom form but found no parameters in the response, so field names " +
          "are still assumed from our labels. " + fallback.source,
      };
    }

    /*
     * Match on either spelling, then WRITE THE NAME.
     *
     * A field is matched by its label (what a human calls it, and what our own
     * labels are written to look like) or by its name. Whichever matched, the
     * key we send is `name`, never `label` - see parameterFields for what went
     * wrong when the two were treated as one.
     *
     * The name already carries the DE: prefix when it is a custom field, so it
     * is NOT prefixed again here. Prefixing a name that already had one is how
     * "DE:DE:Something" gets written.
     */
    const map: Record<string, string> = {};
    const types: Record<string, string> = {};
    const unmatched: string[] = [];
    for (const f of CAMPAIGN_BRIEF_FIELDS) {
      const hit =
        fields.find((c) => normalise(c.label) === normalise(f.label)) ||
        fields.find((c) => normalise(c.name) === normalise(f.label)) ||
        fields.find((c) => normalise(c.label) === normalise(f.key) || normalise(c.name) === normalise(f.key)) ||
        fields.find((c) => (f.aliases || []).some((a) => normalise(c.label) === normalise(a) || normalise(c.name) === normalise(a))) ||
        fields.find((c) => normalise(c.label).includes(normalise(f.label)) && normalise(f.label).length > 4);
      if (hit) {
        map[f.key] = hit.name.startsWith(DE) ? hit.name : `${DE}${hit.name}`;
        types[f.key] = hit.dataType;
      } else {
        unmatched.push(f.key);
      }
    }

    return {
      map,
      types,
      verified: true,
      source:
        `Field names read from the form: ${fields.length} parameter(s), ` +
        `${Object.keys(map).length} of ${CAMPAIGN_BRIEF_FIELDS.length} of our fields matched` +
        (unmatched.length
          ? `. No parameter matches ${unmatched.join(", ")} - those values are NOT sent, rather than sent under a guessed name.`
          : "."),
      formFields: fields.map((c) => c.name),
    };
  } catch (err) {
    const fallback = assumed();
    return {
      ...fallback,
      source: `Could not read the custom form (${(err as Error).message}). ` + fallback.source,
    };
  }
}

/** Month names, index 0 = January. */
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/**
 * Turn what a marketer wrote into a date Workfront will accept.
 *
 * WHY THIS EXISTS
 *
 * DE:Requested_Launch_Date is a DATE field. The brief says "1 November". Sending
 * the words got "Invalid Parameter: conversion to type DATE value
 * \"1 November\"" - and because that error names no field, the per-field retry
 * loop could not tell which value was at fault and dropped the whole batch. One
 * unconvertible date cost the brief every other field with it.
 *
 * THE YEAR IS INFERRED, AND THE INFERENCE IS RETURNED
 *
 * "1 November" has no year. The only sensible reading is the next 1 November
 * that has not happened yet, which is what this picks. But an inferred year in
 * a launch date is a real decision - it is the difference between six weeks and
 * eighteen months - so the inference travels back in `note` and is reported on
 * the artifact rather than applied silently.
 *
 * WORD BOUNDARIES, DELIBERATELY
 *
 * An earlier version of the month match used `includes("mar")`, which found
 * "mar" inside "market" and turned "in market for 1 November" into March. Every
 * month is matched as a whole word here, and that is not a stylistic choice.
 */
export function toWorkfrontDate(
  raw: unknown,
  now: Date = new Date(),
): { date: string | null; note: string } {
  const v = String(raw ?? "").trim();
  if (!v) return { date: null, note: "no value" };

  // Already a date Workfront can read.
  const iso = v.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, note: "already an ISO date" };

  /*
   * A whole-word month name, or its three-letter abbreviation.
   *
   * TOKENS, NOT A REGEX, AND THAT IS THE POINT.
   *
   * This was `new RegExp(`\b(${full}|${abbr})\b`, "i")`. Inside a TEMPLATE
   * LITERAL, \b is not a word boundary - it is the backspace character U+0008.
   * So the pattern actually tested was "<backspace>(november|nov)<backspace>",
   * which matches nothing, and every date came back as
   * `no month name in "1 November"` with a month sitting right there in it.
   *
   * The predecessor of that line had the opposite bug: a bare includes("mar")
   * found "mar" inside "market" and read "in market for 1 November" as March.
   * Two bugs, one from too little escaping and one from too much.
   *
   * Splitting on non-letters and comparing whole tokens has no escaping to get
   * wrong. "market" is one token and never equals "mar"; "November" is one
   * token and equals "november". There is no third way for this to break.
   */
  const tokens = v.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let month = -1;
  for (let i = 0; i < MONTHS.length; i++) {
    const full = MONTHS[i];
    const abbr = full.slice(0, 3);
    if (tokens.some((t) => t === full || t === abbr)) { month = i; break; }
  }
  if (month < 0) {
    return {
      date: null,
      note: `no month name in "${v}", so no date could be built from it`,
    };
  }

  // A day, if there is one. Not the year: a bare 2026 must not become day 26.
  const dayMatch = v.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/i);
  const day = dayMatch ? Math.min(31, Math.max(1, Number(dayMatch[1]))) : 1;
  const dayAssumed = !dayMatch;

  const yearMatch = v.match(/\b(20\d{2})\b/);
  let year: number;
  let yearAssumed = false;
  if (yearMatch) {
    year = Number(yearMatch[1]);
  } else {
    // The next occurrence that has not passed.
    year = now.getUTCFullYear();
    const candidate = Date.UTC(year, month, day);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (candidate < today) year += 1;
    yearAssumed = true;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${year}-${pad(month + 1)}-${pad(day)}`;

  const notes: string[] = [];
  if (yearAssumed) notes.push(`the year ${year} is INFERRED - "${v}" gives none, so the next ${MONTHS[month]} that has not passed was used`);
  if (dayAssumed) notes.push(`no day was given, so the 1st was used`);
  return { date, note: notes.length ? notes.join("; ") : `read from "${v}"` };
}

export type AppliedFields = {
  customFields: Record<string, unknown>;
  /** Our keys with no field on the form. Not sent. */
  dropped: string[];
  /** Values changed to fit the field's type, and how. */
  coerced: Array<{ field: string; from: string; to: string; note: string }>;
  /** Values the field's type could not accept. Not sent, and said out loud. */
  uncoercible: Array<{ field: string; value: string; reason: string }>;
};

/**
 * Apply a field map to our values.
 *
 * A field with no mapping is DROPPED, not sent under a guessed name. A value
 * written to a field that does not exist is either rejected or silently
 * ignored, and silently ignored is the outcome that produces a Workfront record
 * that looks filled in and is not.
 *
 * A value the field's TYPE cannot accept is also dropped, for a different and
 * more urgent reason: Workfront rejects the whole update over one bad value and
 * names no field, so leaving it in costs every other field in the batch.
 */
export function applyFieldMap(
  values: Record<string, unknown>,
  fieldMap: FieldMap,
  now: Date = new Date(),
): AppliedFields {
  const customFields: Record<string, unknown> = {};
  const dropped: string[] = [];
  const coerced: AppliedFields["coerced"] = [];
  const uncoercible: AppliedFields["uncoercible"] = [];

  for (const [key, value] of Object.entries(values)) {
    if (value == null || String(value).trim() === "") continue;
    const name = fieldMap.map[key];
    if (!name) { dropped.push(key); continue; }

    const dataType = String(fieldMap.types?.[key] || "").toLowerCase();
    if (dataType === "date" || dataType === "datetime") {
      const { date, note } = toWorkfrontDate(value, now);
      if (!date) {
        uncoercible.push({ field: name, value: String(value), reason: note });
        continue;
      }
      if (date !== String(value)) coerced.push({ field: name, from: String(value), to: date, note });
      customFields[name] = date;
      continue;
    }

    customFields[name] = value;
  }

  return { customFields, dropped, coerced, uncoercible };
}
