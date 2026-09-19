"use client";

/** Mirrors live-progress.ts's LiveToolCall. */
export type LiveToolCall = {
  id: number;
  taskId: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: string;
  status: "pending" | "success" | "error";
  durationMs?: number;
  error?: string;
};

/**
 * What an agent is doing RIGHT NOW - polled from GET /api/runs/[runId]/live
 * while a request that runs one or more agents is still in flight (see
 * live-progress.ts for why this exists at all: before it, the whole window
 * between clicking a button and the response coming back - now sometimes
 * TWO chained agent steps, since Audience Creation's approval gate was
 * removed - was an opaque spinner with no visibility into what was
 * actually happening).
 *
 * Deliberately lightweight compared to ToolCallLog (the finished,
 * persisted record with full expandable request/response detail): this
 * one's only job is answering "is it doing something, and what" while the
 * user is actively waiting, not being pored over afterward - so no
 * expand/collapse, just name, status, and elapsed time, updating live.
 */
export function LiveToolCallLog({
  calls,
  currentTaskId,
  agentLabel,
}: {
  calls: LiveToolCall[];
  currentTaskId: string | null;
  agentLabel?: (taskId: string) => string;
}) {
  if (!calls.length) return null;
  const label = agentLabel ?? ((t: string) => t);

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-blue-200 bg-blue-50/60 p-2.5 dark:border-blue-900 dark:bg-blue-950/20">
      {currentTaskId && (
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-400">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
          {label(currentTaskId)} is running
        </p>
      )}
      <div className="flex flex-col gap-0.5">
        {calls.map((call) => (
          <div key={call.id} className="flex items-center gap-2 text-xs">
            <span
              className={
                call.status === "pending"
                  ? "animate-pulse text-blue-500"
                  : call.status === "success"
                    ? "text-green-600"
                    : "text-red-600"
              }
            >
              {call.status === "pending" ? "→" : call.status === "success" ? "✓" : "✕"}
            </span>
            <span className="font-mono text-zinc-700 dark:text-zinc-300">{call.name}</span>
            <span className="text-zinc-400">{call.status === "pending" ? "…" : `${call.durationMs}ms`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
