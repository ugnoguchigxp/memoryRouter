import { describe, expect, test, vi } from "vitest";
import { type SeedPayload, sanitizeSeedPayloadForPersistence } from "../src/db/seed.js";
import {
  redactSecretRecord,
  redactSecrets,
  redactSecretsFromValue,
} from "../src/shared/utils/secret-redaction.js";

vi.mock("../src/db/index.js", () => ({
  closeDbPool: vi.fn(),
  db: {},
}));

describe("db seed redaction", () => {
  test("sanitizes secrets before seed rows are persisted", () => {
    const payload: SeedPayload = {
      schemaVersion: 1,
      generatedAt: "2026-05-25T00:00:00.000Z",
      knowledgeItems: [
        {
          id: "k1",
          body: "normal\napi_key=sk-abcdefghijklmnopqrstuvwxyz0123456789",
          metadata: { credentials: { value: "raw-token-value" } },
        },
      ],
      sources: [
        {
          id: "s1",
          body: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
          metadata: { url: "https://example.com/docs?token=abcdef0123456789" },
        },
      ],
      sourceFragments: [
        {
          id: "f1",
          content: "password=super-secret-value",
          metadata: { privateKey: "raw-private-key" },
        },
      ],
      knowledgeSourceLinks: [],
      knowledgeTagDefinitions: [],
      knowledgeCommunityLabels: [],
    };

    const sanitized = sanitizeSeedPayloadForPersistence(payload);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).toContain("[REMOVED SENSITIVE DATA]");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("raw-token-value");
    expect(serialized).not.toContain("abcdef0123456789");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("raw-private-key");
  });

  test("redactSecrets", () => {
    expect(redactSecrets("http://example.com?api_key=123")).toContain("[REMOVED SENSITIVE DATA]");
    for (const key of ["admin_api_key", "adminApiKey", "x-admin-api-key"]) {
      expect(redactSecrets(`http://example.com?${key}=legacy-secret`)).not.toContain(
        "legacy-secret",
      );
    }
    expect(redactSecrets("-----BEGIN PRIVATE KEY-----\nFOO\n-----END PRIVATE KEY-----")).toBe(
      "[REMOVED SENSITIVE DATA]",
    );
    expect(redactSecrets("Bearer abcdef123456789")).toBe("[REMOVED SENSITIVE DATA]");
    expect(redactSecrets("AWS_ACCESS_KEY_ID=AKIA3333333333333333")).not.toContain(
      "AKIA3333333333333333",
    );
    expect(
      redactSecrets("DATABASE_URL=postgres://user:fakePassword@db.example/test"),
    ).not.toContain("fakePassword");
  });

  test("redactSecretsFromValue", () => {
    class CustomClass {
      constructor(public secret: string) {}
    }
    const inst = new CustomClass("my-secret");
    expect(redactSecretsFromValue(inst)).toEqual(inst);

    expect(redactSecretsFromValue(123)).toBe(123);
    expect(redactSecretsFromValue(true)).toBe(true);
    expect(redactSecretsFromValue(null)).toBeNull();

    expect(redactSecretsFromValue(["Bearer abcdef123456789", 123])).toEqual([
      "[REMOVED SENSITIVE DATA]",
      123,
    ]);

    expect(redactSecretsFromValue({ apikey: "some-value" })).toEqual({
      apikey: "[REMOVED SENSITIVE DATA]",
    });
    expect(redactSecretsFromValue({ BearerToken: "some-value" })).toEqual({
      BearerToken: "[REMOVED SENSITIVE DATA]",
    });
    expect(redactSecretsFromValue({ custom_secret_key: "some-value" })).toEqual({
      custom_secret_key: "[REMOVED SENSITIVE DATA]",
    });

    expect(redactSecretsFromValue({ password: "" })).toEqual({ password: "" });
    expect(redactSecretsFromValue({ password: [] })).toEqual({ password: [] });
    expect(redactSecretsFromValue({ password: 123 })).toEqual({ password: 123 });
    expect(redactSecretsFromValue({ password: null })).toEqual({ password: null });
    expect(redactSecretsFromValue({ password: true })).toEqual({ password: true });
  });

  test("redactSecretRecord", () => {
    const record = { secret: "value", normal: "text" };
    expect(redactSecretRecord(record)).toEqual({
      secret: "[REMOVED SENSITIVE DATA]",
      normal: "text",
    });
  });
});
