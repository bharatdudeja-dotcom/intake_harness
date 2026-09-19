import { describe, it, expect } from "vitest";
import { parseBrief, nextQuestions } from "./parse";
import { requiredFields, audienceFields } from "@/lib/agents/shared/campaign-brief";

const COMPLETE_REQUIRED_BRIEF =
  "Campaign name: Fall Push. Business objective: Growth/Upsell for existing residential subscribers. " +
  "Line of business: Residential (RES). Request type: Audience Build-Only. Launch date: 1 November.";

describe("nextQuestions sequencing - required fields before audience-completeness ones", () => {
  it("asks about missing REQUIRED fields first, never an audience field while any required field is still missing", () => {
    const parsed = parseBrief("We need something built.");
    const questions = nextQuestions(parsed, 2);
    expect(questions.length).toBe(2);
    for (const q of questions) {
      expect(requiredFields().map((f) => f.key)).toContain(q.key);
    }
  });

  it("once every required field is answered, moves on to askForAudience fields instead of stopping", () => {
    const parsed = parseBrief(COMPLETE_REQUIRED_BRIEF);
    expect(parsed.missing).toEqual([]); // every required field was extracted from the brief
    const questions = nextQuestions(parsed, 2);
    expect(questions.length).toBe(2);
    for (const q of questions) {
      expect(audienceFields().map((f) => f.key)).toContain(q.key);
    }
  });

  it("stops asking (empty) once both required and audience-completeness fields are all answered", () => {
    // Every required AND every askForAudience field, keyed exactly as parse.ts expects.
    const known: Record<string, string> = {};
    for (const f of requiredFields()) known[f.key] = "x";
    for (const f of audienceFields()) known[f.key] = "x";

    const parsed = parseBrief("", known);
    expect(nextQuestions(parsed, 2)).toEqual([]);
  });

  it("respects the same 2-per-round cap for audience questions as for required ones", () => {
    const known: Record<string, string> = {};
    for (const f of requiredFields()) known[f.key] = "x";
    const parsed = parseBrief("", known);
    expect(parsed.missing).toEqual([]);
    expect(parsed.missingAudience.length).toBeGreaterThan(2); // there are more than 2 askForAudience fields
    expect(nextQuestions(parsed, 2).length).toBe(2);
  });
});

describe("the audience-completeness field set - a regression guard on what's actually asked", () => {
  // Explicit product direction (a real LCE Workfront form's "Audience
  // Specifications & Model Integration" section, ticket 1475050/"9Box", 19
  // Sep 2026): these specific fields are the ones Agent 1 now asks for.
  // Guards against silently dropping one in a future refactor.
  it("includes every field identified from the LCE audience section", () => {
    const keys = audienceFields().map((f) => f.key);
    for (const expected of [
      "audience_description",
      "audience_build_method",
      "expected_audience_size",
      "audience_refresh_cadence",
      "exclusion",
      "data_availability",
      "data_location",
      "requires_predictive_model",
      "activation_pattern",
      "trigger_already_active",
      "campaign_duration",
      "lifecycle_journey",
      "audience_support_type",
      "lifecycle_journey_subcategory",
      "product_mix",
      "audience_performance_history",
    ]) {
      expect(keys).toContain(expected);
    }
  });

  it("does not include fields unrelated to the audience (creative/priority/campaign-series)", () => {
    const keys = audienceFields().map((f) => f.key);
    expect(keys).not.toContain("creative_status");
    expect(keys).not.toContain("priority");
    expect(keys).not.toContain("campaign_series");
    expect(keys).not.toContain("email_count");
  });
});
