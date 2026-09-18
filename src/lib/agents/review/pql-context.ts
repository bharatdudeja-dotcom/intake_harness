/**
 * Grounding Review's "can this audience actually be expressed as a
 * segment" reasoning in whatever PQL (Profile Query Language) documentation
 * the knowledge base actually has - never assumed or invented syntax.
 *
 * WHAT'S ACTUALLY INDEXED, verified 19 Sep 2026 against the live knowledge
 * base: eight different PQL-related phrasings (including operator/function
 * names like "existsMulti", and a dedicated "pql" topic filter, which
 * returned nothing) all surfaced the same one or two documents -
 * Segmentation Service and Query Service OVERVIEWS. They confirm PQL is
 * "the language segment definitions are ultimately defined using" and link
 * OUT to Adobe's own PQL reference page, but the corpus itself does not
 * contain PQL's actual operators, functions, or expression grammar.
 *
 * So this grounds Review in exactly what's really there - general
 * segmentation/PQL context, with a citation a human can click through to
 * Adobe's real reference - rather than pretending to "deeply understand"
 * syntax this knowledge base has never actually been asked to teach it.
 * Same conclusive-vs-inconclusive discipline as aep.ts's SchemaProbe: if
 * the search comes back empty, that is reported as exactly that.
 *
 * If deeper PQL understanding is genuinely needed, the knowledge base's
 * corpus needs real PQL reference material indexed - no amount of query
 * rephrasing here will surface syntax that was never loaded.
 */

import { callMcpTool } from "@/lib/mcp-client";

export type PqlHit = { title: string; url: string; excerpt: string };

export type PqlGuidance = {
  grounded: boolean;
  reason: string | null;
  hits: PqlHit[];
};

/** Ask the knowledge base what it actually knows about expressing THIS audience's criteria in PQL. */
export async function groundPqlGuidance(criteria: string): Promise<PqlGuidance> {
  const trimmed = criteria.trim();
  if (!trimmed) {
    return { grounded: false, reason: "no audience criteria to ground", hits: [] };
  }
  try {
    const result = await callMcpTool<{ results?: Array<{ title: string; url: string; content: string }> }>(
      "review",
      "search_adobe_knowledge",
      { query: `Profile Query Language PQL segment definition for ${trimmed}`, topic: "aep" },
    );
    const hits: PqlHit[] = (result?.results ?? []).slice(0, 3).map((r) => ({
      title: r.title,
      url: r.url,
      excerpt: r.content.slice(0, 400),
    }));
    return {
      grounded: hits.length > 0,
      reason: hits.length ? null : "search_adobe_knowledge returned nothing for this audience's criteria",
      hits,
    };
  } catch (err) {
    return { grounded: false, reason: (err as Error).message, hits: [] };
  }
}

/** The Workfront-comment/note line for whatever PQL grounding was found. */
export function formatPqlGuidanceNote(guidance: PqlGuidance): string {
  if (!guidance.hits.length) {
    return `- Could not ground this in PQL documentation: ${guidance.reason}`;
  }
  return (
    `- PQL reference for this audience: ${guidance.hits.map((h) => `"${h.title}" (${h.url})`).join(", ")}. ` +
    "Overview-level as indexed today - confirms PQL is the language segment definitions are built in, " +
    "not its operators/syntax. Confirm exact PQL expressions against Adobe's own PQL reference before building."
  );
}
