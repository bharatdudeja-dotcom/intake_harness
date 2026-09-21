import { describe, it, expect } from "vitest";
import { reflectLoop } from "./reflect";
import type { LlmClient, LlmCompletionResult } from "./types";

/** One reply per call, in order; repeats the last reply once exhausted. */
function stubSequence(replies: string[]): LlmClient & { calls: number } {
  let i = 0;
  const client = {
    id: "stub-seq",
    calls: 0,
    async complete(): Promise<LlmCompletionResult> {
      client.calls++;
      const text = replies[Math.min(i, replies.length - 1)];
      i++;
      return { text, model: `stub-${i}`, usage: null };
    },
  };
  return client;
}

type Parsed = { n: number };

const parseNumber = (text: string): Parsed => {
  const n = Number(text);
  if (Number.isNaN(n)) throw new Error(`not a number: "${text}"`);
  return { n };
};

/** Critic: must be >= 10. */
const mustBeAtLeastTen = (p: Parsed): string[] => (p.n >= 10 ? [] : [`${p.n} is less than 10`]);

describe("reflectLoop", () => {
  it("passes immediately when the first attempt already satisfies the critique - exactly one call", async () => {
    const client = stubSequence(["10"]);
    const outcome = await reflectLoop({
      client,
      system: "sys",
      prompt: "p1",
      parse: parseNumber,
      critique: mustBeAtLeastTen,
      revise: () => "revised prompt",
    });
    expect(outcome).toMatchObject({ passed: true, attempts: 1, result: { n: 10 } });
    expect(client.calls).toBe(1);
  });

  it("revises once and passes on the second attempt", async () => {
    const client = stubSequence(["3", "42"]);
    const outcome = await reflectLoop({
      client,
      system: "sys",
      prompt: "p1",
      parse: parseNumber,
      critique: mustBeAtLeastTen,
      revise: ({ issues }) => `try again: ${issues.join("; ")}`,
    });
    expect(outcome).toMatchObject({ passed: true, attempts: 2, result: { n: 42 } });
    expect(client.calls).toBe(2);
  });

  it("stops at maxAttempts and reports the last (failing) attempt", async () => {
    const client = stubSequence(["1", "2", "3"]);
    const outcome = await reflectLoop({
      client,
      system: "sys",
      prompt: "p1",
      parse: parseNumber,
      critique: mustBeAtLeastTen,
      revise: () => "still trying",
      maxAttempts: 2,
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.attempts).toBe(2);
    expect(outcome.result).toEqual({ n: 2 });
    expect(outcome.issues).toEqual(["2 is less than 10"]);
    expect(client.calls).toBe(2); // never calls a 3rd time
  });

  it("a parse failure on attempt 1 triggers a retry with the parse error, not a critique-driven revise", async () => {
    const client = stubSequence(["not json at all", "10"]);
    const outcome = await reflectLoop({
      client,
      system: "sys",
      prompt: "p1",
      parse: parseNumber,
      critique: mustBeAtLeastTen,
      revise: () => {
        throw new Error("revise() should not be called after a parse failure");
      },
    });
    expect(outcome).toMatchObject({ passed: true, attempts: 2, result: { n: 10 } });
  });

  it("throws when every attempt fails to parse, so the caller's existing catch-and-fallback still fires", async () => {
    const client = stubSequence(["nope", "still nope"]);
    await expect(
      reflectLoop({
        client,
        system: "sys",
        prompt: "p1",
        parse: parseNumber,
        critique: mustBeAtLeastTen,
        revise: () => "irrelevant",
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/not a number/);
  });

  it("defaults to maxAttempts 2 when unspecified", async () => {
    const client = stubSequence(["1", "2", "3"]);
    const outcome = await reflectLoop({
      client,
      system: "sys",
      prompt: "p1",
      parse: parseNumber,
      critique: mustBeAtLeastTen,
      revise: () => "again",
    });
    expect(outcome.attempts).toBe(2);
    expect(client.calls).toBe(2);
  });
});
