/**
 * The points the process waits at, and what opens them.
 *
 * WHAT WAS WRONG
 *
 * runPipeline called intake, then review, then audience_creation, in one pass.
 * Nothing in that sequence corresponded to 1.5 "Approved?" - the decision the
 * map puts between phase 1 and phase 2. So Agents 2 and 3 ran on every brief
 * the moment it was submitted, whether or not anyone had approved it, and both
 * reported `completed`:
 *
 *   Agent 2 - "completed", while the comment read it depends on had errored and
 *             been treated as "no rejection found".
 *   Agent 3 - "completed", having built no segment, produced no count, and
 *             been unable to confirm AEP holds the attributes it needs.
 *
 * Two of the three green stages were green about nothing. That is the same
 * reported-success-while-failing pattern the review layer exists to catch, and
 * here the pipeline was generating it itself.
 *
 * THE FIX IS NOT A BETTER STATUS, IT IS NOT RUNNING
 *
 * A gated agent is not called. It writes no task_runs row, so it does not
 * appear as pending, skipped, completed or anything else - there is no record
 * of it because it did not run. An agent that was never handed the work cannot
 * report on it, correctly or otherwise, and a reader cannot mistake an absent
 * stage for a finished one.
 *
 * The run itself says what it is waiting for, in `runs.blocked_on`. B4 is
 * explicit that the thing to avoid is silence: "give the marketer a visible
 * status instead of silence." A blocked run is visible and names its gate.
 */

import type { AgentName } from "./types";

/** Which gate. One per waiting point in the map. */
export type GateId = "approval_1_5" | "audience_build_2_7";

/** A decision recorded against a gate - one row of `run_gates`. */
export type GateDecision = {
  gate_id: GateId | string;
  step_index: number;
  decision: "approved" | "rejected";
  decided_by: string;
  reason: string | null;
  evidence: Record<string, unknown>;
  decided_at: string;
};

/**
 * Whether an agent may run, and if not, what is being waited for.
 *
 * `awaiting` is written to be read by a marketer, because it is what the
 * dashboard and the MCP layer show them. "Gate closed" is not a status.
 */
export type GateVerdict =
  | { open: true; note?: string }
  | {
      open: false;
      awaiting: string;
      needs: "approval" | "upstream";
      /**
       * The record a human has to go and look at, when there is one.
       *
       * Carried so the layer above can turn it into a clickable link. Being
       * told to "approve the request" without being told where is the friction
       * that stops the approval happening, and this gate is the one place in
       * the process where everything waits on a person opening a page.
       */
      ref?: { objCode: string; objId: string };
    };

export type GateContext = {
  /*
   * EVERY attempt each stage made, in order, whatever its status.
   *
   * priorOutputs carries the last COMPLETED output per agent, which is the
   * right thing to hand an agent. It is the wrong thing to judge a gate on: a
   * stage can run more than once, and a later run does not undo what an
   * earlier one did.
   *
   * On run 9b8e39ee the review that created the project is marked needs_input
   * - it also asked the marketer a question - and the row marked completed is
   * a lighter preflight pass with no conversion in it. Judging the 2.7 gate on
   * completed rows alone told a marketer the request had never been through
   * review, in front of the project it had just created.
   */
  allOutputs?: Partial<Record<AgentName, unknown[]>>;
  /** Every decision recorded for this run so far, oldest first. */
  decisions: GateDecision[];
  /** What would be passed to the agent as its input. */
  input: unknown;
  /** Every prior agent's output, before the registry's contextAccess filter. */
  priorOutputs: Partial<Record<AgentName, unknown>>;
};

export type Gate = {
  id: GateId;
  /** The step in the map this gate stands at, for the artifact and the UI. */
  mapStep: string;
  label: string;
  check: (ctx: GateContext) => GateVerdict;
};

/** The most recent decision recorded for a gate, if any. */
export function decisionFor(decisions: GateDecision[], gateId: GateId): GateDecision | null {
  const hits = decisions.filter((d) => d.gate_id === gateId);
  return hits.length ? hits[hits.length - 1] : null;
}

/**
 * 1.5 - "Approved?" - in front of Agent 2.
 *
 * BOTH answers open this gate, and that is deliberate. Yes goes to connector A
 * and phase 2 begins at 2.1. No goes to 1.5a, which is B2 - "the review queue
 * rejects the issue and it goes back to the marketer as rework. Nothing reads
 * the rejection reason." Agent 2 is the thing that reads it. So a rejection
 * must run Agent 2, in triage mode, rather than ending the run.
 *
 * What closes the gate is neither answer: it is nobody having decided yet.
 */
