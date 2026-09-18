/**
 * Explicit, on-command audience activation - Agent 3's one WRITE-ADJACENT
 * capability, and the one place in this agent that isn't "everything here
 * is a READ" (see aep.ts's own docstring). OFF BY DEFAULT: nothing in this
 * file runs unless the brief itself says, in so many words, to activate the
 * audience somewhere (detectActivationIntent). Every other decision this
 * agent makes - build path, attribute checks, count prediction - behaves
 * exactly as it always has, with or without this module ever firing.
 *
 * WHAT THIS ACTUALLY DOES, AND WHAT IT DELIBERATELY DOES NOT DO
 *
 * Grounded against a live sandbox, 19 Sep 2026 - not guessed. Destinations
 * here are DATAFLOWS (destination_list_dataflows / destination_get_dataflow),
 * each carrying its own `segment_selectors`: the actual list of segments
 * activated to it. Two things follow from what's really available:
 *
 * 1. There is no tool that ADDS a segment to an EXISTING dataflow's
 *    selectors. destination_update_dataflow only supports renaming and
 *    rescheduling - its schema has no segment_selectors field at all.
 *    destination_create_dataflow does take segment_selectors, but it
 *    creates a NEW dataflow with that exact list - it does not merge into
 *    an existing one. So if the named destination already exists with
 *    segments wired to it, there is no safe way to add ours without either
 *    duplicating the dataflow or silently dropping everything it already
 *    activates.
 *
 * 2. What IS safe, and is the actual answer for the brief this module was
 *    built against ("create an audience where ECID exists, and activate it
 *    to Chauncey's custom destination"): a real segment named "Has ECID"
 *    already existed, and was ALREADY activated to a real dataflow named
 *    "chaunceys custom dest" - this agent just never looked, because
 *    findExistingSegment's search terms were only intake's own
 *    categorization fields, never the audience's actual criteria (see
 *    aep.ts's criteriaKeywords). So the highest-value, lowest-risk thing
 *    this module does is confirm and report that, rather than attempt any
 *    write at all.
 *
 * When neither of those applies - no existing segment, or an existing
 * segment that genuinely needs wiring a human has to do - this reports
 * exactly what's blocking rather than guessing at a write. An unsafe write
 * is worse than an honest dry run; that rule runs through every write in
 * this codebase, and this is no exception.
 */

import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";
import { criteriaKeywords } from "./aep";

export type ActivationIntent = {
  requested: boolean;
  destinationName: string | null;
  evidence: string | null;
};

/**
 * Does the brief explicitly ask to activate the audience somewhere?
 *
 * Looked for as an actual verb - activate/send/push/sync "to" a named
 * destination - never inferred from request_type's "Audience + Campaign
 * Execution", which is a Workfront-form category for routing the intake
 * issue, not a statement that a real AEP activation should happen right
 * now. The whole point of "unless the user gives an explicit command" is
 * that this has to be a real, specific ask, not a proxy for one.
 */
export function detectActivationIntent(brief: string | undefined): ActivationIntent {
  const text = String(brief || "");
  const m = text.match(
    /\b(?:activate|send|push|sync)\b(?:\s+\w+){0,4}?\s+(?:it|this|the audience|them)?\s*(?:to|into)\s+([^.,;]{3,80})/i,
  );
  if (!m) return { requested: false, destinationName: null, evidence: null };
  const destinationName = m[1].trim().replace(/^(the|a|an)\s+/i, "").trim();
  return { requested: true, destinationName: destinationName || null, evidence: m[0] };
}

type DataflowRecord = {
  id: string;
  name: string;
  segmentSelectors: unknown;
};

type DestinationMatch = {
  read: boolean;
  error: string | null;
  dataflow: DataflowRecord | null;
  considered: number;
};

/**
 * Fuzzy-match a destination name against real, existing dataflows - the
 * same word-overlap scoring aep.ts's findExistingSegment uses for segments,
 * reusing its criteriaKeywords so "Chauncey's custom destination" and a
 * real dataflow named "chaunceys custom dest" can find each other despite
 * neither being an exact string.
 */
