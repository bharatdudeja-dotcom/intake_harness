import { NextRequest, NextResponse } from "next/server";
import { parseBrief, nextQuestions } from "@/lib/agents/intake/parse";
import { planFormWrites, questionsFromPlan } from "@/lib/agents/intake/form-plan";

/**
 * What WOULD be created, before anything is.
 *
 * WHY THIS EXISTS
 *
 * Creating the request sends email. The moment it exists, a queue sees it, a
 * reviewer may open it, and a correction after that point is a second version
 * of the truth rather than an edit. So the marketer should see what is about to
 * be filed while it is still free to change - the title, every field, and the
 * values as Workfront will store them.
 *
 * It is a READ. It parses the brief and reads the form; it creates nothing,
 * writes nothing, and sends no mail. Calling it twice costs two reads.
 *
 * WHY IT IS NOT JUST "ASK THE ASSISTANT TO SUMMARISE"
 *
 * An assistant summarising its own intention is not the same as the payload.
 * The interesting differences are exactly the ones a summary smooths over: that
 * "New York" will not fit a Region field offering uk/de/us, that "Email" is
 * stored as `email`, that the audience sentence goes in one field and the
 * audience enumeration in another. This returns what will actually be sent.
 *
 * POST /api/intake/preview
 *   { "input": { "brief": "...", "known": { ... } } }
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const input = (body?.input ?? body ?? {}) as { brief?: string; known?: Record<string, unknown> };
  const brief = String(input.brief ?? "").trim();

  if (!brief) {
    return NextResponse.json({ error: 'Body must be { "input": { "brief": "..." } }' }, { status: 400 });
  }

  const parsed = parseBrief(brief, input.known ?? {});

  /*
   * The form, read live. Which fields exist and what they accept is a property
   * of the tenant and changes without us, so it is never assumed here.
   */
  const plan = await planFormWrites("intake", "issue", parsed.fields).catch((err) => ({
    writes: {},
    explains: [],
    mismatched: [],
    unanswered: [],
    formFieldCount: 0,
    error: (err as Error).message,
  }));

  const missing = nextQuestions(parsed, 4).map((f) => ({ field: f.key, ask: f.ask ?? `What is the ${f.label}?` }));

  return NextResponse.json({
    /** The title the request will carry. */
    title: parsed.fields.campaign_name || "(no campaign name yet - it will be asked for)",
    /** Everything read out of the brief, and whether it was stated or inferred. */
    captured: parsed.extracted.map((f) => ({ field: f.label, value: f.value, from: f.from })),
    /** Exactly what will be written to the request's own fields. */
    willWrite: "writes" in plan ? plan.writes : {},
    willWriteExplained: "explains" in plan ? plan.explains : [],
    /** The brief says it; this form cannot hold it. Worth seeing before filing. */
    cannotHold: "mismatched" in plan ? plan.mismatched : [],
    /** The form asks; the brief has not said. */
    unanswered: "unanswered" in plan ? plan.unanswered : [],
    /** Essentials with no answer at all - these WILL be asked before filing. */
    missing,
    questions: "writes" in plan ? questionsFromPlan(plan as never) : [],
    formFieldsSeen: "formFieldCount" in plan ? plan.formFieldCount : 0,
    /*
     * Said plainly, because the next call is the irreversible one.
     */
    note:
      "Nothing has been created. Creating the request notifies the queue by email, so show this to " +
      "the marketer, take any corrections, and only then start the run.",
  });
}
