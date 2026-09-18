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
import type { TaskId } from "@/lib/pipeline/types";

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

/**
 * How many schemas to open. Each is a network call, and this is THE tool
 * call this whole probe lives or dies on - miss every field on a small
 * sample and the result is "inconclusive", which Agent 3 then has no choice
 * but to build around blindly (see decideBuildPath's default-to-rule-builder
 * branch). Raised from 3 to 6 after exactly that happened on a real run: the
 * 3 sampled schemas were real XDM class schemas that compose their fields
 * via `allOf`/`$ref` field groups rather than inline `properties` (see
 * fieldGroupRefs/fieldNames below), so a bigger sample alone would not have
 * saved that run - field-group resolution is the actual fix, this is the
 * cheap second line of defense.
 */
const SCHEMA_SAMPLE = 6;

/**
 * How many referenced field groups to open per schema. XDM class schemas
 * (Profile, ExperienceEvent) rarely carry attributes inline - they compose
 * them from field groups via `allOf: [{ $ref: "..." }, ...]`, and a class
 * schema's OWN document has no `properties` at all for those. Capped so one
 * schema with many field groups cannot turn this into an unbounded fan-out.
 */
const FIELD_GROUP_SAMPLE = 6;

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
  /** How many referenced field groups we additionally opened - see fieldGroupRefs. */
  fieldGroupsInspected: number;
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

/** Every property name in a schema (or field group) document, however deeply nested. */
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

/**
 * The field-group `$ref`s a CLASS-based schema composes via `allOf`.
 *
 * A real XDM Profile/ExperienceEvent schema's own document usually has no
 * inline `properties` at all - it lists `allOf: [{ $ref: ".../xdm/context/
 * profile" }, { $ref: ".../mixins/profile/loyalty" }, ...]` and the actual
 * attributes live in each referenced field group's OWN document. Reading
 * only the class schema and finding zero properties is not "this tenant has
 * no fields" - it's "we asked the wrong document." Excludes Adobe's own
 * base class refs (ns.adobe.com/xdm/context/...), which are never a
 * tenant's custom attributes and are not fetchable the same way a
 * tenant-registered field group is.
 */
