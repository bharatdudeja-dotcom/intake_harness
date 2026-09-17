/**
 * Reading a review-queue rejection. B2, at step 1.5a.
 *
 * "The review queue rejects the issue and it goes back to the marketer as
 * rework. Nothing reads the rejection reason, and the loop resumes at 1.3 with
 * the marketer guessing. The largest unclaimed gap in the map. A review-triage
 * agent should parse the rejection, translate it into the specific missing field
 * or wrong data source, and redraft 1.3 automatically for the marketer to
 * confirm."
 *
 * The gap is not that rejections are unread by machines - it is that they are
 * unread by ANYONE in a form that says what to change. "Audience definition
 * unclear" sends a marketer back to a form with eleven fields and no idea which
 * one is wrong. So the job is translation: rejection text in, a specific field
 * and a proposed value out.
 *
 * PURE ON PURPOSE. No MCP calls, no database, no fetch. A rejection reason is a
 * string and a classification is a decision about that string, so this file is
 * testable without a network, and the agent route is the only thing that talks
 * to anything.
 */

import {
  CAMPAIGN_BRIEF_FIELDS,
  requiredFields,
  resolveFieldRef,
  type FieldSpec,
} from "@/lib/agents/shared/campaign-brief";

/**
 * What kind of problem a rejection describes.
 *
 * These are the four the map actually distinguishes, because they lead to
 * different next actions - and a classification that does not change what
 * happens next is decoration.
 */
export type RejectionKind =
  /** A field is absent or unusable. The marketer supplies it. */
  | "missing_field"
  /** A field has a value, but not one the form allows. We can often propose the right one. */
  | "invalid_value"
  /** The right data is being read from the wrong place - FAC vs the profile store. */
  | "wrong_data_source"
  /** Real, and not reducible to a field. A human has to read it. */
  | "unclassified";

export type TriageFinding = {
  kind: RejectionKind;
  /** The field this is about, where there is one. */
  fieldKey: string | null;
  fieldLabel: string | null;
  /** What to ask the marketer, phrased as one answerable question. */
  ask: string;
  /** A value we believe is right, for them to confirm rather than compose. */
  proposed?: string | null;
  /** Which words in the rejection led here, so a human can check the reading. */
  evidence: string;
};

export type TriageResult = {
  findings: TriageFinding[];
  /** The redraft: the intake as it should be resubmitted. */
  redraft: Record<string, string>;
  /** Fields in the redraft we changed or filled, for the confirm step. */
  changed: string[];
  /** True when nothing could be classified and a person must read it. */
  needsHuman: boolean;
  /** One line for the marketer, assembled from the findings. */
  summary: string;
};

const lower = (s: unknown) => String(s ?? "").toLowerCase();

/**
 * Phrases that mean "this is absent".
 *
 * Deliberately narrow. A rejection saying "the launch date is too aggressive"
 * is not a missing field, and matching it as one would send a pointless
 * question and burn a loop.
 */
const MISSING_CUES = /\b(missing|absent|not (specified|provided|given|stated|filled)|no\s|blank|empty|unspecified|needs? (a|the)?\s*\w+|unclear|ambiguous|which\b|what\b)/i;

/** Phrases that mean "the value is wrong, not absent". */
const INVALID_CUES = /\b(invalid|not (a )?valid|unrecognis|unrecognized|wrong value|not an option|must be one of|incorrect)/i;

/**
 * Phrases that mean the data is coming from the wrong place.
 *
 * This is the one classification that is not about the form at all, and it is
 * the expensive one: FAC versus the profile store is the difference between the
 * rule builder at 3.1a and the undefined workflow at 3.1b.
 */
const SOURCE_CUES = /\b(fac\b|federated|wrong (data )?source|data source|profile store|account[- ]level|profile[- ]level|identity|crm\b|golden record)/i;

