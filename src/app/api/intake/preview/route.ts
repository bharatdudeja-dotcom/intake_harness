import { NextRequest, NextResponse } from "next/server";
import { parseBrief, nextQuestions } from "@/lib/agents/intake/parse";
import { planFormWrites, questionsFromPlan } from "@/lib/agents/intake/form-plan";

/*
 * Two. Not a tuning knob - the process rule, quoted in nextQuestions:
 * past two, the agent has failed rather than the marketer.
 */
const MAX_QUESTIONS = 2;

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

  /*
   * TWO QUESTIONS. THE RULE WAS ALREADY WRITTEN; THIS IS WHERE IT WAS BROKEN.
   *
   * nextQuestions defaults to two, and says why in its own doc comment:
   * "Asking for eleven fields is how a loop count passes two, and past two the
   * agent has failed, not the marketer." This call passed 4 - and then a
   * SECOND, entirely uncapped list went out beside it as `questions`. A live
   * preview returned four in `missing` plus one more in `questions`, on a brief
   * that had already said most of it.
   *
   * Two lists also meant nobody was counting. Whatever each one thought it was
   * doing, the marketer saw the sum.
   *
   * So they are merged and cut to two, and the two that survive are the ones a
   * PERSON has to answer - a judgement the system has no standing to make -
   * rather than whichever happened to sort first. Everything else the form
   * would like is still reported under `unanswered`, where it informs without
   * demanding.
   */
  const asks = [
    ...nextQuestions(parsed, MAX_QUESTIONS).map((f) => ({
      field: f.key,
      ask: f.ask ?? `What is the ${f.label}?`,
    })),
    ...("writes" in plan ? questionsFromPlan(plan as never) : []).map((q) => ({
      field: typeof q === "string" ? q : (q as { field?: string }).field ?? "",
      ask: typeof q === "string" ? q : String((q as { ask?: string }).ask ?? q),
    })),
  ];

  const seenAsk = new Set<string>();
  const missing = asks
    .filter((a) => {
      const key = a.field || a.ask;
      if (seenAsk.has(key)) return false;
      seenAsk.add(key);
      return true;
    })
    .slice(0, MAX_QUESTIONS);

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
    /**
     * Where the brief disagrees with itself - an amendment that changed a
     * value, or two statements that cannot both be true. Shown separately from
     * the questions because it is the one thing here the marketer will want to
     * see even when they do not intend to answer anything: it proves the brief
     * was read, not pattern-matched.
     */
    conflicts: parsed.conflicts,
    /**
     * The questions a person actually has to answer - at most two, and the
     * same two in both fields. `questions` used to be a separate, uncapped
     * list, which is how a marketer ended up facing five. It is kept as an
     * alias so existing callers do not break, but it can no longer disagree.
     */
    missing,
    questions: missing,
    formFieldsSeen: "formFieldCount" in plan ? plan.formFieldCount : 0,
    /**
     * WHY THERE IS NOTHING TO WRITE, WHEN THERE IS NOTHING TO WRITE.
     *
     * The form is read live, and that read can fail - the Workfront connection
     * being signed out is the common case. The failure was caught and then
     * dropped, so the preview answered `willWrite: {}` with no explanation,
     * which reads as "this brief fills nothing" rather than "I could not see
     * the form". A marketer would reasonably conclude their brief was useless.
     *
     * This is the same honesty rule the rest of the preview follows: an empty
     * answer and an unavailable answer are different facts, and saying so is
     * the difference between a preview and a guess.
     */
    formError: "error" in plan ? (plan as { error?: string }).error ?? null : null,
    formReadable: ("formFieldCount" in plan ? plan.formFieldCount : 0) > 0,
    /*
     * Said plainly, because the next call is the irreversible one.
     */
    note:
      ("formFieldCount" in plan ? plan.formFieldCount : 0) > 0
        ? "Nothing has been created. Creating the request notifies the queue by email, so show this to " +
          "the marketer, take any corrections, and only then start the run."
        : "Nothing has been created - AND the Workfront form could not be read, so this preview shows " +
          "what was understood from the brief but NOT what would be written to the request. Do not " +
          "file from this preview: sign the Workfront connection in and preview again first.",
  });
}
