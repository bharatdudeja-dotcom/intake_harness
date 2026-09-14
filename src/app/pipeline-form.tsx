"use client";

import { useState } from "react";
import type { PipelineRunRow, PipelineStepRow } from "@/lib/pipeline/types";

type RunState = { run: PipelineRunRow; steps: PipelineStepRow[] } | null;

export function PipelineForm() {
  const [brief, setBrief] = useState("");
  const [runState, setRunState] = useState<RunState>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    setRunState(null);
    try {
      const res = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { brief } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      const statusRes = await fetch(`/api/pipeline/run/${data.run.id}`);
      setRunState(await statusRes.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <textarea
        className="min-h-24 rounded-lg border border-zinc-300 bg-white p-3 text-sm text-black outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
        placeholder="Describe the campaign / audience brief..."
        value={brief}
        onChange={(e) => setBrief(e.target.value)}
      />
      <button
        onClick={submit}
        disabled={submitting || !brief.trim()}
        className="self-start rounded-full bg-zinc-900 px-5 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
      >
        {submitting ? "Running..." : "Run pipeline"}
      </button>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {runState && (
        <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex items-center gap-2">
            <span className="font-medium text-black dark:text-zinc-50">Run {runState.run.id}</span>
            <StatusBadge status={runState.run.status} />
          </div>
          <ol className="flex flex-col gap-2">
            {runState.steps.map((step) => (
              <li key={step.id} className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-900">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{step.agent_name}</span>
                  <StatusBadge status={step.status} />
                  <span className="ml-auto text-xs text-zinc-400">{step.duration_ms}ms</span>
                </div>
                {step.message && <p className="text-xs text-red-600">{step.message}</p>}
                <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
                  {JSON.stringify(step.output, null, 2)}
                </pre>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "completed"
      ? "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-400"
      : status === "failed"
        ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-400"
        : status === "needs_input"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-400"
          : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-400";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>{status}</span>;
}
