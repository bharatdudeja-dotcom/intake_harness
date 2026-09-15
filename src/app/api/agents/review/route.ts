import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { triage } from "@/lib/agents/review/triage";
import { ground, postRedraft } from "@/lib/agents/review/tools";

/**
 * Agent 2 — Review / Triage.
 *
 * B2, which David Ross calls "the largest unclaimed gap in the map": the review
 * queue rejects an issue, it goes back as rework, and *nothing reads the
 * rejection reason* — so the loop resumes at 1.3 with the marketer guessing.
 *
 * This agent reads it. It maps the rejection to the specific field at fault,
 * asks only for that field, and returns `needs_input` so the pipeline pauses
 * rather than carrying a broken intake forward.
 *
 * Two rules it keeps that the stub did not:
 *
 *   1. **It does not report success when something failed.** A grounding
 *      failure is surfaced in `metadata`, and an unrecoverable error returns
 *      `failed` — which is what finally allows Agent 4 to be invoked at all.
 *
 *   2. **It never re-asks the whole brief.** B1's health metric is loop count;
 *      more than two rounds means the agent failed, not the marketer. Asking
 *      for two named fields is how you stay under that.
 *
 * The contract in lib/pipeline/types.ts is unchanged.
 */

type ReviewInput = {
  /** The structured intake so far, as Agent 1 left it. */
  intake?: Record<string, unknown>;
  /** The review queue's rejection, when this is a rework loop. */
  rejectionReason?: string;
  /** Where to post the redraft back to, when known. */
  workfront?: { objCode?: string; objId?: string };
  /** Rounds so far, for B1. */
  loopCount?: number;
  /** Anything else Agent 1 passed through. */
  [key: string]: unknown;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AgentRequest<ReviewInput>;
    const input = body.input ?? {};

    // Agent 1 does not yet emit a structured intake, so fall back to reading its
    // passthrough. Defensive rather than assuming a shape that is still a stub.
    const intake = (input.intake ?? input) as Record<string, unknown>;
    const rejectionReason =
      typeof input.rejectionReason === "string" ? input.rejectionReason : undefined;

    const result = triage({ intake, rejectionReason });

    // Nothing wrong: approve, and pass the intake on untouched.
    if (result.decision === "completed" && result.faults.length === 0) {
      const response: AgentResponse = {
        status: "completed",
        output: { ...input, reviewed: true, triage: { decision: "completed", faults: [] } },
        metadata: { faultCount: 0, loopCount: Number(input.loopCount ?? 0) },
      };
      return NextResponse.json(response);
    }

    // Ground the questions so they are specific. Optional — and its failure is
    // reported rather than folded into the output as though it had worked.
    const grounding = await ground(
      `Comcast Xfinity campaign intake: ${result.faults.map((f) => f.field.label).join(", ")}`,
    );

    const post = await postRedraft({
      objCode: input.workfront?.objCode,
      objId: input.workfront?.objId,
      text: result.redraft,
    });

    const faults = result.faults.map((f) => ({
      field: f.field.key,
      label: f.field.label,
      kind: f.kind,
      because: f.because,
      ask: f.field.ask,
    }));

    const response: AgentResponse = {
      status: result.decision,
      output: {
        ...input,
        reviewed: true,
        triage: { decision: result.decision, faults },
        redraft: result.redraft,
        redraftPosted: post.posted,
        // Kept in the output deliberately: a reviewer can read the redraft even
        // while the Workfront write path is down.
        redraftPending: post.posted ? undefined : post.wouldHavePosted,
      },
      message: result.message,
      metadata: {
        // B1's metric. Counting rounds is the only way to know whether the agent
        // is failing the marketer.
        loopCount: Number(input.loopCount ?? 0) + 1,
        faultCount: faults.length,
        blockingFields: result.faults
          .filter((f) => f.kind !== "ambiguous")
          .map((f) => f.field.key),
        groundingUsed: grounding.hits.length > 0,
        // Said out loud. A tool that failed is not a tool that worked.
        groundingError: grounding.error ?? undefined,
        redraftPost: post.posted ? { via: post.via } : { failed: post.reason },
      },
    };

    return NextResponse.json(response);
  } catch (err) {
    // A real failure, reported as one. The orchestrator invokes Agent 4 on
    // "failed" and on nothing else, so swallowing this is precisely what has
    // kept escalation from ever running.
    const response: AgentResponse = {
      status: "failed",
      message: `Review/triage could not complete: ${(err as Error).message}`,
    };
    return NextResponse.json(response);
  }
}
