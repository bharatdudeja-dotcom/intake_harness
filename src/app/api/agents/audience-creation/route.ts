import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import { withToolCallLog } from "@/lib/mcp-client";
import {
  probeSchemas,
  findExistingSegment,
  identityGap,
  decideBuildPath,
  nightlyCutoff,
  neededAttributes,
  criteriaKeywords,
} from "@/lib/agents/audience/aep";
import { detectActivationIntent, activateAudience, type ActivationOutcome } from "@/lib/agents/audience/activation";

/**
 * Agent 3 - Audience Creation.
 *
 * The output INTERFACE below is unchanged from the scaffold: it was derived
 * field by field from the blockers this agent owns, and it was derived
 * correctly, so it is reused rather than redesigned. What was missing was the
 * logic behind it - every field returned a placeholder and statusMessage said
 * so honestly.
 *
 *   B3 (2.5)  flag the account-vs-profile identity gap rather than letting the
 *             marketer discover a number they do not recognise. (Predicting a
 *             count itself is NOT done here - see aep.ts's docstring: the
 *             estimate tool is verified broken upstream, and the effort that
 *             would have gone into working around it instead went into
 *             checking whether the audience's needed attributes are real.)
 *   B4 (2.7a) when attributes are missing, keep state on the open GTO request,
 *             re-evaluate on completion rather than waiting for someone to
 *             check, and give the marketer a visible status instead of silence.
 *   B5 (3.1)  decide whether this genuinely needs FAC or can be satisfied in
 *             the rule builder, so the undefined 3.1b path is entered only when
 *             unavoidable.
 *   B6 (3.3)  the nightly job runs at 21:45 and every cycle after it costs a
 *             full day, so validate and predict BEFORE the cutoff.
 *
 * STILL READ-ONLY, DELIBERATELY - even with activation added. Everything
 * here is an AEP read, including activation: it will report that it cannot
 * predict a count rather than create a segment definition to produce one
 * (lib/agents/audience/aep.ts), and it will report whether an audience is
 * already wired to a named destination rather than write that wiring itself
 * (lib/agents/audience/activation.ts) - the tools available genuinely have
 * no safe way to add a segment to an existing destination's dataflow
 * without risking every other segment already activated there, so this
 * reports that rather than guessing. A number, or an activation, obtained
 * by silently writing to a client's sandbox is not worth having.
 *
 * ACTIVATION IS OFF BY DEFAULT. Nothing below changes unless the brief
 * itself explicitly asks to activate the audience somewhere
 * (activation.ts's detectActivationIntent) - build path, attribute checks,
 * and count prediction behave exactly as they always have otherwise.
 */

export interface AudienceCreationInput {
  [key: string]: unknown;
}

export interface AudienceCreationOutput {
  /** B5: which build path this request takes. */
  buildPath: "aep_rule_builder" | "fac";
  /**
   * B4: do the attributes this audience needs exist in AEP today?
   *
   * THREE states, not two. This was a boolean, and when the probe could not
   * reach field-level data it was set to `true` - chosen so an inconclusive
   * check could not open a GTO attribute request. The result was an artifact
   * reading `attributesAvailable: true` directly above a status message saying
   * availability "could not be determined", which is a contradiction a reader
   * has to resolve for themselves, and most will read the boolean.
   *
   * "undetermined" behaves like true for gating - it opens nothing - and reads
   * like what it is.
   */
  attributesAvailable: boolean | "undetermined";
  /** B4: set when attributesAvailable is false and a GTO request is open. */
  openAttributeRequest: {
    status: "not_opened" | "open" | "resolved";
    requestId: string | null;
    ageSeconds: number | null;
  };
  /** B3/B8: account-vs-profile identity gap the marketer should see, not discover. */
  identityGap: { hasGap: boolean; details: string | null };
  /** Marketer-visible status string - the thing B4 says must never be silence. */
  statusMessage: string;
  /**
   * Set ONLY when the brief explicitly asked to activate the audience
   * somewhere (see activation.ts) - absent otherwise, so a reader can tell
   * "activation wasn't asked for" from "activation was asked for and this
   * is what happened" without inspecting a status string.
   */
  activation?: ActivationOutcome;
}

