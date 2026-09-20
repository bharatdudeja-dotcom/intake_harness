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

/**
 * AWS SigV4 URI encoding for a single path segment.
 *
 * THIS IS THE BUG THAT PRODUCED THE 403 "signature does not match": the model
 * id contains a colon (…-v1:0). encodeURIComponent leaves some characters AWS
 * expects encoded and, more importantly, the encoded string used to build the
 * canonical request for signing MUST be byte-identical to the path actually
 * sent on the wire. SigV4's rule: encode every byte EXCEPT the unreserved set
 * A-Z a-z 0-9 - _ . ~, uppercase-hex the rest. So ':' -> %3A, and (for a path
 * segment) '/' is also encoded. encodeURIComponent gets the unreserved set
 * right but we then have to sign and send the SAME value; centralizing it here
 * guarantees they can't drift.
 */
export function awsUriEncodeSegment(segment: string): string {
  return Array.from(segment)
    .map((ch) => {
      if (/[A-Za-z0-9\-_.~]/.test(ch)) return ch;
      return Array.from(new TextEncoder().encode(ch))
        .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
        .join("");
    })
    .join("");
}

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
      // The SAME encoded path is used to sign (canonical request below) and to
      // send (fetch URL). Only the modelId segment needs encoding; "/model" and
      // "/invoke" are literal. Byte-identical here is the whole fix.
      const path = `/model/${awsUriEncodeSegment(modelId)}/invoke`;
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
      // Sign the MINIMAL required set: host, x-amz-content-sha256, x-amz-date
      // (plus the session token when present). content-type is deliberately NOT
      // signed - fetch/undici can normalize or re-case a content-type value
      // (e.g. appending charset), and any drift between the value we sign and
      // the value actually sent breaks the signature. Not signing it removes
      // that whole class of "signature does not match" failure. Headers must be
      // listed sorted by lowercase name.
      const canonicalHeaders =
        `host:${host}\n` +
        `x-amz-content-sha256:${payloadHash}\n` +
        `x-amz-date:${amzDate}\n` +
        (cfg.sessionToken ? `x-amz-security-token:${cfg.sessionToken}\n` : "");
      const signedHeaders =
        "host;x-amz-content-sha256;x-amz-date" +
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
        // A 403 signature error includes AWS's OWN expected canonical string,
        // which is the single most useful thing for diagnosing a mismatch - so
        // don't truncate a 403 the way we truncate other errors. Set
        // BEDROCK_DEBUG_SIGNING=true to also log OUR canonical request next to
        // it, so the two can be diffed line by line.
        const isSigError = res.status === 403 && /signature/i.test(errBody);
        if (process.env.BEDROCK_DEBUG_SIGNING === "true") {
          console.error("=== Bedrock SigV4 debug ===\nOUR canonical request:\n" + canonicalRequest + "\n\nAWS RESPONSE:\n" + errBody);
        }
        throw new Error(
          `Bedrock InvokeModel returned HTTP ${res.status}: ${isSigError ? errBody : errBody.slice(0, 300)}`,
        );
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
