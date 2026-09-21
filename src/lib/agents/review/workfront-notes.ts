/**
 * Documenting Review's findings back onto the Workfront issue Agent 1
 * created: a comment for human readers, and a best-effort custom-field
 * write so the same context survives on the record itself, not only in a
 * comment thread that can scroll away.
 *
 * SAME HONESTY CONTRACT AS intake/workfront.ts's createIntakeRequest: write
 * actions are disabled on this tenant today (see that file's docstring), so
 * both functions here report what they WOULD have written rather than
 * pretending success. Argument shapes are unverified against a live tenant
 * for the same reason everything else in workfront-tools.ts is - nobody has
 * been able to test a write yet.
 */

import { callMcpTool } from "@/lib/mcp-client";
import { workfrontToolset } from "@/lib/workfront-tools";

/** Same detection intake/workfront.ts uses: a write tool that 404s because writes are off, not because of a bug here. */
function isMissingWriteTool(raw: string): boolean {
  return /not found/i.test(raw) && /workflow_(create|update)|comment-stream_create/i.test(raw);
}

function explain(raw: string): string {
  return isMissingWriteTool(raw)
    ? `${raw} — this tool is absent because WRITE ACTIONS ARE NOT ENABLED on the Workfront tenant. ` +
        "A Workfront admin turns them on in Setup > System > Preferences."
    : raw;
}

export type CommentOutcome =
  | { posted: true }
  | { posted: false; reason: string; wouldHavePosted: string };

/**
 * Post `text` as a comment on the issue, for a human reviewer.
 *
 * `text` argument name (rather than `message`/`note`) is a guess at
 * comment-stream_create_comment's shape, matching what
 * comment-stream_query_comments reads back (see review/route.ts's
 * fetchRejection) - unverified until writes are enabled and this can
 * actually be tried against the live tenant.
 */
export async function postReviewComment(objId: string, objCode: string, text: string): Promise<CommentOutcome> {
  const set = workfrontToolset();
  try {
    await callMcpTool("review", set.createComment, { objID: objId, objCode, text });
    return { posted: true };
  } catch (err) {
    return { posted: false, reason: explain((err as Error).message), wouldHavePosted: text };
  }
}

/**
 * Which custom field carries Review's notes. Overridable because whether
 * this field exists - and what it's called - is a property of the client's
 * Workfront form, not something this code can know in advance (same reason
 * WORKFRONT_INTAKE_QUEUE is an env var rather than a constant).
 */
export const REVIEW_NOTES_FIELD = process.env.WORKFRONT_REVIEW_NOTES_FIELD || "DE:Review_Notes";

export type FieldUpdateOutcome =
  | { updated: true; field: string }
  | { updated: false; field: string; reason: string; wouldHaveWritten: string };

/**
 * Best-effort: write the same note into a custom field on the issue.
 *
 * Not every tenant/form has REVIEW_NOTES_FIELD attached - Workfront rejects
 * a value for a field that isn't on the object's form (see
 * intake/workfront.ts's writeCustomFields for the same rejection shape).
 * That is reported exactly like "writes are disabled", never treated as a
 * bigger failure than "this field doesn't exist here yet" - the comment
 * above already documented the same findings for a human reader either way.
 */
export async function updateReviewNotesField(objId: string, objCode: string, text: string): Promise<FieldUpdateOutcome> {
  const set = workfrontToolset();
  try {
    await callMcpTool("review", set.update, set.customFieldArgs(objCode, objId, { [REVIEW_NOTES_FIELD]: text }));
    return { updated: true, field: REVIEW_NOTES_FIELD };
  } catch (err) {
    return {
      updated: false,
      field: REVIEW_NOTES_FIELD,
      reason: explain((err as Error).message),
      wouldHaveWritten: text,
    };
  }
}
