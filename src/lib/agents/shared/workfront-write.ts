/**
 * Writing custom-form values to a Workfront object, for any object type.
 *
 * WHY THIS IS SHARED AND NOT COPIED
 *
 * Agent 1 writes the brief to an issue at 1.3. Agent 2 writes it to a project
 * at 2.1. They are the same problem - Workfront rejects the WHOLE update when
 * any single field is not on a form attached to the object, and names only the
 * first offender - and a second copy of the drop-and-retry loop would drift from
 * the first the moment one of them learned something. It lives here once.
 *
 * WHAT THE TENANT TAUGHT US, AND WHY IT MATTERS AT 2.1
 *
 * The brief's fields are PROJECT fields. Read live (taplondonptrsd):
 *
 *   issue    DE:MIG_First Name, DE:MIG_Last Name, DE:MIG_Name, DE:Product Name_CP
 *   project  DE:Name of the Campaign, DE:Objective of the campaign,
 *            DE:Audience_to_be_Targeted, DE:Requested_Launch_Date, DE:MIG_*
 *
 * The issue entity carries NONE of the brief's fields. That is the whole
 * explanation for "only 1 of 15 fields matched a real Workfront form field" -
 * the agent was writing a campaign brief to an object type that has nowhere to
 * put one. It was not a mapping bug by then; it was the wrong object.
 *
 * Which is exactly why 2.1 exists in the map. "Issue converted to project form"
 * is the step where a request becomes a thing with a brief on it. So the fields
 * that get dropped at 1.3 are not lost, they are EARLY - and this module is
 * what lands them at 2.1.
 */

import { callMcpTool } from "@/lib/mcp-client";
import { workfrontToolset } from "@/lib/workfront-tools";
import type { TaskId } from "@/lib/pipeline/types";

export type FieldWriteOutcome = {
  /** Field names (DE:<parameter>) Workfront accepted. */
  written: string[];
  /** Field names it refused, each with why. */
  rejected: Array<{ field: string; reason: string }>;
};

/**
 * Write custom-form values, keeping whatever the form will accept.
 *
 * WHY NOT ONE UPDATE
 *
 * Workfront rejects the whole update when any single field is not on a form
 * attached to the object. Against the live tenant that meant: send four fields,
 * get "Requested_Launch_Date is gated" and write nothing; drop it, get
 * "Audience_to_be_Targeted is gated" and write nothing. All four values lost for
 * the sake of two.
 *
 * And the fields are spread across DIFFERENT forms - the project's
 * "Name of the Campaign" belongs to one form and its objective, audience and
 * launch date to another - so there is no single form we could attach that
 * would accept them all.
 *
 * So: try the batch, and when a field is refused, drop THAT field and retry.
 * The tenant tells us its own layout, which is more reliable than modelling it,
 * and every value that can land does. What could not land is returned, named,
 * rather than being silently absent from a record that looks complete.
 *
 * @param taskId the agent doing the writing, for the MCP tool allowlist
 * @param objCode Workfront objCode of the target, e.g. OPTASK or PROJ
 * @param values keyed by the exact name to send, i.e. DE:<parameter name>
 * @param intent the marketer's own words, which Workfront records as the why
 */
export async function writeCustomFields(
  taskId: TaskId,
  objCode: string,
  objId: string,
  values: Record<string, unknown>,
  intent: string,
): Promise<FieldWriteOutcome> {
  const set = workfrontToolset();
  const remaining = { ...values };
  const rejected: Array<{ field: string; reason: string }> = [];

  // At most one attempt per field, plus one. A field can only be dropped once,
  // so this cannot loop.
  const limit = Object.keys(values).length + 1;
  for (let attempt = 0; attempt < limit; attempt++) {
    const keys = Object.keys(remaining);
    if (!keys.length) break;
    try {
      await callMcpTool(taskId, set.update, set.customFieldArgs(objCode, objId, remaining, intent));
      return { written: keys, rejected };
    } catch (err) {
      const message = (err as Error).message;
      const culprit = blame(message, remaining, objCode);

      if (!culprit) {
        /*
         * Workfront refused the batch and we cannot tell which value it means.
         *
         * Every remaining field is reported with WORKFRONT'S OWN WORDS, not a
         * guess at the cause. This used to label them all "not on a custom form
         * attached to this object", which was flatly wrong the first time it
         * mattered: the real error was
         * `conversion to type DATE value "1 November"`, a bad value on a field
         * that was on the form. A confident wrong diagnosis sent us looking at
         * form configuration for a date-parsing bug.
         */
        /*
         * ONE AT A TIME, rather than losing the lot.
         *
         * Workfront refuses a whole update for one bad value, so a single
         * enumeration sent a sentence took the campaign name, the objective
         * and the launch date down with it. Writing them individually costs
         * one call per field, only on the path that already failed, and turns
         * an all-or-nothing loss into "everything except the one that was
         * wrong".
         */
        const written: string[] = [];
        const refused: Array<{ field: string; reason: string }> = [];
        for (const key of keys) {
          const single = { [key]: remaining[key] };
          try {
            await callMcpTool(taskId, set.update, set.customFieldArgs(objCode, objId, single, intent));
            written.push(key);
          } catch (individual) {
            refused.push({ field: key, reason: (individual as Error).message });
          }
        }
        return { written, rejected: [...rejected, ...refused] };
      }

      delete remaining[culprit.field];
      rejected.push(culprit);
    }
  }
  return {
    written: Object.keys(values).filter((k) => !rejected.some((r) => r.field === k)),
    rejected,
  };
}