async function findDestinationDataflow(taskId: TaskId, destinationName: string): Promise<DestinationMatch> {
  try {
    const result = await callMcpTool<{ dataflows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
      taskId,
      "destination_list_dataflows",
      { limit: "50" },
    );
    const rows = (Array.isArray(result) ? result : (result as { dataflows?: unknown[] })?.dataflows || []) as Array<
      Record<string, unknown>
    >;

    const meaningful = criteriaKeywords(destinationName);
    let best: { id: string; name: string; score: number } | null = null;
    for (const row of rows) {
      const name = String(row.name || "");
      const id = String(row.id || "");
      if (!name || !id) continue;
      const hay = name.toLowerCase();
      const score = meaningful.filter((t) => hay.includes(t)).length;
      if (score > 0 && (!best || score > best.score)) best = { id, name, score };
    }

    if (!best) {
      return { read: true, error: null, dataflow: null, considered: rows.length };
    }

    const detail = await callMcpTool<Record<string, unknown>>(taskId, "destination_get_dataflow", {
      flow_id: best.id,
    });
    return {
      read: true,
      error: null,
      dataflow: { id: best.id, name: best.name, segmentSelectors: detail?.segment_selectors ?? null },
      considered: rows.length,
    };
  } catch (err) {
    return { read: false, error: (err as Error).message, dataflow: null, considered: 0 };
  }
}

/**
 * Does a dataflow's segment_selectors already include this segment id?
 * Walks defensively rather than assuming the exact nesting - the real
 * shape (verified live) is
 * segment_selectors[].params.segmentSelectors.selectors[].value.id, but
 * this reads any {id|systemSegmentId} it finds anywhere in the structure
 * so a shape variation degrades to "checked more than necessary" rather
 * than "missed a real match."
 */
function selectorsIncludeSegment(segmentSelectors: unknown, segmentId: string): boolean {
  let hit = false;
  const walk = (v: unknown, depth = 0) => {
    if (hit || depth > 8 || v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.id === segmentId || o.systemSegmentId === segmentId) {
      hit = true;
      return;
    }
    for (const val of Object.values(o)) walk(val, depth + 1);
  };
  walk(segmentSelectors);
  return hit;
}

export type ActivationOutcome =
  | { status: "already_active"; destinationName: string; dataflowId: string }
  | { status: "no_destination_named"; reason: string }
  | { status: "destination_not_found"; requestedName: string; reason: string | null; considered: number }
  | { status: "needs_manual_wiring"; destinationName: string; dataflowId: string; reason: string }
  | { status: "no_segment_to_activate"; reason: string };

/**
 * The activation decision, given a segment findExistingSegment already
 * found (or didn't) and an explicitly requested destination name.
 */
export async function activateAudience(
  taskId: TaskId,
  args: { segmentId: string | null; segmentName: string | null; destinationName: string | null },
): Promise<ActivationOutcome> {
  if (!args.destinationName) {
    return {
      status: "no_destination_named",
      reason: "Activation was requested but no destination was named in the brief - nothing to wire this to.",
    };
  }

  if (!args.segmentId) {
    return {
      status: "no_segment_to_activate",
      reason:
        "No existing segment matched this audience, and creating a brand-new one requires a real PQL expression - " +
        "which this agent will not author from scratch. The knowledge base does not have PQL's actual operators/" +
        "syntax indexed (see review's PQL grounding), so a guessed expression risks silently selecting the wrong " +
        "audience rather than failing visibly. Supply the exact PQL expression to build and activate a new segment.",
    };
  }

  const match = await findDestinationDataflow(taskId, args.destinationName);
  if (!match.dataflow) {
    return {
      status: "destination_not_found",
      requestedName: args.destinationName,
      reason: match.error,
      considered: match.considered,
    };
  }

  if (selectorsIncludeSegment(match.dataflow.segmentSelectors, args.segmentId)) {
    return { status: "already_active", destinationName: match.dataflow.name, dataflowId: match.dataflow.id };
  }

  return {
    status: "needs_manual_wiring",
    destinationName: match.dataflow.name,
    dataflowId: match.dataflow.id,
    reason:
      `"${args.segmentName ?? args.segmentId}" is not yet on this destination's dataflow (${match.dataflow.id}), ` +
      "and there is no tool that safely adds a segment to an EXISTING dataflow's selectors - " +
      "destination_update_dataflow only supports renaming/rescheduling, and destination_create_dataflow would " +
      "replace the whole selector list on a NEW dataflow rather than merge into this one. Wire this up in the " +
      "Segment Builder/Destinations UI rather than risk dropping this destination's other activations.",
  };
}