/** A quoted or named value inside the rejection: 'Resi', "Residential", `RES`. */
function quotedValue(text: string): string | null {
  const m = text.match(/["'`]([^"'`]{2,40})["'`]/);
  return m ? m[1].trim() : null;
}

/** Split a rejection into the separate complaints it usually contains. */
function clauses(reason: string): string[] {
  return String(reason || "")
    .split(/[;.\n]|,\s*(?=(?:and\b|also\b|plus\b))|\band also\b|\bandthen\b/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 2);
}

/**
 * The closest allowed option to what the marketer wrote.
 *
 * Substring both ways, which covers the realistic cases - "Resi" against
 * "Residential (RES)", "SMB" against "Business (SMB)" - and nothing cleverer.
 * A fuzzy match that guesses wrong here proposes a value that gets confirmed by
 * a busy human and written to Workfront, so it fails closed instead.
 */
export function closestOption(spec: FieldSpec, written: string): string | null {
  if (!spec.options?.length || !written) return null;
  const w = lower(written).replace(/[^a-z0-9 ]/g, "").trim();
  if (!w) return null;

  for (const opt of spec.options) {
    const o = lower(opt).replace(/\s*\(.*?\)\s*/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
    if (o === w) return opt;
  }
  for (const opt of spec.options) {
    const o = lower(opt).replace(/[^a-z0-9 ]/g, "").trim();
    if (o.includes(w) || w.includes(o)) return opt;
    // Also match the parenthesised short form: "(RES)" -> "res".
    const paren = lower(opt).match(/\(([^)]+)\)/)?.[1]?.replace(/[^a-z0-9]/g, "");
    if (paren && paren === w) return opt;
  }
  return null;
}

/** Classify one clause of a rejection. */
function triageClause(clause: string, current: Record<string, string>): TriageFinding | null {
  const spec = resolveFieldRef(clause);

  /*
   * The data-source case, and the order it has to be tested in.
   *
   * This was written as `SOURCE_CUES && !MISSING_CUES`, on the reasoning that
   * "missing FAC field" is a missing field rather than a source problem. But
   * the commonest real rejection is "unclear whether this is FAC or profile
   * store" - which matches MISSING_CUES on the word "unclear" and was therefore
   * thrown away, silently, losing the single most expensive classification in
   * the map. 3.1a versus 3.1b is the difference between the rule builder and an
   * undefined workflow.
   *
   * So a source cue wins unless the clause names a SPECIFIC field and says that
   * field is absent - which is the only case the original guard was really for.
   */
  if (SOURCE_CUES.test(clause)) {
    /*
     * "Unclear", "which", "whether" - the words that mean a QUESTION, not an
     * absence.
     *
     * The \b here were once written through a code generator that turned them
     * into literal backspace characters (U+0008), so this regex was
     * /<BS>(unclear|ambiguous|...)<BS>/ and matched nothing. Which quietly
     * reinstated the very bug the block below documents as fixed: a rejection
     * reading "unclear whether this is FAC or profile store" was classified as
     * a missing field again, losing the most expensive classification in the
     * map. The fix was written and then neutralised by an escape.
     */
    const ASKS_A_QUESTION = /\b(unclear|ambiguous|which|whether|what)\b/i;
    const namesAMissingField = spec && MISSING_CUES.test(clause) && !ASKS_A_QUESTION.test(clause);
    if (!namesAMissingField) {
      return {
        kind: "wrong_data_source",
        fieldKey: spec?.key ?? null,
        fieldLabel: spec?.label ?? null,
        ask:
          "The reviewer is questioning where this data comes from. Should this audience be built " +
          "from the AEP profile store, or does it need the federated (FAC) path? " +
          "They resolve to different identities, so the counts will differ - and FAC is the undefined " +
          "3.1b workflow, so it needs to be a deliberate answer rather than a default.",
        evidence: clause,
      };
    }
  }

  if (!spec) return null;

  const written = current[spec.key];

  if (INVALID_CUES.test(clause) || (written && !MISSING_CUES.test(clause))) {
    const candidate = quotedValue(clause) || written || "";
    const proposed = closestOption(spec, candidate);
    return {
      kind: "invalid_value",
      fieldKey: spec.key,
      fieldLabel: spec.label,
      proposed,
      ask: proposed
        ? `${spec.label} was submitted as "${candidate}". The form expects "${proposed}" - confirm and we will resubmit.`
        : `${spec.label} was submitted as "${candidate}", which the form does not accept.` +
          (spec.options?.length ? ` Allowed: ${spec.options.join(", ")}.` : ""),
      evidence: clause,
    };
  }

  return {
    kind: "missing_field",
    fieldKey: spec.key,
    fieldLabel: spec.label,
    proposed: null,
    ask: spec.ask || `What is the ${spec.label.toLowerCase()}?`,
    evidence: clause,
  };
}

/**
 * Read a rejection and redraft the intake.
 *
 * @param reason the reviewer's own words
 * @param current the intake as submitted, so we can tell absent from wrong
 */
export function triageRejection(
  reason: string,
  current: Record<string, string> = {},
): TriageResult {
  const text = String(reason || "").trim();
  const findings: TriageFinding[] = [];
  const seen = new Set<string>();

  for (const clause of clauses(text)) {
    const f = triageClause(clause, current);
    if (!f) continue;
    const dedupe = `${f.kind}:${f.fieldKey ?? "-"}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    findings.push(f);
  }

  /*
   * A rejection we could not read is reported as exactly that.
   *
   * The temptation is to fall back on "re-ask the required fields", which looks
   * helpful and is the original bug: it sends the marketer back to guess. If we
   * cannot say what to change, a human reads it - and that is a better outcome
   * than a confident wrong question.
   */
  if (!findings.length) {
    const stillMissing = requiredFields().filter((f) => !current[f.key]);
    return {
      findings: [
        {
          kind: "unclassified",
          fieldKey: null,
          fieldLabel: null,
          ask:
            "The rejection could not be mapped to a specific field, so it needs a person to read it: " +
            `"${text}"`,
          evidence: text,
        },
      ],
      redraft: { ...current } as Record<string, string>,
      changed: [],
      needsHuman: true,
      summary:
        `Could not translate this rejection into a field change.` +
        (stillMissing.length
          ? ` For information, these required fields are also still empty: ${stillMissing.map((f) => f.label).join(", ")}.`
          : ""),
    };
  }

  // The redraft: apply every value we are confident about, leave the rest for
  // the marketer to answer. Never blank a field that was already right.
  const redraft: Record<string, string> = { ...current };
  const changed: string[] = [];
  for (const f of findings) {
    if (f.fieldKey && f.proposed) {
      redraft[f.fieldKey] = f.proposed;
      changed.push(f.fieldKey);
    }
  }

  const asks = findings.filter((f) => !f.proposed).length;
  const summary =
    [
      changed.length ? `${changed.length} field(s) corrected and ready to confirm` : "",
      asks ? `${asks} question(s) for the marketer` : "",
    ]
      .filter(Boolean)
      .join("; ") || "No change needed.";

  return { findings, redraft, changed, needsHuman: false, summary };
}

/** Every field key the form knows, for callers that want to validate a redraft. */
export function knownFieldKeys(): string[] {
  return CAMPAIGN_BRIEF_FIELDS.map((f) => f.key);
}