const APPROVAL_1_5: Gate = {
  id: "approval_1_5",
  mapStep: "1.5",
  label: "Approval of the Workfront request",
  check: ({ decisions, priorOutputs }) => {
    const decided = decisionFor(decisions, "approval_1_5");
    if (decided) {
      return {
        open: true,
        note:
          decided.decision === "approved"
            ? `Approved by ${decided.decided_by} at 1.5, so phase 2 begins at 2.1.`
            : `Rejected by ${decided.decided_by} at 1.5, so this is the 1.5a rework path (B2).`,
      };
    }

    // Name the thing to approve, so the marketer is not told to approve "the
    // run". They approve a request in Workfront, which has an id.
    const intake = priorOutputs.intake as { workfront?: { created?: boolean; objId?: string; objCode?: string } } | undefined;
    const wf = intake?.workfront;
    const what =
      wf?.created && wf.objId
        ? `Workfront ${wf.objCode || "OPTASK"} ${wf.objId}`
        : "the Workfront request";

    return {
      open: false,
      needs: "approval",
      awaiting:
        `${what} has been created and is waiting for approval in Workfront. ` +
        "Open it, approve or reject it there, then say so here. Nothing else runs until then: " +
        "approving starts the audience work, rejecting sends it back for the specific fields to be corrected.",
      ref: wf?.created && wf.objId ? { objCode: wf.objCode || "OPTASK", objId: wf.objId } : undefined,
    };
  },
};

/**
 * 2.7 - "Attributes available?" - in front of Agent 3.
 *
 * Connector B, the entry to phase 3, is reached only from the Yes branch of
 * 2.7, and 2.7 is only reached when the audience does not already exist (2.3
 * No -> 2.6 -> 2.7). Agent 2 owns phase 2 and reports which of those happened.
 * Everything else in phase 2 leads somewhere that is not Agent 3:
 *
 *   2.3 Yes  -> 2.4 activate -> 2.5 validate with the marketer (a human step,
 *               kept deliberately per B3). No build, so no Agent 3.
 *   2.7 No   -> 2.7a, the GTO attribute request, a separate workflow (B4).
 *               It returns to 2.7 on completion; until then there is nothing
 *               for Agent 3 to build from.
 *   1.5a     -> rework. The brief went back to the marketer; phase 2 never
 *               happened.
 *
 * So this gate exists to stop Agent 3 doing what it used to do: run regardless,
 * find no attributes, build nothing, and report completed.
 */
const AUDIENCE_BUILD_2_7: Gate = {
  id: "audience_build_2_7",
  mapStep: "2.7",
  label: "Audience needs building, and the attributes exist",
  check: ({ decisions, priorOutputs, allOutputs }) => {
    const approval = decisionFor(decisions, "approval_1_5");
    if (approval && approval.decision === "rejected") {
      return {
        open: false,
        needs: "upstream",
        awaiting:
          "This request was sent back for changes and has not been resubmitted yet, so there is " +
          "nothing to build from. Correct the fields it asked about, resubmit, and approve it in Workfront.",
      };
    }

    /*
     * WHICHEVER ATTEMPT DID THE CONVERSION.
     *
     * This read priorOutputs.review and required mode === "phase2", which was
     * only ever a proxy for "the request has been converted to a project
     * carrying the brief". When review runs twice - once doing the conversion
     * and asking a question, once as a preflight - the completed row is the
     * preflight, and the proxy said no.
     *
     * So: the real evidence, from any attempt review made.
     */
    const reviewAttempts = [...((allOutputs?.review as unknown[] | undefined) ?? []), priorOutputs.review];
    const didPhase2 = reviewAttempts.find((o) => {
      const r = o as { mode?: string; converted?: { created?: boolean } } | null | undefined;
      return r && (r.mode === "phase2" || r.converted?.created === true);
    });

    const phase2 = (didPhase2 ?? priorOutputs.review) as
      | {
          mode?: string;
          converted?: { created?: boolean; objCode?: string; objId?: string };
          audienceExists?: boolean;
          existingAudience?: { id?: string | null; name?: string | null };
        }
      | undefined;

    if (!phase2 || phase2.mode !== "phase2") {
      return {
        open: false,
        needs: "upstream",
        awaiting:
          "This request has not been through review yet, so there is nothing to build an audience from.",
      };
    }

    if (phase2.audienceExists === true) {
      const name = phase2.existingAudience?.name || phase2.existingAudience?.id || "an existing audience";
      return {
        open: false,
        needs: "upstream",
        awaiting:
          `An audience for this already exists - "${name}" - so nothing needs building. ` +
          "Confirm it is the right one and it can be activated. Reusing an existing audience is the " +
          "best outcome here, not a gap.",
      };
    }

    return { open: true, note: "2.7 reached connector B: the audience needs building." };
  },
};

/** Every gate, by the agent it stands in front of. */
export const GATES: Partial<Record<AgentName, Gate>> = {
  review: APPROVAL_1_5,
  audience_creation: AUDIENCE_BUILD_2_7,
};

/** The gate in front of an agent, if it has one. */
export function gateFor(agent: AgentName): Gate | null {
  return GATES[agent] ?? null;
}
