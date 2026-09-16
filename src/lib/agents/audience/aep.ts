/**
 * What AEP can actually answer about an audience, before anyone builds it.
 *
 * Agent 3's blockers are all versions of one question - "what will this
 * audience be, and can this platform even express it?" - asked BEFORE the
 * nightly job at 21:45, because after that every mistake costs a day (B6).
 *
 * Every function here is a READ. Nothing creates a segment.
 *
 * WHY THAT LINE MATTERS: adobe_create_segment_estimate takes a segment_id, so
 * estimating a brand-new audience means creating the segment first. That is a
 * real write, into a client's AEP sandbox, as a side effect of what the
 * marketer experiences as "showing me a number". So this module will report
 * that it cannot predict a count and say exactly what creating one would
 * require, rather than quietly writing a segment definition to produce a
 * figure. A precomputed count is worth a lot (B3); it is not worth silently
 * mutating a production sandbox.
 *
 * Tool names and argument shapes below are verified against the live server -
 * 238 tools, tools/list read 16 Sep 2026. Every one of these takes an optional
 * `sandbox`, and none of them have required arguments.
 */

import { callMcpTool } from "@/lib/mcp-client";

/**
 * Attributes we can recognise, matched against SCHEMA FIELD NAMES.
 *
 * Word-anchored on purpose. The first version used `lob` unanchored, and it
 * matched "glob" inside "https://.../global/schemas?limit=50" - so it reported
 * line-of-business as AVAILABLE on the strength of a substring in a URL. A
 * false positive here is worse than a false negative: it claims an audience can
 * be built when it cannot.
 */
const ATTRIBUTE_CUES: Record<string, RegExp> = {
  line_of_business: /(^|[^a-z])(lineofbusiness|line_of_business|lob|businessunit|business_unit)([^a-z]|$)/i,
  customer_type: /(^|[^a-z])(customertype|customer_type|subscriberstatus|subscriber_status|accountstatus|account_status)([^a-z]|$)/i,
  lifecycle_journey: /(^|[^a-z])(lifecycle|lifecyclestage|lifecycle_stage|journeystage|journey_stage)([^a-z]|$)/i,
  channels: /(^|[^a-z])(channel|emailaddress|email_address|phonenumber|phone_number|mobilephone)([^a-z]|$)/i,
  region: /(^|[^a-z])(region|state|market|geo|postalcode|postal_code)([^a-z]|$)/i,
};

/** Schema titles worth opening: the ones that would carry profile attributes. */
const PROFILE_SCHEMA_HINT = /profile|individual|customer|account|subscriber|person|demographic/i;

/** How many schemas to open. Each is a network call; three is enough to tell. */
const SCHEMA_SAMPLE = 3;

export type SchemaProbe = {
  /** Did the schema LIST read succeed? */
  read: boolean;
  /**
   * Did we actually obtain field-level data?
   *
   * This is the field that matters, and here is why it exists: the first version
   * matched attribute names against schema TITLES, which do not contain field
   * names at all, so it reported every attribute as missing - and on the
   * strength of that it opened a GTO attribute request, the quarter-long tail,
   * for a question it had never actually asked. Inconclusive has to be its own
   * state, distinct from both available and missing.
   */
  conclusive: boolean;
  error: string | null;
  /** The AEP sandbox these schemas came from, read off the schema ids. */
  sandbox: string | null;
  schemaCount: number;
  /** How many schemas we opened and walked. */
  schemasInspected: number;
  /** How many distinct field names we saw. */
  fieldCount: number;
  found: Record<string, boolean>;
  evidence: string[];
};

/** Titles and ids from the schema list. */
function schemaRecords(result: unknown): Array<{ title: string; id: string }> {
  const out: Array<{ title: string; id: string }> = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 5 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const id = String(o.$id || o["meta:altId"] || "");
      const title = String(o.title || "");
      if (id && title) out.push({ title, id });
      for (const val of Object.values(o)) walk(val, depth + 1);
    }
  };
  walk(result);
  return out;
}

/** Every property name in a schema document, however deeply nested. */
function fieldNames(schema: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 12 || v == null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const props = o.properties;
    if (props && typeof props === "object") {
      for (const key of Object.keys(props as Record<string, unknown>)) out.add(key);
    }
    for (const val of Object.values(o)) {
      if (val && typeof val === "object") walk(val, depth + 1);
    }
  };
  walk(schema);
  return [...out];
}

