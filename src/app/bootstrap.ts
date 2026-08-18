import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ANTHROPIC_PROVIDER,
  AnthropicModelAClient,
  DEFAULT_MODEL_A,
  GENERATION_PROMPT_VERSION,
  MODEL_A_CONFIGURATION_VERSION,
} from "../adapters/anthropic-model-client.js";
import {
  CRITIQUE_PROMPT_VERSION,
  DEFAULT_MODEL_B,
  GEMINI_PROVIDER,
  GeminiModelBClient,
  MODEL_B_CONFIGURATION_VERSION,
} from "../adapters/gemini-model-client.js";
import { HttpSourceFetcher } from "../adapters/http-source-fetcher.js";
import { createMvpApplication } from "./mvp-composition-root.js";
import type { MvpApplication } from "./mvp-composition-root.js";
import { createOperatorAuth } from "./operator-auth.js";
import { ConfigError, buildCompositionConfig, loadRuntimeConfig } from "./runtime-config.js";
import type { ReproducibilityMetadata } from "../domain/content.js";

/**
 * Builds the real Phase 1 application from environment variables. Shared by the review
 * dashboard server and the pipeline CLI so both run against identical wiring — a draft
 * produced by the CLI is reviewable by the server without any configuration drift.
 */
export interface ServerEnvironment {
  readonly [key: string]: string | undefined;
}

export interface BootstrappedApplication {
  readonly app: MvpApplication;
  readonly host: string;
  readonly port: number;
  readonly sqlitePath: string;
  readonly modelA: string;
  readonly modelB: string;
}

export const DEFAULTS = {
  configPath: "config/fb-ai.config.json",
  sqlitePath: "data/fb-ai.sqlite",
  staticDirectory: "dist/dashboard",
  host: "127.0.0.1",
  port: 4173,
} as const;

export async function bootstrap(env: ServerEnvironment): Promise<BootstrappedApplication> {
  const configPath = resolve(optionalEnv(env, "FB_AI_CONFIG") ?? DEFAULTS.configPath);
  const sqlitePath = resolve(optionalEnv(env, "FB_AI_DB") ?? DEFAULTS.sqlitePath);
  const staticDirectory = resolve(
    optionalEnv(env, "FB_AI_STATIC_DIR") ?? DEFAULTS.staticDirectory,
  );

  const operatorToken = requireEnv(env, "FB_AI_OPERATOR_TOKEN");
  const anthropicApiKey = requireEnv(env, "ANTHROPIC_API_KEY");
  const geminiApiKey = requireEnv(env, "GEMINI_API_KEY");

  const modelAName = optionalEnv(env, "ANTHROPIC_MODEL") ?? DEFAULT_MODEL_A;
  const modelBName = optionalEnv(env, "GEMINI_MODEL") ?? DEFAULT_MODEL_B;

  const file = await loadRuntimeConfig(configPath);

  // SQLite will not create intermediate directories itself.
  await mkdir(dirname(sqlitePath), { recursive: true });

  const modelA = new AnthropicModelAClient({ apiKey: anthropicApiKey, model: modelAName });
  const modelB = new GeminiModelBClient({ apiKey: geminiApiKey, model: modelBName });
  const sourceFetcher = new HttpSourceFetcher({
    ...optional("githubToken", optionalEnv(env, "GITHUB_TOKEN")),
    ...optional("userAgent", optionalEnv(env, "FB_AI_USER_AGENT")),
  });

  const auth = createOperatorAuth({
    token: operatorToken,
    ...optional("csrfSecret", optionalEnv(env, "FB_AI_CSRF_SECRET")),
  });

  const app = createMvpApplication(
    buildCompositionConfig({
      file,
      sqlitePath,
      staticDirectory,
      modelA: metadataFor(
        ANTHROPIC_PROVIDER,
        modelAName,
        GENERATION_PROMPT_VERSION,
        MODEL_A_CONFIGURATION_VERSION,
      ),
      modelB: metadataFor(
        GEMINI_PROVIDER,
        modelBName,
        CRITIQUE_PROMPT_VERSION,
        MODEL_B_CONFIGURATION_VERSION,
      ),
      dashboardHttp: auth,
    }),
    { sourceFetcher, modelA, modelACorrection: modelA, modelB },
  );

  return {
    app,
    host: optionalEnv(env, "FB_AI_HOST") ?? DEFAULTS.host,
    port: parsePort(optionalEnv(env, "FB_AI_PORT")),
    sqlitePath,
    modelA: modelAName,
    modelB: modelBName,
  };
}

function metadataFor(
  provider: string,
  model: string,
  promptVersion: string,
  configurationVersion: string,
): ReproducibilityMetadata {
  return { provider, model, promptVersion, configurationVersion };
}

/**
 * Reads an optional variable, treating blank as absent.
 *
 * `.env.example` lists every optional key with an empty value, so a copied `.env` exports
 * `ANTHROPIC_MODEL=""`, `FB_AI_USER_AGENT=""` and the rest. Under `??` an empty string is a
 * real value, which sent an empty User-Agent to every source and would have called the
 * Anthropic API with an empty model name the moment research first succeeded.
 */
export function optionalEnv(env: ServerEnvironment, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

/** Spreads a key only when it has a value, for `exactOptionalPropertyTypes`. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function requireEnv(env: ServerEnvironment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new ConfigError(`Thiếu biến môi trường bắt buộc: ${name}`);
  }
  return value;
}

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULTS.port;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new ConfigError(`FB_AI_PORT không hợp lệ: ${raw}`);
  }
  return parsed;
}
