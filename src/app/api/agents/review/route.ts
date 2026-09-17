import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { callMcpTool } from "@/lib/mcp-client";
import { triageRejection, type TriageResult } from "@/lib/agents/review/triage";
import { convertIssueToProject, checkAudienceCatalog } from "@/lib/agents/review/phase2";
import { requiredFields } from "@/lib/agents/shared/campaign-brief";

/**
 * Agent 2. It sits on the decision at 1.5, and which job it does depends on
 * which way that decision went.
 *
 *   APPROVED -> connector A -> phase 2. 2.1 issue converted to project form,
 *               2.2 read and gather, 2.3 does the audience already exist.
 *   REJECTED -> 1.5a, which is B2: "the review queue rejects the issue and it
 *               goes back to the marketer as rework. Nothing reads the
 *               rejection reason, and the loop resumes at 1.3 with the marketer
 *               guessing. The largest unclaimed gap in the map."
 *
 * WHY THIS AGENT USED TO REPORT COMPLETED ON WORK IT HAD NOT DONE
 *
 * It ran on every submission the moment it was made, because the pipeline had
 * no 1.5. With no rejection to read it fell through to a pre-flight, found the
 * required fields present, and returned `completed`. Underneath, the call it
 * makes to look for a prior rejection had ERRORED, and an error was being
 * treated as "no rejection found" - which is the precise bug this agent exists
 * to fix, committed by the agent itself.
 *
 * Two things changed:
 *
 * 1. It is gated (lib/pipeline/gates.ts). Until someone decides at 1.5 it is
 *    not called at all, and writes no task_runs row. It cannot report on work
 *    it was never handed.
 * 2. A check it could not perform never yields `completed`. "I looked and found
 *    none" and "I could not look" are different facts, and only the first of
 *    them is a pass.
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
  /**
   * The decision recorded at 1.5, attached by the orchestrator.
   *
   * This is what makes the rejection reason readable without a comment-stream
   * lookup: a rejection recorded at the gate carries its own reason. B2's
   * complaint is that nothing reads the rejection reason; carrying it is a
   * better answer than hunting for it in a stream we may not be able to read.
   */
  gateDecision?: {
    gate_id: string;
    decision: "approved" | "rejected";
    decided_by: string;
    reason: string | null;
    decided_at: string;
  };
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
      /*
       * An empty comment stream is NOT an error.
       *
       * This used to report "the comment stream returned nothing we recognised
       * as comments" whenever the list was empty, which is the normal state of
       * a freshly created request. That error then blocked the run. A new issue
       * having no comments is the expected case, not a fault.
       */
      error: null as string | null,
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
  const brief = String(input.brief || "");
  const decision = input.gateDecision;

  const objId = input.workfront?.created ? String(input.workfront.objId || "") : "";

  // =========================================================================
  // APPROVED at 1.5 -> connector A -> phase 2
  // =========================================================================
  if (decision?.decision === "approved") {
    // --- 2.1 Issue converted to project form ------------------------------
    const conversion = await convertIssueToProject({ issueId: objId || null, intakeFields: fields, brief });

    if (!conversion.converted) {
      /*
       * 2.1 failing is a failure, not a pause.
       *
       * Everything in phase 2 hangs off the project: the brief's fields live on
       * the project form, 2.2 reads the project, and the audience is built for
       * it. Reporting anything green here would put the run past the one step
       * that had to work.
       */
      return NextResponse.json<AgentResponse>({
        status: "failed",
        message: `The request could not be turned into a project: ${conversion.reason}`,
        output: { ...input, reviewed: true, mode: "phase2", conversion },
        metadata: { mapStep: "2.1", converted: false, approvedBy: decision.decided_by },
      });
    }

    // --- 2.2 read and gather, 2.3 does the audience already exist? --------
    const catalog = await checkAudienceCatalog(fields);

    const output = {
      ...input,
      reviewed: true,
      mode: "phase2",
      approval: { decision: "approved", by: decision.decided_by, at: decision.decided_at },
      converted: {
        created: conversion.converted,
        objCode: conversion.objCode,
        objId: conversion.objId,
        method: conversion.method,
      },
      conversion,
      audienceExists: catalog.audienceExists,
      existingAudience: catalog.existingAudience,
      dataRequirements: catalog.dataRequirements,
      catalog,
      intakeFields: fields,
      loopCount,
    };

    /*
     * 2.3 unanswerable is needs_input, not completed.
     *
     * A null audienceExists means the catalog could not be read. Passing that
     * forward as a completed phase 2 would let Agent 3 build an audience that
     * may already exist - and the gate deliberately treats null as closed, so
     * reporting `completed` here would produce a green stage in front of a
     * blocked one, which reads as a pipeline that stopped for no reason.
     */
    if (catalog.audienceExists === null) {
      return NextResponse.json<AgentResponse>({
        status: "needs_input",
        message:
          `Created Workfront project ${conversion.objId} and wrote the brief onto it. ` +
          `But the audience catalogue could not be read (${catalog.error}), so it is not known whether ` +
          "an audience for this already exists. Someone needs to confirm that before a new one is built, " +
          "otherwise we risk building a duplicate.",
        output,
        metadata: {
          mapStep: "2.3",
          converted: true,
          projectId: conversion.objId,
          fieldsWritten: conversion.fieldsWritten.length,
          fieldsRefused: conversion.fieldsRefused.map((r) => r.field),
          catalogReadable: false,
          approvedBy: decision.decided_by,
          loopCount,
        },
      });
    }

    /*
     * 2.3 Yes -> 2.4 activate -> 2.5 validate with the marketer.
     *
     * 2.5 is a human step the blockers doc keeps deliberately: "one of only
     * three human steps left, and the only value-adding one... Keep the human
     * decision; remove the surprise." So a reused audience pauses for the
     * marketer rather than completing, and the gate in front of Agent 3 stays
     * shut because there is nothing to build.
     */
    if (catalog.audienceExists === true) {
      return NextResponse.json<AgentResponse>({
        status: "needs_input",
        message:
          `Created Workfront project ${conversion.objId}. ${catalog.note} ` +
          "Confirm it is the right audience and it can be activated.",
        output,
        metadata: {
          mapStep: "2.5",
          converted: true,
          projectId: conversion.objId,
          fieldsWritten: conversion.fieldsWritten.length,
          fieldsRefused: conversion.fieldsRefused.map((r) => r.field),
          reusedAudience: catalog.existingAudience,
          approvedBy: decision.decided_by,
          loopCount,
        },
      });
    }

    // 2.3 No -> 2.6 -> 2.7 -> connector B. Phase 2 is done and Agent 3 is next.
    return NextResponse.json<AgentResponse>({
      status: "completed",
      output,
      metadata: {
        mapStep: "2.7",
        converted: true,
        projectId: conversion.objId,
        conversionMethod: conversion.method,
        fieldsWritten: conversion.fieldsWritten,
        fieldsRefused: conversion.fieldsRefused.map((r) => r.field),
        fieldNote: conversion.fieldNote,
        fieldNamesVerified: conversion.fieldNamesVerified,
        linkedBack: conversion.linkedBack,
        audienceExists: false,
        audiencesConsidered: catalog.considered,
        dataRequirements: catalog.dataRequirements,
        approvedBy: decision.decided_by,
        loopCount,
      },
    });
  }

  // =========================================================================
  // REJECTED at 1.5 -> 1.5a -> triage (B2)
  // =========================================================================
  const fetched = await fetchRejection(objId || null);
  const reason = String(input.rejectionReason || decision?.reason || fetched.reason || "").trim();

  if (!reason) {
    /*
     * No rejection, and nothing decided either. The pre-flight.
     *
     * With the gate in place the pipeline does not reach here - it stops at 1.5
     * instead. This path survives for a direct call to the agent (a dev with
     * curl, or a pre-submission check), and the one thing it must not do is
     * what it used to: report `completed` over a failed lookup.
     */
    const pre = preflight(fields);
    const clean = pre.findings.length === 0;

    const rejectionUnreadable = fetched.error !== null;

    return NextResponse.json<AgentResponse>({
      // A check that could not run is not a pass. This was `clean ? completed
      // : needs_input`, which reported a green stage over an errored call.
      status: clean && !rejectionUnreadable ? "completed" : "needs_input",
      message: rejectionUnreadable
        ? `Could not establish whether this was already rejected: ${fetched.error}. ` +
          "That is reported rather than assumed, because treating a failed read as " +
          '"no rejection" is the bug this agent exists to fix. ' +
          (clean ? "The brief itself is complete." : pre.findings.map((f) => f.ask).join(" "))
        : clean
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
        rejectionReadable: !rejectionUnreadable,
        loopCount,
      },
    });
  }

  // --- There is a rejection: translate it -----------------------------------
  const triage = triageRejection(reason, fields);
  const rejectedBy = decision?.decision === "rejected" ? decision.decided_by : null;

  if (triage.needsHuman) {
    return NextResponse.json<AgentResponse>({
      status: "needs_input",
      message: triage.findings[0].ask,
      output: {
        ...input,
        reviewed: true,
        mode: "triage",
        rejection: { present: true, reason, by: rejectedBy, checked: fetched.source, couldNotRead: fetched.error },
        triage,
        intakeFields: triage.redraft,
        loopCount: loopCount + 1,
      },
      metadata: { mode: "triage", mapStep: "1.5a", needsHuman: true, rejectedBy, loopCount: loopCount + 1 },
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
      rejection: { present: true, reason, by: rejectedBy, checked: fetched.source, couldNotRead: fetched.error },
      triage,
      intakeFields: triage.redraft,
      loopCount: loopCount + 1,
    },
    metadata: {
      mode: "triage",
      mapStep: "1.5a",
      corrected: triage.changed,
      questions: triage.findings.filter((f) => !f.proposed).length,
      rejectedBy,
      loopCount: loopCount + 1,
    },
  });
}
