import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import {
  probeSchemas,
  findExistingSegment,
  estimateCount,
  identityGap,
  decideBuildPath,
  nightlyCutoff,
} from "@/lib/agents/audience/aep";

/**
 * Agent 3 - Audience Creation.
 *
 * The output INTERFACE below is unchanged from the scaffold: it was derived
 * field by field from the blockers this agent owns, and it was derived
 * correctly, so it is reused rather than redesigned. What was missing was the
 * logic behind it - every field returned a placeholder and statusMessage said
 * so honestly.
 *
 *   B3 (2.5)  predict the count before the marketer sees it, and flag the
 *             account-vs-profile identity gap rather than letting them discover
 *             a number they do not recognise. Keep the human decision; remove
 *             the surprise.
 *   B4 (2.7a) when attributes are missing, keep state on the open GTO request,
 *             re-evaluate on completion rather than waiting for someone to
 *             check, and give the marketer a visible status instead of silence.
 *   B5 (3.1)  decide whether this genuinely needs FAC or can be satisfied in
 *             the rule builder, so the undefined 3.1b path is entered only when
 *             unavoidable.
 *   B6 (3.3)  the nightly job runs at 21:45 and every cycle after it costs a
 *             full day, so validate and predict BEFORE the cutoff.
 *
 * READ-ONLY, DELIBERATELY. Everything here is an AEP read. It will report that
 * it cannot predict a count rather than create a segment definition to produce
 * one - see lib/agents/audience/aep.ts. A number is the point of B3; a number
 * obtained by silently writing to a client's sandbox is not worth having.
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
  /** B6: predicted membership count before the 9:45pm segmentation cutoff. */
  predictedCount: number | null;
  /** B3/B8: account-vs-profile identity gap the marketer should see, not discover. */
  identityGap: { hasGap: boolean; details: string | null };
  /** Marketer-visible status string - the thing B4 says must never be silence. */
  statusMessage: string;
}

/** The attributes an audience of this shape needs to exist in AEP. */
function neededAttributes(fields: Record<string, string>): string[] {
  const needed = new Set<string>(["customer_type", "line_of_business"]);
  if (fields.lifecycle_journey) needed.add("lifecycle_journey");
  if (fields.channels) needed.add("channels");
  if (/northeast|region|state|market/i.test(Object.values(fields).join(" "))) needed.add("region");
  return [...needed];
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

  const needed = neededAttributes(fields);
  const probe = await probeSchemas(needed);

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
  const terms = [fields.campaign_name, fields.lifecycle_journey, fields.line_of_business, fields.customer_type]
    .filter(Boolean)
    .map(String);
  const existing = await findExistingSegment(terms);
  const estimate = await estimateCount(existing.id);

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
    estimate.count != null ? `Predicted ${estimate.count.toLocaleString()} profiles.` : `No count yet - ${estimate.basis}`,
    gap.hasGap ? "Identity gap flagged: see identityGap." : "",
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
    predictedCount: estimate.count,
    identityGap: gap,
    statusMessage,
  };

  /*
   * An open attribute request is needs_input, not completed.
   *
   * 2.7a leaves this process and comes back. Reporting `completed` while an
   * audience does not exist and cannot yet be built is exactly the
   * reported-success-while-failing pattern the whole review layer exists to
   * catch, and it is why escalation has never fired on this pipeline.
   */
  const status = attrState.status === "open" ? "needs_input" : "completed";

  return NextResponse.json<AgentResponse<AudienceCreationOutput>>({
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
      fieldCount: probe.fieldCount,
      // Which AEP sandbox answered. Assessing Comcast's attributes against a
      // sandbox that is not Comcast's is a meaningless check, and the reader
      // needs to be able to see that for themselves.
      sandbox: probe.sandbox,
      attributesNeeded: needed,
      attributesMissing: missing,
      schemaEvidence: probe.evidence,
      existingSegment: existing.id ? { id: existing.id, name: existing.name } : null,
      countBasis: estimate.basis,
      nightlyCutoff: cutoff,
    },
  });
}
