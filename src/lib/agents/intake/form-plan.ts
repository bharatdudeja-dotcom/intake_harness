import type { TaskId } from "@/lib/pipeline/types";
import { readFormFields, mapValue, fieldByLabel, type MappedValue } from "./tenant-vocabulary";

/**
 * Fill everything the form can actually hold, and say what it could not.
 *
 * WHAT WAS HAPPENING
 *
 * Intake wrote four values and dropped the rest, and the run reported the
 * dropped ones as having "no matching field on this form". That was true of
 * some and wrong about others: the request form on this tenant holds Audience,
 * Primary Channel, Region, Type, Product Name and Priority, and we were
 * offering none of them - because our field map was built from OUR field names
 * rather than from what the form exposes.
 *
 * So this works the other way round. It reads the form, then asks of each
 * field: does the brief say anything this field could hold? That is what a
 * Workfront administrator does when they set up an intake, and it is the
 * difference between a request a reviewer can act on and a title with a
 * paragraph under it.
 *
 * WHAT IT WILL NOT DO
 *
 * Guess. A brief that says "New York" against a Region field offering uk, de
 * and us is a mismatch between the campaign and the form, and the honest
 * outcome is to say so - to the marketer, who can answer, and in the record,
 * where an administrator can see that this tenant's Region field cannot
 * express a US state. Writing `us` would hide a real modelling gap behind a
 * plausible value.
 */

export type FieldPlan = {
  /** name -> value, ready to send to Workfront. */
  writes: Record<string, string>;
  /** What each write means, for the artifact. */
  explains: string[];
  /** The brief said something, and the field would not take it. */
  mismatched: { label: string; given: string; why: string }[];
  /** The form holds this and the brief is silent - worth asking about. */
  unanswered: { label: string; allowed: string[] }[];
  /** What was read, so a reader can see the basis. */
  formFieldCount: number;
};

/** Which brief keys could answer which form field, by the field's own label. */
const CONCEPTS: { labels: string[]; from: string[]; ask: boolean }[] = [
  { labels: ["Name of the Campaign", "Campaign Name"], from: ["campaign_name"], ask: true },
  { labels: ["Objective of the campaign", "Objective"], from: ["business_objective"], ask: true },
  { labels: ["Audience to be Targeted"], from: ["customer_type", "audience_description"], ask: true },
  { labels: ["Audience"], from: ["customer_type"], ask: true },
  { labels: ["Primary Channel", "Channel"], from: ["channels"], ask: true },
  { labels: ["Region"], from: ["region"], ask: true },
  { labels: ["Requested Launch Date", "Launch Date"], from: ["launch_date"], ask: true },
  { labels: ["Product Name"], from: ["product", "line_of_business"], ask: false },
  /*
   * Type is New | Revision / Edit to existing - whether this request is new
   * work or a change to existing work. It was being fed request_type
   * ("Audience + Campaign Execution"), which answers a different question
   * entirely: what the campaign needs done.
   *
   * A fresh intake is New. A brief that came back through triage as rework
   * says so, and `revision_of` is where that lands.
   */
  { labels: ["Type"], from: ["revision_of"], ask: false },
];

/**
 * @param fields the brief as intake extracted it
 * @param entity which form - the request or the project it becomes
 */
export async function planFormWrites(
  taskId: TaskId,
  entity: "issue" | "project",
  fields: Record<string, unknown>,
): Promise<FieldPlan> {
  const form = await readFormFields(taskId, entity);

  const writes: Record<string, string> = {};
  const explains: string[] = [];
  const mismatched: FieldPlan["mismatched"] = [];
  const unanswered: FieldPlan["unanswered"] = [];
  const claimed = new Set<string>();

  for (const concept of CONCEPTS) {
    const field = fieldByLabel(form, ...concept.labels);
    if (!field || claimed.has(field.name)) continue;

    let source = concept.from.map((k) => fields[k]).find((v) => v != null && String(v).trim() !== "");

    // A request that is not a revision of anything is new work, and the form
    // has a value for exactly that. Left blank it tells a reviewer nothing.
    if (source == null && concept.labels[0] === "Type" && field.allowed.some((a) => /^new$/i.test(a))) {
      source = field.allowed.find((a) => /^new$/i.test(a)) as string;
    }

    if (source == null) {
      /*
       * The form asks and the brief is silent. For an enumeration that is a
       * good question to put to the marketer - the answers are a short list -
       * and for free text it usually is not, so only closed fields are raised.
       */
      if (concept.ask && field.allowed.length) {
        unanswered.push({ label: field.label, allowed: field.allowed });
      }
      continue;
    }

    const mapped: MappedValue = mapValue(field, source);
    claimed.add(field.name);

    if (mapped.ok) {
      writes[field.name] = mapped.value;
      explains.push(
        `${field.label} = ${mapped.value}` + (mapped.note ? ` (${mapped.note})` : ""),
      );
    } else {
      mismatched.push({ label: field.label, given: mapped.given, why: mapped.why });
    }
  }

  return { writes, explains, mismatched, unanswered, formFieldCount: form.length };
}

/**
 * The questions worth putting to a marketer, in their words rather than the
 * form's.
 *
 * A closed list is a kind question to ask - it is three options, not an essay -
 * and asking it here is cheaper than a reviewer asking it two days later,
 * which is B2 on the blockers map. A field the brief already answers is never
 * asked about.
 */
export function questionsFromPlan(plan: FieldPlan): string[] {
  const out: string[] = [];

  for (const m of plan.mismatched) {
    out.push(
      `${m.label}: the brief says "${m.given}", and this Workfront form only accepts ${m.why.replace(/^"[^"]*" is not one of the values this field accepts \(/, "").replace(/\)$/, "")}. Which should it be - or should the request record the detail somewhere else?`,
    );
  }

  for (const u of plan.unanswered) {
    out.push(`${u.label}: which of these - ${u.allowed.join(", ")}?`);
  }

  return out;
}
