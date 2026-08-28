import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  DeadZoneMergeReviewQueueError,
  applyDeadZoneMergeReviewJob,
  createDeadZoneMergeReviewJob,
  listDeadZoneMergeReviewQueueJobs,
  processDeadZoneMergeReviewJob,
} from "../src/modules/landscape/deadzone-merge-review-queue.service.js";

// クエリ結果解決用のキュー
let mockDbResults: any[] = [];

// db index のモック（巻き上げ回避のためファクトリ内で定義）
vi.mock("../src/db/index.js", () => {
  const mockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    then: vi.fn().mockImplementation((resolve) => {
      resolve(mockDbResults.shift() ?? []);
    }),
  };
  return {
    db: mockDb,
  };
});

// repository モック
const mockGetDeadZoneMergeReviewQueueRow = vi.fn();
const mockListDeadZoneMergeReviewJobs = vi.fn();
const mockMarkDeadZoneMergeReviewJobCompleted = vi.fn();
const mockMarkDeadZoneMergeReviewJobFailed = vi.fn();
const mockMarkDeadZoneMergeReviewJobSkipped = vi.fn();
const mockUpsertDeadZoneMergeReviewJob = vi.fn();
const mockFindLandscapeCurationJobLinkByQueueJob = vi.fn();
const mockGetLandscapeCurationJob = vi.fn();
const mockUpsertLandscapeCurationJobLink = vi.fn();
const mockUpdateLandscapeCurationJob = vi.fn();
const mockCreateMergeActivationFinalizeJob = vi.fn();

vi.mock("../src/modules/landscape/deadzone-merge-review-queue.repository.js", () => ({
  getDeadZoneMergeReviewQueueRow: (...args: any[]) => mockGetDeadZoneMergeReviewQueueRow(...args),
  listDeadZoneMergeReviewJobs: (...args: any[]) => mockListDeadZoneMergeReviewJobs(...args),
  markDeadZoneMergeReviewJobCompleted: (...args: any[]) =>
    mockMarkDeadZoneMergeReviewJobCompleted(...args),
  markDeadZoneMergeReviewJobFailed: (...args: any[]) =>
    mockMarkDeadZoneMergeReviewJobFailed(...args),
  markDeadZoneMergeReviewJobSkipped: (...args: any[]) =>
    mockMarkDeadZoneMergeReviewJobSkipped(...args),
  upsertDeadZoneMergeReviewJob: (...args: any[]) => mockUpsertDeadZoneMergeReviewJob(...args),
}));

vi.mock("../src/modules/landscape/landscape-curation-queue.repository.js", () => ({
  findLandscapeCurationJobLinkByQueueJob: (...args: any[]) =>
    mockFindLandscapeCurationJobLinkByQueueJob(...args),
  getLandscapeCurationJob: (...args: any[]) => mockGetLandscapeCurationJob(...args),
  upsertLandscapeCurationJobLink: (...args: any[]) => mockUpsertLandscapeCurationJobLink(...args),
  updateLandscapeCurationJob: (...args: any[]) => mockUpdateLandscapeCurationJob(...args),
}));

vi.mock("../src/modules/landscape/merge-activation-finalize.service.js", () => ({
  createMergeActivationFinalizeJob: (...args: any[]) =>
    mockCreateMergeActivationFinalizeJob(...args),
}));

// queue events モック
const mockAppendQueueEvent = vi.fn();
vi.mock("../src/modules/queue/core/events.js", () => ({
  appendQueueEvent: (...args: any[]) => mockAppendQueueEvent(...args),
}));

// settings service モック
const mockResolveDeadZoneMergeReviewRoute = vi.fn();
vi.mock("../src/modules/settings/settings.service.js", () => ({
  resolveDeadZoneMergeReviewRoute: (...args: any[]) => mockResolveDeadZoneMergeReviewRoute(...args),
}));

// deadzone merge review llm モック
const mockRunDeadZoneMergeReviewLlm = vi.fn();
vi.mock("../src/modules/landscape/deadzone-merge-review-llm.js", () => ({
  runDeadZoneMergeReviewLlm: (...args: any[]) => mockRunDeadZoneMergeReviewLlm(...args),
  DeadZoneMergeReviewParseError: class DeadZoneMergeReviewParseError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DeadZoneMergeReviewParseError";
    }
  },
}));

