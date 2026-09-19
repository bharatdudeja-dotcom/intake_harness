/**
 * Reading a review-queue rejection OFF the Workfront issue.
 *
 * This is the input side of B2 - triage.ts does the translation once we have
 * a rejection string; this decides WHETHER there is one and WHICH text is it.
 * The two are separate concerns and this is the one that used to be a one-line
 * regex + `.pop()` in review/route.ts:
 *
 *     list.map(text).filter(/reject|return|more info|insufficient|resubmit/i).pop()
 *
 * Three things were wrong with that, and this module fixes each:
 *
 *   1. IT ONLY SAW A HANDFUL OF WORDS. A reviewer writing "this needs the LOB
 *      before we can proceed" or "sending back - audience definition is
 *      unclear" tripped none of those five stems, so a real rejection read as
 *      "no rejection" - which is the exact bug this whole agent exists to
 *      fix, reproduced one layer down.
 *   2. `.pop()` TOOK THE LAST MATCH BY ARRAY ORDER, not the most recent by
 *      time, and not the one actually carrying a decision. A later "thanks,
 *      resubmitted" comment (matches "resubmit") would win over the earlier
 *      substantive rejection.
 *   3. IT IGNORED STRUCTURED SIGNAL. Workfront comments/updates can carry an
 *      explicit status or decision field ("Rejected", "Needs More Info",
 *      approval decision = "reject"); a keyword scan of the free-text body
 *      threw that away in favour of guessing from prose.
 *
 * Still pure: a list of comment-like records in, a decision out. No MCP, no
 * fetch - review/route.ts does the read and hands the rows here, so this is
 * unit-testable without a network (rejection.test.ts).
 */

/** A Workfront comment/update row, read defensively - connectors differ. */
export type CommentLike = Record<string, unknown>;

export type RejectionSignal = {
  /** Did we conclude this issue was rejected / sent back? */
  rejected: boolean;
  /** The operative rejection text, for triage.ts. Null when not rejected. */
  reason: string | null;
  /**
   * How we know: a structured status/decision field, a strong textual
   * signal, or nothing. Distinguishes "read it, it's a rejection" from
   * "read it, it isn't" from "couldn't tell" for the caller's reporting.
   */
  source: "status_field" | "decision_field" | "text_signal" | "none";
  /** Which record carried the decision, for a human checking the reading. */
  evidence: string | null;
  /** How many records we actually considered. */
  considered: number;
};

const NON_REJECTION: RejectionSignal = {
  rejected: false,
  reason: null,
  source: "none",
  evidence: null,
  considered: 0,
};

/** The free-text body of a comment, however this connector spells the field. */
function bodyOf(row: CommentLike): string {
  return String(row.message ?? row.text ?? row.note ?? row.body ?? row.content ?? "").trim();
}

