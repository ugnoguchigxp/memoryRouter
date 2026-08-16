import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { groupedConfig } from "../../src/config.js";
import { isExactHttpOrigin } from "./admin-cors.js";

export const ADMIN_SESSION_PATH = "/api/admin-session";
export const ADMIN_SESSION_COOKIE = "context_still_admin_session";
export const ADMIN_SESSION_TTL_SECONDS = 15 * 60;
export const ADMIN_API_KEY_MIN_LENGTH = 32;

export type AdminApiKeyConfigurationError =
  | "admin_api_key_not_configured"
  | "admin_api_key_too_short";

export function adminApiKeyConfigurationError(
  configuredKey: string,
): AdminApiKeyConfigurationError | null {
  if (!configuredKey) return "admin_api_key_not_configured";
  if (configuredKey.length < ADMIN_API_KEY_MIN_LENGTH) return "admin_api_key_too_short";
  return null;
}

function secretDigest(value: string): Buffer {
  return createHmac("sha256", "context-still-admin-api-key").update(value).digest();
}

export function isAuthorizedAdminApiKey(configuredKey: string, providedKey: string): boolean {
  return timingSafeEqual(secretDigest(configuredKey), secretDigest(providedKey));
}

function sessionSignature(configuredKey: string, payload: string): Buffer {
  return createHmac("sha256", configuredKey).update(payload).digest();
}

export function createAdminSessionToken(
  configuredKey: string,
  now = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + ADMIN_SESSION_TTL_SECONDS * 1000;
  const payload = `${expiresAt}.${randomBytes(18).toString("base64url")}`;
  const signature = sessionSignature(configuredKey, payload).toString("base64url");
  return { token: `${payload}.${signature}`, expiresAt };
}

export function isValidAdminSessionToken(
  configuredKey: string,
  token: string,
  now = Date.now(),
): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expiresRaw, nonce, signatureRaw] = parts;
  if (!expiresRaw || !nonce || !signatureRaw || !/^\d+$/.test(expiresRaw)) return false;
  const expiresAt = Number(expiresRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  if (expiresAt > now + ADMIN_SESSION_TTL_SECONDS * 1000) return false;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(nonce)) return false;

  let providedSignature: Buffer;
  try {
    providedSignature = Buffer.from(signatureRaw, "base64url");
  } catch {
    return false;
  }
  const expectedSignature = sessionSignature(configuredKey, `${expiresRaw}.${nonce}`);
  return (
    providedSignature.length === expectedSignature.length &&
    timingSafeEqual(providedSignature, expectedSignature)
  );
}

export function hasValidAdminSession(ctx: Context, configuredKey: string): boolean {
  const token = getCookie(ctx, ADMIN_SESSION_COOKIE);
  return Boolean(token && isValidAdminSessionToken(configuredKey, token));
}

export function isTrustedAdminOrigin(ctx: Context): boolean {
  const origin = ctx.req.header("origin");
  if (!origin || !isExactHttpOrigin(origin)) return false;
  let requestOrigin: string;
  try {
    requestOrigin = new URL(ctx.req.url).origin;
  } catch {
    return false;
  }
  return origin === requestOrigin || groupedConfig.admin.allowedOrigins.includes(origin);
}
