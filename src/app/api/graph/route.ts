import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import type { RunRow } from "@/lib/pipeline/types";

type GraphNode = {
  id: string;
  label: string;
  tags: string[];
  approved_by: string | null;
  promoted_by: string | null;
  promoted_at: string | null;
};
type GraphEdge = { from: string; to: string; tag: string };

/**
 * GET: the Shared Graph — every promoted run as a node, plus edges between
 * any two runs that share an admin-declared tag.
 *
 * This is computed live from `runs` on every request, not stored as its own
 * document: with a relational store behind it, "which runs share a tag" is
 * a GROUP BY, so there's nothing to keep in sync and nothing that can go
 * stale between promotions. (The system this was ported from had to
 * pre-compile and cache this exact view, because its storage couldn't join
 * — see services/agent-manager/app/lib/cx-graph.js. Postgres means we
 * don't inherit that problem.)
 */
export async function GET() {
  const promoted = await query<RunRow>(
    `SELECT * FROM runs WHERE promoted = true ORDER BY promoted_at DESC`,
  );

  const nodes: GraphNode[] = promoted.map((r) => {
    const input = (r.input ?? {}) as { brief?: string };
    return {
      id: r.run_id,
      label: input.brief ? input.brief.slice(0, 80) : r.run_id.slice(0, 8),
      tags: r.tags,
      approved_by: r.approved_by,
      promoted_by: r.promoted_by,
      promoted_at: r.promoted_at,
    };
  });

  const byTag = new Map<string, string[]>();
  for (const r of promoted) {
    for (const tag of r.tags) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), r.run_id]);
    }
  }

  const edges: GraphEdge[] = [];
  for (const [tag, runIds] of byTag) {
    for (let i = 0; i < runIds.length; i++) {
      for (let j = i + 1; j < runIds.length; j++) {
        edges.push({ from: runIds[i], to: runIds[j], tag });
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
