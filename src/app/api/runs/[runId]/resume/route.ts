import { NextRequest, NextResponse } from "next/server";
import { resumeRun } from "@/lib/pipeline/orchestrator";
import { query } from "@/lib/db";
import type { TaskRunRow } from "@/lib/pipeline/types";

/**
 * POST: answers a paused ("needs_input") run and re-runs the pipeline from
 * the step that paused. Body is { "answers": { <fieldKey>: <value>, ... } },
 * keyed by the `key` on each question the paused step asked for.
 *
 * Only Intake pauses today (see registry.ts / local/README.md), so this
 * merges the answers into intake's own { brief, loopCount, fields } output
 * shape rather than being a fully generic merge — widen this if a second
 * agent starts returning "needs_input".
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.answers !== "object" || body.answers === null) {
    return NextResponse.json({ error: 'Body must be { "answers": <object> }' }, { status: 400 });
  }

  const [pausedTaskRun] = await query<TaskRunRow>(
    `SELECT * FROM task_runs WHERE run_id = $1 AND status = 'needs_input'
     ORDER BY step_index DESC, task_run_id DESC LIMIT 1`,
    [runId],
  );
  if (!pausedTaskRun) {
    return NextResponse.json({ error: `Run ${runId} has no paused step to answer.` }, { status: 400 });
  }

  const pausedOutput = (pausedTaskRun.output ?? {}) as {
    brief?: string;
    loopCount?: number;
    fields?: Record<string, unknown>;
    questions?: { key: string; label: string }[];
  };
  const mergedFields = { ...(pausedOutput.fields ?? {}), ...(body.answers as Record<string, unknown>) };

  // An empty answer merges in as an empty string, which still counts as
  // missing next round — the round just gets spent for nothing, and enough
  // of those trip the loop-count escalation for no real reason. Reject it
  // here rather than relying on every caller's own client-side validation.
  const stillBlank = (pausedOutput.questions ?? []).filter(
    (q) => String(mergedFields[q.key] ?? "").trim() === "",
  );
  if (stillBlank.length) {
    return NextResponse.json(
      { error: `Still blank: ${stillBlank.map((q) => q.label).join(", ")}. Answer every asked question before resuming.` },
      { status: 400 },
    );
  }

  const resumedInput = {
    brief: pausedOutput.brief,
    loopCount: pausedOutput.loopCount,
    fields: mergedFields,
  };

  const baseUrl = req.nextUrl.origin;
  try {
    const run = await resumeRun(runId, resumedInput, baseUrl);
    return NextResponse.json({ run });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
