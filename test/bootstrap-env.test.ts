import { describe, expect, it } from "vitest";

import { DEFAULTS, optionalEnv, parsePort, requireEnv } from "../src/app/bootstrap.js";

describe("optionalEnv", () => {
  it("treats a blank value as absent", () => {
    // .env.example lists every optional key with an empty value, so a copied .env exports
    // ANTHROPIC_MODEL="" and FB_AI_USER_AGENT="". Under `??` those are real values: the
    // fetcher sent an empty User-Agent to every source, and the first successful research
    // would have called the Anthropic API with an empty model name.
    for (const blank of ["", "   ", "\t\n"]) {
      expect(optionalEnv({ ANTHROPIC_MODEL: blank }, "ANTHROPIC_MODEL")).toBeUndefined();
    }
    expect(optionalEnv({}, "ANTHROPIC_MODEL")).toBeUndefined();
  });

  it("trims a value that is actually set", () => {
    expect(optionalEnv({ GITHUB_TOKEN: " ghp_abc " }, "GITHUB_TOKEN")).toBe("ghp_abc");
  });
});

describe("requireEnv", () => {
  it("names the missing variable", () => {
    expect(() => requireEnv({}, "ANTHROPIC_API_KEY")).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => requireEnv({ ANTHROPIC_API_KEY: "  " }, "ANTHROPIC_API_KEY")).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("returns a value that is set", () => {
    expect(requireEnv({ ANTHROPIC_API_KEY: "sk-test" }, "ANTHROPIC_API_KEY")).toBe("sk-test");
  });
});

describe("parsePort", () => {
  it("falls back to the default when unset", () => {
    expect(parsePort(undefined)).toBe(DEFAULTS.port);
  });

  it("reads a valid port", () => {
    expect(parsePort("8080")).toBe(8080);
  });

  it("rejects a port outside the usable range", () => {
    expect(() => parsePort("0")).toThrow();
    expect(() => parsePort("70000")).toThrow();
    expect(() => parsePort("abc")).toThrow();
  });
});
