/**
 * Anthropic's own Messages API (api.anthropic.com), over plain fetch - no SDK,
 * same as every other network call in this repo.
 *
 * Config (see src/lib/llm/index.ts for how these are read):
 *   ANTHROPIC_API_KEY   - required
 *   ANTHROPIC_MODEL     - optional, defaults to a current Claude model
 *   ANTHROPIC_BASE_URL  - optional, for a proxy/gateway; defaults to the public API
 */

import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "../types";

const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createAnthropicClient(cfg: AnthropicConfig): LlmClient {
  const model = cfg.model || DEFAULT_MODEL;
  const baseUrl = (cfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  return {
    id: `anthropic:${model}`,
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": cfg.apiKey,
            "anthropic-version": API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: req.maxTokens ?? 2048,
            temperature: req.temperature ?? 0,
            ...(req.system ? { system: req.system } : {}),
            messages: [{ role: "user", content: req.prompt }],
          }),
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(`Anthropic request failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Anthropic API returned HTTP ${res.status}: ${body.slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");

      return {
        text,
        model: data.model || model,
        usage: data.usage
          ? { inputTokens: data.usage.input_tokens ?? null, outputTokens: data.usage.output_tokens ?? null }
          : null,
      };
    },
  };
}
