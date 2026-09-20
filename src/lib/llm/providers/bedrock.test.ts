import { describe, it, expect } from "vitest";
import { awsUriEncodeSegment } from "./bedrock";

describe("awsUriEncodeSegment - the SigV4 path encoding that caused the 403", () => {
  it("encodes the colon in a Bedrock model id (…-v1:0), the actual bug", () => {
    expect(awsUriEncodeSegment("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe(
      "anthropic.claude-3-5-sonnet-20240620-v1%3A0",
    );
  });

  it("preserves the SigV4 unreserved set (A-Za-z0-9-_.~) untouched", () => {
    expect(awsUriEncodeSegment("aZ09-_.~")).toBe("aZ09-_.~");
  });

  it("encodes a slash inside a segment (segments are individually encoded)", () => {
    expect(awsUriEncodeSegment("a/b")).toBe("a%2Fb");
  });

  it("uppercases the hex, as SigV4 requires", () => {
    // space -> %20 (already uppercase); ':' -> %3A not %3a
    expect(awsUriEncodeSegment(":")).toBe("%3A");
  });
});
