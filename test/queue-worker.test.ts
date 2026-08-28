import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  coveringEvidenceQueue,
  evidenceCoverageResults,
  finalizeDistilleQueue,
  findingCandidateQueue,
  foundCandidates,
} from "../src/db/schema.js";
import { LlmProviderHttpError } from "../src/modules/llm/provider-http-error.js";
import {
  enqueueFindingJob,
  findFindingJob,
  runQueueWorkerOnce,
} from "../src/modules/queue/core/worker.js";

const mocks = vi.hoisted(() => ({
  appendQueueEvent: vi.fn(),
  claimNextQueueJob: vi.fn(),
  runCoverEvidence: vi.fn(),
  isVibeMemorySelfIngestionBlocked: vi.fn(),
  maybeRunFindingCodexEscalation: vi.fn(),
  markFindingCodexEscalationAccepted: vi.fn(),
  runFindCandidate: vi.fn(),
  runFinalizeDistille: vi.fn(),
  heartbeatProviderLease: vi.fn(),
  releaseProviderLease: vi.fn(),
  processMergeActivationFinalizeJob: vi.fn(),
  processLandscapeCurationJob: vi.fn(),
  findLandscapeCurationJobLinkByQueueJob: vi.fn(),
  getLandscapeCurationJob: vi.fn(),
  updateLandscapeCurationJob: vi.fn(),
  upsertLandscapeCurationJobLink: vi.fn(),
  researchWebSourceToMarkdown: vi.fn(),
  isQueuePaused: vi.fn(),
  setQueuePaused: vi.fn(),
  selectRows: [] as unknown[][],
  insertCalls: [] as Array<{ table: unknown; values: unknown }>,
  updateCalls: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("../src/db/index.js", () => ({
  db: mocks.db,
}));

vi.mock("../src/modules/queue/core/claim.js", () => ({
  claimNextQueueJob: mocks.claimNextQueueJob,
}));

vi.mock("../src/modules/queue/core/events.js", () => ({
  appendQueueEvent: mocks.appendQueueEvent,
}));

vi.mock("../src/modules/queue/core/provider-lease.js", () => ({
  heartbeatProviderLease: mocks.heartbeatProviderLease,
  releaseProviderLease: mocks.releaseProviderLease,
}));

vi.mock("../src/modules/coverEvidence/domain.js", () => ({
  runCoverEvidence: mocks.runCoverEvidence,
}));

vi.mock("../src/modules/findCandidate/codex-escalation.service.js", () => ({
  codexFindingEscalationGeneratedBy: "contextStill.codexFindingEscalation",
  isVibeMemorySelfIngestionBlocked: mocks.isVibeMemorySelfIngestionBlocked,
  maybeRunFindingCodexEscalation: mocks.maybeRunFindingCodexEscalation,
  markFindingCodexEscalationAccepted: mocks.markFindingCodexEscalationAccepted,
}));

vi.mock("../src/modules/findCandidate/domain.js", () => ({
  runFindCandidate: mocks.runFindCandidate,
}));

vi.mock("../src/modules/finalizeDistille/domain.js", () => ({
  runFinalizeDistille: mocks.runFinalizeDistille,
}));

vi.mock("../src/modules/landscape/merge-activation-finalize.worker.js", () => ({
  processMergeActivationFinalizeJob: mocks.processMergeActivationFinalizeJob,
}));

vi.mock("../src/modules/landscape/landscape-curation.service.js", () => ({
  processLandscapeCurationJob: mocks.processLandscapeCurationJob,
}));

vi.mock("../src/modules/landscape/landscape-curation-queue.repository.js", () => ({
  findLandscapeCurationJobLinkByQueueJob: mocks.findLandscapeCurationJobLinkByQueueJob,
  getLandscapeCurationJob: mocks.getLandscapeCurationJob,
  updateLandscapeCurationJob: mocks.updateLandscapeCurationJob,
  upsertLandscapeCurationJobLink: mocks.upsertLandscapeCurationJobLink,
}));

vi.mock("../src/modules/sources/web/source-research.service.js", () => ({
  researchWebSourceToMarkdown: mocks.researchWebSourceToMarkdown,
}));

vi.mock("../src/modules/queue/core/control.js", () => ({
  isQueuePaused: mocks.isQueuePaused,
  setQueuePaused: mocks.setQueuePaused,
}));

function selectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
  };
  return chain;
}

function insertChain(table: unknown) {
  const chain = {
    values: vi.fn((values: unknown) => {
      mocks.insertCalls.push({ table, values });
      return chain;
    }),
    onConflictDoUpdate: vi.fn(() => chain),
    onConflictDoNothing: vi.fn(() => chain),
    returning: vi.fn(async () => [{ id: "evidence-1" }]),
  };
  return chain;
}

function updateChain(table: unknown) {
  const chain = {
    set: vi.fn((values: Record<string, unknown>) => {
      mocks.updateCalls.push({ table, values });
      return chain;
    }),
    where: vi.fn(async () => []),
  };
  return chain;
}

describe("runQueueWorkerOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.heartbeatProviderLease.mockResolvedValue(undefined);
    mocks.releaseProviderLease.mockResolvedValue(undefined);
    mocks.selectRows = [];
    mocks.insertCalls = [];
    mocks.updateCalls = [];
    mocks.claimNextQueueJob.mockResolvedValue({ id: "cover-job-1" });
    mocks.isQueuePaused.mockResolvedValue(false);
    mocks.findLandscapeCurationJobLinkByQueueJob.mockResolvedValue(null);
    mocks.processMergeActivationFinalizeJob.mockResolvedValue(undefined);
    mocks.processLandscapeCurationJob.mockResolvedValue(undefined);
    mocks.setQueuePaused.mockResolvedValue({});
    mocks.isVibeMemorySelfIngestionBlocked.mockResolvedValue(false);
    mocks.maybeRunFindingCodexEscalation.mockResolvedValue({
      mode: "off",
      status: "skipped",
      reason: "disabled",
      candidates: [],
    });
    mocks.markFindingCodexEscalationAccepted.mockResolvedValue(undefined);
    mocks.db.select.mockImplementation(() => selectChain(mocks.selectRows.shift() ?? []));
    mocks.db.insert.mockImplementation((table: unknown) => insertChain(table));
    mocks.db.update.mockImplementation((table: unknown) => updateChain(table));
    mocks.db.execute.mockResolvedValue({ rows: [] });
  });

  test("completes covering insufficient results", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "insufficient",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "not_actionable",
      },
    });

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: coveringEvidenceQueue,
        values: expect.objectContaining({
          status: "completed",
          attemptCount: 1,
          lastOutcomeKind: "insufficient",
          lastError: "not_actionable",
        }),
      }),
    );
  });

  test("marks covering retryable failures as failed on max attempts", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 1,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "parse_failed",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "external_parse_failed",
      },
    });

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: coveringEvidenceQueue,
        values: expect.objectContaining({
          status: "failed",
          attemptCount: 2,
          lastOutcomeKind: "parse_failed",
          lastError: "external_parse_failed",
        }),
      }),
    );
  });

  test("schedules covering retryable failures with backoff before max attempts", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "provider_failed",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "provider temporarily unavailable",
      },
    });

    const before = Date.now();
    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(result.completedJobId).toBeUndefined();
    const update = mocks.updateCalls.find((call) => call.table === coveringEvidenceQueue);
    expect(update?.values).toEqual(
      expect.objectContaining({
        status: "pending",
        attemptCount: 1,
        lastOutcomeKind: "provider_failed",
        lastError: "provider temporarily unavailable",
      }),
    );
    expect(update?.values.nextRunAt).toBeInstanceOf(Date);
    expect((update?.values.nextRunAt as Date).getTime()).toBeGreaterThanOrEqual(before + 29_000);
  });

  test("passes metadata read ranges into covering evidence without source summary", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {
            sourceKind: "vibe_memory",
            sourceKey: "memory-1",
            sourceUri: "vibe_memory:memory-1",
          },
          type: "rule",
          findingJobId: "finding-job-1",
          sourceSummary: "Summarized source evidence from finding.",
          metadata: {
            sourceKind: "vibe_memory",
            sourceKey: "memory-1",
            sourceUri: "vibe_memory:memory-1",
            readRanges: [{ from: 120, toExclusive: 240 }],
          },
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "insufficient",
        stage: "final",
        candidate: null,
        references: [],
        duplicateRefs: [],
        toolEvents: [],
        reason: "not_actionable",
      },
    });

    await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(mocks.runCoverEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          targetKind: "vibe_memory",
          targetKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          origin: expect.objectContaining({
            readRanges: [{ from: 120, toExclusive: 240 }],
          }),
        }),
      }),
    );
  });

  test("preserves negative knowledge appliesTo through covering persistence and finalize enqueue", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Do not trust stale queue status alone",
          content:
            "Failure: Stale queue status was treated as current truth without checking recent events.",
          origin: {
            polarity: "negative",
            intentTags: ["failure_pattern"],
          },
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {
            sourceKind: "knowledge_candidate",
            sourceKey: "review:finding-1",
            sourceUri: "review:finding-1",
            appliesTo: {
              technologies: ["typescript"],
              changeTypes: ["diagnosis"],
              domains: ["queue"],
            },
          },
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "knowledge_candidate",
          sourceKey: "review:finding-1",
          sourceUri: "review:finding-1",
        },
      ],
    ];
    mocks.runCoverEvidence.mockResolvedValue({
      result: {
        status: "knowledge_ready",
        stage: "final",
        candidate: {
          type: "rule",
          title: "Do not trust stale queue status alone",
          body: "Failure: Stale queue status was treated as current truth.",
          importance: 80,
          confidence: 90,
          technologies: ["typescript"],
          changeTypes: ["diagnosis"],
          domains: ["queue"],
        },
        references: [
          {
            kind: "source",
            uri: "review:finding-1",
            note: "Stale queue status was treated as current truth",
            evidenceRole: "supports_candidate",
          },
        ],
        duplicateRefs: [],
        toolEvents: [
          {
            name: "negative_coverage",
            ok: true,
            metadata: {
              polarity: "negative",
              intentTags: ["failure_pattern", "guardrail"],
              appliesTo: {
                technologies: ["typescript"],
                changeTypes: ["diagnosis"],
                domains: ["queue"],
              },
            },
          },
        ],
        reason: null,
      },
    });

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.runCoverEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({
          targetKind: "knowledge_candidate",
          origin: expect.objectContaining({
            polarity: "negative",
            appliesTo: {
              technologies: ["typescript"],
              changeTypes: ["diagnosis"],
              domains: ["queue"],
            },
          }),
        }),
      }),
    );
    expect(mocks.insertCalls).toContainEqual(
      expect.objectContaining({
        table: evidenceCoverageResults,
        values: expect.objectContaining({
          foundCandidateId: "candidate-1",
          status: "knowledge_ready",
          appliesTo: {
            technologies: ["typescript"],
            changeTypes: ["diagnosis"],
            domains: ["queue"],
          },
          toolEvents: expect.arrayContaining([
            expect.objectContaining({
              name: "negative_coverage",
              metadata: expect.objectContaining({
                polarity: "negative",
                intentTags: ["failure_pattern", "guardrail"],
              }),
            }),
          ]),
        }),
      }),
    );
    expect(mocks.insertCalls).toContainEqual(
      expect.objectContaining({
        table: finalizeDistilleQueue,
        values: expect.objectContaining({
          evidenceResultId: "evidence-1",
          status: "pending",
          priority: 90,
          metadata: expect.objectContaining({
            sourceQueue: "coveringEvidence",
            sourceQueueJobId: "cover-job-1",
          }),
        }),
      }),
    );
  });

  test("does not enqueue missing vibe memory sources", async () => {
    mocks.selectRows = [[]];

    const result = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: "missing-memory",
      sourceUri: "vibe_memory:missing-memory",
    });

    expect(result).toBeNull();
    expect(mocks.insertCalls.map((call) => call.table)).not.toContain(findingCandidateQueue);
  });

  test("enqueues existing vibe memory sources", async () => {
    mocks.selectRows = [[{ id: "memory-1" }]];

    const result = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: "memory-1",
      sourceUri: "vibe_memory:memory-1",
    });

    expect(result).toEqual({ id: "evidence-1" });
    expect(mocks.insertCalls.map((call) => call.table)).toContain(findingCandidateQueue);
  });

  test("enqueues legacy agent log sync vibe memory chunk jobs", async () => {
    mocks.selectRows = [[{ id: "memory-1" }]];

    const result = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "vibe_memory",
      sourceKey: "memory-1",
      sourceUri: "vibe_memory:memory-1",
      metadata: {
        sourceType: "agent_log_sync",
        chunkIndex: 0,
      },
    });

    expect(result).toEqual({ id: "evidence-1" });
    expect(mocks.insertCalls.map((call) => call.table)).toContain(findingCandidateQueue);
  });

  test("returns idle when lane is paused", async () => {
    mocks.isQueuePaused.mockResolvedValue(true);

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.idle).toBe(true);
    expect(result.message).toContain("queue paused");
    expect(mocks.claimNextQueueJob).not.toHaveBeenCalled();
  });

  test("dispatches merge activation finalize jobs to the activation worker", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "merge-finalize-job-1" });
    mocks.processMergeActivationFinalizeJob.mockResolvedValue(undefined);

    const result = await runQueueWorkerOnce({
      queueName: "mergeActivationFinalize",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(result.completedJobId).toBe("merge-finalize-job-1");
    expect(mocks.processMergeActivationFinalizeJob).toHaveBeenCalledWith(
      "merge-finalize-job-1",
      expect.any(AbortSignal),
    );
  });

  test("automatically retries failed Curation jobs without requesting user action", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "curation-job-1" });
    mocks.processLandscapeCurationJob.mockRejectedValue(new Error("invalid LLM JSON"));
    mocks.getLandscapeCurationJob.mockResolvedValue({ attemptCount: 0, maxAttempts: 3 });

    const result = await runQueueWorkerOnce({
      queueName: "landscapeCuration",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("retry scheduled");
    expect(mocks.updateLandscapeCurationJob).toHaveBeenCalledWith(
      "curation-job-1",
      expect.objectContaining({
        status: "paused",
        attemptCount: 1,
        lockedBy: null,
        completedAt: null,
      }),
    );
    expect(mocks.appendQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "retried" }),
    );
  });

  test("automatically retries Finalize failures without requesting user action", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "merge-finalize-job-1" });
    mocks.processMergeActivationFinalizeJob.mockRejectedValue(new Error("canonical update failed"));
    mocks.selectRows = [[{ attemptCount: 0, maxAttempts: 2 }]];
    mocks.findLandscapeCurationJobLinkByQueueJob.mockResolvedValue({
      curationJobId: "curation-job-1",
      metadata: { autonomous: true },
    });

    const result = await runQueueWorkerOnce({
      queueName: "mergeActivationFinalize",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(false);
    expect(mocks.upsertLandscapeCurationJobLink).toHaveBeenCalledWith(
      expect.objectContaining({
        curationJobId: "curation-job-1",
        queueJobId: "merge-finalize-job-1",
        status: "paused",
      }),
    );
    expect(mocks.updateLandscapeCurationJob).toHaveBeenCalledWith(
      "curation-job-1",
      expect.objectContaining({
        status: "paused",
        lastOutcomeKind: "downstream_finalize_retrying",
      }),
    );
    expect(result.message).toContain("retry scheduled");
  });

  test("leaves a terminal unresolved Curation task after Finalize exhausts retries", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "merge-finalize-job-1" });
    mocks.processMergeActivationFinalizeJob.mockRejectedValue(new Error("canonical update failed"));
    mocks.selectRows = [[{ attemptCount: 1, maxAttempts: 2 }]];
    mocks.findLandscapeCurationJobLinkByQueueJob.mockResolvedValue({
      curationJobId: "curation-job-1",
      metadata: { autonomous: true },
    });

    await runQueueWorkerOnce({
      queueName: "mergeActivationFinalize",
      workerId: "worker-1",
    });

    expect(mocks.upsertLandscapeCurationJobLink).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(mocks.updateLandscapeCurationJob).toHaveBeenCalledWith(
      "curation-job-1",
      expect.objectContaining({
        status: "failed",
        lastOutcomeKind: "downstream_finalize_failed",
      }),
    );
  });

  test("keeps the queue lane running when the worker dependency is unavailable", async () => {
    mocks.selectRows = [
      [
        {
          id: "cover-job-1",
          foundCandidateId: "candidate-1",
          distillationVersion: "v-test",
          attemptCount: 0,
          maxAttempts: 2,
          priority: 50,
          providerPolicy: "default",
          payload: {},
        },
      ],
      [
        {
          id: "candidate-1",
          title: "Candidate title",
          content: "Candidate body",
          origin: {},
          type: "rule",
          findingJobId: "finding-job-1",
          metadata: {},
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "docs/example.md",
          sourceUri: "file:///docs/example.md",
        },
      ],
    ];
    mocks.runCoverEvidence.mockRejectedValue(
      new Error("Unable to connect. Is the computer able to access the url?"),
    );

    const result = await runQueueWorkerOnce({
      queueName: "coveringEvidence",
      workerId: "worker-1",
      providerLease: {
        id: "lease-worker-unavailable-1",
        poolId: "local-llm-default",
        targetId: "local-primary",
        queueName: "coveringEvidence",
        queueJobId: "cover-job-1",
        workerId: "worker-1",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("worker_unavailable");
    expect(mocks.setQueuePaused).not.toHaveBeenCalled();
    expect(mocks.db.execute).toHaveBeenCalled();
    expect(mocks.updateCalls).not.toContainEqual(
      expect.objectContaining({
        table: coveringEvidenceQueue,
        values: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mocks.appendQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "coveringEvidence",
        queueJobId: "cover-job-1",
        eventType: "retried",
        message: "job kept waiting because worker dependency is unavailable",
      }),
    );
    const workerUnavailableEvent = mocks.appendQueueEvent.mock.calls.find(
      (call) => call[0]?.eventType === "retried",
    )?.[0] as { metadata?: Record<string, unknown> } | undefined;
    expect(workerUnavailableEvent?.metadata ?? {}).not.toHaveProperty("resolvedProviderTarget");
  });

  test("keeps finding candidate jobs waiting when the worker dependency is unavailable", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          distillationVersion: "v-test",
          payload: {},
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockRejectedValue(
      new Error("Unable to connect. Is the computer able to access the url?"),
    );

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("worker_unavailable");
    expect(mocks.setQueuePaused).not.toHaveBeenCalled();
    expect(mocks.db.execute).toHaveBeenCalled();
    expect(mocks.updateCalls).not.toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mocks.appendQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "findingCandidate",
        queueJobId: "finding-job-1",
        eventType: "retried",
        message: "job kept waiting because worker dependency is unavailable",
      }),
    );
  });

  test("returns finding candidate jobs to the queue when LLM provider returns busy 503", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          distillationVersion: "v-test",
          payload: {},
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockRejectedValue(
      new LlmProviderHttpError({
        provider: "local-llm",
        status: 503,
        retryAfterSeconds: 30,
        message: "local-llm HTTP 503: llm_busy",
      }),
    );

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
      providerLease: {
        id: "lease-1",
        poolId: "local-llm-default",
        targetId: "local-primary",
        queueName: "findingCandidate",
        queueJobId: "finding-job-1",
        workerId: "worker-1",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("provider_unavailable_retry");
    expect(mocks.db.execute).toHaveBeenCalled();
    expect(mocks.updateCalls).not.toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({ status: "failed" }),
      }),
    );
    expect(mocks.appendQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "findingCandidate",
        queueJobId: "finding-job-1",
        eventType: "retried",
        message: "job returned to queue because LLM provider is temporarily unavailable",
        metadata: expect.objectContaining({
          retryAfterSeconds: 30,
          status: 503,
          resolvedProviderTarget: expect.objectContaining({
            providerPoolId: "local-llm-default",
            providerTargetId: "local-primary",
            provider: "local-llm",
            localLlmModelId: "local-primary",
          }),
        }),
      }),
    );
  });

  test("processes legacy agent log sync vibe memory chunk jobs through findCandidate", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-legacy" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-legacy",
          inputKind: "source_target",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          distillationVersion: "v-test",
          payload: {},
          metadata: {
            sourceType: "agent_log_sync",
            chunkIndex: 0,
          },
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockResolvedValue({
      targetStateId: null,
      targetKind: "vibe_memory",
      targetKey: "memory-1",
      callerMode: "cli_text",
      candidates: [],
      readRanges: [{ from: 0, toExclusive: 120 }],
    });

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.runFindCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInput: expect.objectContaining({
          targetKind: "vibe_memory",
          targetKey: "memory-1",
        }),
      }),
    );
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({
          status: "skipped",
          lastOutcomeKind: "no_candidate",
        }),
      }),
    );
    expect(mocks.appendQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "findingCandidate",
        queueJobId: "finding-job-legacy",
        eventType: "completed",
        message: "no candidate found",
      }),
    );
  });

  test("processes legacy agent log sync chunk jobs when legacy markers are in payload", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-legacy-payload" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-legacy-payload",
          inputKind: "source_target",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          distillationVersion: "v-test",
          payload: {
            sourceType: "agent_log_sync",
            chunkIndex: 1,
          },
          metadata: {},
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockResolvedValue({
      targetStateId: null,
      targetKind: "vibe_memory",
      targetKey: "memory-1",
      callerMode: "cli_text",
      candidates: [],
      readRanges: [],
    });

    await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(mocks.runFindCandidate).toHaveBeenCalled();
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({
          status: "skipped",
          lastOutcomeKind: "no_candidate",
        }),
      }),
    );
  });

  test("stores negative finding candidates with polarity for downstream covering", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "wiki_file",
          sourceKey: "docs/incident.md",
          sourceUri: "wiki_file:docs/incident.md",
          distillationVersion: "v-test",
          payload: {},
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockResolvedValue({
      targetStateId: null,
      targetKind: "wiki_file",
      targetKey: "docs/incident.md",
      callerMode: "cli_text",
      candidates: [
        {
          type: "rule",
          polarity: "negative",
          title: "Do not trust stale queue status alone",
          content:
            "Queue diagnosis must not treat an old status row as current truth without checking recent events.",
        },
      ],
      readRanges: [{ from: 0, toExclusive: 80 }],
    });

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.runFindCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceInput: expect.objectContaining({
          targetKind: "wiki_file",
          targetKey: "docs/incident.md",
        }),
      }),
    );
    expect(mocks.insertCalls).toContainEqual(
      expect.objectContaining({
        table: foundCandidates,
        values: expect.objectContaining({
          title: "Do not trust stale queue status alone",
          origin: expect.objectContaining({
            polarity: "negative",
            sourceKind: "wiki_file",
            sourceKey: "docs/incident.md",
          }),
          metadata: expect.objectContaining({
            polarity: "negative",
            readRanges: [{ from: 0, toExclusive: 80 }],
          }),
        }),
      }),
    );
  });

  test("findFindingJob returns found row or null", async () => {
    // 1. Found case
    mocks.selectRows = [[{ id: "finding-job-1", sourceKey: "key-1" }]];
    const found = await findFindingJob({
      inputKind: "source_target",
      sourceKind: "wiki_file",
      sourceKey: "key-1",
    });
    expect(found).toEqual({ id: "finding-job-1", sourceKey: "key-1" });

    // 2. Not found case
    mocks.selectRows = [[]];
    const notFound = await findFindingJob({
      inputKind: "source_target",
      sourceKind: "wiki_file",
      sourceKey: "key-1",
    });
    expect(notFound).toBeNull();
  });

  test("enqueueFindingJob with non-vibe-memory always inserts", async () => {
    mocks.selectRows = [];
    const result = await enqueueFindingJob({
      inputKind: "source_target",
      sourceKind: "wiki_file",
      sourceKey: "wiki-1",
      sourceUri: "wiki_file:wiki-1",
    });
    expect(result).toEqual({ id: "evidence-1" });
    expect(mocks.insertCalls.map((call) => call.table)).toContain(findingCandidateQueue);
  });

  test("runQueueWorkerOnce handles missing source error as skipped", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "wiki_file",
          sourceKey: "wiki-1",
          sourceUri: "wiki_file:wiki-1",
          distillationVersion: "v-test",
          payload: {},
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockRejectedValue(new Error("ENOENT: file not found"));

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(result.message).toContain("source missing skipped");
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({
          status: "skipped",
          lastOutcomeKind: "source_missing",
        }),
      }),
    );
  });

  test("runQueueWorkerOnce handles other finding candidate failures as failed", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "wiki_file",
          sourceKey: "wiki-1",
          sourceUri: "wiki_file:wiki-1",
          distillationVersion: "v-test",
          payload: {},
          priority: 50,
        },
      ],
      [
        {
          attemptCount: 0,
        },
      ],
    ];
    mocks.runFindCandidate.mockRejectedValue(new Error("some api error"));

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
      providerLease: {
        id: "lease-failed-1",
        poolId: "local-llm-default",
        targetId: "local-primary",
        queueName: "findingCandidate",
        queueJobId: "finding-job-1",
        workerId: "worker-1",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.message).toBe("some api error");
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({
          status: "failed",
          attemptCount: 1,
          lastOutcomeKind: "failed",
        }),
      }),
    );
    expect(mocks.appendQueueEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        queueName: "findingCandidate",
        queueJobId: "finding-job-1",
        eventType: "failed",
        metadata: expect.objectContaining({
          error: "some api error",
          resolvedProviderTarget: expect.objectContaining({
            providerPoolId: "local-llm-default",
            providerTargetId: "local-primary",
            provider: "local-llm",
            localLlmModelId: "local-primary",
          }),
        }),
      }),
    );
  });

  test("runQueueWorkerOnce writes Codex escalated candidates after covering enqueue succeeds", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          distillationVersion: "v-test",
          payload: {},
          metadata: {},
          priority: 50,
        },
      ],
    ];
    mocks.runFindCandidate.mockResolvedValue({
      targetStateId: null,
      targetKind: "vibe_memory",
      targetKey: "memory-1",
      callerMode: "cli_text",
      candidates: [],
      readRanges: [{ from: 0, toExclusive: 80 }],
      parseDiagnostics: {
        rawWasEmptyArray: true,
        rawCandidateLikeCount: 0,
        droppedMissingType: 0,
        droppedMissingPolarity: 0,
        droppedNeutral: 0,
        droppedNegativeProcedure: 0,
        droppedInvalidProcedureShape: 0,
        plainTextFallbackUsed: false,
      },
    });
    mocks.maybeRunFindingCodexEscalation.mockResolvedValue({
      mode: "write",
      status: "candidate_ready",
      reason: "primary_no_candidate",
      escalationId: "escalation-1",
      readRanges: [{ from: 0, toExclusive: 120 }],
      candidates: [
        {
          type: "rule",
          polarity: "negative",
          title: "Separate provider failure from missing source",
          content:
            "When a findingCandidate job fails, classify provider failures separately from source_missing before requeueing.",
        },
      ],
    });

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.insertCalls).toContainEqual(
      expect.objectContaining({
        table: foundCandidates,
        values: expect.objectContaining({
          title: "Separate provider failure from missing source",
          origin: expect.objectContaining({
            codexEscalation: true,
            escalationId: "escalation-1",
          }),
          metadata: expect.objectContaining({
            generatedBy: "contextStill.codexFindingEscalation",
            excludedFromVibeMemory: true,
            escalationId: "escalation-1",
          }),
        }),
      }),
    );
    expect(mocks.insertCalls.map((call) => call.table)).toContain(coveringEvidenceQueue);
    expect(mocks.markFindingCodexEscalationAccepted).toHaveBeenCalledWith("escalation-1", 1);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({
          status: "completed",
          lastOutcomeKind: "codex_escalated_candidates_found",
        }),
      }),
    );
  });

  test("runQueueWorkerOnce skips self-ingested vibe memories before primary finding", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finding-job-1" });
    mocks.isVibeMemorySelfIngestionBlocked.mockResolvedValue(true);
    mocks.selectRows = [
      [
        {
          id: "finding-job-1",
          inputKind: "source_target",
          sourceKind: "vibe_memory",
          sourceKey: "memory-1",
          sourceUri: "vibe_memory:memory-1",
          distillationVersion: "v-test",
          payload: {},
          metadata: {},
          priority: 50,
        },
      ],
    ];

    const result = await runQueueWorkerOnce({
      queueName: "findingCandidate",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.runFindCandidate).not.toHaveBeenCalled();
    expect(mocks.maybeRunFindingCodexEscalation).not.toHaveBeenCalled();
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        table: findingCandidateQueue,
        values: expect.objectContaining({
          status: "skipped",
          lastOutcomeKind: "self_ingestion_blocked",
        }),
      }),
    );
  });

  test("runs finalizeDistille queue job successfully", async () => {
    mocks.claimNextQueueJob.mockResolvedValue({ id: "finalize-job-1" });
    mocks.selectRows = [
      [
        {
          id: "finalize-job-1",
          evidenceResultId: "evidence-1",
          distillationVersion: "v-test",
          attemptCount: 0,
        },
      ],
      [
        {
          id: "evidence-1",
          foundCandidateId: "candidate-1",
          appliesTo: {},
          type: "rule",
          title: "rule title",
          body: "rule body",
          importance: 70,
          confidence: 70,
          references: [],
          duplicateRefs: [],
          toolEvents: [],
          reason: "reason",
        },
      ],
      [
        {
          id: "candidate-1",
          findingJobId: "finding-job-1",
          type: "rule",
        },
      ],
      [
        {
          id: "finding-job-1",
          sourceKind: "wiki_file",
          sourceKey: "wiki-1",
          sourceUri: "wiki_file:wiki-1",
        },
      ],
    ];

    mocks.runFinalizeDistille.mockResolvedValue({
      status: "stored",
      knowledgeId: "k-1",
      reason: null,
    });

    const result = await runQueueWorkerOnce({
      queueName: "finalizeDistille",
      workerId: "worker-1",
    });

    expect(result.ok).toBe(true);
    expect(mocks.runFinalizeDistille).toHaveBeenCalled();
  });
});
