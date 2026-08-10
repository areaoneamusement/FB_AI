import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import type { ContentDraft } from "../domain/content.js";
import type { AuthenticatedOperator } from "./review-dashboard-api.js";
import { DashboardApiError, ReviewDashboardApi } from "./review-dashboard-api.js";
import { PipelineCommandError } from "../pipeline/content-pipeline.js";

export interface ReviewDashboardHttpOptions {
  readonly staticDirectory?: string;
  readonly authenticate: (request: IncomingMessage) => Promise<AuthenticatedOperator>;
  readonly issueCsrfToken: (request: IncomingMessage, operator: AuthenticatedOperator) => Promise<string>;
  readonly validateCsrfToken: (
    request: IncomingMessage,
    operator: AuthenticatedOperator,
    token: string,
  ) => Promise<boolean>;
}

type JsonObject = Record<string, unknown>;
const MAX_JSON_BYTES = 1_000_000;
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function createReviewDashboardHttpHandler(
  api: ReviewDashboardApi,
  options: ReviewDashboardHttpOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const staticRoot = resolve(options.staticDirectory ?? "dist/dashboard");
  return async (request, response) => {
    setSecurityHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://review.local");
      if (url.pathname.startsWith("/api/")) {
        await handleApi(api, options, request, response, url.pathname);
      } else {
        await serveSpa(staticRoot, url.pathname, response, request.method === "HEAD");
      }
    } catch (error) {
      sendError(response, error);
    }
  };
}

