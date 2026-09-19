/**
 * Grounding Review's "can this audience actually be expressed as a
 * segment" reasoning in whatever PQL (Profile Query Language) documentation
 * the knowledge base actually has - never assumed or invented syntax.
 *
 * WHAT'S ACTUALLY INDEXED - checked two ways, 19 Sep 2026:
 *
 * 1. Eight different semantic-search phrasings against search_adobe_knowledge
 *    (including operator/function names like "existsMulti", and a dedicated
 *    "pql" topic filter) all surfaced the same one or two documents -
 *    Segmentation Service and Query Service OVERVIEWS.
 * 2. That could still have been a search-quality problem rather than a
 *    content problem, so it was checked exhaustively instead of guessed at
 *    again: a direct SQL query against the RAG corpus itself (query_rag_db,
 *    an admin/diagnostic tool - not something this app calls, or should)
 *    for "PQL", "profile query language", "existsMulti", "segment
 *    expression", "pql/text", and every source_url containing "pql" or
 *    "query-service", across ALL FOUR indexed domains (adobe: 335 chunks,
 *    aws_sa: 5676, data_eng: 5949, martech: 4146 - 16,106 chunks total).
 *    Five documents matched, total, all under the "adobe" domain - the same
 *    two Segmentation/Query Service overview pages, one incidental
 *    authentication-guide hit, and the Query Service API reference (REST
 *    endpoints, not PQL syntax). Nothing under data_eng - the domain most
 *    likely to carry query-language reference material - mentions PQL at
 *    all.
 *
 * So this is not a matter of asking the right question - the corpus does
 * not contain PQL's operators, functions, or expression grammar under any
 * phrasing or domain. It confirms PQL is "the language segment definitions
 * are ultimately defined using" and links OUT to Adobe's own PQL reference
 * page, and this grounds Review in exactly that - general segmentation/PQL
 * context with a citation a human can click through - rather than
 * pretending to "deeply understand" syntax this knowledge base has never
 * actually been asked to teach it. Same conclusive-vs-inconclusive
 * discipline as aep.ts's SchemaProbe: if the search comes back empty, that
 * is reported as exactly that.
 *
 * If deeper PQL understanding is genuinely needed, real PQL reference
 * material needs to be INGESTED into the knowledge base - that's an
 * ingestion-pipeline/content problem outside this repo, not a query one. No
 * amount of query rephrasing here will surface syntax that was never
 * loaded, and this has now been checked thoroughly enough that re-trying
 * different search phrasings isn't worth doing again.
 *
 * ../../../../docs/pql-reference.md now holds a full copy of Adobe's actual
 * PQL function reference (all 12 categories, pulled directly from
 * experienceleague.adobe.com, 19 Sep 2026) - the exact material this module
 * just proved is missing from the knowledge base. It is NOT wired into
 * groundPqlGuidance below; this module still only reports what the
 * knowledge base itself actually knows, honestly, rather than silently
 * blending in an out-of-band source the marketer/reviewer can't see cited.
 * If Agent 2 should actually use it, that's a deliberate follow-up (read
 * the file, cite it explicitly in PqlGuidance), not a quiet addition here.
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
