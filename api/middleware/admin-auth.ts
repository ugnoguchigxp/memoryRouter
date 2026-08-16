import type { MiddlewareHandler } from "hono";
import { groupedConfig } from "../../src/config.js";
import { projectIdentity } from "../../src/project-identity.js";
import {
  adminApiKeyConfigurationError,
  hasValidAdminSession,
  isAuthorizedAdminApiKey,
  isTrustedAdminOrigin,
} from "./admin-session.js";

function readApiKeyFromAuthorizationHeader(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bearerMatch = trimmed.match(/^bearer\s+(.+)$/i);
  if (!bearerMatch) return null;
  const token = bearerMatch[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function isPublicHealthPath(path: string): boolean {
  return path === "/api/health" || path === "/api/health/" || path.startsWith("/api/health/");
}

export function adminApiKeyAuth(): MiddlewareHandler {
  return async (ctx, next) => {
    if (ctx.req.method === "OPTIONS" || isPublicHealthPath(ctx.req.path)) {
      return next();
    }

    const configuredKey = groupedConfig.admin.apiKey;
    ctx.header("Cache-Control", "no-store");
    const configurationError = adminApiKeyConfigurationError(configuredKey);
    if (configurationError) {
      return ctx.json({ error: configurationError }, 503);
    }

    const providedHeader =
      ctx.req.header("x-admin-api-key") ??
      readApiKeyFromAuthorizationHeader(ctx.req.header("authorization") ?? undefined) ??
      "";

    if (providedHeader && isAuthorizedAdminApiKey(configuredKey, providedHeader)) {
      return next();
    }

    if (hasValidAdminSession(ctx, configuredKey)) {
      const isSafeMethod = ctx.req.method === "GET" || ctx.req.method === "HEAD";
      if (!isSafeMethod && !isTrustedAdminOrigin(ctx)) {
        return ctx.json({ error: "origin_not_allowed" }, 403);
      }
      return next();
    }

    ctx.header("WWW-Authenticate", `ApiKey realm="${projectIdentity.adminRealm}"`);
    return ctx.json({ error: "unauthorized" }, 401);
  };
}
