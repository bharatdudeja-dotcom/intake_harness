/**
 * Live, in-flight tool-call progress for a run — "what is this agent doing
 * RIGHT NOW", for the UI to poll while a request is still in the air.
 *
 * WHY THIS EXISTS: every agent step already runs inside withToolCallLog
 * (mcp-client.ts), which captures the full request/response of every MCP
 * call — but only as a RETURN VALUE, assembled after the whole step
 * finishes and handed back in one HTTP response. From the browser's side,
 * that whole window — one step, or now several chained steps (Review then
 * Audience Creation in one call, since registry.ts's requiresApproval
 * opt-out) — was a single opaque "Running…" spinner with zero visibility
 * into what was actually happening, for however many seconds or tens of
 * seconds it took. This module is the missing middle: the SAME instrumented
 * calls also publish here as they start and finish, so a poll mid-request
 * sees real, live state instead of nothing.
 *
 * WHY IN-MEMORY, NOT A DB TABLE: this data is meaningful only WHILE a step
 * is in flight — once the step finishes, the real, permanent record is
 * already in task_runs.metadata.toolCalls (unchanged). A new table would
 * also need DDL this app's own DB role does not have (verified this
 * session: `permission denied for schema public`), so in-memory is not
 * just simpler here, it is the only option that does not need a DBA.
 *
 * WHY THIS IS SAFE AS A MODULE-LEVEL SINGLETON: this app runs as one
 * long-lived Node process (`output: "standalone"`, `node server.js` — see
 * the Dockerfile), not stateless serverless functions, so in-memory state
 * persists exactly as long as it needs to across the several server-side
 * HTTP calls one browser action can now trigger (orchestrator.ts calling
 * agent routes internally). It would NOT survive multiple replicas behind
 * a load balancer — fine for this app's actual deployment, not fine if
 * that ever changes; a shared store (Redis, or a DB table once DDL access
 * exists) would be the fix at that point, not a rewrite of the interface
 * below.
 */

export type LiveToolCall = {
  id: number;
  taskId: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: string;
  status: "pending" | "success" | "error";
  durationMs?: number;
  /** Present once status is "success" - the same truncated value mcp-client.ts's ToolCallRecord stores, so the Runs page can show the real response before the step even finishes, not just after. */
  result?: unknown;
  resultTruncated?: boolean;
  /** Present once status is "error". */
  error?: string;
};

type RunProgress = {
  calls: LiveToolCall[];
  /** Which agent (task_id) is actually running right now, or just finished its last call. */
  currentTaskId: string | null;
  updatedAt: number;
};

const runs = new Map<string, RunProgress>();
let nextId = 0;

/**
 * Start tracking a run's live progress — called once per TOP-LEVEL
 * orchestrator action (runPipeline/resumeRun/continueRun/retryRun), before
 * any agent runs, so a chained sequence of agent steps within that one
 * action accumulates into a single ordered list rather than each step
 * clobbering the last.
 */
export function resetRun(runId: string): void {
  runs.set(runId, { calls: [], currentTaskId: null, updatedAt: Date.now() });
}

/** Which agent is now active — called at the top of withToolCallLog for each step. */
export function setCurrentAgent(runId: string, taskId: string): void {
  const p = runs.get(runId);
  if (!p) return;
  p.currentTaskId = taskId;
  p.updatedAt = Date.now();
}

/** A tool call just started. Returns an id to close it out with, or -1 if this run isn't being tracked (fine — just means no poller is watching). */
export function startCall(runId: string, taskId: string, name: string, args: Record<string, unknown>): number {
  const p = runs.get(runId);
  if (!p) return -1;
  const id = ++nextId;
  p.calls.push({ id, taskId, name, args, startedAt: new Date().toISOString(), status: "pending" });
  p.updatedAt = Date.now();
  return id;
}

/** The same tool call finished — success or error. A no-op if `id` is -1 (nothing was tracked to begin with). */
export function finishCall(
  runId: string,
  id: number,
  outcome:
    | { status: "success"; durationMs: number; result?: unknown; resultTruncated?: boolean }
    | { status: "error"; durationMs: number; error: string },
): void {
  if (id < 0) return;
  const p = runs.get(runId);
  if (!p) return;
  const call = p.calls.find((c) => c.id === id);
  if (call) Object.assign(call, outcome);
  p.updatedAt = Date.now();
}

/** What a poller sees. Never throws; an untracked run just reads as "nothing in flight." */
export function getProgress(runId: string): { calls: LiveToolCall[]; currentTaskId: string | null } {
  const p = runs.get(runId);
  return p ? { calls: p.calls, currentTaskId: p.currentTaskId } : { calls: [], currentTaskId: null };
}

/**
 * Stop tracking a run — called once the top-level action's HTTP response
 * has been produced (success OR failure, via try/finally), so memory for a
 * long-lived process doesn't grow with every run ever made. Losing this
 * costs nothing: the permanent record already lives in task_runs by then.
 */
export function clearRun(runId: string): void {
  runs.delete(runId);
}
