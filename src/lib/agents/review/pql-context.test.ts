import { describe, it, expect, vi, beforeEach } from "vitest";

const callMcpToolMock = vi.fn();
vi.mock("@/lib/mcp-client", () => ({ callMcpTool: (...args: unknown[]) => callMcpToolMock(...args) }));

const { groundPqlGuidance, formatPqlGuidanceNote } = await import("./pql-context");
type PqlGuidance = Awaited<ReturnType<typeof groundPqlGuidance>>;

beforeEach(() => {
  callMcpToolMock.mockReset();
});

describe("the local PQL reference - docs/pql-reference.md", () => {
  // This is the regression this guards: the file is read from disk at
  // runtime (not bundled as a constant), and Next's standalone Docker
  // output does NOT trace arbitrary fs reads into the runtime image - only
  // an explicit Dockerfile COPY does. If that COPY is ever removed, this
  // is the thing that silently starts returning `available: false` in
  // every deployed container while still passing in `next dev` and in
  // this test (both run from the repo root, where the real file exists).
  it("loads successfully and finds all 12 function categories (not 13 - 'Concepts' is excluded)", async () => {
    const guidance = await groundPqlGuidance("review", ""); // empty criteria still loads the reference
    expect(guidance.localReference.available).toBe(true);
    expect(guidance.localReference.path).toBe("docs/pql-reference.md");
    expect(guidance.localReference.categoryCount).toBe(12);
    expect(guidance.localReference.content).toMatch(/## Boolean functions/);
    expect(guidance.localReference.content).toMatch(/## Miscellaneous functions/);
    expect(guidance.localReference.error).toBeNull();
  });

  it("is attached even when the criteria is empty (no network call needed to know it)", async () => {
    const guidance = await groundPqlGuidance("audience_creation", "   ");
    expect(guidance.localReference.available).toBe(true);
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });

  it("calls search_adobe_knowledge with the REAL caller's taskId, not a hardcoded one", async () => {
    callMcpToolMock.mockResolvedValue({ results: [] });
    await groundPqlGuidance("audience_creation", "audience where ECID exists");
    expect(callMcpToolMock).toHaveBeenCalledWith(
      "audience_creation",
      "search_adobe_knowledge",
      expect.objectContaining({ query: expect.stringContaining("ECID exists") }),
    );
  });

  it("still attaches the local reference even when the knowledge base call throws", async () => {
    callMcpToolMock.mockRejectedValue(new Error("gateway timeout"));
    const guidance = await groundPqlGuidance("review", "audience where ECID exists");
    expect(guidance.localReference.available).toBe(true);
    expect(guidance.reason).toBe("gateway timeout");
    expect(guidance.hits).toEqual([]);
  });
});

describe("formatPqlGuidanceNote", () => {
  function guidance(overrides: Partial<PqlGuidance> = {}): PqlGuidance {
    return {
      grounded: true,
      reason: null,
      hits: [],
      localReference: { available: true, path: "docs/pql-reference.md", categoryCount: 12, content: "...", error: null },
      ...overrides,
    };
  }

  it("points at the local reference as the material to build against, ahead of the knowledge base", () => {
    const note = formatPqlGuidanceNote(guidance());
    expect(note).toMatch(/PQL function reference: docs\/pql-reference\.md \(12 categories/);
    expect(note).toMatch(/material to build the segment expression against/);
    expect(note).toMatch(/knowledge base.*has no PQL syntax indexed/);
  });

  it("falls back honestly when the local reference could not be loaded", () => {
    const note = formatPqlGuidanceNote(
      guidance({ localReference: { available: false, path: "docs/pql-reference.md", categoryCount: 0, content: null, error: "ENOENT" } }),
    );
    expect(note).toMatch(/Could not load the local PQL reference \(ENOENT\)/);
  });

  it("still cites knowledge-base hits when there are any, alongside the local reference", () => {
    const note = formatPqlGuidanceNote(
      guidance({ hits: [{ title: "Segmentation Service", url: "https://experienceleague.adobe.com/docs/experience-platform/segmentation/home.html", excerpt: "..." }] }),
    );
    expect(note).toMatch(/"Segmentation Service"/);
    expect(note).toMatch(/experienceleague\.adobe\.com/);
  });

  it("reports honestly when the knowledge base found nothing", () => {
    const note = formatPqlGuidanceNote(guidance({ hits: [], reason: "search_adobe_knowledge returned nothing for this audience's criteria" }));
    expect(note).toMatch(/Knowledge base: search_adobe_knowledge returned nothing/);
  });
});
