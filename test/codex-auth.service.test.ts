import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  checkCodexAuthStatus,
  getCodexLoginCommand,
} from "../src/modules/codex/codex-auth.service.js";

// node:fs/promises のモック
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

// node:os のモック
vi.mock("node:os", () => ({
  default: {
    homedir: vi.fn(() => "/mock/home"),
  },
}));

// node:child_process のモック
let mockExecFileShouldFail = false;
let mockExecFileStdout = "codex version 1.0.0";
vi.mock("node:child_process", () => {
  const { promisify } = require("node:util");
  const execFileFn = (...args: any[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      if (mockExecFileShouldFail) {
        callback(new Error("Command failed"), "", "");
      } else {
        callback(null, mockExecFileStdout, "");
      }
    }
  };

  // promisify(execFile) が呼び出された時にオブジェクト `{ stdout, stderr }` を正しく返すようにする
  Object.defineProperty(execFileFn, promisify.custom, {
    value: async () => {
      if (mockExecFileShouldFail) {
        throw new Error("Command failed");
      }
      return { stdout: mockExecFileStdout, stderr: "" };
    },
    writable: true,
    configurable: true,
  });

  return {
    execFile: execFileFn,
  };
});

describe("codex-auth.service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.CODEX_ACCESS_TOKEN = undefined;
    mockExecFileShouldFail = false;
    mockExecFileStdout = "codex version 1.0.0";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getCodexLoginCommand", () => {
    test("returns the correct login command", () => {
      expect(getCodexLoginCommand()).toBe("codex login");
    });
  });

  describe("checkCodexAuthStatus", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64");

    test("returns ready when CODEX_ACCESS_TOKEN env variable is configured", async () => {
      process.env.CODEX_ACCESS_TOKEN = "env-token";
      // auth.json is missing
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));

      const status = await checkCodexAuthStatus();

      expect(status.accessTokenConfigured).toBe(true);
      expect(status.authJsonExists).toBe(false);
      expect(status.tokenInfo).toBeNull();
      expect(status.recommendedAction).toBe("ready");
    });

    test("returns ready when valid auth.json exists with active token", async () => {
      const payloadObj = {
        "https://api.openai.com/profile": { email: "user@example.com" },
        exp: Math.floor(Date.now() / 1000) + 3600, // active for 1 hour
      };
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
      // Replace '+' with '-' and '/' with '_' for base64url compliance
      const token = `${header}.${payload.replace(/\+/g, "-").replace(/\//g, "_")}.signature`;

      const authJson = {
        auth_mode: "oauth",
        tokens: {
          access_token: token,
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(authJson));

      const status = await checkCodexAuthStatus();

      expect(status.authJsonExists).toBe(true);
      expect(status.tokenInfo).not.toBeNull();
      expect(status.tokenInfo?.authMode).toBe("oauth");
      expect(status.tokenInfo?.email).toBe("user@example.com");
      expect(status.tokenInfo?.isExpired).toBe(false);
      expect(status.recommendedAction).toBe("ready");
    });

    test("decodes email directly from token if profile namespace is absent", async () => {
      const payloadObj = {
        email: "direct@example.com",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
      const token = `${header}.${payload.replace(/\+/g, "-").replace(/\//g, "_")}.signature`;

      const authJson = {
        auth_mode: "oauth",
        tokens: {
          id_token: token, // fallback to id_token
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(authJson));

      const status = await checkCodexAuthStatus();

      expect(status.tokenInfo?.email).toBe("direct@example.com");
    });

    test("returns run-codex-login when auth.json has an expired token", async () => {
      const payloadObj = {
        email: "expired@example.com",
        exp: Math.floor(Date.now() / 1000) - 3600, // expired 1 hour ago
      };
      const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64");
      const token = `${header}.${payload.replace(/\+/g, "-").replace(/\//g, "_")}.signature`;

      const authJson = {
        auth_mode: "oauth",
        tokens: {
          access_token: token,
        },
      };

      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(authJson));

      const status = await checkCodexAuthStatus();

      expect(status.tokenInfo?.isExpired).toBe(true);
      expect(status.recommendedAction).toBe("run-codex-login");
    });

    test("returns install-codex-cli when auth.json is missing and CLI is not available", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));
      mockExecFileShouldFail = true;

      const status = await checkCodexAuthStatus();

      expect(status.cliAvailable).toBe(false);
      expect(status.recommendedAction).toBe("install-codex-cli");
    });

    test("returns run-codex-login when auth.json is missing but CLI is available", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));
      mockExecFileShouldFail = false;

      const status = await checkCodexAuthStatus();

      expect(status.cliAvailable).toBe(true);
      expect(status.recommendedAction).toBe("run-codex-login");
    });

    test("does not report ready for an auth file without credentials", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify({ auth_mode: "oauth" }));

      const status = await checkCodexAuthStatus();

      expect(status.authJsonExists).toBe(true);
      expect(status.recommendedAction).toBe("run-codex-login");
    });

    test("does not report ready for malformed auth JSON", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("{not-json");

      const status = await checkCodexAuthStatus();

      expect(status.authJsonExists).toBe(true);
      expect(status.tokenInfo).toBeNull();
      expect(status.recommendedAction).toBe("run-codex-login");
    });

    test("handles corrupted JWT token gracefully", async () => {
      const authJson = {
        auth_mode: "api_key",
        tokens: {
          access_token: "invalid.jwt.token",
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(authJson));

      const status = await checkCodexAuthStatus();

      expect(status.tokenInfo).not.toBeNull();
      expect(status.tokenInfo?.email).toBeNull();
      expect(status.tokenInfo?.expiresAt).toBeNull();
      expect(status.tokenInfo?.isExpired).toBe(false);
    });

    test("handles non-JWT string tokens gracefully", async () => {
      const authJson = {
        auth_mode: "api_key",
        tokens: {
          access_token: "simple-plain-token-no-dots",
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(authJson));

      const status = await checkCodexAuthStatus();

      expect(status.tokenInfo).not.toBeNull();
      expect(status.tokenInfo?.email).toBeNull();
      expect(status.tokenInfo?.expiresAt).toBeNull();
    });
  });
});
