/**
 * Capability signals - the things the agents CANNOT do because of the
 * environment, surfaced as first-class, queryable facts instead of being
 * inferred by a reader from a `created: false` buried in one run's output.
 *
 * Two capabilities gate whether this pipeline can actually finish its job,
 * and both are outside this app's control:
 *
 *   1. WORKFRONT WRITES. 44 of the connector's 94 tools are writes a
 *      Workfront admin enables per tenant (Setup > System > Preferences).
 *      Until then Agent 1 creates nothing - it produces an honest dry-run
 *      "wouldHaveCreated" payload. Whether that switch is on is the single
 *      biggest "can it do the job" question, and it should be answerable
 *      directly, not deduced from a run that happened to dry-run.
 *
 *   2. THE SEGMENT-ESTIMATE TOOLS. adobe_create_segment_estimate /
 *      adobe_get_segment_estimate 404 on every real segment id (a gateway
 *      bug, verified live - see agents/audience/aep.ts). B3/B6's "predict
 *      the count before the marketer sees a number they don't recognise" is
 *      unmet because of it. It was removed from Agent 3's allowlist rather
 *      than left as a call site that always fails; this reports WHY the
 *      count is unavailable so it reads as a tracked upstream dependency,
 *      not a silent omission.
 *
 * This asks the gateway what tools it actually exposes (tools/list) and
 * checks for the specific names, so the answer reflects the live
 * deployment rather than a hardcoded assumption. It is a diagnostic, not an
 * agent tool call, so it does NOT go through callMcpTool's per-task
 * allowlist - it lists tools, it invokes none.
 */

import { workfrontToolset } from "@/lib/workfront-tools";

/** The write tools whose presence means "Agent 1 can actually create in Workfront". */
function workfrontWriteToolNames(): string[] {
  const set = workfrontToolset();
  return [set.create, set.update, set.createComment];
}

/** The segment-estimate tools B3/B6's count prediction needs (known-broken upstream). */
const SEGMENT_ESTIMATE_TOOLS = ["adobe_create_segment_estimate", "adobe_get_segment_estimate"];

export type CapabilityReport = {
  checkedAt: string;
  /** False when no gateway/endpoint is configured - we then can't check anything. */
  reachable: boolean;
  endpoint: string | null;
  error: string | null;
  workfrontWrites: {
    /** Are the write tools present in the live tool list? */
    enabled: boolean | "unknown";
    tools: Array<{ name: string; present: boolean }>;
    note: string;
  };
  segmentEstimate: {
    /** Present in the list? (Presence still doesn't mean it works - see note.) */
    available: boolean | "unknown";
    tools: Array<{ name: string; present: boolean }>;
    note: string;
  };
};

/** Resolve the one endpoint to ask for a tool list - gateway if set, else the AEC base. */
function listEndpoint(): string | null {
  const gateway = process.env.MCP_GATEWAY_URL;
  if (gateway && gateway.trim()) return gateway.trim().replace(/\/+$/, "");
  const base = process.env.MCP_ENDPOINT_URL;
  if (base && base.trim()) return base.trim();
  return null;
}

/** Headers for the tools/list call - mirror the gateway auth the client uses. */
function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const gateway = process.env.MCP_GATEWAY_URL;
  const token = process.env.MCP_GATEWAY_TOKEN;
  if (gateway && gateway.trim() && token && token.trim()) {
    const name = (process.env.MCP_GATEWAY_HEADER || "Authorization").trim();
    h[name] =
      name.toLowerCase() === "authorization" && !token.startsWith("Bearer ") ? `Bearer ${token}` : token;
  }
  return h;
}

/**
 * Ask the endpoint for its tool list and return the set of tool names it
 * exposes. Names may be gateway-namespaced (server__tool), so callers match
 * on suffix. Returns null (not throw) on any failure - "couldn't check" is a
 * capability answer of its own ("unknown"), not an error to surface as 500.
 */
async function liveToolNames(endpoint: string): Promise<Set<string> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { tools?: Array<{ name?: string }> } };
    const names = body.result?.tools?.map((t) => String(t.name || "")).filter(Boolean) ?? [];
    return new Set(names);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** A tool "is present" if its bare name, or any namespaced `*__name`, is in the live set. */
function present(names: Set<string>, bare: string): boolean {
  if (names.has(bare)) return true;
  for (const n of names) {
    if (n === bare || n.endsWith(`__${bare}`)) return true;
  }
  return false;
}

export async function getCapabilities(): Promise<CapabilityReport> {
  const checkedAt = new Date().toISOString();
  const endpoint = listEndpoint();

  if (!endpoint) {
    return {
      checkedAt,
      reachable: false,
      endpoint: null,
      error: "No MCP_GATEWAY_URL or MCP_ENDPOINT_URL configured, so no capability can be checked.",
      workfrontWrites: {
        enabled: "unknown",
        tools: workfrontWriteToolNames().map((name) => ({ name, present: false })),
        note: "Endpoint not configured.",
      },
      segmentEstimate: {
        available: "unknown",
        tools: SEGMENT_ESTIMATE_TOOLS.map((name) => ({ name, present: false })),
        note: "Endpoint not configured.",
      },
    };
  }

  const names = await liveToolNames(endpoint);

  if (!names) {
    return {
      checkedAt,
      reachable: false,
      endpoint,
      error: "Could not read a tool list from the endpoint (unreachable, timed out, or non-2xx).",
      workfrontWrites: {
        enabled: "unknown",
        tools: workfrontWriteToolNames().map((name) => ({ name, present: false })),
        note: "Tool list could not be read; write-enablement is unknown, not disabled.",
      },
      segmentEstimate: {
        available: "unknown",
        tools: SEGMENT_ESTIMATE_TOOLS.map((name) => ({ name, present: false })),
        note: "Tool list could not be read.",
      },
    };
  }

  const wfTools = workfrontWriteToolNames().map((name) => ({ name, present: present(names, name) }));
  const wfEnabled = wfTools.every((t) => t.present);

  const estTools = SEGMENT_ESTIMATE_TOOLS.map((name) => ({ name, present: present(names, name) }));
  const estPresent = estTools.every((t) => t.present);

  return {
    checkedAt,
    reachable: true,
    endpoint,
    error: null,
    workfrontWrites: {
      enabled: wfEnabled,
      tools: wfTools,
      note: wfEnabled
        ? "Workfront write tools are present - Agent 1 can create the intake for real, not dry-run."
        : "One or more Workfront write tools are absent - writes are NOT enabled on this tenant " +
          "(a Workfront admin turns them on in Setup > System > Preferences). Agent 1 will dry-run: " +
          "it reports the exact payload it would have created rather than writing nothing silently.",
    },
    segmentEstimate: {
      available: estPresent,
      tools: estTools,
      note: estPresent
        ? "Segment-estimate tools are listed, but they were verified to 404 on real segment ids upstream - " +
          "presence in the catalog is not the same as working. Agent 3 still does not predict a count."
        : "Segment-estimate tools are absent from the catalog - B3/B6 count prediction is unavailable, " +
          "a known upstream gateway limitation (see agents/audience/aep.ts). Tracked, not silently dropped.",
    },
  };
}
