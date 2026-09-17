import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { RunRow } from "@/lib/pipeline/types";
import { RESOURCE_TYPE_LABELS, type ResourceRow } from "@/lib/resources";

type GraphNode = {
  id: string;
  kind: "run" | "resource";
  label: string;
  tags: string[];
  approved_by: string | null;
  promoted_by: string | null;
  promoted_at: string | null;
};
type GraphEdge = { from: string; to: string; tag: string };

/**
 * GET: the Shared Graph — every promoted run AND every promoted resource
 * (Playbooks, Decisions, etc.) as one set of nodes, plus edges between any
 * two that share an admin-declared tag. Runs and resources share the exact
 * same two-tier curation model (approved -> promoted), so they share one
 * graph rather than two.
 *
 * Computed live on every request, not stored as its own document: with a
 * relational store behind it, "which nodes share a tag" is a GROUP BY, so
 * there's nothing to keep in sync and nothing that can go stale between
 * promotions. (The system this was ported from had to pre-compile and
 * cache this exact view, because its storage couldn't join — see
 * services/agent-manager/app/lib/cx-graph.js. Postgres means we don't
 * inherit that problem.)
 */
export async function GET() {
  const [promotedRuns, promotedResources] = await Promise.all([
    query<RunRow>(`SELECT * FROM runs WHERE promoted = true ORDER BY promoted_at DESC`),
    query<ResourceRow>(`SELECT * FROM resources WHERE promoted = true ORDER BY promoted_at DESC`),
  ]);

  const nodes: GraphNode[] = [
    ...promotedRuns.map((r): GraphNode => {
      const input = (r.input ?? {}) as { brief?: string };
      return {
        id: r.run_id,
        kind: "run",
        label: input.brief ? input.brief.slice(0, 80) : r.run_id.slice(0, 8),
        tags: r.tags,
        approved_by: r.approved_by,
        promoted_by: r.promoted_by,
        promoted_at: r.promoted_at,
      };
    }),
    ...promotedResources.map((r): GraphNode => ({
      id: r.resource_id,
      kind: "resource",
      label: `${RESOURCE_TYPE_LABELS[r.type]}: ${r.title}`,
      tags: r.tags,
      approved_by: r.approved_by,
      promoted_by: r.promoted_by,
      promoted_at: r.promoted_at,
    })),
  ];

  const byTag = new Map<string, string[]>();
  for (const n of nodes) {
    for (const tag of n.tags) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), n.id]);
    }
  }

  const edges: GraphEdge[] = [];
  for (const [tag, ids] of byTag) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        edges.push({ from: ids[i], to: ids[j], tag });
      }
    }
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    node_count: nodes.length,
    edge_count: edges.length,
    nodes,
    edges,
  });
}
