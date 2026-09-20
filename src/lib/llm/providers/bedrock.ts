/**
 * AWS Bedrock Runtime (InvokeModel), signed with SigV4 by hand over Node's
 * crypto - no aws-sdk dependency, consistent with this repo's "plain fetch,
 * no SDKs" approach everywhere else.
 *
 * WHY HAND-ROLLED SIGNING: pulling in @aws-sdk/client-bedrock-runtime drags a
 * large dependency tree into an app that otherwise makes every call with
 * fetch. Bedrock's only awkward part is the request signature, and SigV4 is a
 * well-specified ~40 lines against Node's crypto. Contained here so nothing
 * else in the app has to know about it.
 *
 * Config (see src/lib/llm/index.ts):
 *   AWS_REGION            - required (e.g. us-east-1)
 *   AWS_ACCESS_KEY_ID     - required
 *   AWS_SECRET_ACCESS_KEY - required
 *   AWS_SESSION_TOKEN     - optional (for temporary/STS credentials)
 *   BEDROCK_MODEL_ID      - optional, defaults to a current Claude-on-Bedrock id
 *
 * Targets the Anthropic Claude model family on Bedrock (the anthropic_version
 * body shape). A different Bedrock family would need a different body/parse;
 * kept to the one family this app uses rather than a universal adapter.
 */

import { createHash, createHmac } from "node:crypto";
import type { LlmClient, LlmCompletionRequest, LlmCompletionResult } from "../types";

const DEFAULT_MODEL_ID = "anthropic.claude-3-5-sonnet-20240620-v1:0";
const SERVICE = "bedrock";

export interface BedrockConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  modelId?: string;
  timeoutMs?: number;
}

const sha256Hex = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data, "utf8").digest();

/** The AWS Signature V4 signing-key derivation. */
function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/** amz date pair: ("20260921T140501Z", "20260921"). */
function amzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export function createBedrockClient(cfg: BedrockConfig): LlmClient {
  const modelId = cfg.modelId || DEFAULT_MODEL_ID;
  const region = cfg.region;
  const host = `bedrock-runtime.${region}.amazonaws.com`;
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  return {
    id: `bedrock:${modelId}`,
    async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
      const path = `/model/${encodeURIComponent(modelId)}/invoke`;
      const body = JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: "user", content: req.prompt }],
      });

      const { amzDate, dateStamp } = amzDates();
      const payloadHash = sha256Hex(body);

      // --- SigV4: canonical request ---
      const canonicalHeaders =
        `content-type:application/json\n` +
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n` +
        (cfg.sessionToken ? `x-amz-security-token:${cfg.sessionToken}\n` : "");
      const signedHeaders =
        "content-type;host;x-amz-content-sha256;x-amz-date" +
        (cfg.sessionToken ? ";x-amz-security-token" : "");
      const canonicalRequest = [
        "POST",
        path,
        "",
        canonicalHeaders,
        signedHeaders,
        payloadHash,
      ].join("\n");

      // --- SigV4: string to sign ---
      const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
      const stringToSign = [
        "AWS4-HMAC-SHA256",
        amzDate,
        scope,
        sha256Hex(canonicalRequest),
      ].join("\n");

      // --- SigV4: signature + auth header ---
      const signature = createHmac("sha256", signingKey(cfg.secretAccessKey, dateStamp, region, SERVICE))
        .update(stringToSign, "utf8")
        .digest("hex");
      const authorization =
        `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(`https://${host}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-amz-date": amzDate,
            "x-amz-content-sha256": payloadHash,
            authorization,
            ...(cfg.sessionToken ? { "x-amz-security-token": cfg.sessionToken } : {}),
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        throw new Error(`Bedrock request failed: ${(err as Error).message}`);
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Bedrock InvokeModel returned HTTP ${res.status}: ${errBody.slice(0, 300)}`);
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
        model: data.model || modelId,
        usage: data.usage
          ? { inputTokens: data.usage.input_tokens ?? null, outputTokens: data.usage.output_tokens ?? null }
          : null,
      };
    },
  };
}
