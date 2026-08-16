import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

const ADMIN_ALLOWED_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const ADMIN_ALLOWED_HEADERS = ["authorization", "content-type", "x-admin-api-key"];

export function isExactHttpOrigin(value: string): boolean {
  if (!value || value === "null") return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin === value;
  } catch {
    return false;
  }
}

export function adminCors(allowedOrigins: readonly string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins.filter(isExactHttpOrigin));
  const allowedOriginCors = cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ADMIN_ALLOWED_METHODS,
    allowHeaders: ADMIN_ALLOWED_HEADERS,
    maxAge: 600,
  });

  return async (ctx, next) => {
    const origin = ctx.req.header("origin");
    if (!origin) {
      return next();
    }

    if (!allowed.has(origin)) {
      ctx.header("Vary", "Origin", { append: true });
      if (ctx.req.method === "OPTIONS") {
        ctx.header("Cache-Control", "no-store");
        return ctx.json({ error: "origin_not_allowed" }, 403);
      }
      return next();
    }

    return allowedOriginCors(ctx, next);
  };
}
