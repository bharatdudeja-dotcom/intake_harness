"use client";

import { useState } from "react";

/** Mirrors live-progress.ts's LiveToolCall. */
export type LiveToolCall = {
  id: number;
  taskId: string;
  name: string;
  args: Record<string, unknown>;
  startedAt: string;
  status: "pending" | "success" | "error";
  durationMs?: number;
  result?: unknown;
  resultTruncated?: boolean;
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
 * Same request/response drill-down as ToolCallLog (the finished, persisted
 * record) - click a call to see exactly what was asked and, once it
 * resolves, exactly what came back - just live, before the step even
 * finishes rather than only after. A still-pending call can still be
 * expanded to see the request; there's just no response yet.
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
  const [openId, setOpenId] = useState<number | null>(null);
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
      <div className="flex flex-col rounded-md border border-blue-200/70 dark:border-blue-900/70">
        {calls.map((call, i) => {
          const isOpen = openId === call.id;
          return (
            <div key={call.id} className={i > 0 ? "border-t border-blue-200/70 dark:border-blue-900/70" : undefined}>
              <button
                onClick={() => setOpenId(isOpen ? null : call.id)}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-blue-100/50 dark:hover:bg-blue-950/40"
              >
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
                <span className="ml-auto text-blue-500">{isOpen ? "Hide" : "Details"}</span>
              </button>
              {isOpen && (
                <div className="flex flex-col gap-2 px-2 pb-2 text-xs">
                  <div>
                    <p className="mb-1 font-semibold text-zinc-500 dark:text-zinc-400">Request</p>
                    <pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] dark:bg-zinc-900">
                      {JSON.stringify(call.args, null, 2)}
                    </pre>
                  </div>
                  {call.status === "pending" ? (
                    <p className="italic text-blue-600 dark:text-blue-400">Waiting on a response…</p>
                  ) : (
                    <div>
                      <p className="mb-1 font-semibold text-zinc-500 dark:text-zinc-400">
                        {call.status === "error" ? "Error" : "Response"}
                      </p>
                      <pre
                        className={`overflow-x-auto rounded p-2 font-mono text-[11px] ${
                          call.status === "error"
                            ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                            : "bg-white dark:bg-zinc-900"
                        }`}
                      >
                        {call.status === "error" ? call.error : JSON.stringify(call.result, null, 2)}
                      </pre>
                      {call.resultTruncated && (
                        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                          Response truncated for display — see the full record once this step finishes.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
