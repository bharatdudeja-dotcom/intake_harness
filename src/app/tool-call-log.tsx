"use client";

import { useState } from "react";

/** Mirrors mcp-client.ts's ToolCallRecord — the shape task_runs.metadata.toolCalls is stored as. */
export type ToolCallLogEntry = {
  name: string;
  args: Record<string, unknown>;
  startedAt: string;
  durationMs: number;
  result?: unknown;
  resultTruncated?: boolean;
  error?: string;
};

/**
 * The full, unabridged record of MCP tool calls one agent step made — exact
 * request and response for each, not the curated summaries ToolCallTrace
 * shows (grounded/ungrounded, created/dry-run, schema field counts). Those
 * stay useful as a scan; this is the ground truth underneath them, for when
 * "what did it actually ask, and what did it actually get back" matters
 * more than the summary.
 *
 * Reads straight from task_runs.metadata.toolCalls (see mcp-client.ts's
 * withToolCallLog, which every agent route wraps its handler in) — every
 * call is captured automatically, wherever in the call graph it happens,
 * with nothing at the call site aware it's being watched.
 */
export function ToolCallLog({ calls }: { calls: ToolCallLogEntry[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  if (!calls.length) return null;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
        Tool calls ({calls.length})
      </p>
      <div className="flex flex-col rounded-lg border border-zinc-200 dark:border-zinc-800">
        {calls.map((call, i) => {
          const isOpen = openIndex === i;
          const failed = call.error != null;
          return (
            <div key={i} className={i > 0 ? "border-t border-zinc-200 dark:border-zinc-800" : undefined}>
              <button
                onClick={() => setOpenIndex(isOpen ? null : i)}
                className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
              >
                <span className={failed ? "text-red-600" : "text-green-600"}>{failed ? "✕" : "✓"}</span>
                <span className="font-mono text-zinc-700 dark:text-zinc-300">{call.name}</span>
                <span className="text-zinc-400">{call.durationMs}ms</span>
                <span className="ml-auto text-zinc-400">{isOpen ? "Hide" : "Details"}</span>
              </button>
              {isOpen && (
                <div className="flex flex-col gap-2 px-2 pb-2 text-xs">
                  <div>
                    <p className="mb-1 font-semibold text-zinc-500 dark:text-zinc-400">Request</p>
                    <pre className="overflow-x-auto rounded bg-zinc-50 p-2 font-mono text-[11px] dark:bg-zinc-900">
                      {JSON.stringify(call.args, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 font-semibold text-zinc-500 dark:text-zinc-400">{failed ? "Error" : "Response"}</p>
                    <pre
                      className={`overflow-x-auto rounded p-2 font-mono text-[11px] ${
                        failed
                          ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300"
                          : "bg-zinc-50 dark:bg-zinc-900"
                      }`}
                    >
                      {failed ? call.error : JSON.stringify(call.result, null, 2)}
                    </pre>
                    {call.resultTruncated && (
                      <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                        Response truncated for storage — see the raw run record for the full payload.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
