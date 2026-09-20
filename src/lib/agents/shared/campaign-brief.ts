/**
 * The Campaign Brief, as data.
 *
 * WHY THIS IS A TABLE AND NOT PROSE IN A PROMPT
 *
 * B1 is about a loop: "the agent cannot build the intake from the prompt, so it
 * bounces back to the marketer... each round trip is unbounded." An agent that
 * keeps the form in its prompt cannot tell you which field is missing, only
 * that something is. It therefore re-asks the whole brief, and re-asking the
 * whole brief IS the loop.
 *
 * Keeping the form as a list of fields makes "what is actually missing" a
 * computable question - see parse.ts, which answers it and then asks for two
 * things rather than eleven.
 *
 * WHERE THESE FIELDS COME FROM, AND WHAT IS NOT VERIFIED
 *
 * The keys and option values are the Comcast intake form's own vocabulary as
 * captured from the tenant's "CSC Intake - Issue" form (categoryID
 * 69cad7690002898fbf9d684642dc25bc, see intake/workfront.ts). Several option
 * lists here are PARTIAL - they contain the values we have actually seen, and
 * are marked where that is true. That is deliberate: a made-up option would be
 * matched against a real brief and written into a real Workfront record.
 *
 * The authoritative list lives on the Workfront custom form, and can be read
 * once someone has signed in to the official MCP:
 *   insights_search_fields / workflow_resolve_field_names_any_object
 * Until then, an unmatched value falls through to "missing" and gets asked,
 * which is the safe direction to be wrong in.
 */

export type FieldSpec = {
  /** Stable key. Also the custom-field name sent to Workfront. */
  key: string;
  /** What the marketer sees. */
  label: string;
  /** Required for an audience to be buildable at all. Drives needs_input. */
  required?: boolean;
  /**
   * Allowed values, where the form constrains them. Matched against the brief
   * verbatim by parse.ts, longest-first.
   */
  options?: readonly string[];
  /** True when `options` is known to be incomplete. */
  optionsPartial?: boolean;
  /** Other names the same thing goes by in a brief. */
  aliases?: readonly string[];
  /**
   * The question to put to the marketer when this is the thing that is missing.
   * Written as one specific question, because "please complete the brief" is
   * what produces another round trip.
   */
  ask?: string;
};

/**
 * REQUIRED means: without this, no audience can be built or targeted.
 *
 * Not "the form marks it mandatory" - the form marks more than this mandatory,
 * and treating all of it as blocking is how the loop count passes two. Cadence
 * and activation pattern matter for execution and can be settled after the
 * audience exists, so they do not block.
 */
