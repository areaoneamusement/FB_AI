import { HttpSourceFetcher } from "../adapters/http-source-fetcher.js";
import {
  AnthropicModelAClient,
  DEFAULT_MODEL_A,
} from "../adapters/anthropic-model-client.js";
import { DEFAULT_MODEL_B, GeminiModelBClient } from "../adapters/gemini-model-client.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { DEFAULTS, optionalEnv } from "./bootstrap.js";
import { diagnoseModelA, diagnoseModelB, type ModelDiagnosis } from "./model-probe.js";
import type { ServerEnvironment } from "./bootstrap.js";
import type { SourceConfig } from "../domain/source.js";

/**
 * Reads the state a failing cycle can only guess at: what GitHub thinks of the token right
 * now, and what each configured source answers to exactly one request.
 *
 * A cycle is the wrong instrument for this. It writes cursors, spends quota on pages nobody
 * reads, and reports a source as failed without saying whether the fault is the token, the
 * network, robots.txt, or a limit that resets in ten seconds. This makes one request per
 * source, keeps no state, and prints what it saw.
 */
export interface SourceDiagnosis {
  readonly sourceId: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly items?: number;
}

export interface QuotaDiagnosis {
  readonly resource: string;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: string;
}

export interface DoctorReport {
  readonly tokenPresent: boolean;
  readonly quotas: readonly QuotaDiagnosis[];
  readonly quotaError?: string;
  readonly sources: readonly SourceDiagnosis[];
  readonly models: readonly ModelDiagnosis[];
}

/**
 * Deadline for each probe. Shorter than the pipeline's own so a hung provider is reported
 * rather than waited out, long enough that a slow-but-working one is not called broken.
 */
export const MODEL_PROBE_DEADLINE_MS = 90_000;

interface RateLimitPayload {
  readonly resources?: Record<string, { limit: number; remaining: number; reset: number }>;
}

