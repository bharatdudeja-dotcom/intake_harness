import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { parseBrief, nextQuestions } from "@/lib/agents/intake/parse";
import { createIntakeRequest } from "@/lib/agents/intake/workfront";
import { callMcpTool } from "@/lib/mcp-client";

/**
 * Agent 1 — Intake.
 *
 * B1 / step 1.2a: *"The agent cannot build the intake from the prompt, so it
 * bounces back to the marketer. The loop can run many times, and each round
 * trip is unbounded."*
 *
 * Three rules, all of them from David's map:
 *
 *   1. **Ask for the two things actually missing**, not the whole brief.
 *      Re-asking everything is how loop count passes two, and past two the
 *      agent failed, not the marketer.
 *   2. **Never fill a field silently.** Every value is marked stated, derived
 *      or inferred. A brief that looks complete because the agent guessed
 *      clears intake and then fails at creative review a week later.
 *   3. **Report failure as failure.** A tool error returns `failed`, which is
 *      the only status that causes the orchestrator to invoke Agent 4 at all.
 *      The previous version caught its grounding error, wrote it into the
 *      payload, and still returned `completed` — which is why every run has
 *      silently failed its grounding since the beginning.
 *
 * The contract in lib/pipeline/types.ts is unchanged.
 */

type IntakeInput = {
  brief?: string;
  /** Answers to the questions a previous round asked. */
  answers?: Record<string, unknown>;
  /** Rounds so far. B1's health metric. */
  loopCount?: number;
  [key: string]: unknown;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AgentRequest<IntakeInput>;
    const input = body.input ?? {};
    const brief = String(input.brief ?? "").trim();
    const loopCount = Number(input.loopCount ?? 0);

    if (!brief) {
      return NextResponse.json({
        status: "needs_input",
        message: "No brief was provided. Tell me in a sentence or two what campaign you need.",
        metadata: { loopCount: loopCount + 1, faultCount: 1 },
      } satisfies AgentResponse);
    }

    // Answers from a previous round count as stated, not guessed.
    const parsed = parseBrief(brief, (input.answers as Record<string, unknown>) ?? {});

    // Grounding makes the questions specific. Optional, and its failure is
    // REPORTED rather than folded into the output as though it had worked.
    let groundingError: string | null = null;
    let groundingUsed = false;
    try {
      const hits = await callMcpTool("intake", "search_adobe_knowledge", {
        query: brief,
        agent: "adobe",
        top_k: 3,
      });
      groundingUsed = Array.isArray(hits) ? hits.length > 0 : Boolean(hits);
    } catch (err) {
      groundingError = (err as Error).message;
    }

    const questions = nextQuestions(parsed, 2);

    // Still missing something required: ask for exactly those, and stop. Do not
    // create a Workfront request from an intake we know is incomplete.
    if (questions.length) {
      return NextResponse.json({
        status: "needs_input",
        message:
          `I have ${parsed.extracted.length} of the brief's fields. ` +
          `Two things I still need: ${questions.map((q) => q.label).join(" and ")}.`,
        output: {
          ...input,
          intake: parsed.fields,
          extracted: parsed.extracted,
          questions: questions.map((q) => ({ field: q.key, label: q.label, ask: q.ask })),
          inferred: parsed.inferred,
        },
        metadata: {
          loopCount: loopCount + 1,
          fieldsFound: parsed.extracted.length,
          missingCount: parsed.missing.length,
          inferredCount: parsed.inferred.length,
          groundingUsed,
          groundingError: groundingError ?? undefined,
          // Above two rounds this is the agent's failure, not the marketer's.
          b1Breach: loopCount + 1 > 2,
        },
      } satisfies AgentResponse);
    }

    // Complete enough to submit. Create the Workfront request — pluggable, so
    // an unreachable Workfront records what it would have created rather than
    // failing the run.
    const wf = await createIntakeRequest({ intake: parsed.fields, brief });

    return NextResponse.json({
      status: "completed",
      output: {
        ...input,
        intake: parsed.fields,
        extracted: parsed.extracted,
        inferred: parsed.inferred,
        // Carried forward so Agent 2 can post its redraft against the right object.
        workfront: wf.created
          ? { objCode: wf.objCode, objId: wf.objId, customFieldsSet: wf.customFieldsSet }
          : undefined,
        workfrontPending: wf.created ? undefined : wf.wouldHaveCreated,
      },
      message: parsed.inferred.length
        ? `Built the intake. ${parsed.inferred.length} field${parsed.inferred.length === 1 ? " was" : "s were"} inferred and ${parsed.inferred.length === 1 ? "needs" : "need"} your confirmation: ${parsed.inferred.map((i) => i.label).join(", ")}.`
        : "Built the intake from the brief. Every field was stated.",
      metadata: {
        loopCount,
        fieldsFound: parsed.extracted.length,
        inferredCount: parsed.inferred.length,
        groundingUsed,
        groundingError: groundingError ?? undefined,
        workfrontCreated: wf.created,
        workfrontBlocked: wf.created ? undefined : wf.reason,
      },
    } satisfies AgentResponse);
  } catch (err) {
    // A real failure, reported as one, so escalation can finally fire.
    return NextResponse.json({
      status: "failed",
      message: `Intake could not complete: ${(err as Error).message}`,
    } satisfies AgentResponse);
  }
}
