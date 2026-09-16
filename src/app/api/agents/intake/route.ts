import { NextRequest, NextResponse } from "next/server";
import { callMcpTool } from "@/lib/mcp-client";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { parseBrief, nextQuestions, type ParsedIntake } from "@/lib/agents/intake/parse";
import { createIntakeRequest, toWorkfrontPayload } from "@/lib/agents/intake/workfront";

/**
 * Agent 1 - Intake. B1, at step 1.2a.
 *
 * "The agent cannot build the intake from the prompt, so it bounces back to the
 * marketer. The loop can run many times, and each round trip is unbounded...
 * Questions must be grounded in AEP schemas and the FAC view, so the agent asks
 * for the two things actually missing rather than re-asking the whole brief.
 * Track loop count as a health metric - more than two rounds means the agent
 * failed, not the marketer."
 *
 * Three things follow from that, and they are the whole design:
 *
 * 1. ASK FOR TWO THINGS. parse.ts computes which required fields the brief does
 *    not answer; nextQuestions takes the first two. Asking for eleven is what
 *    makes a loop unbounded, so the cap is the feature, not a limitation.
 *
 * 2. COUNT THE LOOPS, AND OWN THE FAILURE. loopCount arrives on the request and
 *    leaves in metadata. Past two rounds this agent reports its OWN failure
 *    rather than asking again: the doc is explicit that at that point the agent
 *    has failed, and an agent that blames the marketer indefinitely is the bug
 *    being fixed.
 *
 * 3. GROUND THE QUESTIONS in what AEP actually holds, and say so when the
 *    lookup failed rather than presenting an ungrounded question as grounded.
 *
 * WHAT IT WILL NOT DO: invent a value. A field the brief does not state is
 * either inferred AND FLAGGED as inferred, or asked about. Filling the form in
 * to make a run go green is precisely the failure this system exists to catch.
 */

/** Past this the doc says the agent has failed. A verdict, not a retry budget. */
const LOOP_LIMIT = 2;

function readLoopCount(body: AgentRequest<{ loopCount?: number }>): number {
  const n = Number(body.input?.loopCount);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Ground the questions in what the platform can actually segment on.
 *
 * "Questions must be grounded in AEP schemas and the FAC view." A question like
 * "which line of business?" is answerable in the abstract; the useful version
 * knows what fields exist. This attaches that context and reports honestly when
 * it could not be fetched - a question labelled grounded when the lookup failed
 * is worse than an openly ungrounded one.
 */
async function groundQuestions(missingLabels: string[]) {
  if (!missingLabels.length) {
    return { grounded: false, reason: "nothing missing to ground", hits: null as unknown };
  }
  try {
    const hits = await callMcpTool("intake", "search_adobe_knowledge", {
      query: `Adobe Experience Platform profile attributes and schema fields for ${missingLabels.join(", ")}`,
      agent: "adobe",
      top_k: 3,
    });
    return { grounded: true, reason: null, hits };
  } catch (err) {
    return { grounded: false, reason: (err as Error).message, hits: null as unknown };
  }
}

/** What a reviewer needs, without the raw hit payload drowning it. */
function summarise(parsed: ParsedIntake) {
  return {
    fields: parsed.fields,
    stated: parsed.extracted.filter((f) => f.from === "stated").map((f) => f.key),
    inferred: parsed.inferred.map((f) => ({
      key: f.key,
      value: f.value,
      from: f.from,
      evidence: f.evidence ?? null,
    })),
    missing: parsed.missing.map((f) => f.key),
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<{
    brief?: string;
    loopCount?: number;
    fields?: Record<string, unknown>;
  }>;

  const brief = String(body.input?.brief || "").trim();
  const loopCount = readLoopCount(body);

  if (!brief) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message: "No brief was supplied, so there is nothing to read.",
      metadata: { loopCount },
    });
  }

  // A rework loop carries the fields already confirmed, so the marketer is
  // never asked twice for the same thing.
  const parsed = parseBrief(brief, body.input?.fields || {});
  const questions = nextQuestions(parsed, 2);
  const grounding = await groundQuestions(questions.map((q) => q.label));

  // B1's verdict, owned by the agent instead of looped onto the marketer.
  if (loopCount >= LOOP_LIMIT && questions.length) {
    return NextResponse.json<AgentResponse>({
      status: "failed",
      message:
        `Still missing ${questions.map((q) => q.label).join(" and ")} after ${loopCount} rounds. ` +
        `Past ${LOOP_LIMIT} rounds this is the agent failing to read the brief, not the marketer ` +
        `failing to write it, so it escalates rather than asking a third time.`,
      output: {
        brief,
        ...summarise(parsed),
        loopCount,
        grounding: { grounded: grounding.grounded, reason: grounding.reason },
      },
      metadata: { loopCount, loopLimitReached: true },
    });
  }

  // Something required is genuinely absent. Ask for it, and only it.
  if (questions.length) {
    return NextResponse.json<AgentResponse>({
      status: "needs_input",
      message: questions.map((q) => q.ask || `What is the ${q.label.toLowerCase()}?`).join(" "),
      output: {
        brief,
        ...summarise(parsed),
        // The next round arrives with this incremented and the fields so far,
        // so the marketer answers two questions instead of the whole form.
        loopCount: loopCount + 1,
        questions: questions.map((q) => ({
          key: q.key,
          label: q.label,
          ask: q.ask ?? null,
          options: q.options ?? null,
          optionsPartial: q.optionsPartial ?? false,
        })),
        grounding,
      },
      metadata: { loopCount: loopCount + 1, askedFor: questions.map((q) => q.key) },
    });
  }

  /*
   * Complete enough to build. Create the Workfront request.
   *
   * createIntakeRequest reports what it WOULD have created when the call fails,
   * which is the honest outcome while nobody has signed in to the official MCP:
   * Workfront writes need OAuth, and 44 of its 94 tools are writes a Workfront
   * admin must enable per tenant. A visible dry run beats a run that reads as a
   * success and wrote nothing.
   */
  const outcome = await createIntakeRequest({ intake: parsed.fields, brief });

  return NextResponse.json<AgentResponse>({
    status: "completed",
    output: {
      brief,
      ...summarise(parsed),
      loopCount,
      workfront: outcome,
      grounding,
      // Named plainly so Agent 2 reads them rather than re-deriving them.
      intakeFields: parsed.fields,
      workfrontPayload: toWorkfrontPayload(parsed.fields, brief),
    },
    metadata: {
      loopCount,
      inferredCount: parsed.inferred.length,
      // A run where the agent guessed four fields is not the same as one where
      // the marketer stated them. The human at 2.5 has to know which they are
      // looking at, and that is the only reason 2.5 stays a human step.
      needsConfirmation: parsed.inferred.length > 0,
      workfrontCreated: outcome.created,
    },
  });
}
