import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordAuditLogSafe } from "../src/modules/audit/audit-log.service.js";
import {
  recoverStaleDistillationTargets,
  releaseRetryablePausedDistillationTargets,
} from "../src/modules/distillationTarget/repository-maintenance.js";

const mockSelect = vi.fn();
const mockUpdate = vi.fn();

vi.mock("../src/db/index.js", () => ({
  db: {
    select: (...args: any[]) => mockSelect(...args),
    update: (...args: any[]) => mockUpdate(...args),
  },
}));

vi.mock("../src/modules/audit/audit-log.service.js", () => ({
  auditEventTypes: {
    distillationTargetRecovered: "DISTILLATION_TARGET_RECOVERED",
  },
  recordAuditLogSafe: vi.fn().mockResolvedValue(undefined),
}));

const makeChain = (result: any) => {
  const chain = {
    from: vi.fn().mockImplementation(() => chain),
    where: vi.fn().mockImplementation(() => chain),
    limit: vi.fn().mockImplementation(() => chain),
    orderBy: vi.fn().mockImplementation(() => chain),
    groupBy: vi.fn().mockImplementation(() => chain),
    set: vi.fn().mockImplementation(() => chain),
    returning: vi.fn().mockResolvedValue(result),
    then: (onfulfilled: any) => Promise.resolve(result).then(onfulfilled),
    catch: (onrejected: any) => Promise.resolve(result).catch(onrejected),
  };
  return chain;
};

describe("distillationTarget repository-maintenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("releaseRetryablePausedDistillationTargets", () => {
    it("updates target status from paused to pending", async () => {
      const mockRows = [{ id: "target-1" }];
      mockUpdate.mockReturnValueOnce(makeChain([])).mockReturnValueOnce(makeChain(mockRows));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
      });

      expect(count).toBe(1);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalled();
    });

    it("skips paused targets that already reached the retry limit", async () => {
      mockUpdate
        .mockReturnValueOnce(makeChain([{ id: "target-1" }]))
        .mockReturnValueOnce(makeChain([]));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
      });

      expect(count).toBe(0);
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledTimes(2);
    });

    it("skips retry-exhausted paused targets even before their next retry time", async () => {
      mockSelect.mockReturnValueOnce(
        makeChain([
          {
            id: "future-exhausted",
            attemptCount: 2,
            nextRetryAt: new Date(Date.now() + 60_000),
            lastError: "cover_evidence_retryable",
            metadata: {},
          },
        ]),
      );
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "future-exhausted" }]));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
        excludeManualPauseReasons: true,
      });

      expect(count).toBe(0);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it("does not release manual paused targets when excludeManualPauseReasons is enabled", async () => {
      mockSelect.mockReturnValueOnce(
        makeChain([
          { id: "manual", attemptCount: 1, lastError: "manual_pause", metadata: {} },
          {
            id: "retryable",
            attemptCount: 1,
            lastError: "cover_evidence_retryable",
            metadata: {},
          },
        ]),
      );
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "retryable" }]));

      const count = await releaseRetryablePausedDistillationTargets({
        distillationVersion: "v1",
        now: new Date(),
        excludeManualPauseReasons: true,
      });

      expect(count).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });

  describe("recoverStaleDistillationTargets", () => {
    it("does nothing if there are no running targets", async () => {
      mockSelect.mockReturnValueOnce(makeChain([])); // No running targets

      const result = await recoverStaleDistillationTargets();
      expect(result).toEqual({ recoveredToPending: 0, failed: 0, skipped: 0 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("recovers stale targets to pending if attemptCount is under limit", async () => {
      const now = new Date();
      // heartbeat is older than threshold
      const staleHeartbeat = new Date(now.getTime() - 600 * 1000);
      const mockRunning = [
        {
          id: "t-1",
          status: "running",
          attemptCount: 1,
          heartbeatAt: staleHeartbeat,
          lockedAt: staleHeartbeat,
        },
      ];

      // 1. load running targets
      mockSelect.mockReturnValueOnce(makeChain(mockRunning));
      // 2. update call in loop
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "t-1" }]));

      const result = await recoverStaleDistillationTargets({
        now,
        maxAttempts: 3,
        staleSeconds: 300,
      });

      expect(result.recoveredToPending).toBe(1);
      expect(result.skipped).toBe(0);
      expect(mockUpdate).toHaveBeenCalled();
      expect(recordAuditLogSafe).toHaveBeenCalled();
    });

    it("skips stale targets if attemptCount exceeds limit", async () => {
      const now = new Date();
      const staleHeartbeat = new Date(now.getTime() - 600 * 1000);
      const mockRunning = [
        {
          id: "t-1",
          status: "running",
          attemptCount: 5, // Limit is 3
          heartbeatAt: staleHeartbeat,
          lockedAt: staleHeartbeat,
        },
      ];

      mockSelect.mockReturnValueOnce(makeChain(mockRunning));
      mockUpdate.mockReturnValueOnce(makeChain([{ id: "t-1" }]));

      const result = await recoverStaleDistillationTargets({
        now,
        maxAttempts: 3,
        staleSeconds: 300,
      });

      expect(result.recoveredToPending).toBe(0);
      expect(result.skipped).toBe(1);
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