function fieldGroupRefs(schema: unknown): string[] {
  const refs = new Set<string>();
  const walk = (v: unknown, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const ref = o.$ref;
    if (typeof ref === "string" && ref && !/ns\.adobe\.com\/xdm\/(context|data)\//.test(ref)) {
      refs.add(ref);
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(schema);
  return [...refs];
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
 *
 * `taskId` is whichever pipeline task is calling this - originally always
 * "audience_creation", now also "review" (see agents/review/aep-context.ts),
 * which asks the identical question one step earlier so the brief handed to
 * Agent 3 already answers it. Passed through verbatim to callMcpTool so the
 * allowlist check in mcp-client.ts is enforced against the REAL caller, not
 * a hardcoded one.
 */
export async function probeSchemas(taskId: TaskId, needed: string[]): Promise<SchemaProbe> {
  let records: Array<{ title: string; id: string }> = [];
  try {
    const list = await callMcpTool<unknown>(taskId, "adobe_list_schemas", { limit: "50" });
    records = schemaRecords(list);
  } catch (err) {
    return {
      read: false, conclusive: false, error: (err as Error).message, sandbox: null,
      schemaCount: 0, schemasInspected: 0, fieldGroupsInspected: 0, fieldCount: 0, found: {}, evidence: [],
    };
  }

  const sandbox = sandboxFrom(records);
  const candidates = records.filter((r) => PROFILE_SCHEMA_HINT.test(r.title)).slice(0, SCHEMA_SAMPLE);

  const fields = new Set<string>();
  const pendingRefs = new Set<string>();
  let inspected = 0;
  let lastError: string | null = null;
  for (const c of candidates) {
    try {
      const doc = await callMcpTool<unknown>(taskId, "adobe_get_schema", { schema_id: c.id });
      for (const f of fieldNames(doc)) fields.add(f);
      // A class-based schema's own document rarely has inline properties -
      // it composes field groups via allOf/$ref (see fieldGroupRefs). Queue
      // those regardless of whether this schema's own walk found anything,
      // since a schema can mix a few inline fields with several field-group
      // refs.
      for (const ref of fieldGroupRefs(doc)) pendingRefs.add(ref);
      inspected += 1;
    } catch (err) {
      lastError = (err as Error).message;
    }
  }

  // Resolve field groups only if the class schemas alone were inconclusive -
  // fields.size === 0 after inspecting at least one schema is exactly the
  // "properties live in a $ref, not inline" case this exists for. Bounded to
  // FIELD_GROUP_SAMPLE total, not per schema, so several profile-hinted
  // schemas each listing a handful of refs cannot fan out unboundedly.
  let fieldGroupsInspected = 0;
  if (inspected > 0 && fields.size === 0 && pendingRefs.size > 0) {
    for (const ref of [...pendingRefs].slice(0, FIELD_GROUP_SAMPLE)) {
      try {
        const doc = await callMcpTool<unknown>(taskId, "adobe_get_field_group", { field_group_id: ref });
        for (const f of fieldNames(doc)) fields.add(f);
        fieldGroupsInspected += 1;
      } catch (err) {
        lastError = (err as Error).message;
      }
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
        : pendingRefs.size > 0 && fieldGroupsInspected === 0
          ? `${candidates.length} class schema(s) composed their fields via ${pendingRefs.size} field-group ` +
            `reference(s) none of which could be opened (${lastError})`
          : lastError || "opened the candidate schemas and their field groups but found no field definitions in them",
    sandbox,
    schemaCount: records.length,
    schemasInspected: inspected,
    fieldGroupsInspected,
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
 *
 * `taskId`: see probeSchemas above - same reasoning, same requirement.
 */
export async function findExistingSegment(taskId: TaskId, terms: string[]): Promise<SegmentMatch> {
  try {
    const result = await callMcpTool<unknown>(taskId, "adobe_list_segments", { limit: "50" });
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

/** A dataset's name/id, and whether Catalog metadata marks it profile-enabled. */
function datasetRecords(result: unknown): Array<{ id: string; name: string; profileEnabled: boolean }> {
  const out: Array<{ id: string; name: string; profileEnabled: boolean }> = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 5 || v == null) return;
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const name = String(o.name || o.title || "");
      const id = String(o.$id || o.id || o["meta:altId"] || "");
      if (name && id) {
        // Real-Time Customer Profile enablement is a literal tag Catalog
        // attaches to the dataset - `tags.unifiedProfile` - never guessed
        // from the dataset's own NAME containing the word "profile". Schema
        // titles already taught this lesson once (see probeSchemas above);
        // the same trap exists here.
        const tagKeys = o.tags && typeof o.tags === "object" ? Object.keys(o.tags as Record<string, unknown>) : [];
        out.push({ id, name, profileEnabled: tagKeys.some((k) => /unifiedprofile/i.test(k)) });
        return; // a dataset record is a leaf - don't also walk into its own fields looking for more.
      }
      for (const val of Object.values(o)) walk(val, depth + 1);
    }
  };
  walk(result);
  return out;
}

export type DatasetProbe = {
  read: boolean;
  /** Did we get back anything we could recognise as dataset records at all? */
  conclusive: boolean;
  error: string | null;
  datasetCount: number;
  profileEnabled: Array<{ id: string; name: string }>;
};

/**
 * Which datasets Catalog marks profile-enabled - context for a brief, not a
 * row count. Catalog metadata (this call) does not carry record counts;
 * getting one requires Query Service, which review/registry.ts deliberately
 * does NOT allowlist for this task (a much bigger permission - arbitrary
 * SQL - than triage needs). This stops at "which datasets", on purpose.
 */
export async function profileDatasetSummary(taskId: TaskId): Promise<DatasetProbe> {
  try {
    const list = await callMcpTool<unknown>(taskId, "adobe_list_datasets", { limit: "50" });
    const records = datasetRecords(list);
    return {
      read: true,
      conclusive: records.length > 0,
      error: records.length ? null : "the dataset list returned nothing recognisable as a dataset",
      datasetCount: records.length,
      profileEnabled: records.filter((r) => r.profileEnabled).map((r) => ({ id: r.id, name: r.name })),
    };
  } catch (err) {
    return { read: false, conclusive: false, error: (err as Error).message, datasetCount: 0, profileEnabled: [] };
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