/** "https://ns.adobe.com/taplondonptrsd/schemas/..." -> "taplondonptrsd" */
function sandboxFrom(records: Array<{ id: string }>): string | null {
  for (const r of records) {
    const m = r.id.match(/ns\.adobe\.com\/([^/]+)\//);
    if (m) return m[1];
  }
  return null;
}

/**
 * B4: are the attributes this audience needs present in AEP today?
 *
 * Asked of schema FIELDS, by opening the schemas most likely to carry profile
 * attributes and walking their properties. Asked of schema titles - which is
 * what this did first - the question cannot be answered either way.
 *
 * When no profile-like schema can be opened the answer is INCONCLUSIVE, not
 * "missing", and the caller must not open an attribute request off it.
 */
export async function probeSchemas(needed: string[]): Promise<SchemaProbe> {
  let records: Array<{ title: string; id: string }> = [];
  try {
    const list = await callMcpTool<unknown>("audience_creation", "adobe_list_schemas", { limit: "50" });
    records = schemaRecords(list);
  } catch (err) {
    return {
      read: false, conclusive: false, error: (err as Error).message, sandbox: null,
      schemaCount: 0, schemasInspected: 0, fieldCount: 0, found: {}, evidence: [],
    };
  }

  const sandbox = sandboxFrom(records);
  const candidates = records.filter((r) => PROFILE_SCHEMA_HINT.test(r.title)).slice(0, SCHEMA_SAMPLE);

  const fields = new Set<string>();
  let inspected = 0;
  let lastError: string | null = null;
  for (const c of candidates) {
    try {
      const doc = await callMcpTool<unknown>("audience_creation", "adobe_get_schema", { schema_id: c.id });
      for (const f of fieldNames(doc)) fields.add(f);
      inspected += 1;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  const conclusive = inspected > 0 && fields.size > 0;
  const found: Record<string, boolean> = {};
  const evidence: string[] = [];
  if (conclusive) {
    const names = [...fields];
    for (const key of needed) {
      const cue = ATTRIBUTE_CUES[key];
      if (!cue) { found[key] = false; continue; }
      const hit = names.find((n) => cue.test(n));
      found[key] = !!hit;
      if (hit) evidence.push(hit);
    }
  }

  return {
    read: true,
    conclusive,
    error: conclusive
      ? null
      : candidates.length === 0
        ? `none of the ${records.length} schemas in this sandbox look like profile schemas, so attribute availability could not be determined`
        : lastError || "opened the candidate schemas but found no field definitions in them",
    sandbox,
    schemaCount: records.length,
    schemasInspected: inspected,
    fieldCount: fields.size,
    found,
    evidence: evidence.slice(0, 8),
  };
}

export type SegmentMatch = {
  read: boolean;
  error: string | null;
  /** An existing segment that looks like what was asked for. */
  id: string | null;
  name: string | null;
  considered: number;
};

/**
 * Is there already a segment for this? B6's cheapest possible outcome.
 *
 * Reusing an existing audience skips the build, the nightly job and the whole
 * rework window. It is also the only way to get a real count without writing
 * anything, so it is tried first.
 */
export async function findExistingSegment(terms: string[]): Promise<SegmentMatch> {
  try {
    const result = await callMcpTool<unknown>("audience_creation", "adobe_list_segments", { limit: "50" });
    const rows = (Array.isArray(result) ? result : ((result as { segments?: unknown[]; data?: unknown[] })?.segments
      || (result as { data?: unknown[] })?.data || [])) as Array<Record<string, unknown>>;

    const meaningful = terms.map((t) => String(t).toLowerCase()).filter((t) => t.length > 3);
    let best: { id: string; name: string; score: number } | null = null;
    for (const row of rows) {
      const name = String(row.name || row.title || "");
      const id = String(row.id || row.segmentId || row["meta:altId"] || "");
      if (!name || !id) continue;
      const hay = name.toLowerCase();
      const score = meaningful.filter((t) => hay.includes(t)).length;
      if (score > 0 && (!best || score > best.score)) best = { id, name, score };
    }
    return { read: true, error: null, id: best?.id ?? null, name: best?.name ?? null, considered: rows.length };
  } catch (err) {
    return { read: false, error: (err as Error).message, id: null, name: null, considered: 0 };
  }
}

export type CountEstimate = {
  count: number | null;
  /** Where the number came from, or why there is not one. */
  basis: string;
  segmentId: string | null;
};

/**
 * B3/B6: the expected count, before the marketer sees it.
 *
 * Only ever estimated for a segment that ALREADY EXISTS. When there is none,
 * this returns null and says what producing one would require. A number is the
 * whole value of B3, and a number produced by writing an unrequested segment
 * definition into a client's sandbox is not worth having.
 */
export async function estimateCount(segmentId: string | null): Promise<CountEstimate> {
  if (!segmentId) {
    return {
      count: null,
      basis:
        "No existing segment matched this request, and estimating a new one requires creating the " +
        "segment definition first (adobe_create_segment_estimate takes a segment_id). That is a write " +
        "into the AEP sandbox, so it is not done as a side effect of a prediction - it needs an " +
        "explicit build step.",
      segmentId: null,
    };
  }
  try {
    const started = await callMcpTool<Record<string, unknown>>(
      "audience_creation",
      "adobe_create_segment_estimate",
      { segment_id: segmentId },
    );
    const estimateId = String(started?.estimate_id || started?.id || "");
    const detail = estimateId
      ? await callMcpTool<Record<string, unknown>>("audience_creation", "adobe_get_segment_estimate", {
          segment_id: segmentId,
          estimate_id: estimateId,
        })
      : started;

    const n = Number(
      detail?.totalRows ?? detail?.profileCount ?? detail?.count ?? detail?.estimatedSize ?? NaN,
    );
    return Number.isFinite(n)
      ? { count: n, basis: `estimate on existing segment ${segmentId}`, segmentId }
      : {
          count: null,
          basis: `the estimate for ${segmentId} returned no recognisable count field`,
          segmentId,
        };
  } catch (err) {
    return { count: null, basis: `estimate failed: ${(err as Error).message}`, segmentId };
  }
}

/**
 * B3/B8: the account-versus-profile identity gap.
 *
 * "Flag the account-versus-profile identity gap explicitly rather than letting
 * the marketer discover a number they do not recognise." The gap is real
 * whenever the brief counts one thing and AEP counts another: a marketer asking
 * for "subscribers" is thinking in accounts, and the profile store resolves to
 * people, so one household with three profiles is 1 or 3 depending on who is
 * counting. Saying so up front is the entire fix - the doc keeps the human
 * decision at 2.5 and asks only that the surprise be removed.
 */
export function identityGap(fields: Record<string, string>): { hasGap: boolean; details: string | null } {
  const text = Object.values(fields || {}).join(" ").toLowerCase();
  const accountWords = /\b(subscriber|account|household|customer|line|premise)\b/.test(text);
  if (!accountWords) return { hasGap: false, details: null };
  return {
    hasGap: true,
    details:
      "This brief is written in account terms (subscribers/accounts/households) and AEP counts " +
      "resolved profiles. One household can resolve to several profiles, so the audience count " +
      "will not equal the subscriber count and the difference is identity resolution, not an error. " +
      "Agree which number is the target before the count is reviewed.",
  };
}

/**
 * B5: rule builder, or the federated path?
 *
 * "Establish whether a request genuinely needs FAC or can be satisfied in the
 * AEP rule builder at 3.1a, so the undefined path is taken only when
 * unavoidable." 3.1b is undefined and unscoped, so the default has to be the
 * rule builder and FAC has to be argued for - not the other way round.
 */
export function decideBuildPath(
  fields: Record<string, string>,
  probe: SchemaProbe,
): { buildPath: "aep_rule_builder" | "fac"; reason: string } {
  const text = Object.values(fields || {}).join(" ").toLowerCase();

  if (/\bfac\b|federated|data warehouse|snowflake|offline only/.test(text)) {
    return {
      buildPath: "fac",
      reason: "The brief names federated/FAC data explicitly, so the federated path is being asked for.",
    };
  }

  // Prospects are not in the profile store, which is the honest FAC case.
  if (/prospect|non-?customer/.test(text)) {
    return {
      buildPath: "fac",
      reason:
        "The audience is prospects, who do not exist in the AEP profile store, so this cannot be " +
        "satisfied in the rule builder.",
    };
  }

  if (!probe.conclusive) {
    return {
      buildPath: "aep_rule_builder",
      reason:
        `Attribute availability could not be determined (${probe.error}), so the path is unconfirmed. ` +
        "Defaulting to the rule builder because 3.1b is an undefined, unscoped workflow and must be " +
        "entered only when it is known to be necessary - not because a probe came back inconclusive.",
    };
  }

  const absent = Object.entries(probe.found).filter(([, ok]) => !ok).map(([k]) => k);
  if (absent.length) {
    return {
      buildPath: "aep_rule_builder",
      reason:
        `The rule builder can express this once ${absent.join(", ")} ${absent.length === 1 ? "is" : "are"} ` +
        "available. Missing attributes are a B4 attribute request, not a reason to take the federated path.",
    };
  }

  return {
    buildPath: "aep_rule_builder",
    reason: "Every attribute this audience needs is present in AEP, so the rule builder covers it.",
  };
}

/**
 * B6: the nightly segmentation job.
 *
 * "The segmentation job runs once a night at 9:45 pm. Every rework cycle after
 * this point costs a minimum of one full day." The agent cannot move the job,
 * so the only useful thing it can do is say how much of today is left.
 */
export function nightlyCutoff(now = new Date()): {
  cutoff: string;
  minutesRemaining: number;
  madeIt: boolean;
  note: string;
} {
  const cutoff = new Date(now);
  cutoff.setHours(21, 45, 0, 0);
  const minutes = Math.round((cutoff.getTime() - now.getTime()) / 60000);
  const madeIt = minutes > 0;
  return {
    cutoff: "21:45",
    minutesRemaining: minutes,
    madeIt,
    note: madeIt
      ? `${minutes} minute(s) until the 21:45 segmentation run. A fix landing before it costs no extra day.`
      : `The 21:45 run has passed (${Math.abs(minutes)} minute(s) ago). Anything from here lands tomorrow night, ` +
        "so batch the outstanding fixes rather than spending a night on each.",
  };
}