/**
 * Which field Workfront is objecting to, and why, read from its own error.
 *
 * Workfront names the offender two different ways and neither is the field key
 * we sent, so both need translating:
 *
 *   "rejected field 'Requested_Launch_Date'"          -> names the field
 *   "conversion to type DATE value \"1 November\""      -> names the VALUE
 *
 * The second is the one that cost us a whole brief: it identifies the bad field
 * only by its value, so a loop looking for a field name found nothing, decided
 * the failure was not per-field, and gave up on all of them.
 *
 * Returns null when the error identifies nothing - in which case the caller
 * must report Workfront's words rather than invent a cause.
 */
function blame(
  message: string,
  remaining: Record<string, unknown>,
  objCode: string,
): { field: string; reason: string } | null {
  const keys = Object.keys(remaining);

  const named = message.match(/rejected field '([^']+)'/i)?.[1];
  if (named) {
    const key = keys.find((k) => k === named || k === `DE:${named}` || k.endsWith(named));
    if (key) {
      return {
        field: key,
        reason: `not on a custom form attached to this ${objCode}, so Workfront refused it`,
      };
    }
  }

  // A type conversion failure, identified by the value it could not convert.
  const conv = message.match(/conversion to type (\w+) value "([^"]*)"/i);
  if (conv) {
    const [, type, badValue] = conv;
    const key = keys.find((k) => String(remaining[k]) === badValue);
    if (key) {
      return {
        field: key,
        reason: `Workfront could not read "${badValue}" as a ${type.toUpperCase()}, so this value was not written`,
      };
    }
  }

  return null;
}

/**
 * One line summarising a write, for an artifact a human reads.
 *
 * Returns null when everything landed, because a line saying "nothing went
 * wrong" on every successful run trains the reader to skip the line that
 * matters. Silence here means success, and it is the only thing that does.
 *
 * The reasons are Workfront's, grouped - not a single asserted cause. Refused
 * fields do not all fail for the same reason, and saying they do is how a
 * date-parsing bug got read as a form configuration gap for a day.
 */
/**
 * A FIELD THAT LIVES ON ANOTHER FORM IS NOT A FAILURE.
 *
 * "not on a custom form attached to this OPTASK" means exactly what it says:
 * the parameter belongs to a different form. In this tenant the brief's fields
 * are PROJECT fields, and the request carries the brief in its description
 * until it is converted - so this is the client's process working, and
 * reporting it as "refused by Workfront" told a marketer something was broken
 * when nothing was. A genuine refusal - a bad value, a type mismatch - still
 * reads as one.
 */
const NOT_ON_THIS_FORM = /not on a custom form attached to|no custom form|is not a valid field|does not exist on/i;

export function describeFieldWrite(outcome: FieldWriteOutcome, objCode: string): string | null {
  if (!outcome.rejected.length) return null;

  const elsewhere = outcome.rejected.filter((r) => NOT_ON_THIS_FORM.test(r.reason));
  const genuine = outcome.rejected.filter((r) => !NOT_ON_THIS_FORM.test(r.reason));

  if (!genuine.length) {
    return (
      `${outcome.written.length} field(s) written to this ${objCode}. ` +
      `${elsewhere.length} value(s) belong to a form this ${objCode} does not use ` +
      `(${elsewhere.map((r) => r.field).join(", ")}) - they travel in the description and are ` +
      "written when the request is converted to a project. Nothing was lost and nothing failed."
    );
  }

  const byReason = new Map<string, string[]>();
  for (const r of genuine) {
    const list = byReason.get(r.reason) || [];
    list.push(r.field);
    byReason.set(r.reason, list);
  }

  const parts = [...byReason.entries()].map(([reason, fields]) => `${fields.join(", ")}: ${reason}`);

  return (
    `${outcome.written.length} field(s) written to this ${objCode}, ` +
    `${genuine.length} refused. ` +
    parts.join(". ") +
    "."
  );
}
