import { describe, expect, it } from "vitest";

import {
  MAX_CANDIDATES,
  findWorkingGeminiModel,
  formatGeminiSearch,
  listGeminiModels,
  rankCandidates,
} from "../src/app/gemini-model-search.js";
import type { ModelBCritiquePort } from "../src/adapters/ports.js";

function listStub(models: unknown, init: ResponseInit = {}): {
  impl: typeof globalThis.fetch;
  keys: (string | null)[];
} {
  const keys: (string | null)[] = [];
  const impl = (async (_input: RequestInfo | URL, request?: RequestInit) => {
    keys.push(new Headers(request?.headers).get("x-goog-api-key"));
    return new Response(JSON.stringify({ models }), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
  }) as unknown as typeof globalThis.fetch;
  return { impl, keys };
}

describe("listGeminiModels", () => {
  it("keeps only models that can generate content, and strips the models/ prefix", async () => {
    const { impl } = listStub([
      { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
      { name: "models/gemini-3.1-pro", supportedGenerationMethods: ["generateContent"] },
    ]);

    const { models, error } = await listGeminiModels("key", impl);

    expect(error).toBeUndefined();
    expect(models.map(({ name }) => name)).toEqual(["gemini-2.5-flash", "gemini-3.1-pro"]);
  });

  it("sends the key as a header, never in the URL", async () => {
    // A key in the query string ends up in logs, shell history and error reports.
    let requested = "";
    const impl = (async (input: RequestInfo | URL, request?: RequestInit) => {
      requested = String(input);
      expect(new Headers(request?.headers).get("x-goog-api-key")).toBe("secret-key");
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    await listGeminiModels("secret-key", impl);
    expect(requested).not.toContain("secret-key");
  });

  it("reports a refusal instead of throwing", async () => {
    const impl = (async () =>
      new Response("nope", { status: 403, statusText: "Forbidden" })) as unknown as typeof globalThis.fetch;
    const { models, error } = await listGeminiModels("key", impl);
    expect(models).toEqual([]);
    expect(error).toContain("403");
  });

  it("survives a network failure", async () => {
    const impl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof globalThis.fetch;
    const { error } = await listGeminiModels("key", impl);
    expect(error).toContain("ENOTFOUND");
  });
});

describe("rankCandidates", () => {
  it("puts the tiers a free key is actually entitled to first", () => {
    // The pro tiers are exactly what answered `limit: 0` on a free key.
    const ranked = rankCandidates([
      { name: "gemini-3.1-pro" },
      { name: "gemini-2.5-flash" },
      { name: "gemini-2.5-flash-lite" },
    ]);
    expect(ranked.map(({ name }) => name)).toEqual([
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-3.1-pro",
    ]);
  });

  it("leaves preview and experimental builds until last", () => {
    // A preview name is what broke the first default, retired without notice.
    const ranked = rankCandidates([
      { name: "gemini-3.1-flash-preview" },
      { name: "gemini-2.5-pro" },
      { name: "gemini-4-exp" },
    ]);
    expect(ranked[0]?.name).toBe("gemini-2.5-pro");
    expect(ranked.map(({ name }) => name).slice(1)).toContain("gemini-3.1-flash-preview");
  });

  it("orders deterministically when the tier is the same", () => {
    const ranked = rankCandidates([{ name: "gemini-b-flash" }, { name: "gemini-a-flash" }]);
    expect(ranked.map(({ name }) => name)).toEqual(["gemini-a-flash", "gemini-b-flash"]);
  });
});

describe("findWorkingGeminiModel", () => {
  const modelsPayload = [
    { name: "models/gemini-3.1-pro", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
  ];

  function client(behaviour: (model: string) => void): (model: string) => ModelBCritiquePort {
    return (model) => ({
      critique: async () => {
        behaviour(model);
        return {
          findings: [{ claimId: "doctor-claim-1", verdict: "Pass" as const, evidenceRefs: [] }],
          provenance: {
            provider: "google",
            model,
            promptVersion: "p",
            configurationVersion: "c",
          },
        };
      },
    });
  }

  it("stops at the first model that answers and does not try the rest", async () => {
    const { impl } = listStub(modelsPayload);
    const attempted: string[] = [];

    const result = await findWorkingGeminiModel("key", 5_000, {
      fetch: impl,
      createClient: client((model) => {
        attempted.push(model);
      }),
    });

    // flash-lite is ranked first, so a working key costs exactly one probe.
    expect(attempted).toEqual(["gemini-2.5-flash-lite"]);
    expect(result.working).toBe("gemini-2.5-flash-lite");
    expect(result.tried).toHaveLength(1);
  });

  it("keeps every failure so `limit: 0` everywhere reads as a billing decision", async () => {
    const { impl } = listStub(modelsPayload);
    const attempted: string[] = [];

    const result = await findWorkingGeminiModel("key", 5_000, {
      fetch: impl,
      createClient: (model) => ({
        critique: async () => {
          attempted.push(model);
          throw new Error(JSON.stringify({ error: { code: 429, message: "limit: 0" } }));
        },
      }),
    });

    expect(attempted).toHaveLength(3);
    expect(result.working).toBeUndefined();
    expect(result.tried.every(({ ok }) => !ok)).toBe(true);
  });

  it("probes nothing when the list itself failed", async () => {
    const impl = (async () =>
      new Response("nope", { status: 403, statusText: "Forbidden" })) as unknown as typeof globalThis.fetch;
    let probed = false;

    const result = await findWorkingGeminiModel("key", 5_000, {
      fetch: impl,
      createClient: () => ({
        critique: async () => {
          probed = true;
          throw new Error("should not be reached");
        },
      }),
    });

    expect(probed).toBe(false);
    expect(result.listError).toContain("403");
  });

  it("never probes more than the candidate cap", async () => {
    const many = Array.from({ length: 20 }, (_unused, index) => ({
      name: `models/gemini-${index}-flash`,
      supportedGenerationMethods: ["generateContent"],
    }));
    const { impl } = listStub(many);
    let probes = 0;

    await findWorkingGeminiModel("key", 5_000, {
      fetch: impl,
      createClient: () => ({
        critique: async () => {
          probes += 1;
          throw new Error("nope");
        },
      }),
    });

    expect(probes).toBe(MAX_CANDIDATES);
  });
});

describe("formatGeminiSearch", () => {
  it("names the model to use and the line to add", () => {
    const text = formatGeminiSearch({
      working: "gemini-2.5-flash",
      tried: [
        { label: "Model B (Gemini)", model: "gemini-3.1-pro", ok: false, detail: "limit: 0", elapsedMs: 900 },
        { label: "Model B (Gemini)", model: "gemini-2.5-flash", ok: true, detail: "phán quyết: Pass", elapsedMs: 2_100 },
      ],
    });
    expect(text).toContain("Dùng được: gemini-2.5-flash");
    expect(text).toContain("GEMINI_MODEL=gemini-2.5-flash");
  });

  it("calls out billing when nothing worked", () => {
    const text = formatGeminiSearch({
      tried: [
        { label: "Model B (Gemini)", model: "gemini-3.1-pro", ok: false, detail: "limit: 0", elapsedMs: 800 },
      ],
    });
    expect(text).toContain("free tier");
    expect(text).toContain("aistudio.google.com/apikey");
    expect(text).not.toContain("Dùng được:");
  });

  it("reduces a JSON error document to its message", () => {
    // Three of these arrived per cycle at full length, burying the report.
    const text = formatGeminiSearch({
      tried: [
        {
          label: "Model B (Gemini)",
          model: "gemini-3.1-pro",
          ok: false,
          detail: JSON.stringify({
            error: { code: 429, message: "You exceeded your current quota", status: "RESOURCE_EXHAUSTED" },
          }),
          elapsedMs: 500,
        },
      ],
    });
    expect(text).toContain("You exceeded your current quota");
    expect(text).not.toContain("RESOURCE_EXHAUSTED");
  });

  it("says so when the key cannot list models at all", () => {
    const text = formatGeminiSearch({ tried: [], listError: "models.list trả 403 Forbidden" });
    expect(text).toContain("403");
  });

  it("says so when the key sees no usable model", () => {
    expect(formatGeminiSearch({ tried: [] })).toContain("không thấy model nào");
  });
});

describe("MAX_CANDIDATES", () => {
  it("bounds how many probes a search can cost", () => {
    expect(MAX_CANDIDATES).toBeGreaterThan(0);
    expect(MAX_CANDIDATES).toBeLessThanOrEqual(10);
  });
});
