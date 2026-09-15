/**
 * Agent 2's outside world, behind one seam.
 *
 * Two things this agent wants from outside itself: grounding (so its questions
 * are informed rather than generic), and somewhere to post the redraft.
 *
 * Both are **pluggable and optional**. If a tool is not reachable, the agent
 * still does its real work and reports what it would have done. That matters
 * right now for two reasons:
 *
 *   - `search_knowledge_base` does not exist. The Adobe MCP server exposes
 *     `search_adobe_knowledge`. Agent 1 asks for the wrong name, catches the
 *     error, and still returns `completed` - which is why every run's grounding
 *     has silently failed. This agent uses the name that exists.
 *
 *   - The Workfront routes 404 at the current gateway, so `wf_comments_create`
 *     cannot be called yet. Rather than block B2 on that, the post goes through
 *     an adapter that records its intent. When a Workfront MCP becomes
 *     reachable - Chauncey's, or Adobe's official one - it starts posting for
 *     real with nothing here rewritten.
 *
 * Tool NAMES are constants in one place, so swapping a provider is an edit
 * here rather than a hunt through the agent.
 */

import { callMcpTool } from "@/lib/mcp-client";

/** The knowledge tool that actually exists on the Adobe MCP server. */
export const GROUNDING_TOOL = "search_adobe_knowledge";

/** Workfront comment creation. Present in chaunceyplum/mcp; not yet deployed. */
export const COMMENT_TOOL = "wf_comments_create";

export type GroundingHit = { title?: string; snippet?: string; url?: string };

/**
 * Ask the knowledge base about the fields we are going to question the marketer
 * on, so the redraft can be specific rather than generic.
 *
 * Returns [] on any failure. Grounding makes a better question; it is not worth
 * failing a run over — but the caller is told, so the failure is never silent.
 */
export async function ground(
  query: string,
): Promise<{ hits: GroundingHit[]; error: string | null }> {
  try {
    const result = await callMcpTool<{ results?: GroundingHit[] } | GroundingHit[]>(
      "review",
      GROUNDING_TOOL,
      { query, agent: "adobe", top_k: 3 },
    );
    const hits = Array.isArray(result) ? result : (result?.results ?? []);
    return { hits, error: null };
  } catch (err) {
    // Reported, never swallowed. The whole reason this pipeline has looked
    // healthy while failing is that a caught error became part of a payload
    // that still said "completed".
    return { hits: [], error: (err as Error).message };
  }
}

export type PostOutcome =
  | { posted: true; via: string }
  | { posted: false; reason: string; wouldHavePosted: { objCode: string; objId: string; text: string } };

/**
 * Post the redraft back to the Workfront object the rejection came from.
 *
 * When the tool is unreachable this returns what it *would* have posted. That
 * is deliberately part of the agent's output: a reviewer can see the redraft
 * even while the write path is down, and nothing has to be rebuilt when it
 * comes up.
 */
export async function postRedraft(args: {
  objCode?: string;
  objId?: string;
  text: string;
}): Promise<PostOutcome> {
  const { objCode, objId, text } = args;

  if (!objCode || !objId) {
    return {
      posted: false,
      reason: "the rejection did not identify a Workfront object to reply to",
      wouldHavePosted: { objCode: objCode ?? "OPTASK", objId: objId ?? "(unknown)", text },
    };
  }

  try {
    await callMcpTool("review", COMMENT_TOOL, { obj_code: objCode, obj_id: objId, text });
    return { posted: true, via: COMMENT_TOOL };
  } catch (err) {
    return {
      posted: false,
      reason: (err as Error).message,
      wouldHavePosted: { objCode, objId, text },
    };
  }
}
