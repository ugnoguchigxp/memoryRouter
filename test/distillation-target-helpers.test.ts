import { describe, expect, it } from "vitest";
import {
  nowMinusSeconds,
  rowHeartbeatMs,
  staleThresholdMs,
} from "../src/modules/distillationTarget/repository-helpers.js";

describe("selectDistillationTarget repository helpers", () => {
  describe("nowMinusSeconds", () => {
    it("subtracts correct amount of seconds", () => {
      const now = new Date("2026-05-22T12:00:00.000Z");
      const past = nowMinusSeconds(30, now);
      expect(past.toISOString()).toBe("2026-05-22T11:59:30.000Z");
    });

    it("uses at least 1 second subtraction even if 0 or negative is passed", () => {
      const now = new Date("2026-05-22T12:00:00.000Z");
      const past = nowMinusSeconds(-10, now);
      expect(past.toISOString()).toBe("2026-05-22T11:59:59.000Z");
    });
  });

  describe("staleThresholdMs", () => {
    it("returns correct millisecond timestamp", () => {
      const now = new Date("2026-05-22T12:00:00.000Z");
      const threshold = staleThresholdMs(10, now);
      expect(threshold).toBe(now.getTime() - 10000);
    });
  });

  describe("rowHeartbeatMs", () => {
    it("prefers heartbeatAt if present", () => {
      const row = {
        heartbeatAt: new Date("2026-05-22T12:00:10.000Z"),
        lockedAt: new Date("2026-05-22T12:00:00.000Z"),
      };
      expect(rowHeartbeatMs(row)).toBe(row.heartbeatAt.getTime());
    });

    it("falls back to lockedAt if heartbeatAt is null", () => {
      const row = {
        heartbeatAt: null,
        lockedAt: new Date("2026-05-22T12:00:00.000Z"),
      };
      expect(rowHeartbeatMs(row)).toBe(row.lockedAt.getTime());
    });

    it("returns negative infinity if both are null", () => {
      const row = {
        heartbeatAt: null,
        lockedAt: null,
      };
      expect(rowHeartbeatMs(row)).toBe(Number.NEGATIVE_INFINITY);
    });
  });
});
