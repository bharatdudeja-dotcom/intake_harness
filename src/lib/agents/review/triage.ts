/**
 * Triage — the part of Agent 2 that does the actual thinking.
 *
 * B2, in David Ross's words: *"The review queue rejects the issue and it goes
 * back to the marketer as rework. Nothing reads the rejection reason, and the
 * loop resumes at 1.3 with the marketer guessing."*
 *
 * So the job is to turn a rejection sentence back into **the specific field**,
 * and to ask only for that. Not to re-ask the brief. B1's health metric is the
 * same idea from the other end: more than two rounds means the agent failed,
 * not the marketer.
 *
 * Pure functions, no I/O, no framework — so this is testable on its own and the
 * route stays a thin wrapper.
 */

import { CAMPAIGN_BRIEF_FIELDS, requiredFields, type FieldSpec } from "./fields";

export type Fault = {
  field: FieldSpec;
  /** Why we think this field is at fault. Shown to the marketer, and logged. */
  because: string;
  kind: "missing" | "ambiguous" | "named-in-rejection";
};

export type TriageResult = {
  decision: "completed" | "needs_input";
  faults: Fault[];
  /** The question to put to the marketer. Empty when nothing is at fault. */
  message: string;
  /** The redraft to post back, when there is something to say. */
  redraft: string;
};

function normalise(text: unknown): string {
  return String(text ?? "").toLowerCase();
}

function isBlank(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Which fields does this rejection text actually name?
 *
 * Longest alias first, so "audience size" wins over "size" and we report the
 * more specific field rather than whichever matched first.
 */
export function fieldsNamedIn(rejection: string): FieldSpec[] {
  const haystack = normalise(rejection);
  if (!haystack.trim()) return [];

  const hits: Array<{ field: FieldSpec; weight: number }> = [];
  for (const field of CAMPAIGN_BRIEF_FIELDS) {
    const aliases = [...field.aliases, field.label.toLowerCase()].sort((a, b) => b.length - a.length);
    const matched = aliases.find((a) => haystack.includes(a));
    if (matched) hits.push({ field, weight: matched.length });
  }
  return hits.sort((a, b) => b.weight - a.weight).map((h) => h.field);
}

/** Required fields with nothing in them. */
export function missingFields(intake: Record<string, unknown>): FieldSpec[] {
  return requiredFields().filter((f) => isBlank(intake[f.key]));
}

/**
 * Fields answered with something that is technically a value and tells us
 * nothing — "Not sure", "N/A". These are not errors, but they are the reason a
 * request later falls into the GTO tail, so they are worth surfacing early.
 */
export function ambiguousFields(intake: Record<string, unknown>): Array<{ field: FieldSpec; value: string }> {
  const out: Array<{ field: FieldSpec; value: string }> = [];
  for (const field of CAMPAIGN_BRIEF_FIELDS) {
    if (!field.ambiguous) continue;
    const value = normalise(intake[field.key]).trim();
    if (value && field.ambiguous.includes(value)) out.push({ field, value: String(intake[field.key]) });
  }
  return out;
}

/**
 * The decision.
 *
 * A rejection that names a field wins over a blank field: the reviewer looked
 * at this and said what was wrong, and that is better evidence than our own
 * completeness check.
 */
export function triage(args: {
  intake: Record<string, unknown>;
  rejectionReason?: string;
}): TriageResult {
  const { intake, rejectionReason } = args;

  const named = rejectionReason ? fieldsNamedIn(rejectionReason) : [];
  const missing = missingFields(intake);
  const ambiguous = ambiguousFields(intake);

  const faults: Fault[] = [];
  for (const field of named) {
    faults.push({
      field,
      kind: "named-in-rejection",
      because: `the review queue's rejection refers to ${field.label.toLowerCase()}`,
    });
  }
  for (const field of missing) {
    if (faults.some((f) => f.field.key === field.key)) continue;
    faults.push({ field, kind: "missing", because: `${field.label} is required and was left empty` });
  }
  for (const { field, value } of ambiguous) {
    if (faults.some((f) => f.field.key === field.key)) continue;
    faults.push({ field, kind: "ambiguous", because: `${field.label} was answered "${value}", which does not identify anything` });
  }

  // A rejection we could not attribute to any field is still a rejection. Say
  // so honestly and hand the reviewer's words over, rather than approving it or
  // inventing a field to blame.
  if (rejectionReason && rejectionReason.trim() && faults.length === 0) {
    return {
      decision: "needs_input",
      faults: [],
      message:
        "The review queue rejected this, and the reason does not name a field we recognise. " +
        `Their words: "${rejectionReason.trim()}"`,
      redraft: `This request was rejected with: "${rejectionReason.trim()}"\n\nWe could not map that to a specific field on the Campaign Brief. Could you say which field needs to change?`,
    };
  }

  if (faults.length === 0) {
    return { decision: "completed", faults: [], message: "", redraft: "" };
  }

  const blocking = faults.filter((f) => f.kind !== "ambiguous");
  const decision: "completed" | "needs_input" = blocking.length > 0 ? "needs_input" : "completed";

  const lines = faults.map((f) => `- ${f.field.label}: ${f.field.ask}`);
  const message =
    blocking.length > 0
      ? `${blocking.length} thing${blocking.length === 1 ? "" : "s"} to fix before this can go back: ${blocking
          .map((f) => f.field.label)
          .join(", ")}.`
      : `This can proceed, but ${faults.length} answer${faults.length === 1 ? "" : "s"} will cause delays later: ${faults
          .map((f) => f.field.label)
          .join(", ")}.`;

  const redraft = [
    rejectionReason?.trim()
      ? `The review queue rejected this with: "${rejectionReason.trim()}"`
      : "This intake is not complete enough to submit.",
    "",
    "Specifically:",
    ...lines,
    "",
    "Answer just those and the rest of the brief stands as written.",
  ].join("\n");

  return { decision, faults, message, redraft };
}
