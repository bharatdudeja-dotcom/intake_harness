/**
 * Rules over a tool-call trace - the trajectory eval level (guide §5.2).
 *
 * A trajectory eval does NOT judge the final answer; it judges HOW the agent
 * got there: did it probe before deciding, did it stay within its
 * least-privilege tool set, did it avoid thrashing. The guide offers two ways
 * to do this - compare against a reference trajectory, or check a SET OF RULES
 * over the trace. We use rules, deliberately: this app's probes are
 * response-dependent (aep.ts's probeSchemas asks the union view FIRST and only
 * falls through to list+sample+field-group when that comes back empty), so an
 * exact-sequence reference would be brittle against a live sandbox that
 * answers differently run to run. Rules capture the invariants that hold
 * regardless of which branch the live data takes.
 *
 * The trace is exactly what production already records: withToolCallLog
 * (mcp-client.ts) returns { toolCalls } for anything run inside it, every MCP
 * call in order, with its args. Nothing new is instrumented - the eval reads
 * the same list task_runs.metadata.toolCalls stores.
 */

import type { ToolCallRecord } from "@/lib/mcp-client";

export type TrajectoryRules = {
  /** Tool names (bare, pre-gateway-prefix) that MUST appear at least once. */
  mustCall?: string[];
  /** Tool names that must NEVER appear - the observable half of the least-privilege boundary (e.g. no _create/_update/_delete for a read-only agent). */
  mustNotCall?: string[];
  /** Substrings that must not appear in ANY called tool name - catches a whole family (e.g. "_delete") without listing each. */
  mustNotCallMatching?: string[];
  /** [a, b] ordering: the first call to `a` must come before the first call to `b`. Skipped if either never appears. */
  mustPrecede?: Array<[string, string]>;
  /** Upper bound on total calls - the guide's "no more than N searches" efficiency rule. */
  maxCalls?: number;
};

export type TrajectoryCheck = { ok: boolean; notes: string };

/** Grade one trace against one rule set. Structural only - no model, no judge. */
export function checkTrajectory(calls: ToolCallRecord[], rules: TrajectoryRules): TrajectoryCheck {
  const names = calls.map((c) => c.name);
  const notes: string[] = [];
  let ok = true;

  const firstIndexOf = (name: string) => names.indexOf(name);

  for (const need of rules.mustCall ?? []) {
    if (!names.includes(need)) {
      ok = false;
      notes.push(`missing required call "${need}" (trace: ${names.join(" -> ") || "empty"})`);
    }
  }

  for (const banned of rules.mustNotCall ?? []) {
    if (names.includes(banned)) {
      ok = false;
      notes.push(`called forbidden tool "${banned}"`);
    }
  }

  for (const frag of rules.mustNotCallMatching ?? []) {
    const hit = names.find((n) => n.includes(frag));
    if (hit) {
      ok = false;
      notes.push(`called a tool matching forbidden pattern "${frag}": "${hit}"`);
    }
  }

  for (const [a, b] of rules.mustPrecede ?? []) {
    const ia = firstIndexOf(a);
    const ib = firstIndexOf(b);
    // Only meaningful when both actually happened; a branch that skipped one
    // isn't an ordering violation.
    if (ia !== -1 && ib !== -1 && ia > ib) {
      ok = false;
      notes.push(`ordering: "${a}" (at ${ia}) should precede "${b}" (at ${ib})`);
    }
  }

  if (rules.maxCalls !== undefined && calls.length > rules.maxCalls) {
    ok = false;
    notes.push(`made ${calls.length} tool calls, over the ${rules.maxCalls}-call budget`);
  }

  return { ok, notes: notes.join("; ") || `trace ok (${names.length} calls: ${names.join(" -> ") || "none"})` };
}
