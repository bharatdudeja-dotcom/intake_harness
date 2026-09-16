/**
 * Agent 1 — turning a marketer's paragraph into a structured intake.
 *
 * B1: *"The agent cannot build the intake from the prompt, so it bounces back
 * to the marketer. The loop can run many times, and each round trip is
 * unbounded."* The fix is not to ask better questions — it is to ask **fewer**.
 * Extract everything the brief already contains, and come back only for what is
 * genuinely missing.
 *
 * The rule this module exists to enforce:
 *
 *   **Every value records where it came from.** Stated, derived, or inferred.
 *
 * A brief that looks complete because the agent guessed is worse than one with
 * visible gaps: it clears intake, and then fails at creative review a week
 * later, by which point the rework is a full creative round. So an inferred
 * value is marked as inferred and surfaced for confirmation, never silently
 * filled.
 *
 * Pure functions. No I/O, no framework — testable on its own.
 */

import { CAMPAIGN_BRIEF_FIELDS, requiredFields, type FieldSpec } from "@/lib/agents/shared/campaign-brief";

export type Provenance = "stated" | "derived" | "inferred";

export type ExtractedField = {
  key: string;
  label: string;
  value: string;
  /** Where the value came from. Anything but "stated" needs a human to confirm. */
  from: Provenance;
  /** The phrase in the brief this came from, so a reviewer can check it. */
  evidence?: string;
};

export type ParsedIntake = {
  fields: Record<string, string>;
  extracted: ExtractedField[];
  /** Required fields the brief does not answer. These drive needs_input. */
  missing: FieldSpec[];
  /** Fields the agent guessed. Correct in most cases; must still be confirmed. */
  inferred: ExtractedField[];
};

const lower = (s: string) => String(s || "").toLowerCase();

/** Longest option first, so "TV/Streaming" beats "TV". */
function matchOption(text: string, options: readonly string[]): string | null {
  const hay = lower(text);
  const sorted = [...options].sort((a, b) => b.length - a.length);
  for (const opt of sorted) {
    const needle = lower(opt).replace(/\s*\(.*?\)\s*/g, "").trim();
    if (needle && hay.includes(needle)) return opt;
  }
  return null;
}

/** Phrases that carry a field without naming it. Kept small and explicit. */
const CUES: Array<{ key: string; value: string; from: Provenance; cues: RegExp }> = [
  { key: "business_objective", value: "Growth/Upsell", from: "inferred", cues: /\bupsell|up-sell|upgrade path|grow(th)? revenue\b/i },
  { key: "business_objective", value: "Retention", from: "inferred", cues: /\bretention|retain|churn|renewal\b/i },
  { key: "business_objective", value: "Acquisition", from: "inferred", cues: /\bacquisition|acquire|prospect|new customer\b/i },
  { key: "customer_type", value: "Subscriber - Existing Customers", from: "inferred", cues: /\bexisting (customers|subscribers)|current (customers|subscribers)|our base\b/i },
  { key: "lifecycle_journey", value: "Upgrade", from: "inferred", cues: /\bupgrade|speed ?tier|move up\b/i },
  { key: "lifecycle_journey", value: "Winback", from: "inferred", cues: /\bwin ?back|lapsed|former\b/i },
  { key: "line_of_business", value: "Residential (RES)", from: "inferred", cues: /\bresidential|\bres\b|home\b/i },
  { key: "line_of_business", value: "Business (SMB)", from: "inferred", cues: /\bsmb|small business|business customers\b/i },
  { key: "request_type", value: "Audience Build-Only", from: "inferred", cues: /\baudience (build|only)|just the audience\b/i },
  { key: "campaign_duration", value: "Evergreen (ongoing)", from: "inferred", cues: /\bevergreen|ongoing|always[- ]on\b/i },
  { key: "cadence", value: "Recurring Campaign", from: "inferred", cues: /\brecurring|repeat(ing)?|every (month|quarter|week)\b/i },
  { key: "activation_pattern", value: "Near-real time trigger", from: "inferred", cues: /\breal[- ]?time|triggered?\b/i },
];

/** Months, for a date the marketer wrote in prose. */
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];

function findLaunchDate(brief: string): ExtractedField | null {
  const hay = lower(brief);
  // "end of October", "launch 31 Oct", "by November"
  for (let i = 0; i < MONTHS.length; i++) {
    const m = MONTHS[i];
    if (!hay.includes(m.slice(0, 3))) continue;
    const endOf = new RegExp(`(end|late)\\s+(of\\s+)?${m.slice(0, 3)}`, "i").test(brief);
    const evidence = brief.match(new RegExp(`[^.]*${m.slice(0, 3)}[^.]*`, "i"))?.[0]?.trim();
    return {
      key: "launch_date",
      label: "Launch date",
      value: endOf ? `End of ${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)}` : `${MONTHS[i][0].toUpperCase()}${MONTHS[i].slice(1)}`,
      // A month is not a date. Derived, and the marketer confirms the day.
      from: "derived",
      evidence,
    };
  }
  return null;
}

/**
 * Read a brief.
 * @param brief the marketer's own words
 * @param known anything already structured (a rework loop carries this)
 */
export function parseBrief(brief: string, known: Record<string, unknown> = {}): ParsedIntake {
  const extracted: ExtractedField[] = [];
  const seen = new Set<string>();

  const push = (f: ExtractedField) => {
    if (seen.has(f.key)) return;
    seen.add(f.key);
    extracted.push(f);
  };

  // 1. Anything already structured wins outright - it was stated, not guessed.
  for (const spec of CAMPAIGN_BRIEF_FIELDS) {
    const existing = known[spec.key];
    if (existing != null && String(existing).trim() !== "") {
      push({ key: spec.key, label: spec.label, value: String(existing), from: "stated" });
    }
  }

  // 2. Enum fields whose own options appear verbatim in the brief.
  for (const spec of CAMPAIGN_BRIEF_FIELDS) {
    if (seen.has(spec.key) || !spec.options?.length) continue;
    const hit = matchOption(brief, spec.options);
    if (hit) {
      push({
        key: spec.key, label: spec.label, value: hit, from: "stated",
        evidence: brief.match(new RegExp(`[^.]*${hit.split(" ")[0]}[^.]*`, "i"))?.[0]?.trim(),
      });
    }
  }

  // 3. Cue phrases. These are inferences and are marked as such.
  for (const cue of CUES) {
    if (seen.has(cue.key)) continue;
    const m = brief.match(cue.cues);
    if (m) {
      const spec = CAMPAIGN_BRIEF_FIELDS.find((f) => f.key === cue.key);
      push({
        key: cue.key, label: spec?.label ?? cue.key, value: cue.value,
        from: cue.from, evidence: m[0],
      });
    }
  }

  // 4. A date written in prose.
  if (!seen.has("launch_date")) {
    const d = findLaunchDate(brief);
    if (d) push(d);
  }

  const fields: Record<string, string> = {};
  for (const f of extracted) fields[f.key] = f.value;

  const missing = requiredFields().filter((f) => !fields[f.key]);
  const inferred = extracted.filter((f) => f.from !== "stated");

  return { fields, extracted, missing, inferred };
}

/**
 * The two things actually missing — not the whole form.
 *
 * B1 again: *"the agent asks for the two things actually missing rather than
 * re-asking the whole brief."* Asking for eleven fields is how a loop count
 * passes two, and past two the agent has failed, not the marketer.
 */
export function nextQuestions(parsed: ParsedIntake, limit = 2): FieldSpec[] {
  return parsed.missing.slice(0, limit);
}
