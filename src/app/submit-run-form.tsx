"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Kicks off a pipeline run, then hands off to /runs/[runId] to watch it — see runs-browser.tsx for the actual observability view. */
export function SubmitRunForm() {
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      router.push(`/runs/${data.run.run_id}`);
    } catch (err) {
      setError((err as Error).message);
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
    </div>
  );
}
