import Link from "next/link";
import { listActiveRuns } from "@/lib/pipeline/orchestrator";
import { StatusBadge } from "../status-badge";

export const dynamic = "force-dynamic";

/** Live Queue — every run currently waiting on a human (needs_input, awaiting_approval) or possibly stuck (running), oldest first. */
export default async function QueuePage() {
  const runs = await listActiveRuns();

  return (
    <div className="flex max-w-3xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Live Queue</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Every run currently waiting on a human, oldest first. A run stuck at &quot;running&quot; for a while is
          worth checking on its own{" "}
          <Link href="/runs" className="underline">
            Runs
          </Link>{" "}
          page.
        </p>
      </div>

      {runs.length === 0 ? (
        <p className="text-sm text-zinc-400">Nothing waiting — every run is either completed or failed.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {runs.map((run) => (
            <li key={run.run_id}>
              <Link
                href={`/runs/${run.run_id}`}
                className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm hover:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-zinc-600"
              >
                <StatusBadge status={run.status} />
                <span className="font-mono text-xs text-zinc-500">{run.run_id.slice(0, 8)}</span>
                <span className="ml-auto text-xs text-zinc-400">
                  waiting since {new Date(run.updated_at).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
