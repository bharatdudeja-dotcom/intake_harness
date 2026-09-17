import { NextRequest, NextResponse } from "next/server";
import { decideGate, getRun } from "@/lib/pipeline/orchestrator";

/**
 * The decision at a gate - 1.5 "Approved?" above all.
 *
 * WHY THIS IS AN ENDPOINT AND NOT A FIELD ON THE RUN
 *
 * "Who owns the review queue decision at 1.5, and is the rejection reason
 * captured anywhere structured today? B2 depends entirely on the answer."
 *
 * Today the answer is nowhere: the approval happens in Workfront's own
 * Approvals tab, as a click by one of the named approvers, and nothing
 * downstream learns why a rejection happened. This endpoint is where that
 * becomes structured. A decision here carries a name and, on a rejection, the
 * reason - and the reason is handed straight to Agent 2's triage rather than
 * left for it to find in a comment stream.
 *
 * IT DOES NOT APPROVE ANYTHING IN WORKFRONT
 *
 * Worth being exact, because it would be easy to read this as a Workfront
 * write. Adobe's official MCP exposes tools to add, remove and replace who sits
 * on an approval stage, and none to submit an approve/reject decision AS a
 * person - correctly, since an approval attributable to a service account is
 * not an approval. So the human clicks Approve in Workfront, and this records
 * that they did and lets the process move. `evidence` is where a caller says
 * how they know, e.g. { source: "workfront_approvals_tab", approver: "..." }.
 *
 * POST /api/runs/<runId>/gate
 *   { "decision": "approved" | "rejected",
 *     "decided_by": "a named human",
 *     "reason": "...",            // required in practice on a rejection
 *     "gate_id": "approval_1_5",  // optional; defaults to the gate it waits at
 *     "evidence": { ... } }
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const body = await req.json().catch(() => null);

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const decision = String(body.decision || "").toLowerCase();
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json(
      { error: 'decision must be "approved" or "rejected"' },
      { status: 400 },
    );
  }

  /*
   * A decision needs a name on it.
   *
   * B4 and B7 are both about things sitting unowned, and an unattributed
   * approval is that failure in miniature: when the audience turns out wrong at
   * 3.4, "who approved this brief" has to have an answer. Defaulting this to
   * "system" would make the field present and worthless.
   */
  const decidedBy = String(body.decided_by || body.decidedBy || "").trim();
  if (!decidedBy) {
    return NextResponse.json(
      { error: "decided_by is required - an approval has to be attributable to a named person" },
      { status: 400 },
    );
  }

  const reason = body.reason == null ? null : String(body.reason).trim() || null;

  /*
   * A rejection without a reason is the bug, not an input error.
   *
   * B2: "the review queue rejects the issue and it goes back to the marketer as
   * rework. Nothing reads the rejection reason." An unexplained rejection sends
   * the marketer back to a form with eleven fields to guess at, which is the
   * unbounded loop this whole agent exists to close. So it is refused here.
   */
  if (decision === "rejected" && !reason) {
    return NextResponse.json(
      {
        error:
          "A rejection must carry a reason. Without one the marketer is sent back to guess, " +
          "which is B2 - the loop this pipeline exists to close. Say what is wrong and " +
          "Agent 2 will translate it into the specific field to change.",
      },
      { status: 400 },
    );
  }

  try {
    const { run, decision: recorded } = await decideGate(
      runId,
      {
        gateId: body.gate_id || body.gateId,
        decision,
        decidedBy,
        reason,
        evidence: typeof body.evidence === "object" && body.evidence ? body.evidence : {},
      },
      req.nextUrl.origin,
    );

    // Return the run as it now stands, including whatever ran as a result of
    // the gate opening - the caller asked a question about the process, and
    // "what happened next" is the answer to it.
    const full = await getRun(runId);
    return NextResponse.json({ decision: recorded, run, taskRuns: full?.taskRuns ?? [], gates: full?.gates ?? [] });
  } catch (err) {
    const message = (err as Error).message;
    const status = /No run |not waiting at a gate/.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