/** A timestamp for ordering, if the row carries one; else null. */
function timeOf(row: CommentLike): number | null {
  const raw =
    row.entryDate ?? row.entry_date ?? row.createdAt ?? row.created_at ?? row.timestamp ?? row.date ?? null;
  if (raw == null) return null;
  const t = new Date(String(raw)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * An explicit status/decision the connector attached to the row, normalised.
 * Workfront issues carry a `status`; approval decisions carry a `decision` or
 * `approvalStatus`. We read any of them rather than betting on one spelling.
 */
function structuredDecision(row: CommentLike): { rejected: boolean; field: "status_field" | "decision_field" } | null {
  const status = String(row.status ?? row.statusLabel ?? "").toLowerCase();
  if (/reject|returned?|sent back|needs? more info|more info needed|rework|declined?/.test(status)) {
    return { rejected: true, field: "status_field" };
  }
  const decision = String(row.decision ?? row.approvalStatus ?? row.approval_status ?? row.outcome ?? "").toLowerCase();
  if (/reject|deny|denied|declin|return/.test(decision)) {
    return { rejected: true, field: "decision_field" };
  }
  return null;
}

/**
 * How strongly a body reads as a rejection, 0 = not at all.
 *
 * Broader than the old five stems, but still deliberately about SENDING WORK
 * BACK, not merely mentioning a problem. Weighted so an explicit "rejected /
 * sending back / cannot approve" outranks a softer "please clarify", and so
 * an acknowledgement ("resubmitted, thanks") scores nothing on its own.
 */
function textRejectionScore(body: string): number {
  if (!body) return 0;
  const t = body.toLowerCase();

  // Acknowledgements that happen to contain a trigger word ("resubmitted")
  // are not rejections - discount them hard so they can't win by recency.
  if (/\b(resubmitted|resubmitting|thanks|thank you|approved|looks good|good to go)\b/.test(t) &&
      !/\b(reject|sending back|sent back|cannot|can't|can not|needs|missing|unclear)\b/.test(t)) {
    return 0;
  }

  let score = 0;
  // Strong: an explicit rejection/return verb.
  if (/\b(rejected?|rejecting|returning|returned|sending (this )?back|sent back|declin(e|ed|ing)|cannot approve|can'?t approve|not approv)\b/.test(t)) score += 5;
  // Strong: rework framing.
  if (/\b(rework|resubmit|re-?submit|send back|back to the marketer|more info(rmation)? (is )?(needed|required)|need(s|ed)? more)\b/.test(t)) score += 3;
  // Medium: a named deficiency - the commonest real rejection, and the class
  // the old regex missed entirely ("needs the LOB", "audience is unclear").
  if (/\b(missing|absent|not (specified|provided|given|stated)|unclear|ambiguous|insufficient|incomplete|before we (can )?proceed|which\b|what\b)\b/.test(t)) score += 2;
  return score;
}

/**
 * Decide whether an issue's comment/update stream carries a rejection, and
 * if so, which text is the operative one.
 *
 * Order of authority:
 *   1. A structured status/decision field that says rejected - the most
 *      recent such row wins, and its body (or a synthesized note) is the
 *      reason.
 *   2. Otherwise, the highest-scoring rejection body; ties broken by recency
 *      (newest wins), and by array order only when there is no timestamp.
 *   3. Otherwise, not rejected.
 *
 * @param rows comment/update records as the connector returned them
 */
export function detectRejection(rows: CommentLike[]): RejectionSignal {
  if (!Array.isArray(rows) || rows.length === 0) return { ...NON_REJECTION, considered: 0 };

  // Stable index so ties without timestamps fall back to original order
  // (later in the array = later, matching the old .pop() intuition) rather
  // than an arbitrary sort.
  const enriched = rows.map((row, index) => ({
    row,
    index,
    body: bodyOf(row),
    time: timeOf(row),
    structured: structuredDecision(row),
    score: textRejectionScore(bodyOf(row)),
  }));

  // More recent first; rows without a time sort after those with one, then by
  // descending array index so the last-added wins a timestamp-less tie.
  const byRecency = <T extends { time: number | null; index: number }>(a: T, b: T) => {
    if (a.time != null && b.time != null) return b.time - a.time;
    if (a.time != null) return -1;
    if (b.time != null) return 1;
    return b.index - a.index;
  };

  // 1. Structured decision wins outright - most recent rejecting row.
  const rejectingStructured = enriched.filter((e) => e.structured?.rejected).sort(byRecency);
  if (rejectingStructured.length) {
    const top = rejectingStructured[0];
    return {
      rejected: true,
      // Prefer the row's own body; if the status field rejected but the row
      // has no prose, say so rather than returning an empty reason triage
      // can't read.
      reason: top.body || "The issue's status indicates it was rejected, but no reason text was recorded on it.",
      source: top.structured!.field,
      evidence: top.body || `status/decision field on record ${top.index}`,
      considered: rows.length,
    };
  }

  // 2. Strongest textual rejection, ties broken by recency.
  const scored = enriched.filter((e) => e.score > 0).sort((a, b) => b.score - a.score || byRecency(a, b));
  if (scored.length) {
    const top = scored[0];
    return {
      rejected: true,
      reason: top.body,
      source: "text_signal",
      evidence: top.body,
      considered: rows.length,
    };
  }

  // 3. Nothing read as a rejection.
  return { ...NON_REJECTION, considered: rows.length };
}