// knowledge repository モック
const mockUpdateKnowledgeItem = vi.fn();
vi.mock("../api/modules/knowledge/knowledge.repository.js", () => ({
  updateKnowledgeItem: (...args: any[]) => mockUpdateKnowledgeItem(...args),
}));

// landscape deadzone review repository モック
const mockRecordDeadZoneReviewDecision = vi.fn();
vi.mock("../src/modules/landscape/landscape-deadzone-review.repository.js", () => ({
  recordDeadZoneReviewDecision: (...args: any[]) => mockRecordDeadZoneReviewDecision(...args),
}));

describe("deadzone-merge-review-queue.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDbResults = [];
    mockResolveDeadZoneMergeReviewRoute.mockReturnValue({ provider: "openai", model: "gpt-4" });
    mockFindLandscapeCurationJobLinkByQueueJob.mockResolvedValue(null);
    mockGetLandscapeCurationJob.mockResolvedValue(null);
    mockCreateMergeActivationFinalizeJob.mockResolvedValue({
      id: "finalize-1",
      status: "pending",
    });
  });

  describe("createDeadZoneMergeReviewJob", () => {
    test("throws error if dead-zone and canonical knowledge IDs are the same", async () => {
      await expect(
        createDeadZoneMergeReviewJob({
          deadZoneKnowledgeId: "same-id",
          canonicalKnowledgeId: "same-id",
        }),
      ).rejects.toThrow("dead-zone and canonical knowledge must differ");
    });

    test("throws error if dead-zone knowledge is not found", async () => {
      mockDbResults = [
        [], // loadKnowledgeRows returns no rows
      ];

      await expect(
        createDeadZoneMergeReviewJob({
          deadZoneKnowledgeId: "dz-1",
          canonicalKnowledgeId: "ca-1",
        }),
      ).rejects.toThrow("dead-zone knowledge not found");
    });

    test("throws error if canonical knowledge is not found", async () => {
      mockDbResults = [
        [{ id: "dz-1", status: "active", title: "DZ", body: "DZ Body", type: "rule" }], // only dead-zone found
      ];

      await expect(
        createDeadZoneMergeReviewJob({
          deadZoneKnowledgeId: "dz-1",
          canonicalKnowledgeId: "ca-1",
        }),
      ).rejects.toThrow("canonical knowledge not found");
    });

    test("throws error if canonical knowledge is not active", async () => {
      mockDbResults = [
        [
          { id: "dz-1", status: "active", title: "DZ", body: "DZ Body", type: "rule" },
          { id: "ca-1", status: "deprecated", title: "CA", body: "CA Body", type: "rule" },
        ],
      ];

      await expect(
        createDeadZoneMergeReviewJob({
          deadZoneKnowledgeId: "dz-1",
          canonicalKnowledgeId: "ca-1",
        }),
      ).rejects.toThrow("canonical knowledge must be active");
    });

    test("throws error if dead-zone knowledge is deprecated", async () => {
      mockDbResults = [
        [
          { id: "dz-1", status: "deprecated", title: "DZ", body: "DZ Body", type: "rule" },
          { id: "ca-1", status: "active", title: "CA", body: "CA Body", type: "rule" },
        ],
      ];

      await expect(
        createDeadZoneMergeReviewJob({
          deadZoneKnowledgeId: "dz-1",
          canonicalKnowledgeId: "ca-1",
        }),
      ).rejects.toThrow("deprecated dead-zone knowledge cannot be queued");
    });

    test("successfully creates a job", async () => {
      const dzRow = {
        id: "dz-1",
        status: "active",
        title: "DZ",
        body: "DZ Body",
        type: "rule",
        appliesTo: {},
      };
      const caRow = {
        id: "ca-1",
        status: "active",
        title: "CA",
        body: "CA Body",
        type: "rule",
        appliesTo: {},
      };
      mockDbResults = [[dzRow, caRow]];

      const expectedJob = { id: "job-1" };
      mockUpsertDeadZoneMergeReviewJob.mockResolvedValue(expectedJob);

      const result = await createDeadZoneMergeReviewJob({
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        note: "Test note",
        reviewItemId: "review-1",
      });

      expect(result).toEqual(expectedJob);
      expect(mockUpsertDeadZoneMergeReviewJob).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewItemId: "review-1",
          deadZoneKnowledgeId: "dz-1",
          canonicalKnowledgeId: "ca-1",
          priority: 70,
          provider: "openai",
          model: "gpt-4",
          inputSnapshot: expect.objectContaining({
            deadZone: expect.objectContaining({ id: "dz-1" }),
            canonical: expect.objectContaining({ id: "ca-1" }),
          }),
        }),
      );
    });

    test("falls back to local-llm if route provider is auto", async () => {
      mockResolveDeadZoneMergeReviewRoute.mockReturnValue({ provider: "auto", model: null });
      const dzRow = { id: "dz-1", status: "active", title: "DZ", body: "DZ Body", type: "rule" };
      const caRow = { id: "ca-1", status: "active", title: "CA", body: "CA Body", type: "rule" };
      mockDbResults = [[dzRow, caRow]];

      await createDeadZoneMergeReviewJob({
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
      });

      expect(mockUpsertDeadZoneMergeReviewJob).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "local-llm",
          model: null,
        }),
      );
    });
  });

  describe("listDeadZoneMergeReviewQueueJobs", () => {
    test("delegates to repository function", async () => {
      const jobs = [{ id: "job-1" }];
      mockListDeadZoneMergeReviewJobs.mockResolvedValue(jobs);

      const query = { status: "pending" as const, limit: 10 };
      const result = await listDeadZoneMergeReviewQueueJobs(query);

      expect(result).toEqual(jobs);
      expect(mockListDeadZoneMergeReviewJobs).toHaveBeenCalledWith(query);
    });
  });

  describe("processDeadZoneMergeReviewJob", () => {
    test("throws error if job is not found", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue(null);

      await expect(processDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "dead-zone merge review job not found: job-1",
      );
    });

    test("skips the job if knowledge status changed before review", async () => {
      const mockJob = {
        id: "job-1",
        inputSnapshot: {
          deadZone: { id: "dz-1" },
          canonical: { id: "ca-1" },
        },
      };
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue(mockJob);
      // loadKnowledgeRows returns non-matching statuses (e.g. canonical is deprecated)
      mockDbResults = [
        [
          { id: "dz-1", status: "active" },
          { id: "ca-1", status: "deprecated" }, // not active
        ],
      ];

      await processDeadZoneMergeReviewJob("job-1");

      expect(mockAppendQueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "claimed" }),
      );
      expect(mockMarkDeadZoneMergeReviewJobSkipped).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "job-1",
          reason: "knowledge status changed before review",
          result: expect.objectContaining({ decision: "merge_blocked" }),
        }),
      );
      expect(mockRunDeadZoneMergeReviewLlm).not.toHaveBeenCalled();
    });

    test("successfully completes the job", async () => {
      const mockJob = {
        id: "job-1",
        inputSnapshot: {
          deadZone: { id: "dz-1" },
          canonical: { id: "ca-1" },
        },
      };
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue(mockJob);
      mockDbResults = [
        [
          { id: "dz-1", status: "active" },
          { id: "ca-1", status: "active" },
        ],
      ];

      const expectedResult = { decision: "merge_recommended", proposedCanonicalBody: "New Body" };
      mockRunDeadZoneMergeReviewLlm.mockResolvedValue(expectedResult);

      await processDeadZoneMergeReviewJob("job-1");

      expect(mockRunDeadZoneMergeReviewLlm).toHaveBeenCalled();
      expect(mockMarkDeadZoneMergeReviewJobCompleted).toHaveBeenCalledWith({
        id: "job-1",
        result: expectedResult,
        outcome: "merge_recommended",
      });
      expect(mockAppendQueueEvent).toHaveBeenCalledTimes(2); // claimed, completed
    });

    test("automatically sends a Curation-linked merge recommendation to Finalize", async () => {
      const now = "2026-05-24T00:00:00.000Z";
      const sameBodyHash = createHash("sha256").update("Same Body").digest("hex");
      const pendingJob = {
        id: "job-1",
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        inputSnapshot: {
          deadZone: { id: "dz-1" },
          canonical: { id: "ca-1" },
        },
      };
      const mergeResult = {
        decision: "merge_recommended",
        confidence: "high",
        rationale: ["same guidance"],
        blockers: [],
        proposedCanonicalBody: "Same Body",
        proposedSummary: "Merged",
        rawOutputExcerpt: "{}",
        parseStatus: "parsed",
      };
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValueOnce(pendingJob).mockResolvedValueOnce({
        ...pendingJob,
        status: "completed",
        result: mergeResult,
        completedAt: new Date("2026-05-24T00:00:00.000Z"),
      });
      mockDbResults = [
        [
          { id: "dz-1", status: "active" },
          { id: "ca-1", status: "active" },
        ],
      ];
      mockRunDeadZoneMergeReviewLlm.mockResolvedValue(mergeResult);
      mockFindLandscapeCurationJobLinkByQueueJob.mockResolvedValue({
        id: "link-1",
        curationJobId: "curation-1",
        role: "merge_review",
        queueName: "deadZoneMergeReview",
        queueJobId: "job-1",
        status: "pending",
        outcomeKind: null,
        metadata: {},
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
        completedAt: null,
      });
      mockGetLandscapeCurationJob.mockResolvedValue({
        inputSnapshot: {
          schemaVersion: 1,
          capturedAt: now,
          finding: {
            type: "duplicate_candidate",
            reviewItemId: "review-1",
            evidenceHash: "evidence-hash",
          },
          subject: {
            id: "dz-1",
            title: "Duplicate",
            body: "Same Body",
            bodyHash: sameBodyHash,
            appliesToHash: "same-applies-to-hash",
            status: "active",
            type: "rule",
            polarity: "positive",
            scope: "global",
            classificationStatus: "classified",
            projectRef: null,
            repoKey: null,
            repoPath: null,
            appliesTo: {},
            confidence: 90,
            importance: 80,
            updatedAt: now,
            createdAt: now,
            lastVerifiedAt: null,
          },
          candidates: [
            {
              id: "ca-1",
              title: "Canonical",
              body: "Same Body",
              bodyHash: sameBodyHash,
              appliesToHash: "same-applies-to-hash",
              status: "active",
              type: "rule",
              polarity: "positive",
              scope: "global",
              classificationStatus: "classified",
              projectRef: null,
              repoKey: null,
              repoPath: null,
              appliesTo: {},
              confidence: 90,
              importance: 80,
              updatedAt: now,
              createdAt: now,
              lastVerifiedAt: null,
            },
          ],
          evidence: [],
          usage: {},
          lineage: {},
          reviewItem: null,
          capabilities: {},
          versions: { detector: "v1", policy: "v1", prompt: "v1" },
        },
        result: {
          schemaVersion: 1,
          decision: "deprecate_duplicate",
          confidence: "high",
          canonicalKnowledgeId: "ca-1",
          rationale: ["exact duplicate"],
          supportingEvidenceIds: [],
          counterEvidence: [],
          blockers: [],
          proposedAppliesTo: null,
          proposedSummary: null,
        },
        policyResult: {
          schemaVersion: 1,
          policyVersion: "curation-policy-v1",
          releaseMode: "auto_bounded",
          requestedDecision: "deprecate_duplicate",
          disposition: "enqueue_downstream",
          effectiveAction: "enqueue_merge_review",
          reasonCodes: ["AUTONOMOUS_SAFE_DOWNSTREAM"],
          evaluatedAt: now,
          limits: { dailyRemaining: 1, repoRemaining: 1 },
        },
      });

      await processDeadZoneMergeReviewJob("job-1");

      expect(mockCreateMergeActivationFinalizeJob).toHaveBeenCalledWith("job-1", {
        curationJobId: "curation-1",
        autonomousExactDuplicate: true,
      });
      expect(mockUpsertLandscapeCurationJobLink).toHaveBeenCalledWith(
        expect.objectContaining({
          curationJobId: "curation-1",
          role: "merge_finalize",
          queueJobId: "finalize-1",
          status: "pending",
          metadata: expect.objectContaining({ exactDuplicate: true }),
        }),
      );
    });

    test("does not auto-finalize a low-confidence Curation-linked recommendation", async () => {
      const pendingJob = {
        id: "job-1",
        inputSnapshot: {
          deadZone: { id: "dz-1" },
          canonical: { id: "ca-1" },
        },
      };
      const mergeResult = {
        decision: "merge_recommended",
        confidence: "medium",
        rationale: ["possibly the same guidance"],
        blockers: [],
        proposedCanonicalBody: "New Body",
        proposedSummary: "Merged",
        rawOutputExcerpt: "{}",
        parseStatus: "parsed",
      };
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValueOnce(pendingJob).mockResolvedValueOnce({
        ...pendingJob,
        status: "completed",
        result: mergeResult,
        completedAt: new Date("2026-05-24T00:00:00.000Z"),
      });
      mockDbResults = [
        [
          { id: "dz-1", status: "active" },
          { id: "ca-1", status: "active" },
        ],
      ];
      mockRunDeadZoneMergeReviewLlm.mockResolvedValue(mergeResult);
      mockFindLandscapeCurationJobLinkByQueueJob.mockResolvedValue({
        id: "link-1",
        curationJobId: "curation-1",
        role: "merge_review",
        queueName: "deadZoneMergeReview",
        queueJobId: "job-1",
        status: "pending",
        outcomeKind: null,
        metadata: {},
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
        completedAt: null,
      });

      await processDeadZoneMergeReviewJob("job-1");

      expect(mockCreateMergeActivationFinalizeJob).not.toHaveBeenCalled();
      expect(mockUpdateLandscapeCurationJob).toHaveBeenCalledWith(
        "curation-1",
        expect.objectContaining({
          status: "completed",
          lastOutcomeKind: "downstream_merge_not_auto_eligible",
        }),
      );
    });

    test("automatically retries the job if LLM execution fails", async () => {
      const mockJob = {
        id: "job-1",
        attemptCount: 0,
        maxAttempts: 2,
        inputSnapshot: {
          deadZone: { id: "dz-1" },
          canonical: { id: "ca-1" },
        },
      };
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue(mockJob);
      mockDbResults = [
        [
          { id: "dz-1", status: "active" },
          { id: "ca-1", status: "active" },
        ],
      ];

      const error = new Error("LLM Error");
      mockRunDeadZoneMergeReviewLlm.mockRejectedValue(error);

      await processDeadZoneMergeReviewJob("job-1");

      expect(mockMarkDeadZoneMergeReviewJobFailed).toHaveBeenCalledWith({
        id: "job-1",
        error: "LLM Error",
        outcome: "retry_scheduled",
        retryAt: expect.any(Date),
      });
      expect(mockAppendQueueEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "retried" }),
      );
    });

    test("fails the job after LLM retries are exhausted", async () => {
      const mockJob = {
        id: "job-1",
        attemptCount: 1,
        maxAttempts: 2,
        inputSnapshot: {
          deadZone: { id: "dz-1" },
          canonical: { id: "ca-1" },
        },
      };
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue(mockJob);
      mockDbResults = [
        [
          { id: "dz-1", status: "active" },
          { id: "ca-1", status: "active" },
        ],
      ];
      mockRunDeadZoneMergeReviewLlm.mockRejectedValue(new Error("LLM Error"));

      await expect(processDeadZoneMergeReviewJob("job-1")).rejects.toThrow("LLM Error");

      expect(mockMarkDeadZoneMergeReviewJobFailed).toHaveBeenCalledWith({
        id: "job-1",
        error: "LLM Error",
        outcome: "provider_failed",
        retryAt: null,
      });
    });
  });

  describe("applyDeadZoneMergeReviewJob", () => {
    test("throws 404 if job not found", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue(null);

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "merge review job not found",
      );
    });

    test("throws error if job status is not completed", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({ status: "pending" });

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "merge review job is not completed",
      );
    });

    test("throws error if result is not merge_recommended", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({
        status: "completed",
        result: {
          decision: "keep_separate",
          confidence: "high",
          rationale: [],
          blockers: [],
          proposedCanonicalBody: null,
          proposedSummary: null,
          rawOutputExcerpt: "",
          parseStatus: "parsed",
        },
      });

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "merge review did not recommend applying a merge",
      );
    });

    test("throws error if proposedCanonicalBody is missing", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({
        status: "completed",
        result: {
          decision: "merge_recommended",
          confidence: "high",
          rationale: [],
          blockers: [],
          proposedCanonicalBody: "",
          proposedSummary: "Summary",
          rawOutputExcerpt: "",
          parseStatus: "parsed",
        },
      });

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "merge review did not produce a canonical body",
      );
    });

    test("throws 404 if knowledge row missing", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({
        id: "job-1",
        status: "completed",
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        result: {
          decision: "merge_recommended",
          confidence: "high",
          rationale: [],
          blockers: [],
          proposedCanonicalBody: "New Body",
          proposedSummary: "Summary",
          rawOutputExcerpt: "",
          parseStatus: "parsed",
        },
        inputSnapshot: {
          deadZone: { bodyHash: "h1" },
          canonical: { bodyHash: "h2" },
        },
      });
      mockDbResults = [
        [], // knowledge not found
      ];

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow("knowledge row missing");
    });

    test("throws 409 if knowledge body hash changed after review", async () => {
      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({
        id: "job-1",
        status: "completed",
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        result: {
          decision: "merge_recommended",
          confidence: "high",
          rationale: [],
          blockers: [],
          proposedCanonicalBody: "New Body",
          proposedSummary: "Summary",
          rawOutputExcerpt: "",
          parseStatus: "parsed",
        },
        inputSnapshot: {
          deadZone: { bodyHash: "h1" },
          canonical: { bodyHash: "h2" },
        },
      });
      mockDbResults = [
        [
          { id: "dz-1", body: "Changed DZ Body", status: "active" }, // different body hash
          { id: "ca-1", body: "CA Body", status: "active" },
        ],
      ];

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "knowledge body changed after review",
      );
    });

    test("throws 409 if knowledge status changed after review", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const crypto = require("node:crypto");
      const h1 = crypto.createHash("sha256").update(dzBody).digest("hex");
      const h2 = crypto.createHash("sha256").update(caBody).digest("hex");

      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({
        id: "job-1",
        status: "completed",
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        result: {
          decision: "merge_recommended",
          confidence: "high",
          rationale: [],
          blockers: [],
          proposedCanonicalBody: "New Body",
          proposedSummary: "Summary",
          rawOutputExcerpt: "",
          parseStatus: "parsed",
        },
        inputSnapshot: {
          deadZone: { bodyHash: h1 },
          canonical: { bodyHash: h2 },
        },
      });
      mockDbResults = [
        [
          { id: "dz-1", body: dzBody, status: "deprecated" }, // not active/deprecated
          { id: "ca-1", body: caBody, status: "active" },
        ],
      ];

      await expect(applyDeadZoneMergeReviewJob("job-1")).rejects.toThrow(
        "knowledge status changed after review",
      );
    });

    test("successfully applies the merge decision", async () => {
      const dzBody = "DZ Body";
      const caBody = "CA Body";
      const crypto = require("node:crypto");
      const h1 = crypto.createHash("sha256").update(dzBody).digest("hex");
      const h2 = crypto.createHash("sha256").update(caBody).digest("hex");

      mockGetDeadZoneMergeReviewQueueRow.mockResolvedValue({
        id: "job-1",
        status: "completed",
        deadZoneKnowledgeId: "dz-1",
        canonicalKnowledgeId: "ca-1",
        reviewItemId: "review-1",
        result: {
          decision: "merge_recommended",
          confidence: "high",
          rationale: [],
          blockers: [],
          proposedCanonicalBody: "New Body",
          proposedSummary: "Summary",
          rawOutputExcerpt: "",
          parseStatus: "parsed",
        },
        inputSnapshot: {
          deadZone: { bodyHash: h1 },
          canonical: { bodyHash: h2 },
        },
      });
      mockDbResults = [
        [
          { id: "dz-1", body: dzBody, status: "active" },
          { id: "ca-1", body: caBody, status: "active" },
        ],
        [], // for the db.update call
      ];

      const result = await applyDeadZoneMergeReviewJob("job-1");

      expect(result).toEqual({
        status: "applied",
        jobId: "job-1",
        keptKnowledgeId: "ca-1",
        deprecatedKnowledgeId: "dz-1",
        reviewItemId: "review-1",
      });

      expect(mockUpdateKnowledgeItem).toHaveBeenCalledTimes(2);
      expect(mockUpdateKnowledgeItem).toHaveBeenNthCalledWith(
        1,
        "ca-1",
        expect.objectContaining({ body: "New Body" }),
      );
      expect(mockUpdateKnowledgeItem).toHaveBeenNthCalledWith(2, "dz-1", { status: "deprecated" });
      expect(mockRecordDeadZoneReviewDecision).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewItemId: "review-1",
          action: "merge_deadzone_into_canonical",
          status: "applied",
        }),
      );
    });
  });
});
