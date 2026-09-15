/**
 * The Campaign Brief field catalogue.
 *
 * This is the real Comcast/Xfinity "Audience Build" form, not a guess. It is
 * the thing a review-queue rejection is always *about*: a rejection says some
 * field is missing, wrong, or sourced from the wrong place, and B2 is the job
 * of turning that sentence back into the field.
 *
 * Kept as data rather than code so a form change is an edit here. SHARED by
 * Agent 1 (which fills these fields from a brief) and Agent 2 (which works out
 * which one a rejection is about), so the two can never drift apart on what
 * the form actually is.
 *
 * `aliases` are how a human might refer to the field in a rejection comment.
 * They are matched case-insensitively against the rejection text.
 */

export type FieldSpec = {
  key: string;
  label: string;
  section: string;
  /** Blocks submission outright when missing. */
  required?: boolean;
  /** Values that are technically answers but tell us nothing. */
  ambiguous?: string[];
  /** How a reviewer might name this field in prose. */
  aliases: string[];
  /**
   * The values the form actually offers. Agent 1 matches these against the
   * brief to fill a field from the marketer's own words; Agent 2 uses them to
   * tell a wrong value from a missing one.
   */
  options?: string[];
  /** What to ask the marketer when this is the field at fault. */
  ask: string;
};

