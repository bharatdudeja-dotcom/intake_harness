import { describe, it, expect } from "vitest";
import { formatPqlGuidanceNote, type PqlGuidance } from "./pql-context";

describe("formatPqlGuidanceNote", () => {
  it("reports honestly when nothing was found - never invents guidance", () => {
    const guidance: PqlGuidance = { grounded: false, reason: "search_adobe_knowledge returned nothing for this audience's criteria", hits: [] };
    const note = formatPqlGuidanceNote(guidance);
    expect(note).toMatch(/Could not ground this in PQL documentation/);
    expect(note).toMatch(/returned nothing/);
  });

  it("cites every hit with a clickable url, and flags it as overview-level only", () => {
    const guidance: PqlGuidance = {
      grounded: true,
      reason: null,
      hits: [{ title: "Segmentation Service", url: "https://experienceleague.adobe.com/docs/experience-platform/segmentation/home.html", excerpt: "..." }],
    };
    const note = formatPqlGuidanceNote(guidance);
    expect(note).toMatch(/"Segmentation Service"/);
    expect(note).toMatch(/experienceleague\.adobe\.com/);
    expect(note).toMatch(/Overview-level/);
    expect(note).toMatch(/Confirm exact PQL expressions against Adobe's own PQL reference/);
  });
});
