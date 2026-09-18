import Link from "next/link";
import { ESCALATION, PIPELINE } from "@/lib/pipeline/registry";
import { getRunStats } from "@/lib/pipeline/orchestrator";
import { PipelineChat } from "./pipeline-chat";

// The stat tiles read `runs` on every request, so this can't be statically
// prerendered at build time (when DATABASE_URL generally isn't set) — same
// reason every /api/* route here is dynamic.
export const dynamic = "force-dynamic";

export default async function Home() {
  const stats = await getRunStats();
  const tiles: { label: string; value: number }[] = [
    { label: "total runs", value: stats.total },
    { label: "needs input", value: stats.needsInput },
    { label: "failed", value: stats.failed },
    { label: "approved", value: stats.approved },
    { label: "promoted", value: stats.promoted },
  ];

  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <main className="flex max-w-7xl flex-col gap-8 px-4 py-6 sm:px-8 sm:py-10">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Home
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Describe a campaign below. Agent 1 (Intake) runs first, then each
            later agent waits for your approval before it runs. See every run
            in the database on the{" "}
            <Link href="/runs" className="underline">Runs</Link> page.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {tiles.map((tile) => (
            <div
              key={tile.label}
              className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950"
            >
              <p className="text-2xl font-bold text-black dark:text-zinc-50">{tile.value}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{tile.label}</p>
            </div>
          ))}
        </div>

        <PipelineChat />

        <details className="rounded-lg border border-zinc-200 bg-white text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <summary className="cursor-pointer px-4 py-3 font-medium text-black dark:text-zinc-50">
            How the pipeline works
          </summary>
          <ol className="flex flex-col gap-2 px-4 pb-4">
            {PIPELINE.map((agent, i) => (
              <li
                key={agent.name}
                className="flex items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-medium text-white dark:bg-zinc-100 dark:text-black">
                  {i + 1}
                </span>
                <span className="font-medium text-black dark:text-zinc-50">{agent.label}</span>
                <span className="ml-auto text-xs text-zinc-500">{agent.owner}</span>
                <code className="text-xs text-zinc-400">{agent.path}</code>
              </li>
            ))}
            {/* Escalation isn't step 4 of the sequence above — it's called
                out of band by the orchestrator only when a run fails, so
                it's rendered separately rather than numbered 4 in the same
                list. */}
            <li
              key={ESCALATION.name}
              className="flex items-center gap-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/30"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500 text-xs font-medium text-white dark:bg-amber-600">
                !
              </span>
              <span className="font-medium text-black dark:text-zinc-50">{ESCALATION.label}</span>
              <span className="text-xs text-amber-700 dark:text-amber-500">on failure</span>
              <span className="ml-auto text-xs text-zinc-500">{ESCALATION.owner}</span>
              <code className="text-xs text-zinc-400">{ESCALATION.path}</code>
            </li>
          </ol>
        </details>
      </main>
    </div>
  );
}