/** The one statusMessage line for whatever activateAudience decided - only ever called when activation was actually requested. */
function formatActivationMessage(activation: ActivationOutcome): string {
  switch (activation.status) {
    case "already_active":
      return `Already activated to "${activation.destinationName}" - nothing to do.`;
    case "no_destination_named":
      return `Activation requested, but no destination was named. ${activation.reason}`;
    case "destination_not_found":
      return (
        `Could not find a destination matching "${activation.requestedName}" ` +
        `(${activation.considered} dataflow(s) checked)` +
        (activation.reason ? ` - ${activation.reason}` : ".")
      );
    case "needs_manual_wiring":
      return `Activation needs manual wiring: ${activation.reason}`;
    case "no_segment_to_activate":
      return `Cannot activate yet: ${activation.reason}`;
  }
}

/**
 * B4's state, carried on the run.
 *
 * "Keep state on the open request, re-evaluate 2.7 automatically on completion
 * rather than waiting for someone to check." The run carries the request
 * forward, so each pass re-reads the schemas and can close it out itself. A
 * durable store would outlive the run and is the right next step; carrying it
 * here is what makes the re-evaluation automatic today rather than a person
 * remembering to look.
 */
function attributeRequestState(
  priorOutputs: Partial<Record<string, unknown>>,
  attributesAvailable: boolean,
  missing: string[],
): AudienceCreationOutput["openAttributeRequest"] & { note: string } {
  const prior = (priorOutputs?.audience_creation as AudienceCreationOutput | undefined)?.openAttributeRequest;

  if (attributesAvailable) {
    if (prior && prior.status === "open") {
      return {
        status: "resolved",
        requestId: prior.requestId,
        ageSeconds: prior.ageSeconds,
        note:
          `Attribute request ${prior.requestId} is now satisfied - the attributes are present in AEP, ` +
          "so 2.7 was re-evaluated automatically rather than waiting for someone to check.",
      };
    }
    return { status: "not_opened", requestId: null, ageSeconds: null, note: "No attribute request needed." };
  }

  if (prior && prior.status === "open" && prior.requestId) {
    const age = Number(prior.ageSeconds || 0) + 1;
    return {
      status: "open",
      requestId: prior.requestId,
      ageSeconds: age,
      // B7's lesson applied here: an open request with no visible age is how a
      // quarter-long tail hides.
      note: `Attribute request ${prior.requestId} is still open, waiting on ${missing.join(", ")}.`,
    };
  }

  const requestId = `ATTR-${Date.now().toString(36).toUpperCase()}`;
  return {
    status: "open",
    requestId,
    ageSeconds: 0,
    note:
      `Opened attribute request ${requestId} for ${missing.join(", ")}. This is the 2.7a branch: it ` +
      "leaves this process into the GTO workflow and returns here on completion, and its age is " +
      "tracked so it cannot sit unanswered with nobody owning it.",
  };
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as AgentRequest<AudienceCreationInput>;
  const input = body.input || {};
  const fields = ((input.intakeFields || input.fields || {}) as Record<string, string>) || {};
  const brief = typeof input.brief === "string" ? input.brief : undefined;

  // Every read below (probeSchemas, findExistingSegment) calls MCP tools -
  // wrapped so every call, request and response, ends up in
  // metadata.toolCalls for the UI.
  const { result, toolCalls } = await withToolCallLog(async (): Promise<AgentResponse<AudienceCreationOutput>> => {
    const needed = neededAttributes(fields, brief);
    const probe = await probeSchemas("audience_creation", needed);

    /*
     * AN INCONCLUSIVE PROBE IS NOT A MISSING ATTRIBUTE.
     *
     * This distinction is the whole safety property of this agent. If we could
     * not obtain field-level data we do not know what AEP holds, and claiming the
     * attributes are absent would open a GTO attribute request - the
     * quarter-long tail in B4 - on the strength of our own failure to look.
     *
     * It has already happened once: the probe matched attribute names against
     * schema TITLES, which never contain field names, concluded that all three
     * were missing, and opened a request. Unknown is now reported as unknown, and
     * only a conclusive probe can open anything.
     */
    const missing = probe.conclusive
      ? Object.entries(probe.found).filter(([, ok]) => !ok).map(([k]) => k)
      : [];
    const attributesAvailable: boolean | "undetermined" = probe.conclusive
      ? missing.length === 0
      : "undetermined";

    const path = decideBuildPath(fields, probe);
    const gap = identityGap(fields);
    const cutoff = nightlyCutoff();

    // Cheapest good outcome first: an audience that already exists needs no build
    // and is the only way to get a real count without writing anything.
    //
    // THE BUG THIS FIXES: these terms used to be ONLY intake's own
    // categorization fields (campaign_name/lifecycle_journey/line_of_business/
    // customer_type) - never the audience's actual criteria. A brief asking
    // for "an audience where ECID exists" would never match a real, already-
    // built segment literally named "Has ECID", because "ecid" was never one
    // of the words being searched for. Adding keywords from the brief/
    // audience_description is what makes that match findable.
    const terms = [
      fields.campaign_name, fields.lifecycle_journey, fields.line_of_business, fields.customer_type,
      ...criteriaKeywords([brief, fields.audience_description].filter(Boolean).join(" ")),
    ]
      .filter(Boolean)
      .map(String);
    const existing = await findExistingSegment("audience_creation", terms);

    // Off by default - see this file's docstring and activation.ts. Only
    // runs the (read-only) destination check when the brief itself
    // explicitly asked for activation.
    const activationIntent = detectActivationIntent(brief);
    const activation = activationIntent.requested
      ? await activateAudience("audience_creation", {
          segmentId: existing.id,
          segmentName: existing.name,
          destinationName: activationIntent.destinationName,
        })
      : undefined;

    // Only a CONCLUSIVE "no" opens an attribute request. "undetermined" must not:
    // opening the 2.7a branch because we failed to look is the quarter-long tail
    // started by our own blind spot.
    const attrState = attributeRequestState(body.priorOutputs || {}, attributesAvailable !== false, missing);

    const statusMessage = [
      path.buildPath === "fac"
        ? "Federated (FAC) path: " + path.reason
        : "AEP rule builder: " + path.reason,
      probe.conclusive
        ? `Checked ${probe.fieldCount} field(s) across ${probe.schemasInspected} profile schema(s)` +
          (probe.sandbox ? ` in sandbox "${probe.sandbox}"` : "") + "."
        : `Attribute availability is UNDETERMINED: ${probe.error}` +
          (probe.sandbox ? ` (sandbox "${probe.sandbox}")` : "") +
          ". No attribute request has been opened on the strength of that.",
      existing.id
        ? `Reusing existing audience "${existing.name}".`
        : existing.read
          ? `No existing audience matched (${existing.considered} checked).`
          : `Could not list existing audiences: ${existing.error}.`,
      gap.hasGap ? "Identity gap flagged: see identityGap." : "",
      activation ? formatActivationMessage(activation) : "",
      attrState.note,
      cutoff.note,
    ]
      .filter(Boolean)
      .join(" ");

    const output: AudienceCreationOutput = {
      buildPath: path.buildPath,
      attributesAvailable,
      openAttributeRequest: {
        status: attrState.status,
        requestId: attrState.requestId,
        ageSeconds: attrState.ageSeconds,
      },
      identityGap: gap,
      statusMessage,
      ...(activation ? { activation } : {}),
    };

    /*
     * An open attribute request is needs_input, not completed.
     *
     * 2.7a leaves this process and comes back. Reporting `completed` while an
     * audience does not exist and cannot yet be built is exactly the
     * reported-success-while-failing pattern the whole review layer exists to
     * catch.
     */
    const status = attrState.status === "open" ? "needs_input" : "completed";

    return {
      status,
      output,
      message: status === "needs_input" ? attrState.note : statusMessage,
      metadata: {
        buildPathReason: path.reason,
        schemasRead: probe.read,
        schemaProbeConclusive: probe.conclusive,
        schemasReadError: probe.error,
        schemaCount: probe.schemaCount,
        schemasInspected: probe.schemasInspected,
        fieldGroupsInspected: probe.fieldGroupsInspected,
        fieldCount: probe.fieldCount,
        // Which AEP sandbox answered. Assessing Comcast's attributes against a
        // sandbox that is not Comcast's is a meaningless check, and the reader
        // needs to be able to see that for themselves.
        sandbox: probe.sandbox,
        attributesNeeded: needed,
        attributesMissing: missing,
        schemaEvidence: probe.evidence,
        existingSegment: existing.id ? { id: existing.id, name: existing.name } : null,
        nightlyCutoff: cutoff,
        activationRequested: activationIntent.requested,
        activationDestination: activationIntent.destinationName,
      },
    };
  });

  return NextResponse.json<AgentResponse<AudienceCreationOutput>>({
    ...result,
    metadata: { ...result.metadata, toolCalls },
  });
}
