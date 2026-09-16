"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type GraphNode = {
  id: string;
  label: string;
  tags: string[];
  approved_by: string | null;
  promoted_by: string | null;
  promoted_at: string | null;
};
type GraphEdge = { from: string; to: string; tag: string };
type Graph = { generated_at: string; node_count: number; edge_count: number; nodes: GraphNode[]; edges: GraphEdge[] };

/**
 * The Shared Graph: every run an admin has promoted, plus which of them are
 * connected by a shared tag. See GET /api/graph — this page just renders
 * what that route computes, live, from `runs` on every load.
 */
export default function GraphPage() {
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/graph")
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setGraph(await res.json());
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const edgesFor = (nodeId: string) => graph?.edges.filter((e) => e.from === nodeId || e.to === nodeId) ?? [];
  const labelFor = (id: string) => graph?.nodes.find((n) => n.id === id)?.label ?? id.slice(0, 8);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-12">
      <div>
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Shared Graph</h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Runs an admin has promoted as reusable examples, connected wherever two promoted runs share a tag. Approve
          and promote a run from its{" "}
          <Link href="/runs" className="underline">
            Runs
          </Link>{" "}
          page.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {graph && graph.nodes.length === 0 && (
        <p className="text-sm text-zinc-400">Nothing promoted yet — approve a completed run, then promote it.</p>
      )}

      <ol className="flex flex-col gap-3">
        {graph?.nodes.map((node) => (
          <li
            key={node.id}
            className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/runs/${node.id}`} className="font-medium text-black underline dark:text-zinc-50">
                {node.label}
              </Link>
              <span className="font-mono text-xs text-zinc-400">{node.id.slice(0, 8)}</span>
            </div>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Approved by {node.approved_by} · Promoted by {node.promoted_by}
            </p>
            {node.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {node.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800 dark:bg-purple-950 dark:text-purple-400"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {edgesFor(node.id).length > 0 && (
              <div className="text-xs text-zinc-500 dark:text-zinc-400">
                Shares a tag with:{" "}
                {edgesFor(node.id)
                  .map((e) => `${labelFor(e.from === node.id ? e.to : e.from)} (${e.tag})`)
                  .join(", ")}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
