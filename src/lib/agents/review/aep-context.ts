/**
 * What Review can tell Agent 3 - and a human reading the Workfront issue -
 * about AEP before the handoff: which attributes this audience will need
 * and whether they exist, whether an audience like this already exists, and
 * which candidate profile datasets are even profile-enabled.
 *
 * These are the SAME three read-only questions Agent 3 asks in
 * lib/agents/audience/aep.ts, for the same reasons - asked one step
 * earlier, so the brief that reaches Agent 3 already answers them instead
 * of Agent 3 discovering the same facts from scratch. Nothing here writes
 * to AEP; see registry.ts for exactly why review's AEP allowlist stops at
 * list/get (no segment-estimate or query tools).
 */

import {
  probeSchemas,
  findExistingSegment,
  profileDatasetSummary,
  type SchemaProbe,
  type SegmentMatch,
  type DatasetProbe,
} from "@/lib/agents/audience/aep";

/**
 * The attributes this brief's audience will need in AEP - mirrors
 * audience-creation/route.ts's own `neededAttributes`, asked here first so
 * a "wrong data source" or missing-attribute problem surfaces at review,
 * not two agents later.
 */
function neededAttributes(fields: Record<string, string>): string[] {
  const needed = new Set<string>(["customer_type", "line_of_business"]);
  if (fields.lifecycle_journey) needed.add("lifecycle_journey");
  if (fields.channels) needed.add("channels");
  if (/northeast|region|state|market/i.test(Object.values(fields).join(" "))) needed.add("region");
  return [...needed];
}

/** Same derivation as audience-creation/route.ts's `terms` - what to search existing segments for. */
function segmentSearchTerms(fields: Record<string, string>): string[] {
  return [fields.campaign_name, fields.lifecycle_journey, fields.line_of_business, fields.customer_type]
    .filter(Boolean)
    .map(String);
}

export type AepContext = {
  neededAttributes: string[];
  schemaProbe: SchemaProbe;
  segmentTerms: string[];
  segmentMatch: SegmentMatch;
  datasetProbe: DatasetProbe;
};

/** Run all three AEP reads for this brief, in parallel - each is independent and none writes anything. */
export async function gatherAepContext(fields: Record<string, string>): Promise<AepContext> {
  const neededAttrs = neededAttributes(fields);
  const terms = segmentSearchTerms(fields);
  const [schemaProbe, segmentMatch, datasetProbe] = await Promise.all([
    probeSchemas("review", neededAttrs),
    findExistingSegment("review", terms),
    profileDatasetSummary("review"),
  ]);
  return { neededAttributes: neededAttrs, schemaProbe, segmentTerms: terms, segmentMatch, datasetProbe };
}

/**
 * Turn gatherAepContext's result into readable text - the body of the
 * Workfront comment and the review-notes field write. Every line says
 * whether the underlying read was conclusive; an inconclusive read is
 * reported as exactly that, never silently dropped or guessed at (same
 * discipline as aep.ts's own SchemaProbe/DatasetProbe).
 */
export function formatAepContextNote(ctx: AepContext): string {
  const lines: string[] = ["Review — AEP context for Agent 3 (Audience Creation):"];

  if (ctx.schemaProbe.conclusive) {
    const found = ctx.neededAttributes.filter((k) => ctx.schemaProbe.found[k]);
    const missing = ctx.neededAttributes.filter((k) => !ctx.schemaProbe.found[k]);
    lines.push(
      `- Attributes needed: ${ctx.neededAttributes.join(", ")}. Checked ${ctx.schemaProbe.fieldCount} field(s) ` +
        `across ${ctx.schemaProbe.schemasInspected} profile schema(s)` +
        (ctx.schemaProbe.sandbox ? ` in sandbox "${ctx.schemaProbe.sandbox}"` : "") +
        `. Present: ${found.join(", ") || "none"}.` +
        (missing.length ? ` Missing: ${missing.join(", ")}.` : ""),
    );
  } else {
    lines.push(
      `- Attribute availability could not be determined: ${ctx.schemaProbe.error} ` +
        "Not reporting anything as missing on the strength of that.",
    );
  }

  if (ctx.segmentMatch.id) {
    lines.push(`- An existing audience may already cover this: "${ctx.segmentMatch.name}" (${ctx.segmentMatch.id}).`);
  } else if (ctx.segmentMatch.read) {
    lines.push(`- No existing audience matched this request (${ctx.segmentMatch.considered} checked).`);
  } else {
    lines.push(`- Could not check for an existing audience: ${ctx.segmentMatch.error}`);
  }

  if (ctx.datasetProbe.conclusive) {
    lines.push(
      ctx.datasetProbe.profileEnabled.length
        ? `- Profile-enabled dataset(s): ${ctx.datasetProbe.profileEnabled.map((d) => d.name).join(", ")}.`
        : `- No profile-enabled datasets found among ${ctx.datasetProbe.datasetCount} dataset(s) listed.`,
    );
  } else {
    lines.push(`- Could not determine which datasets are profile-enabled: ${ctx.datasetProbe.error}`);
  }

  return lines.join("\n");
}
