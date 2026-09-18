import { NextRequest, NextResponse } from "next/server";
import { continueRun, getRun } from "@/lib/pipeline/orchestrator";

/**
 * POST: advance a run by exactly one step.
 *
 * Runs the next agent and stops again, or finishes if that was the last one.
 * No body required. This is NOT the approval - the approval is a named person
 * clicking Approve in Workfront, recorded through the gate endpoint. By the
 * time anything continues a run, that has already happened.
 *
 * A REQUEST THAT DOES NOT APPLY IS 409, NOT 500
 *
 * Asking a finished run to advance returned 500 with "nothing to approve" - a
 * message from the approval path, on a run whose approval was long done. An
 * assistant reported the harness had failed, twice, and refused to describe the
 * audience the run had in fact built correctly. It was right to refuse: a 500
 * says we are broken.
 *
 * So: 409 when there is simply no step waiting, with the run's real state
 * attached so the caller can read the outcome instead of guessing at it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const baseUrl = req.nextUrl.origin;
  try {
    const run = await continueRun(runId, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    const message = (err as Error).message;
    const notApplicable = /has already finished|no step waiting|No run |not waiting at a gate|nothing there is gated/i.test(message);

    // Hand back where the run actually is. "Nothing to advance" is only useful
    // alongside "and here is what it produced".
    let run = null;
    if (notApplicable) {
      run = await getRun(runId).catch(() => null);
    }
    return NextResponse.json(
      run ? { error: message, run: run.run, taskRuns: run.taskRuns, gates: run.gates } : { error: message },
      { status: notApplicable ? 409 : 500 },
    );
  }
}
