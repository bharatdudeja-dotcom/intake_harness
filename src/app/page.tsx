import Link from "next/link";
import { ESCALATION, PIPELINE } from "@/lib/pipeline/registry";
import { SubmitRunForm } from "./submit-run-form";

export default function Home() {
  return (
    <div className="min-h-full bg-zinc-50 dark:bg-black">
      <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-16">
        <div>
          <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
            Agentic Harness
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Submits a request through the 3-agent pipeline, one HTTP call per
            agent, in order. A 4th agent handles escalation if a run fails.
            See every run in the database on the{" "}
            <Link href="/runs" className="underline">Runs</Link> page.
          </p>
        </div>

        <ol className="flex flex-col gap-2">
          {PIPELINE.map((agent, i) => (
            <li
              key={agent.name}
              className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900 text-xs font-medium text-white dark:bg-zinc-100 dark:text-black">
                {i + 1}
              </span>
              <span className="font-medium text-black dark:text-zinc-50">{agent.label}</span>
              <span className="ml-auto text-xs text-zinc-500">{agent.owner}</span>
              <code className="text-xs text-zinc-400">{agent.path}</code>
            </li>
          ))}
          {/* Escalation isn't step 4 of the sequence above — it's called out
              of band by the orchestrator only when a run fails, so it's
              rendered separately rather than numbered 4 in the same list. */}
          <li
            key={ESCALATION.name}
            className="flex items-center gap-3 rounded-lg border border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/30"
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

        <SubmitRunForm />
      </main>
    </div>
  );
}
