import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { callMcpTool } from "@/lib/mcp-client";
import { triageRejection, type TriageResult } from "@/lib/agents/review/triage";

/**
 * Agent 2 - Review / Triage. B2, at step 1.5a.
 *
 * "The review queue rejects the issue and it goes back to the marketer as
 * rework. Nothing reads the rejection reason, and the loop resumes at 1.3 with
 * the marketer guessing. The largest unclaimed gap in the map. A review-triage
 * agent should parse the rejection, translate it into the specific missing field
 * or wrong data source, and redraft 1.3 automatically for the marketer to
 * confirm."
 *
 * TWO JOBS, AND THE SECOND IS THE ONE NOBODY DOES
 *
 * 1. When there is no rejection, this is a pre-flight: check the intake against
 *    the form before the review queue sees it, so an avoidable rejection never
 *    costs a queue cycle. A rejection prevented is worth more than one
 *    translated, because the queue's turnaround is the thing we cannot shorten.
 *
 * 2. When there IS a rejection, translate it: which field, what value, or which
 *    data source - and hand back a redraft the marketer confirms rather than
 *    composes. That is the gap.
 *
 * WHERE THE REJECTION COMES FROM
 *
 * Workfront carries it as a comment or an update on the issue, so this reads it
 * with the comment tools when it has an object id and a signed-in connector.
 * That call is expected to fail today - Workfront needs OAuth and nobody has
 * signed in - and a failure is REPORTED, not swallowed. Reporting it is the
 * whole point: an agent that treats "I could not read the rejection" as "there
 * was no rejection" reproduces the bug it was built to fix.
 */

type ReviewInput = {
  brief?: string;
  intakeFields?: Record<string, string>;
  fields?: Record<string, string>;
  /** A rejection passed in directly, e.g. on a rework loop. */
  rejectionReason?: string;
  /** The Workfront issue, when Agent 1 managed to create one. */
  workfront?: { created?: boolean; objId?: string; objCode?: string };
  loopCount?: number;
};

/**
 * Fetch the rejection from Workfront, if we can.
 *
 * @returns the reason, plus why we do or do not have one. The `error` is
 *   surfaced to the caller rather than collapsed into "no rejection" - those
 *   are different facts and conflating them is the failure mode this pipeline
 *   already has too much of.
 */
async function fetchRejection(objId: string | null) {
  if (!objId) {
    return { reason: null as string | null, source: "none", error: null as string | null };
  }
  try {
    const result = await callMcpTool<unknown>("review", "comment-stream_query_comments", {
      objID: objId,
      objCode: "OPTASK",
    });
    // Shapes differ between connectors, so read defensively and say when the
    // response was not something we recognise.
    const rows = (result as { comments?: unknown[]; data?: unknown[] } | null);
    const list = (rows?.comments || rows?.data || (Array.isArray(result) ? result : [])) as Array<Record<string, unknown>>;
    const rejection = list
      .map((c) => String(c.message || c.text || c.note || ""))
      .filter((t) => /reject|return|more info|insufficient|resubmit/i.test(t))
      .pop();
    return {
      reason: rejection || null,
      source: "workfront_comments",
      error: list.length ? null : "the comment stream returned nothing we recognised as comments",
    };
  } catch (err) {
    return { reason: null as string | null, source: "workfront_comments", error: (err as Error).message };
  }
}

/** Pre-flight: what the review queue would reject this for. */
function preflight(fields: Record<string, string>): TriageResult {
  // Reuse the same translator, fed a synthetic reason built from what is
  // actually absent. One code path means the pre-flight and the post-rejection
  // paths cannot drift apart in what they consider a problem.
  const { requiredFields } = require("@/lib/agents/shared/campaign-brief") as typeof import("@/lib/agents/shared/campaign-brief");
  const absent = requiredFields().filter((f) => !String(fields[f.key] || "").trim());
  if (!absent.length) {
    return { findings: [], redraft: { ...fields }, changed: [], needsHuman: false, summary: "Nothing the review queue should reject this for." };
  }
  const reason = absent.map((f) => `missing ${f.label}`).join("; ");
  return triageRejection(reason, fields);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<ReviewInput>;
  const input = body.input || {};
  const fields = input.intakeFields || input.fields || {};
  const loopCount = Number(input.loopCount) || 0;

  const objId = input.workfront?.created ? String(input.workfront.objId || "") : "";
  const fetched = await fetchRejection(objId || null);
  const reason = String(input.rejectionReason || fetched.reason || "").trim();

  // --- No rejection to read: act as the pre-flight ---------------------------
  if (!reason) {
    const pre = preflight(fields);
    const clean = pre.findings.length === 0;

    return NextResponse.json<AgentResponse>({
      status: clean ? "completed" : "needs_input",
      message: clean
        ? undefined
        : `Before this reaches the review queue: ${pre.findings.map((f) => f.ask).join(" ")}`,
      output: {
        ...input,
        reviewed: true,
        mode: "preflight",
        rejection: {
          // Said explicitly. "We looked and there was none" and "we could not
          // look" must never read the same way.
          present: false,
          checked: fetched.source,
          couldNotRead: fetched.error,
        },
        triage: pre,
        intakeFields: pre.redraft,
        loopCount,
      },
      metadata: {
        mode: "preflight",
        findings: pre.findings.length,
        rejectionReadable: fetched.error === null,
        loopCount,
      },
    });
  }

  // --- There is a rejection: translate it -----------------------------------
  const triage = triageRejection(reason, fields);

  if (triage.needsHuman) {
    return NextResponse.json<AgentResponse>({
      status: "needs_input",
      message: triage.findings[0].ask,
      output: {
        ...input,
        reviewed: true,
        mode: "triage",
        rejection: { present: true, reason, checked: fetched.source, couldNotRead: fetched.error },
        triage,
        intakeFields: triage.redraft,
        loopCount: loopCount + 1,
      },
      metadata: { mode: "triage", needsHuman: true, loopCount: loopCount + 1 },
    });
  }

  /*
   * A redraft goes back for confirmation, never straight through.
   *
   * The doc keeps 2.5 as a human step deliberately - "keep the human decision;
   * remove the surprise". Auto-resubmitting a redraft the marketer never saw
   * would remove the decision instead of the surprise, and the first time a
   * proposed value was wrong it would be wrong in Workfront.
   */
  return NextResponse.json<AgentResponse>({
    status: "needs_input",
    message:
      `${triage.summary}. ` +
      triage.findings.map((f) => f.ask).join(" ") +
      " Confirm and it will be resubmitted.",
    output: {
      ...input,
      reviewed: true,
      mode: "triage",
      rejection: { present: true, reason, checked: fetched.source, couldNotRead: fetched.error },
      triage,
      intakeFields: triage.redraft,
      loopCount: loopCount + 1,
    },
    metadata: {
      mode: "triage",
      corrected: triage.changed,
      questions: triage.findings.filter((f) => !f.proposed).length,
      loopCount: loopCount + 1,
    },
  });
}
