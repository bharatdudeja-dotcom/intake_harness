import { describe, it, expect, afterEach } from "vitest";
import { getLlmClient, isLlmConfigured, LlmConfigError } from "./index";
import { normalizeOllamaHost } from "./providers/ollama";

const LLM_VARS = [
  "LLM_PROVIDER", "AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN", "BEDROCK_MODEL_ID", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL", "OLLAMA_HOST", "OLLAMA_MODEL",
];

afterEach(() => {
  for (const v of LLM_VARS) delete process.env[v];
});

describe("getLlmClient - provider resolution from env", () => {
  it("returns null when LLM_PROVIDER is unset (LLM disabled = the default)", () => {
    expect(getLlmClient()).toBeNull();
    expect(isLlmConfigured()).toBe(false);
  });

  it("builds an anthropic client when configured", () => {
    process.env.LLM_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    const client = getLlmClient();
    expect(client?.id).toMatch(/^anthropic:/);
    expect(isLlmConfigured()).toBe(true);
  });

  it("builds a bedrock client when configured", () => {
    process.env.LLM_PROVIDER = "bedrock";
    process.env.AWS_REGION = "us-east-1";
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    expect(getLlmClient()?.id).toMatch(/^bedrock:/);
  });

  it("builds an ollama client with a user-supplied host", () => {
    process.env.LLM_PROVIDER = "ollama";
    process.env.OLLAMA_HOST = "10.0.0.9";
    process.env.OLLAMA_MODEL = "llama3.1";
    expect(getLlmClient()?.id).toMatch(/^ollama:llama3\.1@http:\/\/10\.0\.0\.9:11434$/);
  });

  it("throws (not returns null) when a provider is named but misconfigured", () => {
    process.env.LLM_PROVIDER = "ollama"; // no OLLAMA_HOST/MODEL
    expect(() => getLlmClient()).toThrow(LlmConfigError);
  });

  it("throws on an unknown provider name", () => {
    process.env.LLM_PROVIDER = "gpt5";
    expect(() => getLlmClient()).toThrow(LlmConfigError);
  });
});

describe("normalizeOllamaHost - the host changes often, so it's forgiving", () => {
  it("adds scheme and default port to a bare host", () => {
    expect(normalizeOllamaHost("10.0.0.5")).toBe("http://10.0.0.5:11434");
  });
  it("keeps an explicit port", () => {
    expect(normalizeOllamaHost("host:9000")).toBe("http://host:9000");
  });
  it("keeps an explicit scheme and strips a trailing slash", () => {
    expect(normalizeOllamaHost("https://gpu.box:11434/")).toBe("https://gpu.box:11434");
  });
  it("rejects an empty host", () => {
    expect(() => normalizeOllamaHost("  ")).toThrow();
  });
});
