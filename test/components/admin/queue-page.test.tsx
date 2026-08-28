/** @vitest-environment jsdom */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueuePage } from "../../../web/src/modules/admin/components/queue.page";
import * as adminRepository from "../../../web/src/modules/admin/repositories/admin.repository";

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", async () => {
  const actual = await vi.importActual(
    "../../../web/src/modules/admin/repositories/admin.repository",
  );
  return {
    ...actual,
    fetchQueueDashboardStatsV2: vi.fn(),
    fetchActiveQueueTasksV2: vi.fn(),
    fetchQueueItemsV2: vi.fn(),
    pauseQueueLaneV2: vi.fn(),
    pauseQueueJobV2: vi.fn(),
    resumeQueueLaneV2: vi.fn(),
    resumeQueueJobV2: vi.fn(),
    retryQueueJobV2: vi.fn(),
  };
});

function renderQueuePage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <QueuePage />
    </QueryClientProvider>,
  );
}

describe("QueuePage v2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));

    vi.mocked(adminRepository.fetchQueueDashboardStatsV2).mockResolvedValue({
      queueControls: {
        findingCandidate: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        episodeDistiller: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        coveringEvidence: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        deadZoneMergeReview: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        landscapeCuration: { paused: false, updatedAt: null, updatedBy: null, reason: null },
        finalizeDistille: { paused: false, updatedAt: null, updatedBy: null, reason: null },
      },
      queues: {
        findingCandidate: {
          counters: { pending: 1, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        episodeDistiller: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        coveringEvidence: {
          counters: { pending: 0, running: 1, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 1,
          failed: 0,
          offline: 0,
          nonRegistered: 2,
        },
        deadZoneMergeReview: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        landscapeCuration: {
          counters: { pending: 0, running: 0, completed: 0, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
        finalizeDistille: {
          counters: { pending: 0, running: 0, completed: 2, skipped: 0, failed: 0, paused: 0 },
          oldestPendingAt: null,
          running: 0,
          failed: 0,
          offline: 0,
          nonRegistered: 0,
        },
      },
      totals: {
        counters: { pending: 1, running: 1, completed: 2, skipped: 0, failed: 1, paused: 0 },
        oldestPendingAt: null,
        running: 1,
        failed: 1,
        offline: 1,
        nonRegistered: 2,
      },
    });

    vi.mocked(adminRepository.fetchActiveQueueTasksV2).mockResolvedValue([
      {
        queueName: "coveringEvidence",
        visibleQueueName: "coveringEvidence",
        backendKind: "covering_evidence_queue",
        id: "job-running",
        status: "running",
        priority: 50,
        attemptCount: 1,
        subjectTitle: "candidate A",
        subjectDetail: "detail",
        provider: "codex",
        model: "gpt-5.4-mini",
        lastError: null,
        lastOutcomeKind: null,
        lockedBy: "worker-1",
        lockedAt: "2026-05-25T11:59:25.000Z",
        heartbeatAt: "2026-05-25T11:59:30.000Z",
        createdAt: "2026-05-25T11:58:00.000Z",
        updatedAt: "2026-05-25T11:59:30.000Z",
        completedAt: null,
        nextRunAt: null,
        metadataSummary: null,
      },
    ]);

    vi.mocked(adminRepository.fetchQueueItemsV2).mockResolvedValue({
      queue: "findingCandidate",
      items: [
        {
          queueName: "findingCandidate",
          visibleQueueName: "findingCandidate",
          backendKind: "finding_candidate_queue",
          id: "job-1",
          status: "pending",
          priority: 50,
          attemptCount: 0,
          subjectTitle: "wiki/page.md",
          subjectDetail: "wiki_file | file:///wiki/page.md",
          provider: "azure-openai",
          model: "gpt-5.4-mini",
          lastError: null,
          lastOutcomeKind: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          createdAt: "2026-05-25T11:58:00.000Z",
          updatedAt: "2026-05-25T11:59:00.000Z",
          completedAt: null,
          nextRunAt: null,
          metadataSummary: "input=source_target",
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    vi.mocked(adminRepository.pauseQueueJobV2).mockResolvedValue({ ok: true });
    vi.mocked(adminRepository.pauseQueueLaneV2).mockResolvedValue({ ok: true });
    vi.mocked(adminRepository.resumeQueueLaneV2).mockResolvedValue({ ok: true });
    vi.mocked(adminRepository.resumeQueueJobV2).mockResolvedValue({ ok: true });
    vi.mocked(adminRepository.retryQueueJobV2).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("renders queue tabs and table rows", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("button", { name: "Finding" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Covering" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge Review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finalize" })).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Total")).toBeInTheDocument();
    expect(screen.getByText("wiki/page.md")).toBeInTheDocument();
  });

  it("shows schema-not-ready state without retrying the stats poll", async () => {
    vi.mocked(adminRepository.fetchQueueDashboardStatsV2).mockRejectedValue(
      new adminRepository.AdminApiError(
        "Queue schema is not ready. Run `bun run db:migrate` and restart the API.",
        503,
        "QUEUE_SCHEMA_NOT_READY",
      ),
    );

    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Queue Schema Not Ready")).toBeInTheDocument();
    expect(screen.getByText(/bun run db:migrate/)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(adminRepository.fetchQueueDashboardStatsV2).toHaveBeenCalledTimes(1);
  });

  it("identifies queue task model by provider", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByText("Codex SDK / gpt-5.4-mini")).toBeInTheDocument();
    const azureProviderLabel = screen.getByText("Azure OpenAI API /");
    expect(azureProviderLabel).toBeInTheDocument();
    expect(azureProviderLabel.parentElement).toHaveTextContent("gpt-5.4-mini");
  });

  it("switches queue tab and refetches list with selected queue", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Covering" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.fetchQueueItemsV2).toHaveBeenCalledWith(
      expect.objectContaining({ queue: "coveringEvidence" }),
    );
  });

  it("runs pause action with queue-aware endpoint call", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByTitle("Pause queue job"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.pauseQueueJobV2).toHaveBeenCalledWith("findingCandidate", "job-1");
  });

  it("keeps requeue disabled for already queued jobs", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const requeueButton = screen.getByTitle("Already queued");
    expect(requeueButton).toBeDisabled();

    fireEvent.click(requeueButton);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.retryQueueJobV2).not.toHaveBeenCalled();
  });

  it("requeues non-running jobs from the rightmost action button", async () => {
    vi.mocked(adminRepository.fetchQueueItemsV2).mockResolvedValue({
      queue: "findingCandidate",
      items: [
        {
          queueName: "findingCandidate",
          visibleQueueName: "findingCandidate",
          backendKind: "finding_candidate_queue",
          id: "job-failed",
          status: "failed",
          priority: 20,
          attemptCount: 2,
          subjectTitle: "failed source",
          subjectDetail: "wiki_file | file:///wiki/failed.md",
          provider: "azure-openai",
          model: "gpt-5.4-mini",
          lastError: "previous failure",
          lastOutcomeKind: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          createdAt: "2026-05-25T11:00:00.000Z",
          updatedAt: "2026-05-25T11:30:00.000Z",
          completedAt: null,
          nextRunAt: null,
          metadataSummary: "input=source_target",
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });

    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByTitle("Requeue job"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.retryQueueJobV2).toHaveBeenCalledWith({
      queue: "findingCandidate",
      id: "job-failed",
      mode: "default",
      forceRefreshEvidence: true,
      reason: "requeued from queue dashboard",
    });
  });

  it("shows LLM status labels (Ready/Active/Offline) and does not show 待機中 label", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const queueLanes = screen.getByLabelText("Queue lanes");
    expect(screen.getByRole("button", { name: "Finding" })).toBeInTheDocument();
    expect(queueLanes).toHaveTextContent("Ready");
    expect(queueLanes).toHaveTextContent("Active");
    expect(queueLanes).toHaveTextContent("非登録");
    expect(queueLanes).toHaveTextContent("2");
    expect(queueLanes.firstElementChild).toHaveClass("grid-cols-5");
    expect(screen.queryByRole("button", { name: "Premium" })).not.toBeInTheDocument();
    expect(screen.getAllByText("非登録")).toHaveLength(1);
    expect(screen.queryByText("待機中")).not.toBeInTheDocument();
  });

  it("calls lane pause endpoint from queue card control", async () => {
    renderQueuePage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getAllByRole("button", { name: "一時停止" })[0]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(adminRepository.pauseQueueLaneV2).toHaveBeenCalledWith("findingCandidate");
  });
});