export const CAMPAIGN_BRIEF_FIELDS: FieldSpec[] = [
  {
    key: "campaign_name",
    label: "Campaign Name",
    section: "Request type",
    required: true,
    aliases: ["campaign name", "name of the campaign", "campaign title"],
    ask: "What should the campaign be called? Succinct, no spaces, and distinct from other campaigns (e.g. XOSSpeedUptier).",
  },
  {
    key: "request_type",
    label: "Request type",
    section: "Request type",
    required: true,
    aliases: ["request type", "type of request"],
    options: ["Audience Build-Only", "Campaign + Audience", "Creative Only"],
    ask: "Is this Audience Build-Only, Campaign + Audience, or Creative Only?",
  },
  {
    key: "audience_support",
    label: "Audience support needed",
    section: "Request type",
    required: true,
    aliases: ["audience support", "type of audience support"],
    options: ["Audience Build (New)", "Audience Update", "Audience Clone"],
    ask: "Is this a new audience build, an update, or a clone?",
  },
  {
    key: "approved_por",
    label: "Approved POR",
    section: "Overview",
    required: true,
    aliases: ["por", "approved por", "plan of record"],
    options: ["Yes", "No"],
    ask: "Is this tied to an approved POR?",
  },
  {
    key: "business_objective",
    label: "Primary business objective",
    section: "Overview",
    required: true,
    aliases: ["business objective", "objective", "goal"],
    options: ["Growth/Upsell", "Retention", "Acquisition", "Engagement"],
    ask: "What is the primary business objective — Growth/Upsell, Retention, Acquisition or Engagement?",
  },
  {
    key: "lifecycle_journey",
    label: "Customer Lifecycle Journey",
    section: "Overview",
    required: true,
    aliases: ["lifecycle", "journey", "customer lifecycle"],
    options: ["Upgrade", "Onboard", "Renew", "Winback"],
    ask: "Which lifecycle journey — Upgrade, Onboard, Renew or Winback?",
  },
  {
    key: "product_mix",
    label: "Product Mix",
    section: "Overview",
    required: true,
    aliases: ["product mix", "product"],
    ask: "Which product mix does this target?",
  },
  {
    key: "line_of_business",
    label: "Line of business",
    section: "Overview",
    required: true,
    aliases: ["line of business", "lob", "residential", "business unit"],
    options: ["Residential (RES)", "Business (SMB)"],
    ask: "Residential (RES) or Business (SMB)?",
  },
  {
    key: "launch_date",
    label: "Launch date",
    section: "Timeline",
    required: true,
    aliases: ["launch date", "launch", "go live", "in market date", "timing"],
    ask: "When does this need to launch?",
  },
  {
    key: "priority",
    label: "Priority",
    section: "Timeline",
    required: true,
    aliases: ["priority", "urgency"],
    options: ["Standard Priority", "High Priority", "Critical"],
    ask: "Standard, High or Critical priority?",
  },
  {
    key: "build_method",
    label: "How the audience should be built",
    section: "Audience",
    required: true,
    aliases: ["build method", "how should the audience be built", "rule builder", "fac", "workflow audience"],
    options: ["1) Simple Workflow Audience", "2) AEP Rule Builder", "3) FAC"],
    ask: "Simple Workflow Audience, AEP Rule Builder, or FAC?",
  },
  {
    key: "expected_size",
    label: "Expected audience size",
    section: "Audience",
    required: true,
    aliases: ["audience size", "expected size", "size", "count", "volume", "how many"],
    options: ["Small (<100k)", "Medium (100k-1M)", "Very Large (1M+)"],
    ask: "Roughly how large is the audience — under 100k, 100k to 1M, or over 1M?",
  },
  {
    key: "refresh",
    label: "Audience refresh cadence",
    section: "Audience",
    aliases: ["refresh", "cadence", "how often should the audience refresh"],
    options: ["One-time snapshot", "Dynamic Audience Updates"],
    ask: "One-time snapshot, or dynamic updates?",
  },
  {
    key: "exclusions",
    label: "Exclusions or suppressions",
    section: "Audience",
    aliases: ["exclusion", "suppression", "suppress", "exclude"],
    ask: "Any exclusions or suppressions that must be applied?",
  },
  {
    key: "data_available",
    label: "Targeting data availability",
    section: "Audience",
    required: true,
    aliases: ["data available", "targeting data", "attributes available", "attribute availability"],
    options: ["Yes", "No"],
    ask: "Is all the required targeting data available today?",
  },
  {
    key: "data_location",
    label: "Where the data lives today",
    section: "Audience",
    // "Not sure" is the single most common answer here, and it is the one that
    // sends the request into the quarter-long GTO tail (B4).
    ambiguous: ["not sure", "unknown", "n/a", "tbc", "tbd", "dont know", "don't know"],
    aliases: ["where does this data live", "data source", "source system", "data location", "wrong source"],
    ask: "Which system holds this data today? If you are not sure, name the team who would know — that answer is what decides whether this needs a GTO request.",
  },
  {
    key: "predictive_model",
    label: "Predictive model required",
    section: "Audience",
    aliases: ["predictive model", "model not live", "propensity"],
    options: ["Yes", "No"],
    ask: "Does this need a predictive model that is not live yet?",
  },
  {
    key: "activation_pattern",
    label: "Activation pattern",
    section: "Audience",
    aliases: ["activation pattern", "trigger", "near real time", "batch"],
    options: ["Batch", "Near-real time trigger", "Scheduled"],
    ask: "Batch, scheduled, or a near-real-time trigger?",
  },
  {
    key: "channels",
    label: "Channels",
    section: "Channels",
    required: true,
    aliases: ["channel", "channels", "email", "sms", "direct mail", "streaming"],
    options: ["Email", "SMS", "Digital/Display", "Direct Mail", "TV", "Streaming", "Xfinity App"],
    ask: "Which channels — Email, SMS, Digital/Display, Direct Mail, TV, Streaming, Xfinity App?",
  },
  {
    key: "attribution",
    label: "Cross-channel attribution",
    section: "Channels",
    aliases: ["attribution", "how should performance be measured"],
    options: ["First-Touch Attribution", "Last-Touch", "Multi-Touch"],
    ask: "First-touch, last-touch or multi-touch attribution?",
  },
];

/** @returns the field whose key matches, or undefined */
export function fieldByKey(key: string): FieldSpec | undefined {
  return CAMPAIGN_BRIEF_FIELDS.find((f) => f.key === key);
}

/** Every field that blocks submission when absent. */
export function requiredFields(): FieldSpec[] {
  return CAMPAIGN_BRIEF_FIELDS.filter((f) => f.required);
}
