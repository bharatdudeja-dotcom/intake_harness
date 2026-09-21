/**
 * Activating the audience - building it was only half the job.
 *
 * A segment sitting in AEP reaches nobody. Until it is activated to a
 * destination, the campaign the marketer filed cannot send, and the pipeline
 * was reporting "audience built" as though that were the end of it. It is
 * not: B5's own wording is activation, and the run is not finished until the
 * audience is somewhere a channel can use it.
 *
 * OFF UNLESS THE BRIEF ASKS. Nothing here fires for a build-only request.
 * Activation sends a real population to a real external system, so it needs
 * to have been asked for, and `request_type: Audience Build-Only` means it
 * was not.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO
 *
 * Grounded against the live tenant on 21 Sep 2026, not guessed:
 *
 * 1. `destination_update_dataflow_audiences` is the correct operation and it
 *    exists - "Add or remove activated audiences on an existing destination
 *    dataflow", taking `flow_id` and `add_audience_ids`. An earlier design in
 *    this repo concluded no such tool existed and worked around it by
 *    CREATING AN ADDITIONAL DATAFLOW for the segment. That workaround is not
 *    needed and is not used here: a second dataflow pointing at the same
 *    destination is a thing a human then has to understand and clean up.
 *
 * 2. It never CREATES a destination, a base connection or a dataflow. Those
 *    define where a client's customer data is sent and with which
 *    credentials; an agent proposing that is an agent exceeding its remit.
 *    When the named destination has no dataflow in this sandbox, this
 *    declines and says precisely what a human has to create.
 *
 * 3. It checks first. A segment already activated to that destination is
 *    reported as already active, with no write attempted.
 *
 * THE SANDBOX IS NOT OPTIONAL. Verified the hard way: the destination tools
 * default to `sandbox: "prod"`, and the demo's segments live in `tapdemo`. A
 * listing taken without the sandbox shows prod's dataflows, which is how a
 * probe concluded that the tenant had destinations when the sandbox holding
 * the segment has none at all. Every call below passes it explicitly.
 */

import { callMcpTool } from "@/lib/mcp-client";
import type { TaskId } from "@/lib/pipeline/types";

/** Answers meaning "no destination, build the audience only" - not a destination named "none". */
const NOT_A_DESTINATION = new Set([
  "", "n/a", "na", "none", "no", "not applicable", "no destination",
  "build-only", "build only", "audience only", "audience build-only",
  "not yet", "tbd", "to be confirmed",
]);

export type ActivationIntent = {
  requested: boolean;
  destinationName: string | null;
  /** What in the brief said so, quoted, so a reader can disagree with it. */
  evidence: string | null;
};

export type ActivationResult =
  | { state: "not_requested"; detail: string }
  | { state: "already_active"; flowId: string; flowName: string; detail: string }
  | { state: "activated"; flowId: string; flowName: string; detail: string }
  | { state: "declined"; detail: string; needsHuman: string }
  | { state: "failed"; detail: string };

/**
 * Did the brief ask for this audience to go somewhere?
 *
 * The intake field wins over the prose. `request_type` is the marketer's own
 * answer to "audience only, or audience and campaign execution", and it is
 * the question this depends on - reading the prose first means a stray
 * "send it to the team for review" can turn a build-only request into an
 * activation.
 *
 * `channels` is NOT treated as a destination. "Email" is a channel, not a
 * place in AEP, and guessing which email destination a marketer meant is
 * exactly the kind of inference that produced the wrong audience earlier in
 * this project's history.
 */
export function resolveActivationIntent(fields: Record<string, string>): ActivationIntent {
  const named = String(fields.destination ?? "").trim();
  if (named && !NOT_A_DESTINATION.has(named.toLowerCase())) {
    return { requested: true, destinationName: named, evidence: `the brief's destination: "${named}"` };
  }

  const requestType = String(fields.request_type ?? "").toLowerCase();
  if (requestType.includes("build-only") || requestType.includes("build only")) {
    return {
      requested: false,
      destinationName: null,
      evidence: `request type "${fields.request_type}" - the audience is the deliverable`,
    };
  }

  /*
   * Activation as an explicit verb, with a named place after it. Not
   * "Audience + Campaign Execution" on its own: that says the campaign will
   * run, not which AEP destination it runs out of, and the marketer is the
   * one who knows.
   */
  const prose = Object.values(fields).join(" ");
  /*
   * The name ends where the sentence moves on.
   *
   * A greedy tail read "Activate it to Adobe Campaign once approved" as a
   * destination called "Adobe Campaign once approved", and the lookup would
   * then hunt for a dataflow by that name, miss, and decline for a reason
   * unrelated to the real one. A destination name does not contain "once",
   * "when", "after", "for", a comma or a full stop.
   */
  const verb = prose.match(
    new RegExp(
      "\\b(?:activate|activation to|send|push|sync|deliver)" +
      "\\s+(?:it|the audience|this audience)?\\s*(?:to|into)\\s+" +
      "([A-Za-z0-9][A-Za-z0-9 _./&'-]{2,48}?)" +
      "(?=\\s+(?:once|when|after|before|if|so|for|as|and|then|to)\\b|[.,;:!?\\n]|$)",
      "i",
    ),
  );
  if (verb) {
    const place = verb[1].trim().replace(/[.,;]+$/, "");
    if (!NOT_A_DESTINATION.has(place.toLowerCase())) {
      return { requested: true, destinationName: place, evidence: `the brief says "${verb[0].trim()}"` };
    }
  }

  return {
    requested: false,
    destinationName: null,
    evidence: "the brief names no AEP destination, and a channel is not a destination",
  };
}

