import { NextRequest, NextResponse } from "next/server";
import { completeInProgressStep } from "@/lib/pipeline/orchestrator";
import type { AgentStatus } from "@/lib/pipeline/types";
import { apiError } from "@/lib/api-error";

/**
 * PATCH: the fire-and-poll completion callback.
 *
 * A long-running agent that earlier returned "in_progress" (Audience
 * Creation's GTO/FAC sub-workflow, B4/B5 — work that can run for a quarter)
 * calls this once the work is actually done, to finalize its own task_run
 * out-of-band and advance the pipeline. This is what lets POST /api/runs
 * return immediately instead of one request blocking on a multi-hour await
 * and blowing AGENT_CALL_TIMEOUT_MS.
 *
 * Body: { status: "completed" | "needs_input" | "failed", output?, message?, metadata? }
 * ("in_progress" is rejected — a finalization must be terminal.)
 *
 * The marketer-facing UI polls GET /api/runs/[runId] the whole time; this
 * is the event that finally moves it off "in_progress".
 */
const TERMINAL: AgentStatus[] = ["completed", "needs_input", "failed"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string; taskRunId: string }> },
) {
  const { runId, taskRunId } = await params;
  const id = Number(taskRunId);
  if (!Number.isInteger(id) || id <= 0) {
    return apiError(`taskRunId must be a positive integer, got "${taskRunId}".`, "VALIDATION_ERROR", 400);
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.status !== "string") {
    return apiError('Body must be { "status": "completed" | "needs_input" | "failed", output?, message?, metadata? }', "VALIDATION_ERROR", 400);
  }
  if (!TERMINAL.includes(body.status as AgentStatus)) {
    return apiError(
      `status must be one of ${TERMINAL.join(", ")} — "in_progress" cannot finalize a step.`,
      "VALIDATION_ERROR",
      400,
    );
  }

  const baseUrl = req.nextUrl.origin;
  try {
    const run = await completeInProgressStep(
      runId,
      id,
      {
        status: body.status as AgentStatus,
        output: body.output,
        message: typeof body.message === "string" ? body.message : undefined,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : undefined,
      },
      baseUrl,
    );
    return NextResponse.json({ run });
  } catch (err) {
    // A late/duplicate PATCH (run no longer in_progress, or step already
    // finalized) is a client/timing problem, not a server fault.
    const message = (err as Error).message;
    const isConflict = /not "in_progress"|already finalized|nothing to finalize/.test(message);
    return apiError(message, isConflict ? "VALIDATION_ERROR" : "INTERNAL_ERROR", isConflict ? 409 : 500);
  }
}
