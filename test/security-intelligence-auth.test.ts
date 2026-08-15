import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  SECURITY_CANDIDATE_PATH,
  SECURITY_FEEDBACK_PATH,
  apiAuthenticationDispatcher,
} from "../api/middleware/security-intelligence-auth.js";
import {
  resetSecurityIntelligenceTrafficGuardForTests,
  securityIntelligenceRateLimit,
  securityIntelligenceRequestTimeout,
} from "../api/middleware/security-intelligence-traffic.js";

const oldCandidate = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_TOKEN;
const oldFeedback = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_TOKEN;
const oldCandidateEnabled = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_ENABLED;
const oldFeedbackEnabled = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_ENABLED;
const oldRateLimit = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_RATE_LIMIT_PER_MINUTE;
const oldRequestTimeout = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_REQUEST_TIMEOUT_MS;

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_TOKEN", oldCandidate);
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_TOKEN", oldFeedback);
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_ENABLED", oldCandidateEnabled);
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_ENABLED", oldFeedbackEnabled);
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_RATE_LIMIT_PER_MINUTE", oldRateLimit);
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_REQUEST_TIMEOUT_MS", oldRequestTimeout);
  resetSecurityIntelligenceTrafficGuardForTests();
});

function authApp() {
  const app = new Hono();
  app.use("/api/*", apiAuthenticationDispatcher());
  app.get("/api/health", (c) => c.text("ok"));
  app.post(SECURITY_CANDIDATE_PATH, (c) => c.text("candidate"));
  app.post(SECURITY_FEEDBACK_PATH, (c) => c.text("feedback"));
  return app;
}

describe("Security Intelligence auth dispatcher", () => {
  test("keeps health public and fails closed when integration token is unset", async () => {
    Reflect.deleteProperty(process.env, "CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_TOKEN");
    const app = authApp();
    expect((await app.request("/api/health")).status).toBe(200);
    const response = await app.request(SECURITY_CANDIDATE_PATH, { method: "POST" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "integration_unavailable" } });
  });

  test("does not accept candidate and feedback tokens across scopes", async () => {
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_TOKEN = "candidate-secret";
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_TOKEN = "feedback-secret";
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_ENABLED = "true";
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_ENABLED = "true";
    const app = authApp();
    expect(
      (
        await app.request(SECURITY_CANDIDATE_PATH, {
          method: "POST",
          headers: { authorization: "Bearer candidate-secret" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(SECURITY_FEEDBACK_PATH, {
          method: "POST",
          headers: { authorization: "Bearer candidate-secret" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(SECURITY_FEEDBACK_PATH, {
          method: "POST",
          headers: { authorization: "Bearer feedback-secret" },
        })
      ).status,
    ).toBe(200);
  });

  test("bounds authenticated ingress requests with a stable retry response", async () => {
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_RATE_LIMIT_PER_MINUTE = "1";
    const app = new Hono();
    app.use("/integration", securityIntelligenceRateLimit());
    app.post("/integration", (c) => c.text("ok"));

    expect((await app.request("/integration", { method: "POST" })).status).toBe(200);
    const limited = await app.request("/integration", { method: "POST" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(await limited.json()).toEqual({
      error: {
        code: "rate_limited",
        message: "Security Intelligence ingress rate limit exceeded.",
      },
    });
  });

  test("returns a stable no-store response when ingress work times out", async () => {
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_REQUEST_TIMEOUT_MS = "5";
    const app = new Hono();
    app.use("/integration", securityIntelligenceRequestTimeout());
    app.post("/integration", async (c) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return c.text("late");
    });

    const response = await app.request("/integration", { method: "POST" });
    expect(response.status).toBe(504);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "request_timeout",
        message: "Security Intelligence ingress timed out.",
      },
    });
  });
});
