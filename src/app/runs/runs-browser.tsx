"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RunRow, TaskRunRow } from "@/lib/pipeline/types";
import { StatusBadge } from "../status-badge";

type RunDetail = { run: RunRow; taskRuns: TaskRunRow[] };

/** The shape intake's "needs_input" output puts under `questions` (see src/app/api/agents/intake/route.ts). */
type PendingQuestion = {
  key: string;
  label: string;
  ask: string | null;
  options: string[] | null;
  optionsPartial: boolean;
};

/**
 * The "see runs from the database" page. Lists every row in `runs`
 * (GET /api/runs) and, on selection, every task_runs row for it
 * (GET /api/runs/[runId]) — the same observability API the harness's
 * pipeline writes to, just browsable on its own rather than only
 * appearing right after you submit something.
 */
export function RunsBrowser({ initialRunId }: { initialRunId?: string }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(initialRunId ?? null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [resuming, setResuming] = useState(false);

  const loadDetail = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    const res = await fetch(`/api/runs/${runId}`);
    if (!res.ok) {
      setError(`Failed to load run ${runId} (HTTP ${res.status}).`);
      return;
    }
    setDetail(await res.json());
    setAnswers({});
  }, []);

  // The most recent task_run still waiting on a human, if the run is
  // currently paused — there's at most one, since the pipeline stops at the
  // first non-"completed" step.
  const pendingTaskRun = useMemo(() => {
    if (!detail || detail.run.status !== "needs_input") return null;
    const paused = detail.taskRuns.filter((tr) => tr.status === "needs_input");
    return paused[paused.length - 1] ?? null;
  }, [detail]);

  const pendingQuestions = useMemo(() => {
    const output = pendingTaskRun?.output as { questions?: PendingQuestion[] } | null | undefined;
    return output?.questions ?? [];
  }, [pendingTaskRun]);

  async function submitAnswers() {
    if (!selectedRunId) return;
    setResuming(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${selectedRunId}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to resume run (HTTP ${res.status}).`);
        return;
      }
      await loadDetail(selectedRunId);
      await refresh();
    } finally {
      setResuming(false);
    }
  }

  // Fetch-on-mount via the fetch's own callback, not by calling a
  // setState-holding function directly in the effect body, so a stale
  // response can't overwrite state after unmount.
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
      })
      .finally(() => {
        if (!cancelled) setLoadingList(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep-link support for /runs/[runId]: load that run's detail on mount,
  // same inline-callback pattern as above rather than calling loadDetail
  // (a setState-holding function) directly from the effect.
  useEffect(() => {
    if (!initialRunId) return;
    let cancelled = false;
    fetch(`/api/runs/${initialRunId}`)
      .then(async (res) => {
        if (!res.ok) {
          if (!cancelled) setError(`Failed to load run ${initialRunId} (HTTP ${res.status}).`);
          return;
        }
        const data = await res.json();
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [initialRunId]);

  async function refresh() {
    setError(null);
    const res = await fetch("/api/runs");
    if (!res.ok) {
      setError(`Failed to load runs (HTTP ${res.status}).`);
      return;
    }
    const data = await res.json();
    setRuns(data.runs ?? []);
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Runs</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Every pipeline invocation recorded in the <code className="text-xs">runs</code> table, most recent first.
          </p>
        </div>
        <button
          onClick={refresh}
          className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm text-zinc-700 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600"
        >
          Refresh
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
            {loadingList ? "Loading…" : `${runs.length} run${runs.length === 1 ? "" : "s"}`}
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
                    <span className="text-zinc-400">{new Date(run.created_at).toLocaleString()}</span>
                  </div>
                </button>
              </li>
            ))}
            {!loadingList && runs.length === 0 && <p className="text-xs text-zinc-400">No runs yet.</p>}
          </ol>
        </div>

        <div>
          {detail ? (
            <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-zinc-500">run_id: {detail.run.run_id}</span>
                <StatusBadge status={detail.run.status} />
              </div>

              {pendingTaskRun && (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
                  <p className="text-sm text-amber-900 dark:text-amber-300">
                    {pendingTaskRun.message ?? "This run is waiting on more information."}
                  </p>
                  {pendingQuestions.length > 0 ? (
                    pendingQuestions.map((q) => (
                      <label key={q.key} className="flex flex-col gap-1 text-xs text-amber-900 dark:text-amber-300">
                        {q.ask ?? q.label}
                        {q.options && q.options.length > 0 ? (
                          <select
                            className="rounded border border-amber-300 bg-white px-2 py-1 text-sm text-black dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                            value={answers[q.key] ?? ""}
                            onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                          >
                            <option value="" disabled>
                              Select {q.label.toLowerCase()}…
                            </option>
                            {q.options.map((opt) => (
                              <option key={opt} value={opt}>
                                {opt}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type="text"
                            className="rounded border border-amber-300 bg-white px-2 py-1 text-sm text-black dark:border-amber-800 dark:bg-zinc-950 dark:text-zinc-50"
                            value={answers[q.key] ?? ""}
                            onChange={(e) => setAnswers((a) => ({ ...a, [q.key]: e.target.value }))}
                            placeholder={q.label}
                          />
                        )}
                      </label>
                    ))
                  ) : (
                    <p className="text-xs text-amber-800 dark:text-amber-400">
                      No structured questions were recorded for this pause — check the output below for what&apos;s
                      missing.
                    </p>
                  )}
                  <button
                    onClick={submitAnswers}
                    disabled={resuming || pendingQuestions.length === 0}
                    className="self-start rounded-full bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {resuming ? "Submitting…" : "Submit and resume"}
                  </button>
                </div>
              )}

              <pre className="overflow-x-auto rounded bg-zinc-50 p-2 text-xs dark:bg-zinc-900">
                {JSON.stringify(detail.run.input, null, 2)}
              </pre>
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