async function handleApi(
  api: ReviewDashboardApi,
  options: ReviewDashboardHttpOptions,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const operator = await options.authenticate(request);
  if (request.method === "GET" && pathname === "/api/review-session") {
    sendJson(response, 200, { operator, csrfToken: await options.issueCsrfToken(request, operator) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/reviews/pending") {
    const summaries = await api.listPending();
    const reviews = await Promise.all(summaries.map(async (summary) => ({
      ...summary,
      reviewPackage: await api.getReviewPackage(summary.pipelineRunId),
    })));
    sendJson(response, 200, { reviews });
    return;
  }

  const match = pathname.match(/^\/api\/reviews\/([^/]+)\/(draft|approve|reject|export)$/);
  if (match === null) throw httpError(404, "NOT_FOUND", "Route not found");
  if (request.method !== (match[2] === "draft" ? "PATCH" : "POST")) {
    throw httpError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  await requireCsrf(options, request, operator);
  const id = decodeURIComponent(match[1]!);
  const body = await readJson(request);

  if (match[2] === "draft") {
    const revision = await api.editDraft(id, {
      operator,
      expectedVersion: requiredNumber(body, "expectedVersion"),
      idempotencyKey: requiredString(body, "idempotencyKey"),
      patch: { content: requiredObject(body, "content") as unknown as ContentDraft },
    });
    sendJson(response, 200, revision);
    return;
  }
  if (match[2] === "reject") {
    const run = await api.reject(id, {
      operator,
      expectedVersion: requiredNumber(body, "expectedVersion"),
      idempotencyKey: requiredString(body, "idempotencyKey"),
      note: requiredString(body, "note", false),
    });
    sendJson(response, 200, run);
    return;
  }
  if (match[2] === "approve") {
    if (body.confirmed !== true) throw httpError(400, "INVALID_APPROVAL", "Explicit confirmation is required");
    const approval = await api.approve(id, {
      operator,
      expectedVersion: requiredNumber(body, "expectedVersion"),
      idempotencyKey: requiredString(body, "idempotencyKey"),
      confirmed: true,
      draftRevisionId: requiredString(body, "draftRevisionId"),
      contentHash: requiredString(body, "contentHash"),
      verificationReportId: requiredString(body, "verificationReportId"),
      complianceResultIds: requiredStrings(body, "complianceResultIds"),
      artifactIds: requiredStrings(body, "artifactIds"),
      artifactHashes: requiredStrings(body, "artifactHashes"),
    });
    sendJson(response, 200, approval);
    return;
  }

  const approvalId = requiredString(body, "approvalId");
  const artifactId = requiredString(body, "artifactId");
  const artifactHash = requiredString(body, "artifactHash");
  const outcome = await api.deliverApprovedArtifact(id, {
    operator,
    approvalId,
    artifactId,
    artifactHash,
    targetId: requiredString(body, "targetId"),
    idempotencyKey: requiredString(body, "idempotencyKey"),
  });
  if (outcome.status !== "Exported" || outcome.exportedBundleId === undefined) {
    throw httpError(409, outcome.errorCode ?? "EXPORT_FAILED", outcome.errorMessage ?? "Export failed");
  }
  const deliveries = await api.listDeliveries(id, operator);
  const bundle = deliveries.find((delivery) => delivery.id === outcome.exportedBundleId)?.exportBundle;
  if (bundle === undefined) throw httpError(500, "EXPORT_UNAVAILABLE", "Persisted export bundle was not found");
  sendJson(response, 200, bundle);
}

async function requireCsrf(
  options: ReviewDashboardHttpOptions,
  request: IncomingMessage,
  operator: AuthenticatedOperator,
): Promise<void> {
  const header = request.headers["x-csrf-token"];
  const token = Array.isArray(header) ? header[0] : header;
  if (token === undefined || !(await options.validateCsrfToken(request, operator, token))) {
    throw httpError(403, "CSRF_INVALID", "Mutation requires a valid CSRF token");
  }
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  if (!(request.headers["content-type"] ?? "").toString().toLowerCase().startsWith("application/json")) {
    throw httpError(415, "INVALID_CONTENT_TYPE", "Expected application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BYTES) throw httpError(413, "PAYLOAD_TOO_LARGE", "JSON body is too large");
    chunks.push(buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as JsonObject;
  } catch {
    throw httpError(400, "INVALID_JSON", "Request body must be a JSON object");
  }
}

function requiredObject(body: JsonObject, key: string): JsonObject {
  const value = body[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "INVALID_REQUEST", `${key} must be an object`);
  }
  return value as JsonObject;
}
function requiredString(body: JsonObject, key: string, trim = true): string {
  const value = body[key];
  if (typeof value !== "string" || (trim && value.trim().length === 0)) {
    throw httpError(400, "INVALID_REQUEST", `${key} must be a string`);
  }
  return value;
}
function requiredNumber(body: JsonObject, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw httpError(400, "INVALID_REQUEST", `${key} must be a non-negative integer`);
  }
  return value;
}
function requiredStrings(body: JsonObject, key: string): readonly string[] {
  const value = body[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw httpError(400, "INVALID_REQUEST", `${key} must be a string array`);
  }
  return value as string[];
}

async function serveSpa(root: string, pathname: string, response: ServerResponse, head: boolean): Promise<void> {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  let filePath = resolve(root, requested);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) throw httpError(404, "NOT_FOUND", "Asset not found");
  try {
    if (!(await stat(filePath)).isFile()) throw new Error();
  } catch {
    if (extname(requested) !== "") throw httpError(404, "NOT_FOUND", "Asset not found");
    filePath = resolve(root, "index.html");
  }
  const content = await readFile(filePath);
  response.statusCode = 200;
  response.setHeader("content-type", MIME_TYPES[extname(filePath)] ?? "application/octet-stream");
  response.setHeader("cache-control", filePath.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable");
  response.end(head ? undefined : content);
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

interface HttpError extends Error { status: number; code: string }
function httpError(status: number, code: string, message: string): HttpError {
  return Object.assign(new Error(message), { status, code });
}
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(payload));
}
function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) { response.end(); return; }
  if (error instanceof DashboardApiError || error instanceof PipelineCommandError) {
    const status = error.code === "AUTHORIZATION_REQUIRED" ? 401
      : error.code === "NOT_FOUND" ? 404
      : error.code === "CONFLICT" ? 409
      : error.code === "SAVE_FAILED" ? 500 : 400;
    sendJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  const candidate = error as Partial<HttpError>;
  sendJson(response, candidate.status ?? 500, {
    error: { code: candidate.code ?? "INTERNAL_ERROR", message: candidate.status === undefined ? "Internal server error" : candidate.message },
  });
}
