import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AuthenticatedOperator } from "../dashboard/review-dashboard-api.js";
import { DashboardApiError } from "../dashboard/review-dashboard-api.js";
import type { ReviewDashboardHttpOptions } from "../dashboard/review-dashboard-http-handler.js";

/**
 * Single-operator authentication for the Phase 1 review dashboard.
 *
 * The dashboard approves content that a person will publish under their own name, so it
 * must not be open. This is a shared-secret bearer token plus a signed, expiring CSRF
 * token — enough for the one-operator local deployment Phase 1 targets, and deliberately
 * not a user store: multi-user accounts belong with the Phase 2 credential work.
 */
export interface OperatorAuthOptions {
  /** Shared secret the operator sends as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Signing key for CSRF tokens. Generated per process when omitted. */
  readonly csrfSecret?: string;
  readonly operatorId?: string;
  readonly role?: AuthenticatedOperator["role"];
  readonly csrfTtlMs?: number;
  readonly now?: () => Date;
}

const DEFAULT_CSRF_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_TOKEN_LENGTH = 16;

export type OperatorAuth = Pick<
  ReviewDashboardHttpOptions,
  "authenticate" | "issueCsrfToken" | "validateCsrfToken"
>;

export function createOperatorAuth(options: OperatorAuthOptions): OperatorAuth {
  if (options.token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `Operator token phải dài ít nhất ${MIN_TOKEN_LENGTH} ký tự (hiện tại ${options.token.length})`,
    );
  }

  const expected = Buffer.from(options.token, "utf8");
  const secret = options.csrfSecret ?? randomBytes(32).toString("hex");
  const operatorId = options.operatorId ?? "operator";
  const role = options.role ?? "Admin";
  const ttlMs = options.csrfTtlMs ?? DEFAULT_CSRF_TTL_MS;
  const now = options.now ?? (() => new Date());

  return {
    authenticate: async (request) => {
      const presented = readToken(request);
      if (presented === undefined || !constantTimeEquals(presented, expected)) {
        throw new DashboardApiError(
          "AUTHORIZATION_REQUIRED",
          "Thiếu hoặc sai operator token",
        );
      }
      return { id: operatorId, role };
    },

    issueCsrfToken: async (_request, operator) => {
      const expiresAt = now().getTime() + ttlMs;
      return `${expiresAt}.${sign(secret, operator.id, expiresAt)}`;
    },

    validateCsrfToken: async (_request, operator, token) => {
      const separator = token.indexOf(".");
      if (separator === -1) return false;

      const expiresAt = Number.parseInt(token.slice(0, separator), 10);
      if (!Number.isFinite(expiresAt) || expiresAt <= now().getTime()) return false;

      const signature = token.slice(separator + 1);
      return constantTimeEquals(
        Buffer.from(signature, "utf8"),
        Buffer.from(sign(secret, operator.id, expiresAt), "utf8"),
      );
    },
  };
}

function readToken(request: IncomingMessage): Buffer | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return Buffer.from(header.slice("bearer ".length).trim(), "utf8");
  }
  const alternate = request.headers["x-operator-token"];
  if (typeof alternate === "string" && alternate.length > 0) {
    return Buffer.from(alternate, "utf8");
  }
  return undefined;
}

function sign(secret: string, operatorId: string, expiresAt: number): string {
  return createHmac("sha256", secret).update(`${operatorId}.${expiresAt}`).digest("hex");
}

/**
 * `timingSafeEqual` throws on length mismatch, which would itself leak the length. Hash
 * both sides first so the comparison is always over equal-length buffers.
 */
function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  const digestA = createHmac("sha256", "compare").update(a).digest();
  const digestB = createHmac("sha256", "compare").update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
