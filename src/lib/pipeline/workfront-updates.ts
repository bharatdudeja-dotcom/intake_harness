/**
 * Posting an "update on what the agent did" back onto the Workfront issue,
 * CENTRALLY, for every agent. This is the one place the orchestrator calls
 * after it records a step (advanceOneStep) and after it finalizes an
 * out-of-band step (completeInProgressStep). Individual agent routes do NOT
 * each post their own status comment any more — this is the single commenting
 * authority, so a new agent added to the PIPELINE gets this behaviour for free
 * rather than having to remember to wire it up.
 *
 * SAME HONESTY CONTRACT as intake/workfront.ts and review/workfront-notes.ts:
 * write actions are disabled on the tenant until a Workfront admin enables
 * them (44 of the connector's 94 tools are writes, off by default), so
 * comment-stream_create_comment 404s on most tenants today. A failure is
 * REPORTED (posted:false plus the text we WOULD have posted), never thrown —
 * this runs inside the orchestrator's record path, so "couldn't comment" must
 * never become "the run failed".
 */

import { callMcpTool } from "@/lib/mcp-client";
import { workfrontToolset } from "@/lib/workfront-tools";
import { PIPELINE } from "./registry";
import type { AgentName, AgentStatus, TaskId } from "./types";

/** A write tool that 404s because writes are off, not because of a bug here — same detection the other Workfront write paths use. */
function isMissingWriteTool(raw: string): boolean {
  return /not found/i.test(raw) && /workflow_(create|update)|comment-stream_create/i.test(raw);
}

function explain(raw: string): string {
  return isMissingWriteTool(raw)
    ? `${raw} — this tool is absent because WRITE ACTIONS ARE NOT ENABLED on the Workfront tenant. ` +
        "A Workfront admin turns them on in Setup > System > Preferences."
    : raw;
}

/** Human-readable label for the agent, from the pipeline registry (falls back to the raw name). */
function agentLabel(agent: AgentName): string {
  return PIPELINE.find((a) => a.name === agent)?.label ?? agent;
}

/** How each status reads in the comment header, so the issue thread is an activity log a human can skim. */
const STATUS_PHRASE: Record<AgentStatus, string> = {
  completed: "completed",
  needs_input: "needs input",
  in_progress: "in progress",
  failed: "failed",
};

/**
 * The Workfront issue Intake created, if there is one to comment on.
 *
 * `objId` only exists once a create actually SUCCEEDED — createIntakeRequest
 * returns `created: false` with no id on a dry run — so a run whose Workfront
 * write was disabled naturally has nothing to comment on, which is exactly
 * right: there is no issue there yet, so intake's own needs_input rounds never
 * spam a thread.
 *
 * Checks the current step's own output first, then every prior output: only
 * Intake's output carries `workfront` natively. Review spreads it forward, but
 * Audience Creation's output does not, so for that step the identity is found
 * among priorOutputs rather than on its own output.
 */
export function resolveWorkfrontTarget(
  output: unknown,
  priorOutputs: Partial<Record<AgentName, unknown>>,
): { objId: string; objCode: string } | null {
  const candidates: unknown[] = [output, ...Object.values(priorOutputs)];
  for (const candidate of candidates) {
    const wf = (candidate as { workfront?: { objId?: unknown; objCode?: unknown } } | null | undefined)?.workfront;
    const objId = wf?.objId ? String(wf.objId) : "";
    if (objId) return { objId, objCode: wf?.objCode ? String(wf.objCode) : "OPTASK" };
  }
  return null;
}

export type AgentUpdateResult =
  | { attempted: false; reason: string }
  | { attempted: true; posted: boolean; objId: string; objCode: string; text: string; reason?: string };

/** The comment body: an activity-log line for a human reading the issue. */
function formatUpdate(agent: AgentName, status: AgentStatus, message: string): string {
  return `${agentLabel(agent)} — ${STATUS_PHRASE[status]}\n\n${message}`;
}

/**
 * Post an agent's update comment to its Workfront issue, best-effort.
 *
 * NEVER THROWS: a transport error, a disabled write tool, or a run with no
 * issue yet all come back as a structured result the orchestrator records in
 * the step's metadata (`workfrontUpdate`), so what happened is visible in
 * observability without ever failing the run. Posting as `agent` means that
 * agent must have the comment tool in its registry allowlist (Intake and
 * Review already do via allWorkfrontToolNames; Audience Creation is granted it
 * explicitly via commentToolNames — see registry.ts).
 */
export async function postAgentUpdate(
  agent: TaskId,
  status: AgentStatus,
  message: string | undefined,
  output: unknown,
  priorOutputs: Partial<Record<AgentName, unknown>>,
): Promise<AgentUpdateResult> {
  try {
    const text = String(message ?? "").trim();
    if (!text) return { attempted: false, reason: "no message to post" };

    const target = resolveWorkfrontTarget(output, priorOutputs);
    if (!target) return { attempted: false, reason: "no Workfront issue exists on this run yet" };

    const set = workfrontToolset();
    const body = formatUpdate(agent, status, text);
    try {
      await callMcpTool(agent, set.createComment, { objID: target.objId, objCode: target.objCode, text: body });
      return { attempted: true, posted: true, objId: target.objId, objCode: target.objCode, text: body };
    } catch (err) {
      return {
        attempted: true,
        posted: false,
        objId: target.objId,
        objCode: target.objCode,
        text: body,
        reason: explain((err as Error).message),
      };
    }
  } catch (err) {
    // Defensive: resolving/formatting should never throw, but this runs on the
    // orchestrator's record path, so a bug here must not take the run down.
    return { attempted: false, reason: `update comment skipped: ${(err as Error).message}` };
  }
}