type Dataflow = { id?: string; flowId?: string; name?: string; state?: string };

function flowId(f: Dataflow): string | null {
  return f.id ?? f.flowId ?? null;
}

/** Loose name match, because a marketer writes "the S3 bucket", not the dataflow's exact label. */
function looksLike(flowName: string, wanted: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = norm(flowName);
  const b = norm(wanted);
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  // Every significant word of the request appears in the flow's name.
  const words = b.split(" ").filter((w) => w.length > 2);
  return words.length > 0 && words.every((w) => a.includes(w));
}

/**
 * Put the segment on the destination's dataflow.
 *
 * Returns a state rather than throwing: an audience that was built and not
 * activated is a partial success worth reporting precisely, and a thrown
 * error here would be indistinguishable from the build having failed.
 */
export async function activateAudience(
  taskId: TaskId,
  opts: { segmentId: string; destinationName: string; sandbox: string },
): Promise<ActivationResult> {
  const { segmentId, destinationName, sandbox } = opts;

  let flows: Dataflow[];
  try {
    const listed = await callMcpTool<unknown>(taskId, "destination_list_dataflows", { sandbox });
    flows = Array.isArray(listed)
      ? (listed as Dataflow[])
      : (((listed as Record<string, unknown>)?.items
        ?? (listed as Record<string, unknown>)?.dataflows
        ?? (listed as Record<string, unknown>)?.flows ?? []) as Dataflow[]);
  } catch (err) {
    return { state: "failed", detail: `Could not list destination dataflows in "${sandbox}": ${(err as Error).message}` };
  }

  const match = flows.find((f) => f.name && looksLike(f.name, destinationName));
  if (!match || !flowId(match)) {
    /*
     * Declining, with the specific thing a human must do.
     *
     * "Activation failed" would be useless here, and inventing a destination
     * would be worse. On this tenant the tapdemo sandbox holds twenty
     * dataflows and not one is a destination - they are all Datalake-to-UPS
     * and per-dataset plumbing - so this is the live case, not a theoretical
     * one.
     */
    const names = flows.map((f) => f.name).filter(Boolean).slice(0, 8).join(", ");
    return {
      state: "declined",
      detail:
        `The audience was built, and NOT activated. Sandbox "${sandbox}" has no destination dataflow ` +
        `matching "${destinationName}"` + (names ? `. Dataflows present: ${names}` : "."),
      needsHuman:
        `Create the destination "${destinationName}" in AEP for sandbox "${sandbox}" and connect one ` +
        "dataflow to it. Configuring where a client's customer data is sent, and with which " +
        "credentials, is a decision for a person - so this stops here rather than creating one. " +
        "Once that dataflow exists, this step activates the audience to it with no further change.",
    };
  }

  const id = flowId(match) as string;

  // Already wired? Then there is nothing to write, and saying so is the answer.
  try {
    const detail = await callMcpTool<unknown>(taskId, "destination_get_dataflow", { flow_id: id, sandbox });
    if (JSON.stringify(detail ?? "").includes(segmentId)) {
      return {
        state: "already_active",
        flowId: id,
        flowName: match.name ?? id,
        detail: `Already activated to "${match.name}" — nothing to change.`,
      };
    }
  } catch {
    // A failed read is not a reason to refuse the write; the add is additive
    // and the verification below is what decides whether it worked.
  }

  try {
    await callMcpTool(taskId, "destination_update_dataflow_audiences", {
      flow_id: id,
      add_audience_ids: JSON.stringify([segmentId]),
      sandbox,
    });
  } catch (err) {
    return { state: "failed", detail: `Activation to "${match.name}" was refused: ${(err as Error).message}` };
  }

  /*
   * Read it back. This whole project exists because a stage reported success
   * while the tool it called had failed, and an activation nobody verified is
   * the same trap one layer out.
   */
  try {
    const after = await callMcpTool<unknown>(taskId, "destination_get_dataflow", { flow_id: id, sandbox });
    if (!JSON.stringify(after ?? "").includes(segmentId)) {
      return {
        state: "failed",
        detail:
          `The activation call to "${match.name}" returned without an error, and reading the dataflow ` +
          "back does not show the audience on it. Treating that as NOT activated.",
      };
    }
  } catch (err) {
    return {
      state: "failed",
      detail:
        `Activated to "${match.name}", but it could not be read back to confirm: ` +
        `${(err as Error).message}. Reporting unconfirmed rather than done.`,
    };
  }

  return {
    state: "activated",
    flowId: id,
    flowName: match.name ?? id,
    detail: `Activated to "${match.name}", confirmed by reading the dataflow back.`,
  };
}
