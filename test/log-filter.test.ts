import { describe, expect, it } from "vitest";
import { filterSensitiveData } from "../src/modules/agent-log-sync/log-filter.js";

describe("log-filter > filterSensitiveData", () => {
  it("should replace API keys and tokens with removal placeholder", () => {
    const raw = "My token is ghp_1234567890abcdefghijklmnopqrstuvwxyz and bearer xyz123.";
    const filtered = filterSensitiveData(raw);
    expect(filtered).toContain("[REMOVED SENSITIVE DATA]");
    expect(filtered).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(filtered).not.toContain("bearer xyz123");
  });

  it("should remove lines containing forbidden keywords", () => {
    const raw = "line1: ordinary content\nline2: my password is admin123\nline3: ordinary suffix";
    const filtered = filterSensitiveData(raw);
    const lines = filtered.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("line1: ordinary content");
    expect(lines[1]).toBe("line3: ordinary suffix");
    expect(filtered).not.toContain("password");
  });

  it("should mask private keys", () => {
    const raw =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const filtered = filterSensitiveData(raw);
    expect(filtered).toContain("[REMOVED SENSITIVE DATA]");
    expect(filtered).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  it("should redact AWS environment assignments without removing ordinary lines", () => {
    const raw = [
      "AWS_ACCESS_KEY_ID=AKIA1111111111111111",
      "export AWS_SECRET_ACCESS_KEY='fakeSecretValue123456789'",
      "AWS_SESSION_TOKEN=fakeSessionToken123456789",
      "ordinary line",
    ].join("\n");

    const filtered = filterSensitiveData(raw);
    expect(filtered).toContain("ordinary line");
    expect(filtered).not.toContain("AKIA1111111111111111");
    expect(filtered).not.toContain("fakeSecretValue123456789");
    expect(filtered).not.toContain("fakeSessionToken123456789");
    expect(filtered.match(/\[REMOVED SENSITIVE DATA\]/g)).toHaveLength(3);
  });

  it("should redact structured secret labels idempotently", () => {
    const raw = JSON.stringify({
      AWS_ACCESS_KEY_ID: "AKIA2222222222222222",
      database_url: "postgres://user:fakePassword@example.com/db",
    });
    const once = filterSensitiveData(raw);
    const twice = filterSensitiveData(once);

    expect(once).not.toContain("AKIA2222222222222222");
    expect(once).not.toContain("fakePassword");
    expect(twice).toBe(once);
  });
});
