import { NextRequest, NextResponse } from "next/server";
import type { AgentRequest, AgentResponse } from "@/lib/pipeline/types";
import {
  probeSchemas,
  findExistingSegment,
  estimateCount,
  identityGap,
  decideBuildPath,
  nightlyCutoff,
  // 2.6 gathers the data requirements and 2.7 checks them. One list, shared
  // with Agent 2, because two lists would mean the GTO request opened by 2.7's
  // "No" was for a different set of attributes than the process asked for.
  requiredAttributes,
} from "@/lib/agents/audience/aep";
import {
  readSandboxFields,
  checkAttributes,
  audienceRequirements,
  buildExpression,
  createAudience,
  type BuildResult,
  type Expression,
} from "@/lib/agents/audience/attributes";

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
 * IT NOW WRITES, UNDER ONE CONDITION.
 *
 * This was read-only, and the reasoning was sound at the time: 2.7 could never
 * be answered, and a segment built on unverified attributes is worse than no
 * segment, because it yields a plausible count for an unknown population.
 *
 * What changed is that 2.7 can now be answered. The attributes were always
 * there - xfinityTV, xfinityInternet, state, customerEmail - but the probe read
 * schema documents, which contain $refs to field groups rather than fields, so
 * it never saw them. Reading the FIELD GROUPS answers the question, and once
 * the attributes are CONFIRMED the map's own step applies: 3.1a, "Agent creates
 * audience in AEP rule builder".
 *
 * So the condition is exact: it builds only when the attribute check was
 * conclusive AND every requirement matched a real field AND there is no
 * existing audience to reuse. Anything less and it reports what it needs.
 * The count then goes to the marketer at 3.4, and the approval at 3.5 stays a
 * human's - see lib/agents/audience/attributes.ts.
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
  /** 3.1a: the audience, once one has been built. Null when none was. */
  audience: {
    created: boolean;
    segmentId: string | null;
    name: string;
    /** The PQL, so a human can check the definition and not just the count. */
    definition: string;
    /** Each predicate in words. */
    reads: string[];
    /** What the brief asked for that could NOT be expressed. Never silent. */
    notExpressed: string[];
    error: string | null;
  } | null;
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

  /*
   * THE BRIEF TRAVELS WITH THE FIELDS, and it has to.
   *
   * What this agent has to decide - which products, which place, which
   * reachability - is stated in the marketer's own sentence. The structured
   * fields are what INTAKE managed to lift out of it, and when intake lifts
   * nothing, the targeting is invisible here.
   *
   * That is not hypothetical. For "existing residential subscribers in
   * Pennsylvania who have Xfinity TV but no Internet", intake captured neither
   * a region nor a product holding, so this agent saw neither, built "no
   * Internet and has an email address", and reported it complete. Every
   * customer with no Internet and an email, in any state, TV or not.
   *
   * The fields are still preferred - they are the reviewed, structured version.
   * The brief is added so nothing STATED can be silently absent.
   */
  const briefText = String(
    (input.brief as string) ||
      ((body.priorOutputs?.intake as Record<string, unknown> | undefined)?.brief as string) ||
      "",
  ).trim();
  const targeting: Record<string, string> = briefText ? { ...fields, brief_text: briefText } : fields;

  /*
   * 2.6 and 2.7, answered from the sandbox's real fields.
   *
   * probeSchemas is kept for its schema-level read but it can never answer 2.7
   * on its own: a schema document holds $refs to field groups, not fields, so
   * every run came back "undetermined". readSandboxFields reads the field
   * groups, which is where the attributes actually are - and in this tenant
   * they are there: xfinityTV, xfinityInternet, state, customerEmail.
   *
   * The old requirement list was the BRIEF's fields (line_of_business,
   * lifecycle_journey...), which are routing metadata about the request rather
   * than predicates about a person. No AEP sandbox has a field called "line of
   * business", so 2.7 could never say yes and every run was headed for 2.7a.
   * audienceRequirements asks instead what the DEFINITION has to test.
   */
  const requirements = audienceRequirements(targeting);
  const fieldRead = await readSandboxFields("audience_creation");
  const check = checkAttributes(requirements, fieldRead);

  const needed = requirements.map((r) => r.label);
  const probe = {
    read: fieldRead.read,
    conclusive: check.conclusive,
    error: check.question ?? fieldRead.error,
    sandbox: null,
    tenant: check.tenant,
    schemaCount: fieldRead.groupCount,
    schemasInspected: fieldRead.groupCount,
    fieldCount: check.fieldsSeen,
    found: Object.fromEntries(
      requirements.map((r) => [r.label, !check.missing.some((m) => m.key === r.key)]),
    ),
    // The matched field for every satisfied requirement, so a reader can check
    // the match rather than take it on trust.
    evidence: check.satisfied.map((s) => `${s.label} -> ${s.field} (${s.type}, in "${s.group}")`),
  };

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
  let estimate = await estimateCount(existing.id);

  /*
   * 3.1a - BUILD IT.
   *
   * Only when 2.7 said yes conclusively, and only when there is nothing to
   * reuse. Reuse first is not a preference, it is the cheapest good outcome in
   * the whole map: an existing audience needs no build, no nightly cycle, and
   * already has a real count.
   *
   * This agent used to be read-only and that was right while 2.7 could never be
   * answered - a segment built on unverified attributes is worse than none. Now
   * that the attributes are confirmed against real fields, the map's own step
   * applies: "Agent creates audience in AEP rule builder". The count then goes
   * to the marketer at 3.4 and the approval at 3.5 stays a human's.
   */
  let build: BuildResult | null = null;
  let expression: Expression | null = null;
  if (check.available && !existing.id) {
    expression = buildExpression(check, targeting);
    /*
     * NOTHING IS BUILT IF ANYTHING STATED WAS DROPPED.
     *
     * `ungrounded` means the brief asked for a filter that cannot be expressed
     * against a real field. Building the rest produces an audience BROADER than
     * the request - and then sizes it, and sends that number on for approval as
     * though it described the requested population. With a launch date and a
     * budget behind it, a plausible number for the wrong people is the most
     * expensive thing this pipeline could produce.
     */
    if (expression && !expression.ungrounded.length) {
      build = await createAudience("audience_creation", {
        name: String(fields.campaign_name || "Audience").slice(0, 80),
        pql: expression.pql,
        description:
          `Built by Agent 3 at step 3.1a from the approved intake. ` +
          expression.explain.join("; ") +
          (expression.ungrounded.length ? ` NOT expressed: ${expression.ungrounded.join(" ")}` : ""),
      });
      if (build.created && build.count != null) {
        estimate = { count: build.count, basis: build.countBasis, segmentId: build.segmentId };
      } else if (build.created) {
        estimate = { count: null, basis: build.countBasis, segmentId: build.segmentId };
      }
    }
  }

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
        (probe.tenant ? ` in tenant "${probe.tenant}"` : "") + "."
      : `Attribute availability is UNDETERMINED: ${probe.error}` +
        (probe.tenant ? ` (tenant "${probe.tenant}")` : "") +
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
    /*
     * The audience itself, when one was built.
     *
     * On the output rather than only in metadata, because metadata is not passed
     * to the next agent and a built audience is the one thing everything
     * downstream needs. The PQL is included so a human can read the definition
     * and say whether it is the audience they asked for - which is 2.5/3.5, and
     * they cannot do it from a count alone.
     */
    audience: build
      ? {
          created: build.created,
          segmentId: build.segmentId,
          name: build.name,
          definition: build.pql,
          reads: expression?.explain ?? [],
          notExpressed: expression?.ungrounded ?? [],
          error: build.error,
        }
      : null,
  };

  /*
   * An open attribute request is needs_input, not completed.
   *
   * 2.7a leaves this process and comes back. Reporting `completed` while an
   * audience does not exist and cannot yet be built is exactly the
   * reported-success-while-failing pattern the whole review layer exists to
   * catch, and it is why escalation has never fired on this pipeline.
   */
  /*
   * WHAT THIS AGENT IS ALLOWED TO CALL A SUCCESS.
   *
   * This was `attrState.status === "open" ? "needs_input" : "completed"`, and on
   * the live tenant it reported `completed` on a run where it had:
   *
   *   - failed to confirm AEP holds the attributes it needs (3 schemas opened,
   *     no field definitions found -> "undetermined"),
   *   - found no existing audience to reuse,
   *   - built no segment, deliberately, because it is read-only,
   *   - and produced no predicted count.
   *
   * Nothing happened, and it said `completed`. B3's entire value is a predicted
   * count before the marketer sees one, so a pass with no count is a pass with
   * no product. The rule now: `completed` requires an OUTCOME - either a count,
   * or an existing audience to reuse.
   *
   * The three ways it legitimately does not complete are each reported as
   * themselves, because they need different things to happen next:
   */
  // An audience that now EXISTS because this agent built it is an outcome, and
  // the most important one - it is the only way a real count ever appears.
  const hasOutcome = estimate.count != null || existing.id != null || build?.created === true;

  let status: "completed" | "needs_input" | "failed";
  let blockedReason: string | null = null;

  if (expression && expression.ungrounded.length) {
    /*
     * A pause, not a failure: nothing is broken, the request is simply not yet
     * expressible as an audience, and only a person can resolve the difference.
     */
    status = "needs_input";
    blockedReason =
      "This audience has not been created. " +
      `The request asks for ${expression.ungrounded.length === 1 ? "something" : `${expression.ungrounded.length} things`} ` +
      "the definition cannot express yet, and leaving " +
      (expression.ungrounded.length === 1 ? "it" : "them") +
      " out would build an audience BROADER than what was asked for - so nothing was built. " +
      `Missing: ${expression.ungrounded.join(" Also: ")}` +
      (expression.explain.length
        ? ` What can be expressed today: ${expression.explain.join("; ")}.`
        : "");
  } else if (build && !build.created) {
    /*
     * 2.7 said yes, the expression was grounded, and the WRITE failed.
     *
     * That is a failure, not a pause. There is nothing for a human to answer -
     * the request is complete and the attributes are there - so reporting
     * needs_input would put a question to the marketer that they cannot act on
     * while hiding a broken AEP write from whoever can.
     */
    status = "failed";
    blockedReason =
      `The audience could not be created in Adobe Experience Platform: ${build.error}. ` +
      `The definition was ready and is kept here so nothing is lost: ${build.pql}`;
  } else if (attrState.status === "open") {
    // 2.7a. A GTO attribute request is open and the audience cannot be built
    // until it returns. B4's quarter-long tail.
    status = "needs_input";
    blockedReason = attrState.note;
  } else if (attributesAvailable === "undetermined" || (check.conclusive && !check.available)) {
    /*
     * 2.7 could not be answered, or was answered NO.
     *
     * Either way the question travels with the status. This is the gap that was
     * reported from a real run: Agent 3 returned needs_input, and get_intake,
     * the Workfront record and both comment streams were all silent about what
     * it needed. A status with no question is unactionable - and for the 2.7a
     * GTO request it is worse than that, because the request has to NAME the
     * attributes being asked for or the GTO team starts from zero.
     */
    status = "needs_input";
    blockedReason =
      check.question ||
      `Could not confirm what customer data is available: ${probe.error}. ` +
      "Nothing has been built and no data request has been raised, because raising one because the " +
      "check failed would start a long piece of work for a question nobody asked. Someone with Adobe " +
      "Experience Platform access needs to confirm whether " + needed.join(", ") + " are held.";
  } else if (!hasOutcome) {
    // Attributes are there, and still no count. Say which of the two reads
    // failed rather than leaving the reader to infer it.
    status = "needs_input";
    blockedReason =
      "The customer data needed is available, but this produced no size estimate and found no " +
      `existing audience to reuse. ${estimate.basis} ` +
      (existing.read ? "" : `The audience catalogue could not be read either: ${existing.error}. `) +
      "Without a number there is nothing yet for you to check.";
  } else {
    status = "completed";
  }

  return NextResponse.json<AgentResponse<AudienceCreationOutput>>({
    status,
    output,
    message: blockedReason ?? undefined,
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
      sandbox: probe.tenant,
      attributesNeeded: needed,
      attributesMissing: missing,
      schemaEvidence: probe.evidence,
      existingSegment: existing.id ? { id: existing.id, name: existing.name } : null,
      countBasis: estimate.basis,
      // The one-line honest summary of this stage, for a reader who only looks
      // at metadata: did it produce anything at all?
      producedAnOutcome: hasOutcome,
      nightlyCutoff: cutoff,
    },
  });
}
