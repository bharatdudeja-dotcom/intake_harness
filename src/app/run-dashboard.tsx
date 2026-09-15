"use client";

import { useCallback, useEffect, useState } from "react";
import type { RunRow, TaskRunRow } from "@/lib/pipeline/types";

type RunDetail = { run: RunRow; taskRuns: TaskRunRow[] };

export function RunDashboard() {
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);

  const refreshRuns = useCallback(async () => {
    const res = await fetch("/api/runs");
    if (!res.ok) {
      setError(`Failed to load runs (HTTP ${res.status}). Is DATABASE_URL set in .env.local?`);
      return;
    }
    const data = await res.json();
    setRuns(data.runs ?? []);
  }, []);

  const loadDetail = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    const res = await fetch(`/api/runs/${runId}`);
    if (!res.ok) {
      setError(`Failed to load run ${runId} (HTTP ${res.status}).`);
      return;
    }
    setDetail(await res.json());
  }, []);

  // Fetch-on-mount, not via refreshRuns directly: the effect subscribes to
  // the fetch's own callback rather than calling a setState-holding function
  // synchronously, so a stale response can't overwrite state after unmount.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/runs")
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) {
            setError(`Failed to load runs (HTTP ${res.status}). Is DATABASE_URL set in .env.local?`);
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) setRuns(data.runs ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setRuns(data.runs ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: { brief } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

      await refreshRuns();
      await loadDetail(data.run.run_id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
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
      </div>

      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
            Recent runs ({runs.length})
          </h2>
          <ol className="flex flex-col gap-1">
            {runs.map((run) => (
              <li key={run.run_id}>
                <button
                  onClick={() => loadDetail(run.run_id)}
                  className={`flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-xs ${
                    selectedRunId === run.run_id
                      ? "border-zinc-900 dark:border-zinc-100"
                      : "border-zinc-200 dark:border-zinc-800"
                  } bg-white dark:bg-zinc-950`}
                >
                  <span className="font-mono text-zinc-500">{run.run_id.slice(0, 8)}</span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={run.status} />
                    <span className="text-zinc-400">{new Date(run.created_at).toLocaleTimeString()}</span>
                  </div>
                </button>
              </li>
            ))}
            {runs.length === 0 && <p className="text-xs text-zinc-400">No runs yet.</p>}
          </ol>
        </div>

        <div>
          {detail ? (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-zinc-500">run_id: {detail.run.run_id}</span>
                <StatusBadge status={detail.run.status} />
              </div>
              <ol className="flex flex-col gap-2">
                {detail.taskRuns.map((taskRun) => (
                  <li
                    key={taskRun.task_run_id}
                    className="flex flex-col gap-1 border-t border-zinc-100 pt-2 dark:border-zinc-900"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{taskRun.task_id}</span>
                      <span className="font-mono text-xs text-zinc-400">
                        task_run_id: {taskRun.task_run_id}
                      </span>
                      <StatusBadge status={taskRun.status} />
                      <span className="ml-auto text-xs text-zinc-400">
                        {new Date(taskRun.started_at).toLocaleTimeString()} · {taskRun.duration_ms}ms
                      </span>
                    </div>
                    {taskRun.message && <p className="text-xs text-red-600">{taskRun.message}</p>}
                    <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
                      {JSON.stringify(taskRun.output, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">Select a run to see its task runs.</p>
          )}
        </div>
      </div>
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
