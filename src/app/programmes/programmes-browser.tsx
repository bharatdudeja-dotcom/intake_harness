"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { ProgrammeRow } from "@/lib/programmes";
import type { RunRow } from "@/lib/pipeline/types";
import { StatusBadge } from "../status-badge";

/**
 * Programmes — named groupings for runs, ported from Agent Manager's
 * Project. A run joins one by name at submission time (the "Programme"
 * field on the landing page), upserted idempotently — this page just
 * lists what exists and, on selection, which runs are in it.
 */
export function ProgrammesBrowser() {
  const [programmes, setProgrammes] = useState<ProgrammeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ programme: ProgrammeRow; runs: RunRow[] } | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/programmes");
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? `Failed to load programmes (HTTP ${res.status}).`);
      return;
    }
    setProgrammes(data.programmes ?? []);
  }, []);

  // Fetch-on-mount via the fetch's own callback, not by calling `refresh`
  // (a setState-holding function) directly in the effect body — same
  // pattern as runs-browser.tsx.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/programmes")
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          if (!cancelled) setError(data?.error ?? `Failed to load programmes (HTTP ${res.status}).`);
          return;
        }
        if (!cancelled) setProgrammes(data.programmes ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadDetail(programmeId: string) {
    const res = await fetch(`/api/programmes/${programmeId}`);
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error ?? `Failed to load programme (HTTP ${res.status}).`);
      return;
    }
    setSelected(data);
  }

  async function createProgramme() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/programmes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), note: note.trim() || undefined }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error ?? `Failed to create programme (HTTP ${res.status}).`);
        return;
      }
      setName("");
      setNote("");
      setShowForm(false);
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex max-w-4xl flex-col gap-6 px-8 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Programmes</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Named groupings for runs — set the &quot;Programme&quot; field when submitting a brief to join one.
          </p>
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white dark:bg-zinc-100 dark:text-black"
        >
          {showForm ? "Cancel" : "+ New"}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {showForm && (
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <input
            type="text"
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            placeholder="Programme name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            type="text"
            className="rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-50"
            placeholder="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            onClick={createProgramme}
            disabled={creating || !name.trim()}
            className="self-start rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-black"
          >
            {creating ? "Creating…" : "Create"}
          </button>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <ol className="flex flex-col gap-1">
          {loading && <p className="text-xs text-zinc-400">Loading…</p>}
          {!loading && programmes.length === 0 && <p className="text-xs text-zinc-400">No programmes yet.</p>}
          {programmes.map((p) => (
            <li key={p.programme_id}>
              <button
                onClick={() => loadDetail(p.programme_id)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  selected?.programme.programme_id === p.programme_id
                    ? "border-zinc-900 dark:border-zinc-100"
                    : "border-zinc-200 dark:border-zinc-800"
                } bg-white dark:bg-zinc-950`}
              >
                <span className="font-medium text-black dark:text-zinc-50">{p.name}</span>
                {p.note && <p className="text-xs text-zinc-500">{p.note}</p>}
              </button>
            </li>
          ))}
        </ol>

        <div>
          {selected ? (
            <div className="flex flex-col gap-2">
              <h2 className="text-sm font-semibold text-black dark:text-zinc-50">
                {selected.runs.length} run{selected.runs.length === 1 ? "" : "s"} in {selected.programme.name}
              </h2>
              <ol className="flex flex-col gap-1">
                {selected.runs.map((run) => (
                  <li key={run.run_id}>
                    <Link
                      href={`/runs/${run.run_id}`}
                      className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-600"
                    >
                      <span className="font-mono text-zinc-500">{run.run_id.slice(0, 8)}</span>
                      <StatusBadge status={run.status} />
                    </Link>
                  </li>
                ))}
                {selected.runs.length === 0 && <p className="text-xs text-zinc-400">No runs in this programme yet.</p>}
              </ol>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">Select a programme to see its runs.</p>
          )}
        </div>
      </div>
    </div>
  );
}
