/**
 * Generic reflection/critic loop: call the model, run the caller's own
 * (deterministic, already-trusted) validator over the parsed result as a
 * critic, and — only when the critic found something concretely wrong, never
 * on an honest decline — give the model one chance to fix it before the
 * caller falls back exactly as it did before this existed.
 *
 * WHY A SHARED PRIMITIVE: llm-extract.ts, llm-triage.ts, and pql-synth.ts
 * each already compute the "did this raw model output survive our real
 * validation gate" signal (toKnownFields, validateFindings, verifyFields) —
 * today that signal is used once, to decide what to keep, and the rest is
 * silently dropped. This loop is the one place that turns "here's what got
 * rejected and why" into a second prompt instead of throwing it away. It
 * carries no domain knowledge of its own: parse/critique/revise are all
 * supplied by the caller, reusing each site's existing validator verbatim -
 * so there is no new judgment call introduced here, and no new sycophancy
 * risk (see reflect.test.ts and each call site's own docstring).
 *
 * THE CRITIC MUST BE DETERMINISTIC OR THE SAME MODEL WILL MOSTLY AGREE WITH
 * ITSELF - see the agentic-patterns guide's reflection section. Every caller
 * of this loop passes a `critique` built from real, already-existing
 * validation against ground truth (a real schema field, a real form option),
 * never a second LLM call grading the first.
 */

import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "./types";

export type ReflectionOutcome<T> = {
  /** The winning (or, on exhaustion, the last) attempt's parsed value. */
  result: T;
  /** True iff the winning attempt's critique returned no issues. */
  passed: boolean;
  /** 1 = no revision was needed. */
  attempts: number;
  /** The model id from the winning/last attempt, or null if every attempt failed to parse. */
  model: string | null;
  /** Token usage from the winning/last attempt, when the provider reported it. */
  usage: LlmCompletionResult["usage"];
  /** The critique issues from the LAST attempt - empty when passed. */
  issues: string[];
};

export interface ReflectOptions<T> {
  client: LlmClient;
  system: string;
  /** Round-1 prompt. */
  prompt: string;
  /** Parse the model's raw text into T. Throw for unusable text (e.g. no JSON found). */
  parse: (text: string) => T;
  /** [] = passed. Non-empty = concrete, fixable issues to feed back. Must be deterministic. */
  critique: (parsed: T) => string[];
  /** Build the next round's prompt from the prior attempt's parsed value and its issues. */
  revise: (prior: { parsed: T; issues: string[] }) => string;
  /** Hard cap on total attempts (1 = no revision). Default 2. */
  maxAttempts?: number;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Run the loop. Never throws for a normal critique failure - only a `parse`
 * throw on every single attempt propagates (callers already wrap the whole
 * LLM call in a try/catch that falls back, so this matches their existing
 * "any failure -> fallback" contract without a new error path to handle).
 */
export async function reflectLoop<T>(opts: ReflectOptions<T>): Promise<ReflectionOutcome<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);

  let prompt = opts.prompt;
  let lastError: Error | null = null;
  let last: { parsed: T; issues: string[]; model: string; usage: LlmCompletionResult["usage"] } | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const req: LlmCompletionRequest = {
      system: opts.system,
      prompt,
      temperature: opts.temperature ?? 0,
      maxTokens: opts.maxTokens,
    };
    const completion = await opts.client.complete(req);

    let parsed: T;
    try {
      parsed = opts.parse(completion.text);
    } catch (err) {
      lastError = err as Error;
      if (attempt >= maxAttempts) break;
      // A parse failure has no `parsed` value to build a targeted revision
      // from - ask again with the raw problem named, verbatim, rather than
      // guessing at a structured diff of nothing.
      prompt = [prompt, "", "Your previous response could not be read as valid JSON:", `  ${lastError.message}`, "Return ONLY a valid JSON object this time, matching the format above exactly."].join("\n");
      continue;
    }

    const issues = opts.critique(parsed);
    last = { parsed, issues, model: completion.model, usage: completion.usage };
    lastError = null;

    if (issues.length === 0 || attempt >= maxAttempts) {
      return {
        result: parsed,
        passed: issues.length === 0,
        attempts: attempt,
        model: completion.model,
        usage: completion.usage,
        issues,
      };
    }

    prompt = opts.revise({ parsed, issues });
  }

  if (last) {
    return { result: last.parsed, passed: false, attempts: maxAttempts, model: last.model, usage: last.usage, issues: last.issues };
  }
  // Every attempt failed to parse - nothing for the caller to fall back to
  // but a thrown error, exactly like a parse failure did before this loop
  // existed (each call site's try/catch already turns this into a fallback).
  throw lastError ?? new Error("reflectLoop: no attempt produced a usable result");
}
