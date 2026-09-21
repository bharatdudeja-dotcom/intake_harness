import { describe, it, expect } from "vitest";
import { detectRejection } from "./rejection";

describe("detectRejection - the cases the old keyword-grep missed", () => {
  it("reads a named-deficiency rejection that trips none of the old five stems", () => {
    // "this needs the LOB before we can proceed" matched none of
    // reject|return|more info|insufficient|resubmit, so it read as no rejection.
    const signal = detectRejection([
      { message: "this needs the LOB before we can proceed", entryDate: "2026-09-19T10:00:00Z" },
    ]);
    expect(signal.rejected).toBe(true);
    expect(signal.reason).toMatch(/LOB/);
    expect(signal.source).toBe("text_signal");
  });

  it("reads 'sending back - audience definition is unclear'", () => {
    const signal = detectRejection([{ message: "sending back - audience definition is unclear" }]);
    expect(signal.rejected).toBe(true);
  });

  it("does not treat an acknowledgement ('resubmitted, thanks') as a rejection", () => {
    // The old regex matched "resubmit" and would have returned this as the
    // rejection reason via .pop().
    const signal = detectRejection([{ message: "resubmitted, thanks!" }]);
    expect(signal.rejected).toBe(false);
  });
});

describe("detectRejection - most recent authoritative record, not last by array order", () => {
  it("prefers the substantive rejection over a later acknowledgement", () => {
    const signal = detectRejection([
      { message: "Rejecting: missing launch date", entryDate: "2026-09-19T09:00:00Z" },
      { message: "resubmitted, thanks", entryDate: "2026-09-19T11:00:00Z" },
    ]);
    expect(signal.rejected).toBe(true);
    expect(signal.reason).toMatch(/missing launch date/);
  });

  it("among multiple rejections, the most recent by timestamp wins", () => {
    const signal = detectRejection([
      { message: "returning - wrong line of business", entryDate: "2026-09-19T09:00:00Z" },
      { message: "sending back again - still missing the region", entryDate: "2026-09-19T15:00:00Z" },
    ]);
    expect(signal.reason).toMatch(/region/);
  });

  it("falls back to array order (last wins) when no timestamps are present", () => {
    const signal = detectRejection([
      { message: "rejected - missing objective" },
      { message: "rejected - missing customer type" },
    ]);
    expect(signal.reason).toMatch(/customer type/);
  });
});

describe("detectRejection - structured status/decision fields outrank prose", () => {
  it("reads an explicit rejected status field", () => {
    const signal = detectRejection([{ status: "Rejected", message: "see notes" }]);
    expect(signal.rejected).toBe(true);
    expect(signal.source).toBe("status_field");
    expect(signal.reason).toBe("see notes");
  });

  it("reads an approval decision field", () => {
    const signal = detectRejection([{ decision: "reject", message: "needs rework" }]);
    expect(signal.rejected).toBe(true);
    expect(signal.source).toBe("decision_field");
  });

  it("synthesizes a reason when the status rejects but no prose was recorded", () => {
    const signal = detectRejection([{ status: "Needs More Info" }]);
    expect(signal.rejected).toBe(true);
    expect(signal.reason).toMatch(/no reason text/i);
  });
});

describe("detectRejection - no rejection", () => {
  it("empty list is not a rejection, considered = 0", () => {
    const signal = detectRejection([]);
    expect(signal.rejected).toBe(false);
    expect(signal.considered).toBe(0);
    expect(signal.source).toBe("none");
  });

  it("ordinary approving chatter is not a rejection", () => {
    const signal = detectRejection([
      { message: "looks good to me" },
      { message: "approved, go ahead" },
    ]);
    expect(signal.rejected).toBe(false);
    expect(signal.considered).toBe(2);
  });

  it("reads the body across differing connector field names", () => {
    const signal = detectRejection([{ note: "rejected: missing launch date" }]);
    expect(signal.rejected).toBe(true);
    expect(signal.reason).toMatch(/launch date/);
  });
});
