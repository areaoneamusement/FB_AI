import { describe, expect, it } from "vitest";

import { MAX_PROVIDER_ERROR_LENGTH, summariseProviderError } from "../src/app/provider-error.js";

/** The shape Gemini actually returned during the live run, trimmed of nothing. */
const GEMINI_QUOTA_ERROR = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. " +
      "For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. " +
      "\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
      "limit: 0, model: gemini-3.1-pro\nPlease retry in 38.033570313s.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.Help", links: [{ url: "https://example.test" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "38s" },
    ],
  },
});

describe("summariseProviderError", () => {
  it("keeps the sentence that says what happened", () => {
    const summary = summariseProviderError(GEMINI_QUOTA_ERROR);
    expect(summary).toContain("You exceeded your current quota");
  });

  it("drops the structure around it", () => {
    const summary = summariseProviderError(GEMINI_QUOTA_ERROR);
    expect(summary).not.toContain("RESOURCE_EXHAUSTED");
    expect(summary).not.toContain("@type");
    expect(summary).not.toContain("retryDelay");
  });

  it("bounds the length, because three of these filled a whole report", () => {
    const summary = summariseProviderError(GEMINI_QUOTA_ERROR);
    expect(summary.length).toBeLessThanOrEqual(MAX_PROVIDER_ERROR_LENGTH + 1);
    expect(summary.length).toBeLessThan(GEMINI_QUOTA_ERROR.length / 2);
  });

  it("collapses the newlines a provider embeds in its message", () => {
    const summary = summariseProviderError(GEMINI_QUOTA_ERROR);
    expect(summary).not.toContain("\n");
  });

  it("reads a message even when the JSON has a prefix", () => {
    const summary = summariseProviderError(
      'got status: 429. {"error":{"message":"Quota exceeded","code":429}}',
    );
    expect(summary).toBe("Quota exceeded");
  });

  it("passes plain text through unchanged", () => {
    expect(summariseProviderError("Model B trả về nội dung rỗng")).toBe(
      "Model B trả về nội dung rỗng",
    );
  });

  it("returns something usable for malformed JSON", () => {
    const summary = summariseProviderError('{"error": {"message": "half a document');
    expect(summary).not.toHaveLength(0);
  });

  it("honours a caller's shorter limit", () => {
    expect(summariseProviderError(GEMINI_QUOTA_ERROR, 40).length).toBeLessThanOrEqual(41);
  });
});
