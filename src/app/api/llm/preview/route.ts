import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { getLlmClient, isLlmConfigured } from "@/lib/llm";
import { extractIntake } from "@/lib/agents/intake/llm-extract";
import { triageRejectionLlm, detectRejectionLlm } from "@/lib/agents/review/llm-triage";
import type { CommentLike } from "@/lib/agents/review/rejection";

/**
 * POST /api/llm/preview — a dry-run window into what the LLM (or the
 * deterministic fallback) WOULD do, with no pipeline run and no DB write.
 *
 * WHY THIS EXISTS: the LLM extraction/triage only ran inside a real pipeline
 * run, so there was no way to check its quality on a brief or a rejection
 * without kicking one off and reading task_runs afterward. This is the
 * side-by-side "does the model read this brief better than the regex?" harness
 * made permanent - point it at a real brief, see the extracted fields AND which
 * engine produced them, tune the provider/model, repeat. It calls the exact
 * same functions the agents call, so what you see here is what a run would get.
 *
 * Modes (one per request):
 *   { "mode": "intake",   "brief": "..." }            -> field extraction
 *   { "mode": "triage",   "reason": "...", "fields"? } -> rejection -> findings
 *   { "mode": "detect",   "comments": [ {message}... ]} -> is-it-a-rejection
 *
 * PQL synthesis is intentionally NOT previewable here: it needs a live AEP
 * schema probe (real present-field list) to verify against, which this
 * write-free endpoint has no business making - previewing it without the probe
 * would drop the very safety gate that makes synthesis trustworthy.
 *
 * Read-only and runs OUTSIDE a tool-call-log context, so the traced LLM wrapper
 * is a no-op here (no run to attach to) - which is correct: a preview isn't a run.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return apiError('Body must be a JSON object with a "mode".', "VALIDATION_ERROR", 400);
  }

  const mode = String((body as { mode?: unknown }).mode || "");
  const client = getLlmClient(); // may be null -> functions fall back to deterministic
  const llmConfigured = isLlmConfigured();

  try {
    if (mode === "intake") {
      const brief = String((body as { brief?: unknown }).brief || "").trim();
      if (!brief) return apiError('"brief" is required for mode "intake".', "VALIDATION_ERROR", 400);
      const result = await extractIntake(brief, {}, client);
      return NextResponse.json({
        mode,
        llmConfigured,
        engine: result.source,
        model: result.model,
        fallbackReason: result.fallbackReason,
        fields: result.parsed.fields,
        inferred: result.parsed.inferred,
        missing: result.parsed.missing.map((f) => f.key),
      });
    }

    if (mode === "triage") {
      const reason = String((body as { reason?: unknown }).reason || "").trim();
      if (!reason) return apiError('"reason" is required for mode "triage".', "VALIDATION_ERROR", 400);
      const fields = ((body as { fields?: Record<string, string> }).fields ?? {}) as Record<string, string>;
      const result = await triageRejectionLlm(reason, fields, client);
      return NextResponse.json({
        mode,
        llmConfigured,
        engine: result.source,
        model: result.model,
        fallbackReason: result.fallbackReason,
        findings: result.triage.findings,
        redraft: result.triage.redraft,
        changed: result.triage.changed,
        needsHuman: result.triage.needsHuman,
      });
    }

    if (mode === "detect") {
      const comments = (body as { comments?: unknown }).comments;
      if (!Array.isArray(comments)) {
        return apiError('"comments" (an array) is required for mode "detect".', "VALIDATION_ERROR", 400);
      }
      const result = await detectRejectionLlm(comments as CommentLike[], client);
      return NextResponse.json({
        mode,
        llmConfigured,
        engine: result.source,
        fallbackReason: result.fallbackReason,
        rejected: result.signal.rejected,
        reason: result.signal.reason,
        detectedVia: result.signal.source,
      });
    }

    return apiError(`Unknown mode "${mode}". Use "intake", "triage", or "detect".`, "VALIDATION_ERROR", 400);
  } catch (err) {
    return apiError((err as Error).message, "INTERNAL_ERROR", 500);
  }
}
