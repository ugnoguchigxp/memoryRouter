import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { groupedConfig } from "../../../src/config.js";
import { readProjectEnv } from "../../../src/project-identity.js";
import {
  ADMIN_SESSION_COOKIE,
  adminApiKeyConfigurationError,
  createAdminSessionToken,
  hasValidAdminSession,
  isAuthorizedAdminApiKey,
  isTrustedAdminOrigin,
} from "../../middleware/admin-session.js";

const sessionRequestSchema = z.object({
  apiKey: z.string().trim().min(1).max(1024),
});

function secureCookieRequired(requestUrl: string): boolean {
  return (
    new URL(requestUrl).protocol === "https:" ||
    readProjectEnv("TLS_REVERSE_PROXY_CONFIRMED")?.trim() === "1"
  );
}

export const adminSessionRouter = new Hono()
  .use(
    "*",
    bodyLimit({
      maxSize: 2048,
      onError: (ctx) => ctx.json({ error: "request_too_large" }, 413),
    }),
  )
  .get("/", (ctx) => {
    ctx.header("Cache-Control", "no-store");
    const configuredKey = groupedConfig.admin.apiKey;
    const configurationError = adminApiKeyConfigurationError(configuredKey);
    return ctx.json({
      configured: configurationError === null,
      authenticated: Boolean(
        configurationError === null && hasValidAdminSession(ctx, configuredKey),
      ),
      configurationError,
    });
  })
  .post("/", zValidator("json", sessionRequestSchema), (ctx) => {
    ctx.header("Cache-Control", "no-store");
    if (!isTrustedAdminOrigin(ctx)) {
      return ctx.json({ error: "origin_not_allowed" }, 403);
    }
    const configuredKey = groupedConfig.admin.apiKey;
    const configurationError = adminApiKeyConfigurationError(configuredKey);
    if (configurationError) {
      return ctx.json({ error: configurationError }, 503);
    }
    const { apiKey } = ctx.req.valid("json");
    if (!isAuthorizedAdminApiKey(configuredKey, apiKey)) {
      return ctx.json({ error: "unauthorized" }, 401);
    }

    const sessionToken = createAdminSessionToken(configuredKey);
    setCookie(ctx, ADMIN_SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: "Strict",
      secure: secureCookieRequired(ctx.req.url),
      path: "/",
    });
    return ctx.json({ ok: true });
  })
  .delete("/", (ctx) => {
    ctx.header("Cache-Control", "no-store");
    if (!isTrustedAdminOrigin(ctx)) {
      return ctx.json({ error: "origin_not_allowed" }, 403);
    }
    deleteCookie(ctx, ADMIN_SESSION_COOKIE, { path: "/" });
    return ctx.json({ ok: true });
  });
