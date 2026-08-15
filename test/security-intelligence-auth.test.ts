import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import {
  SECURITY_CANDIDATE_PATH,
  SECURITY_FEEDBACK_PATH,
  apiAuthenticationDispatcher,
} from "../api/middleware/security-intelligence-auth.js";

const oldCandidate = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_TOKEN;
const oldFeedback = process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_TOKEN;

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_CANDIDATE_TOKEN", oldCandidate);
  restore("CONTEXT_STILL_SECURITY_INTELLIGENCE_FEEDBACK_TOKEN", oldFeedback);
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
});
