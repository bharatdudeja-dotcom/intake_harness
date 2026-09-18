import { callMcpTool } from "@/lib/mcp-client";
import { workfrontToolset } from "@/lib/workfront-tools";
import { PIPELINE } from "@/lib/pipeline/registry";
import type { AgentName } from "@/lib/pipeline/types";

/**
 * Every comment this pipeline writes to Workfront, in one place.
 *
 * TWO THINGS WERE WRONG WITH THE COMMENTS WE WERE LEAVING
 *
 * 1. THEY WERE NOT PLAIN TEXT. A comment went in as
 *    "<p><strong>Correction to Agent 1's intake capture:</strong>..." and
 *    Workfront's comment stream rendered it exactly like that - the tags
 *    visible, on one line, in the middle of a human conversation. The stream is
 *    not an HTML field. Nothing had said so, so an assistant reasonably assumed
 *    the formatting it uses everywhere else would work here.
 *
 * 2. THEY DID NOT SAY WHO WROTE THEM. The comment showed the name of whoever's
 *    Adobe token the server holds - "Bharat Dudeja" - for a comment no human
 *    typed. That is worse than anonymous. A reviewer reads it as a colleague's
 *    note and replies to a person who never wrote it, and the audit trail says
 *    a named employee asserted something an agent asserted. Until per-user auth
 *    lands, the token identity is the SERVER's, not the author's, so the author
 *    has to be stated in the body.
 *
 * So: the agent's own label on the first line, plain text underneath, and a
 * footer that says a machine wrote it.
 */

/** The agent's name as the process map and the UI both write it. */
export function agentLabel(agent: AgentName | string): string {
  const def = PIPELINE.find((a) => a.name === agent);
  return def?.label || agent;
}

/**
 * HTML in, readable text out.
 *
 * Callers should send text. This is here because one of them did not, and the
 * result was tags on a stakeholder's screen. Block tags become line breaks so
 * the structure the author intended survives; everything else is dropped.
 */
export function plainText(input: string): string {
  return String(input)
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Strip our own step numbers.
 *
 * "2.1", "1.5", "2.7" are coordinates on an internal process map. They mean
 * nothing to a marketer reading their own request, and printing them makes the
 * pipeline's scaffolding the stakeholder's problem. Say what happened instead.
 */
export function withoutStepNumbers(text: string): string {
  return text
    .replace(/\s*\((?:at\s+)?(?:step|phase)\s+\d+\.\d+[a-z]?\)/gi, "")
    .replace(/\s*(?:\b(?:at|in|during)\s+)?\bstep\s+\d+\.\d+[a-z]?\b/gi, "")
    .replace(/\s+([.,;])/g, "$1");
}

/**
 * The body as it should appear in the stream: who, what, and that it is a bot.
 */
export function signed(agent: AgentName | string, body: string): string {
  const text = withoutStepNumbers(plainText(body));
  return [
    `${agentLabel(agent)} (automated)`,
    "",
    text,
    "",
    "Posted by the CX intake pipeline. No one typed this by hand - if it is wrong, " +
      "reply here and it goes back to the agent as rework rather than being corrected in place.",
  ].join("\n");
}

/**
 * Write a comment to a Workfront object, attributed to the agent writing it.
 *
 * Throws on failure, deliberately. A comment is usually the fallback for
 * something a stronger write could not do, and a fallback that fails silently
 * leaves a record nobody can trace back to the request.
 */
export async function postComment(
  agent: AgentName,
  objCode: string,
  objId: string,
  body: string,
): Promise<void> {
  const set = workfrontToolset();
  await callMcpTool(agent, set.createComment, {
    objID: objId,
    objCode,
    message: signed(agent, body),
  });
}
