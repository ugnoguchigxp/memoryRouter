import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { timeout } from "hono/timeout";
import { readProjectEnv } from "../../src/project-identity.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

function boundedIntegerConfig(name: string, fallback: number, maximum: number) {
  const raw = readProjectEnv(name)?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export function securityIntelligenceRateLimit(): MiddlewareHandler {
  return async (context, next) => {
    const now = Date.now();
    const key = context.req.path;
    const limit = boundedIntegerConfig(
      "SECURITY_INTELLIGENCE_RATE_LIMIT_PER_MINUTE",
      DEFAULT_RATE_LIMIT_PER_MINUTE,
      10_000,
    );
    const existing = buckets.get(key);
    const bucket =
      !existing || now >= existing.resetAt
        ? { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS }
        : existing;
    if (bucket.count >= limit) {
      context.header("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          error: {
            code: "rate_limited",
            message: "Security Intelligence ingress rate limit exceeded.",
          },
        },
        429,
      );
    }
    bucket.count += 1;
    buckets.set(key, bucket);
    await next();
  };
}

export function securityIntelligenceRequestTimeout(): MiddlewareHandler {
  const duration = boundedIntegerConfig(
    "SECURITY_INTELLIGENCE_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    120_000,
  );
  return timeout(
    duration,
    new HTTPException(504, {
      res: new Response(
        JSON.stringify({
          error: {
            code: "request_timeout",
            message: "Security Intelligence ingress timed out.",
          },
        }),
        {
          status: 504,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=UTF-8",
          },
        },
      ),
    }),
  );
}

export function resetSecurityIntelligenceTrafficGuardForTests() {
  buckets.clear();
}
