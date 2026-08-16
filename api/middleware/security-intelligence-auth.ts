import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { readProjectEnv } from "../../src/project-identity.js";
import { adminApiKeyAuth } from "./admin-auth.js";
import { ADMIN_SESSION_PATH } from "./admin-session.js";

export const SECURITY_CANDIDATE_PATH =
  "/api/integrations/security-intelligence/v1/candidate-batches";
export const SECURITY_FEEDBACK_PATH = "/api/integrations/security-intelligence/v1/feedback-batches";

type IntegrationKind = "candidate" | "feedback";

function bearer(value: string | undefined) {
  const match = value?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function equalSecret(expected: string, actual: string) {
  return timingSafeEqual(
    createHash("sha256").update(expected).digest(),
    createHash("sha256").update(actual).digest(),
  );
}

function integrationKind(path: string): IntegrationKind | null {
  if (path === SECURITY_CANDIDATE_PATH) return "candidate";
  if (path === SECURITY_FEEDBACK_PATH) return "feedback";
  return null;
}

function configuredToken(kind: IntegrationKind) {
  const enabled = readProjectEnv(
    kind === "candidate"
      ? "SECURITY_INTELLIGENCE_CANDIDATE_ENABLED"
      : "SECURITY_INTELLIGENCE_FEEDBACK_ENABLED",
  )?.trim();
  if (enabled !== "true" && enabled !== "1") return undefined;
  return readProjectEnv(
    kind === "candidate"
      ? "SECURITY_INTELLIGENCE_CANDIDATE_TOKEN"
      : "SECURITY_INTELLIGENCE_FEEDBACK_TOKEN",
  )?.trim();
}

export function securityIntelligenceProducerPrincipal() {
  return (
    readProjectEnv("SECURITY_INTELLIGENCE_PRODUCER_PRINCIPAL")?.trim() ||
    "nightworkers:local-integration"
  );
}

function isPublicHealthPath(path: string) {
  return path === "/api/health" || path === "/api/health/" || path.startsWith("/api/health/");
}

function isAdminSessionPath(path: string) {
  return path === ADMIN_SESSION_PATH || path === `${ADMIN_SESSION_PATH}/`;
}

export function apiAuthenticationDispatcher(): MiddlewareHandler {
  const adminAuth = adminApiKeyAuth();
  return async (ctx, next) => {
    if (ctx.req.method === "OPTIONS" || isPublicHealthPath(ctx.req.path)) return next();
    if (isAdminSessionPath(ctx.req.path)) return next();
    const kind = integrationKind(ctx.req.path);
    if (!kind) return adminAuth(ctx, next);
    ctx.header("Cache-Control", "no-store");
    const expected = configuredToken(kind);
    if (!expected) {
      return ctx.json(
        {
          error: {
            code: "integration_unavailable",
            message: "Security Intelligence integration token is not configured.",
          },
        },
        503,
      );
    }
    const provided = bearer(ctx.req.header("authorization"));
    if (!provided || !equalSecret(expected, provided)) {
      ctx.header("WWW-Authenticate", 'Bearer realm="context-still-security-intelligence"');
      return ctx.json(
        {
          error: {
            code: "unauthorized",
            message: "Integration token is invalid for this endpoint.",
          },
        },
        401,
      );
    }
    return next();
  };
}
