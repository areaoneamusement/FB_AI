import { GeminiModelBClient } from "../adapters/gemini-model-client.js";
import { diagnoseModelB, type ModelDiagnosis } from "./model-probe.js";
import { summariseProviderError } from "./provider-error.js";
import type { ModelBCritiquePort } from "../adapters/ports.js";

/**
 * Finds a Gemini model the operator's key can actually use, by asking and trying.
 *
 * Picking the default from memory has now failed twice: `gemini-2.5-pro` answered
 * `404 no longer available to new users`, and the replacement Google itself named answered
 * `429 ... limit: 0` — free tier is not entitled to it at all. Neither is discoverable
 * from the model list, which happily includes both.
 *
 * So this lists what the key can see, orders the candidates cheapest-first, and probes them
 * with the real adapter until one answers. What comes back is a name that has demonstrably
 * worked, not one that ought to.
 */
export interface GeminiModelCandidate {
  readonly name: string;
  readonly displayName?: string;
}

export interface GeminiSearchResult {
  readonly tried: readonly ModelDiagnosis[];
  readonly working?: string;
  readonly listError?: string;
}

const LIST_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

/** Probing costs a call each, so the field is narrowed before anything is tried. */
export const MAX_CANDIDATES = 6;

interface ListPayload {
  readonly models?: readonly {
    name?: string;
    displayName?: string;
    supportedGenerationMethods?: readonly string[];
  }[];
}

/** Lists the models this key can see that support generateContent. */
export async function listGeminiModels(
  apiKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ models: readonly GeminiModelCandidate[]; error?: string }> {
  try {
    // Key goes in a header, not the query string, so it stays out of logs and history.
    const response = await fetchImpl(LIST_ENDPOINT, {
      headers: { "x-goog-api-key": apiKey },
    });
    if (!response.ok) {
      return { models: [], error: `models.list trả ${response.status} ${response.statusText}` };
    }
    const payload = (await response.json()) as ListPayload;
    const models = (payload.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent") === true)
      .map((model) => ({
        name: (model.name ?? "").replace(/^models\//, ""),
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
      }))
      .filter(({ name }) => name.length > 0);
    return { models };
  } catch (error) {
    return { models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Cheapest-first, and never a preview or experimental build.
 *
 * Flash tiers are the ones free keys are actually entitled to; the pro tiers are exactly
 * what returned `limit: 0`. Preview and experimental names get retired without notice —
 * which is how the first default broke — so they go last.
 */
export function rankCandidates(
  models: readonly GeminiModelCandidate[],
): readonly GeminiModelCandidate[] {
  const rank = ({ name }: GeminiModelCandidate): number => {
    const unstable = /preview|exp|experimental/.test(name) ? 100 : 0;
    if (name.includes("flash-lite")) return unstable + 1;
    if (name.includes("flash")) return unstable + 2;
    if (name.includes("pro")) return unstable + 3;
    return unstable + 4;
  };
  return [...models].sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name));
}

/**
 * Tries candidates in order and stops at the first that answers.
 *
 * Failures are kept rather than discarded: knowing that every pro tier said `limit: 0` is
 * what tells an operator this is a billing decision, not a broken key.
 */
export async function findWorkingGeminiModel(
  apiKey: string,
  deadlineMs: number,
  seams: {
    readonly fetch?: typeof globalThis.fetch;
    /** Injected for tests; the default builds the same adapter a cycle uses. */
    readonly createClient?: (model: string) => ModelBCritiquePort;
  } = {},
): Promise<GeminiSearchResult> {
  const fetchImpl = seams.fetch ?? globalThis.fetch;
  const createClient =
    seams.createClient ?? ((model: string) => new GeminiModelBClient({ apiKey, model }));

  const { models, error } = await listGeminiModels(apiKey, fetchImpl);
  if (error !== undefined) return { tried: [], listError: error };

  const candidates = rankCandidates(models).slice(0, MAX_CANDIDATES);
  const tried: ModelDiagnosis[] = [];

  for (const candidate of candidates) {
    const result = await diagnoseModelB(createClient(candidate.name), candidate.name, deadlineMs);
    tried.push(result);
    if (result.ok) return { tried, working: candidate.name };
  }

  return { tried };
}

export function formatGeminiSearch(result: GeminiSearchResult): string {
  const lines: string[] = [];
  lines.push("Đang tìm model Gemini mà key của bạn dùng được:");

  if (result.listError !== undefined) {
    lines.push(`  không liệt kê được model: ${result.listError}`);
    return lines.join("\n");
  }
  if (result.tried.length === 0) {
    lines.push("  key này không thấy model nào hỗ trợ generateContent.");
    return lines.join("\n");
  }

  for (const attempt of result.tried) {
    const seconds = (attempt.elapsedMs / 1_000).toFixed(1);
    lines.push(`  ${(attempt.ok ? "OK" : "LỖI").padEnd(4)}${attempt.model} ${seconds}s: ${summariseProviderError(attempt.detail, 160)}`);
  }

  lines.push("");
  if (result.working === undefined) {
    lines.push("Không model nào dùng được. Nếu mọi dòng đều là quota `limit: 0` thì key đang ở");
    lines.push("gói free tier không được cấp các model này — cần bật thanh toán tại");
    lines.push("https://aistudio.google.com/apikey để mở gói trả phí.");
  } else {
    lines.push(`Dùng được: ${result.working}`);
    lines.push(`Thêm dòng này vào .env:  GEMINI_MODEL=${result.working}`);
  }
  return lines.join("\n");
}

