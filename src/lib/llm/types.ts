/**
 * The provider-agnostic seam for every LLM call in this app.
 *
 * WHY AN INTERFACE AND NOT A DIRECT SDK CALL: this repo has to run against
 * three genuinely different backends - AWS Bedrock, Anthropic's own API, and
 * a self-hosted Ollama whose host changes often - and the choice must be
 * configuration, not code. Everything that wants a completion depends on this
 * one small interface; the concrete provider is resolved once, in
 * src/lib/llm/index.ts, from environment variables. Adding a fourth provider
 * later is one new file implementing `LlmClient`, nothing else.
 *
 * DELIBERATELY MINIMAL: one method, text in / text out, plus token usage when
 * the provider reports it. The agents here don't need streaming, tool-calling,
 * or multi-turn state at this layer - they build a single prompt and parse a
 * single response. Keeping the interface this narrow is what makes all three
 * providers trivially swappable.
 */

/** One completion request. Prompt is plain text; the caller owns any formatting/JSON instructions. */
export interface LlmCompletionRequest {
  /** System instruction, when the provider supports one separately from the user turn. */
  system?: string;
  /** The user prompt. */
  prompt: string;
  /** Upper bound on generated tokens. Providers clamp to their own limits. */
  maxTokens?: number;
  /** 0 = deterministic-as-possible. Extraction wants this low; default 0. */
  temperature?: number;
}

export interface LlmCompletionResult {
  /** The model's text output, verbatim (untrimmed). */
  text: string;
  /** Which model actually answered - echoed into AgentResponse.usage.model for the trace. */
  model: string;
  /** Token counts when the provider returns them; null when it doesn't (e.g. some Ollama builds). */
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
}

/**
 * A single LLM backend. Implementations live in ./providers/*.
 *
 * `complete` MUST throw on any transport/API failure rather than returning a
 * degraded result - every caller in this app treats a thrown error as "the LLM
 * is unavailable, fall back to the deterministic path", which is only correct
 * if a failure is unambiguous. A provider that swallowed an error into an empty
 * string would defeat that fallback.
 */
export interface LlmClient {
  /** A stable identifier for the configured provider+model, for logging/trace. */
  readonly id: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

/** Which provider the factory should build. */
export type LlmProvider = "bedrock" | "anthropic" | "ollama";

/** Thrown when LLM config is present but invalid (missing host, unknown provider, ...). */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}