export const CAMPAIGN_BRIEF_FIELDS: readonly FieldSpec[] = [
  {
    key: "campaign_name",
    label: "Campaign name",
    required: true,
    aliases: ["campaign", "name of campaign", "initiative", "Name of the Campaign"],
    ask: "What should this campaign be called? A short name is enough - it becomes the Workfront request title.",
  },
  {
    key: "business_objective",
    label: "Business objective",
    required: true,
    options: ["Growth/Upsell", "Retention", "Acquisition"],
    optionsPartial: true,
    aliases: ["objective", "goal", "business goal", "Objective of the campaign"],
    ask: "Is this Growth/Upsell, Retention, or Acquisition? It decides who we start from, so it is worth getting right.",
  },
  {
    key: "customer_type",
    label: "Customer type",
    required: true,
    options: ["Subscriber - Existing Customers", "Prospect - Non-Customers"],
    optionsPartial: true,
    aliases: ["audience type", "who are we targeting"],
    ask: "Existing subscribers, or prospects? We hold data on existing customers and not on prospects, so the two are built completely differently.",
  },
  {
    key: "line_of_business",
    label: "Line of business",
    required: true,
    options: ["Residential (RES)", "Business (SMB)"],
    optionsPartial: true,
    aliases: ["lob", "segment", "division"],
    ask: "Residential or Business? They are held separately, so one cannot be assumed from the other.",
  },
  {
    key: "request_type",
    label: "Request type",
    required: true,
    options: ["Audience Build-Only", "Audience + Campaign Execution"],
    optionsPartial: true,
    aliases: ["what do you need", "scope"],
    ask: "Do you need the audience only, or the audience and the campaign executed?",
  },
  {
    key: "launch_date",
    label: "Launch date",
    required: true,
    aliases: ["in market", "go live", "live date", "launch", "Requested_Launch_Date", "Requested Launch Date"],
    // The nightly segmentation job at 21:45 (B6) means a date is not a
    // formality - every rework cycle after it costs a full day.
    ask: "What is the in-market date? Audiences refresh overnight, so the date decides how much room there is to change anything afterwards.",
  },
  {
    key: "lifecycle_journey",
    label: "Lifecycle journey",
    options: ["Upgrade", "Winback", "Onboarding", "Cross-sell"],
    optionsPartial: true,
    aliases: ["journey", "lifecycle stage"],
    ask: "Which lifecycle journey does this sit in - upgrade, winback, onboarding, cross-sell?",
  },
  {
    key: "campaign_duration",
    label: "Campaign duration",
    options: ["Evergreen (ongoing)", "Fixed window"],
    optionsPartial: true,
    aliases: ["duration", "how long"],
    ask: "Is this a fixed window or evergreen?",
  },
  {
    key: "cadence",
    label: "Cadence",
    options: ["One-time Campaign", "Recurring Campaign"],
    optionsPartial: true,
    aliases: ["frequency", "how often"],
    ask: "One-time or recurring?",
  },
  {
    key: "activation_pattern",
    label: "Activation pattern",
    options: ["Batch", "Near-real time trigger"],
    optionsPartial: true,
    aliases: ["activation", "trigger"],
    ask: "Batch send, or a near-real-time trigger?",
  },
  {
    key: "channels",
    label: "Channels",
    // Outbound call appeared in two consecutive real briefs and was captured
    // as nothing, because the list did not have it.
    options: ["Email", "SMS", "Direct Mail", "Paid Media", "In-app", "Outbound Call", "Push"],
    optionsPartial: true,
    aliases: ["channel", "how are we reaching them"],
    ask: "Which channels - email, SMS, direct mail, paid media, in-app?",
  },
  {
    key: "offer",
    label: "Offer",
    aliases: ["incentive", "promo", "promotion", "discount"],
    ask: "What is the offer or incentive?",
  },
  {
    // "Northeast", "in the Northeast". It was in every brief we tested and in
    // none of the structured output, which meant the audience definition was
    // missing the geography it was supposed to be built on.
    key: "region",
    label: "Region / market",
    options: ["Northeast", "Southeast", "Midwest", "West", "Southwest", "National"],
    optionsPartial: true,
    aliases: ["market", "geography", "geo", "footprint", "territory"],
    ask: "Which region or market - Northeast, Southeast, Midwest, West?",
  },
  {
    // "who do not have a mobile line with us yet" is the exclusion that defines
    // the audience. Carrying it only in free text means the person building the
    // segment has to re-read the brief to find the most important clause in it.
    key: "exclusion",
    label: "Exclusion",
    aliases: ["exclude", "without", "who do not have", "not already"],
    ask: "Who should be excluded - for example, customers who already have the product?",
  },
  {
    /*
     * The audience, in one sentence, because that is what the form asks for.
     *
     * Read off the live tenant (taplondonptrsd, 16 Sep 2026), the intake form
     * has FOUR meaningful fields, not the fourteen modelled above:
     *
     *   DE:Name of the Campaign      DE:Objective of the campaign
     *   DE:Audience_to_be_Targeted   DE:Requested_Launch_Date
     *
     * There is no Line of Business field, no Region field, no Channels field.
     * So the fields we extract that the form has nowhere to put are COMPOSED
     * into this one, rather than dropped or written to names that do not exist.
     * The richer breakdown still travels in the run record, where the audience
     * builder can read it - it just is not pretended into Workfront.
     */
    key: "audience_description",
    label: "Audience to be targeted",
    aliases: ["Audience_to_be_Targeted", "audience to be targeted", "target audience"],
    ask: "Who is the audience, in a sentence?",
  },
  {
    /*
     * Routing metadata, not a campaign fact — which Workfront project the
     * intake issue should land in. Deliberately NOT required and has no
     * `ask`: a marketer doesn't state a Workfront project GUID in a brief,
     * so this must never trigger a needs_input round asking for one. Set
     * explicitly (the intake form's own project-id input) or left absent,
     * in which case intake/workfront.ts falls back to
     * WORKFRONT_INTAKE_PROJECT_ID / WORKFRONT_INTAKE_QUEUE as before.
     */
    key: "workfront_project_id",
    label: "Workfront project",
    aliases: ["project id", "destination project", "workfront project"],
  },
] as const;

/** The fields without which nothing can be built. */
export function requiredFields(): FieldSpec[] {
  return CAMPAIGN_BRIEF_FIELDS.filter((f) => f.required);
}

/** One field by key. */
export function fieldByKey(key: string): FieldSpec | undefined {
  return CAMPAIGN_BRIEF_FIELDS.find((f) => f.key === key);
}

/**
 * Resolve a field from whatever a rejection or a reviewer called it.
 *
 * Agent 2 reads rejection text written by a human in a hurry - "no LOB", "which
 * segment?", "missing launch" - and has to land on a field key. Matching the
 * label, the key, or a declared alias covers the realistic cases without
 * pretending to understand arbitrary prose.
 */
export function resolveFieldRef(text: string): FieldSpec | undefined {
  const hay = String(text || "").toLowerCase();
  if (!hay.trim()) return undefined;

  const candidates = CAMPAIGN_BRIEF_FIELDS.flatMap((f) => [
    { f, needle: f.label.toLowerCase() },
    { f, needle: f.key.replace(/_/g, " ") },
    { f, needle: f.key },
    ...(f.aliases || []).map((a) => ({ f, needle: a.toLowerCase() })),
  ]);

  // Longest needle first: "customer type" must beat "type".
  candidates.sort((a, b) => b.needle.length - a.needle.length);
  return candidates.find((c) => c.needle.length > 2 && hay.includes(c.needle))?.f;
}
