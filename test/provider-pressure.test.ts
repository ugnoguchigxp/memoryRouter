import { beforeEach, describe, expect, test, vi } from "vitest";
import { LlmProviderHttpError } from "../src/modules/llm/provider-http-error.js";
import {
  isRateLimitError,
  readProviderPressureState,
  recordProviderRateLimit,
  recordProviderUsage,
} from "../src/modules/llm/provider-pressure.service.js";

const dbMocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
}));

vi.mock("../src/db/client.js", () => ({
  db: {
    select: dbMocks.select,
    insert: dbMocks.insert,
  },
}));

vi.mock("../src/config.js", () => ({
  groupedConfig: {
    embedding: {
      dimension: 768,
    },
    distillation: {
      findCandidateRateLimitCooldownSeconds: 60,
    },
  },
}));

const limitMock = vi.fn();
const onConflictMock = vi.fn(() => Promise.resolve());
const valuesMock = vi.fn((_arg?: any) => ({ onConflictDoUpdate: onConflictMock }));

describe("provider-pressure service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockReset();
    onConflictMock.mockReset();
    valuesMock.mockReset();

    dbMocks.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: limitMock,
        }),
      }),
    });

    dbMocks.insert.mockReturnValue({
      values: valuesMock,
    });
  });

  describe("isRateLimitError", () => {
    test("identifies LlmProviderHttpError with status 429", () => {
      const err = new LlmProviderHttpError({
        provider: "openai",
        status: 429,
        message: "Too Many Requests",
      });
      expect(isRateLimitError(err)).toBe(true);

      const err400 = new LlmProviderHttpError({
        provider: "openai",
        status: 400,
        message: "Bad Request",
      });
      expect(isRateLimitError(err400)).toBe(false);
    });

    test("identifies error message strings containing rate limit", () => {
      expect(isRateLimitError(new Error("error: HTTP 429"))).toBe(true);
      expect(isRateLimitError(new Error("Rate Limit reached"))).toBe(true);
      expect(isRateLimitError("rate limit error")).toBe(true);
      expect(isRateLimitError(new Error("random error"))).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
    });
  });

  describe("readProviderPressureState", () => {
    test("returns default state when database row is missing", async () => {
      limitMock.mockResolvedValue([]);
      const state = await readProviderPressureState({ provider: "openai", model: "gpt-4" });
      expect(state).toEqual({
        metadata: {
          provider: "openai",
          model: "gpt-4",
          cooldownUntil: null,
          reason: null,
          updatedAt: null,
          lastRateLimitedAt: null,
          lastInteractiveAt: null,
          lastBackgroundAt: null,
          consecutiveFailures: 0,
          source: null,
        },
        cooldownActive: false,
        waitMs: 0,
      });
    });

    test("handles stringified number in consecutiveFailures", async () => {
      limitMock.mockResolvedValue([
        {
          metadata: {
            consecutiveFailures: "5",
          },
        },
      ]);
      const state = await readProviderPressureState({ provider: "openai", model: "gpt-4" });
      expect(state.metadata.consecutiveFailures).toBe(5);
    });

    test("returns active cooldown state if cooldownUntil is in the future", async () => {
      const futureTime = new Date(Date.now() + 10000).toISOString();
      limitMock.mockResolvedValue([
        {
          metadata: {
            cooldownUntil: futureTime,
            reason: "rate_limit",
            consecutiveFailures: 2,
          },
        },
      ]);
      const state = await readProviderPressureState({ provider: "openai", model: "gpt-4" });
      expect(state.cooldownActive).toBe(true);
      expect(state.waitMs).toBeGreaterThan(0);
      expect(state.metadata.consecutiveFailures).toBe(2);
    });

    test("handles database load failure gracefully", async () => {
      limitMock.mockRejectedValue(new Error("DB failure"));
      const state = await readProviderPressureState({ provider: "openai", model: "gpt-4" });
      expect(state.metadata.provider).toBe("openai");
      expect(state.cooldownActive).toBe(false);
    });
  });

  describe("recordProviderUsage", () => {
    test("saves usage metadata updates for interactive kind", async () => {
      limitMock.mockResolvedValue([
        {
          metadata: {
            consecutiveFailures: 1,
          },
        },
      ]);

      await recordProviderUsage({
        provider: "openai",
        model: "gpt-4",
        source: "test-source",
        kind: "interactive",
      });

      expect(dbMocks.insert).toHaveBeenCalled();
      const insertRow = valuesMock.mock.calls[0]?.[0];
      expect(insertRow.metadata.source).toBe("test-source");
      expect(insertRow.metadata.lastInteractiveAt).not.toBeNull();
      expect(insertRow.metadata.lastBackgroundAt).toBeNull();
    });

    test("saves usage metadata updates for background kind", async () => {
      limitMock.mockResolvedValue([]);

      await recordProviderUsage({
        provider: "openai",
        model: "gpt-4",
        source: "test-source",
        kind: "background",
      });

      expect(dbMocks.insert).toHaveBeenCalled();
      const insertRow = valuesMock.mock.calls[0]?.[0];
      expect(insertRow.metadata.lastBackgroundAt).not.toBeNull();
      expect(insertRow.metadata.lastInteractiveAt).toBeNull();
    });
  });

  describe("recordProviderRateLimit", () => {
    test("calculates cooldown using error retryAfterSeconds if present", async () => {
      limitMock.mockResolvedValue([]);
      const err = new LlmProviderHttpError({
        provider: "openai",
        status: 429,
        retryAfterSeconds: 15,
        message: "rate limit",
      });

      await recordProviderRateLimit({
        provider: "openai",
        model: "gpt-4",
        source: "test",
        error: err,
      });

      expect(dbMocks.insert).toHaveBeenCalled();
      const insertRow = valuesMock.mock.calls[0]?.[0];
      expect(insertRow.metadata.reason).toBe("rate_limit");
      expect(insertRow.metadata.consecutiveFailures).toBe(1);

      const cooldownMs = Date.parse(insertRow.metadata.cooldownUntil) - Date.now();
      // Should be close to 15 seconds (15000ms)
      expect(cooldownMs).toBeGreaterThan(14000);
      expect(cooldownMs).toBeLessThan(16000);
    });

    test("falls back to config cooldown seconds if error does not specify it", async () => {
      limitMock.mockResolvedValue([
        {
          metadata: {
            consecutiveFailures: 5,
          },
        },
      ]);

      await recordProviderRateLimit({
        provider: "openai",
        model: "gpt-4",
        source: "test",
        error: new Error("rate limit without retry-after"),
      });

      expect(dbMocks.insert).toHaveBeenCalled();
      const insertRow = valuesMock.mock.calls[0]?.[0];
      expect(insertRow.metadata.consecutiveFailures).toBe(6);

      const cooldownMs = Date.parse(insertRow.metadata.cooldownUntil) - Date.now();
      // Config fallback is 60 seconds
      expect(cooldownMs).toBeGreaterThan(59000);
      expect(cooldownMs).toBeLessThan(61000);
    });
  });
});