/** Asks GitHub what the token's budget is, without spending any of the search allowance. */
export async function readGitHubQuota(
  token: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ quotas: readonly QuotaDiagnosis[]; error?: string }> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "FB_AI-doctor/0.1",
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;

  try {
    const response = await fetchImpl("https://api.github.com/rate_limit", { headers });
    if (!response.ok) {
      return { quotas: [], error: `rate_limit trả ${response.status} ${response.statusText}` };
    }
    const payload = (await response.json()) as RateLimitPayload;
    const resources = payload.resources ?? {};
    const quotas = ["core", "search"]
      .filter((name) => resources[name] !== undefined)
      .map((name) => {
        const entry = resources[name] as { limit: number; remaining: number; reset: number };
        return {
          resource: name,
          limit: entry.limit,
          remaining: entry.remaining,
          resetAt: new Date(entry.reset * 1_000).toISOString(),
        };
      });
    return { quotas };
  } catch (error) {
    return { quotas: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/** One request per source. Reports what came back rather than retrying past it. */
export async function diagnoseSource(
  fetcher: HttpSourceFetcher,
  source: SourceConfig,
): Promise<SourceDiagnosis> {
  try {
    const permission = await fetcher.isAllowed(source);
    if (!permission.allowed) {
      return {
        sourceId: source.id,
        ok: false,
        detail: permission.reason ?? "Bị robots.txt hoặc điều khoản nguồn từ chối",
      };
    }
    const page = await fetcher.fetch(source, undefined, new AbortController().signal);
    return {
      sourceId: source.id,
      ok: true,
      detail: `${page.items.length} mục`,
      items: page.items.length,
    };
  } catch (error) {
    return {
      sourceId: source.id,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDoctor(env: ServerEnvironment = process.env): Promise<DoctorReport> {
  const configPath = optionalEnv(env, "FB_AI_CONFIG") ?? DEFAULTS.configPath;
  const file = await loadRuntimeConfig(configPath);
  const githubToken = optionalEnv(env, "GITHUB_TOKEN");

  const fetcher = new HttpSourceFetcher({
    ...(githubToken === undefined ? {} : { githubToken }),
    ...(optionalEnv(env, "FB_AI_USER_AGENT") === undefined
      ? {}
      : { userAgent: optionalEnv(env, "FB_AI_USER_AGENT") as string }),
  });

  const { quotas, error } = await readGitHubQuota(githubToken);

  // Sequential on purpose: firing every source at once is what a cycle does, and it makes
  // a rate limit look like a network fault.
  const sources: SourceDiagnosis[] = [];
  for (const source of file.sources.filter(({ active }) => active)) {
    sources.push(await diagnoseSource(fetcher, source));
  }

  return {
    tokenPresent: githubToken !== undefined,
    quotas,
    ...(error === undefined ? {} : { quotaError: error }),
    sources,
    models: await diagnoseModels(env),
  };
}

/**
 * Probes both providers with one short request each, through the production adapters.
 *
 * A missing key is reported, not thrown: the source half of the report is still worth
 * having when only the model half is misconfigured.
 */
export async function diagnoseModels(env: ServerEnvironment): Promise<readonly ModelDiagnosis[]> {
  const results: ModelDiagnosis[] = [];

  const anthropicKey = optionalEnv(env, "ANTHROPIC_API_KEY");
  const modelAName = optionalEnv(env, "ANTHROPIC_MODEL") ?? DEFAULT_MODEL_A;
  if (anthropicKey === undefined) {
    results.push({
      label: "Model A (Claude)",
      model: modelAName,
      ok: false,
      detail: "Thiếu ANTHROPIC_API_KEY trong .env",
      elapsedMs: 0,
    });
  } else {
    results.push(
      await diagnoseModelA(
        new AnthropicModelAClient({ apiKey: anthropicKey, model: modelAName }),
        modelAName,
        MODEL_PROBE_DEADLINE_MS,
      ),
    );
  }

  const geminiKey = optionalEnv(env, "GEMINI_API_KEY");
  const modelBName = optionalEnv(env, "GEMINI_MODEL") ?? DEFAULT_MODEL_B;
  if (geminiKey === undefined) {
    results.push({
      label: "Model B (Gemini)",
      model: modelBName,
      ok: false,
      detail: "Thiếu GEMINI_API_KEY trong .env",
      elapsedMs: 0,
    });
  } else {
    results.push(
      await diagnoseModelB(
        new GeminiModelBClient({ apiKey: geminiKey, model: modelBName }),
        modelBName,
        MODEL_PROBE_DEADLINE_MS,
      ),
    );
  }

  return results;
}

/** Fixed width so the OK and LỖI columns line up when the report is skimmed. */
function flag(ok: boolean): string {
  return (ok ? "OK" : "LỖI").padEnd(4);
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push(`GITHUB_TOKEN: ${report.tokenPresent ? "có" : "KHÔNG có"}`);
  if (report.quotaError !== undefined) {
    lines.push(`  không đọc được quota: ${report.quotaError}`);
  }
  for (const quota of report.quotas) {
    const flag = quota.remaining === 0 ? "  HẾT" : "  ";
    lines.push(
      `${flag} ${quota.resource}: còn ${quota.remaining}/${quota.limit}, reset ${quota.resetAt}`,
    );
  }

  lines.push("");
  lines.push("Nguồn:");
  for (const source of report.sources) {
    lines.push(`  ${flag(source.ok)}${source.sourceId}: ${source.detail}`);
  }

  const working = report.sources.filter(({ ok }) => ok).length;
  lines.push("");
  lines.push(`${working}/${report.sources.length} nguồn đọc được.`);
  if (working < 2) {
    lines.push("Cần ít nhất 2 nguồn đọc được thì research mới đủ dữ liệu để viết bài.");
  }

  if (report.models.length > 0) {
    lines.push("");
    lines.push("Model:");
    for (const model of report.models) {
      const seconds = (model.elapsedMs / 1_000).toFixed(1);
      lines.push(
        `  ${flag(model.ok)}${model.label} [${model.model}] ${seconds}s: ${model.detail}`,
      );
    }
    if (report.models.every(({ ok }) => ok)) {
      lines.push("Cả hai model trả lời đúng schema. Bài viết đi được tới bước duyệt.");
    }
  }

  return lines.join("\n");
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  runDoctor()
    .then((report) => {
      process.stdout.write(`${formatDoctorReport(report)}\n`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
