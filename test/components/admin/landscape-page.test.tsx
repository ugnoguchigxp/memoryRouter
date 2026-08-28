import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LandscapePage } from "../../../web/src/modules/admin/components/landscape.page";
import {
  type DeadZoneKnowledgeReviewResponse,
  applyDeadZoneKnowledgeReviewAction,
  fetchDeadZoneKnowledgeReview,
  fetchUnresolvedLandscapeCurationJobs,
  requestDeadZoneMergeReviewJob,
} from "../../../web/src/modules/admin/repositories/admin.repository";

const deadZoneReview: DeadZoneKnowledgeReviewResponse = {
  generatedAt: "2026-05-24T00:00:00.000Z",
  windowDays: 30,
  minSimilarity: 0.9,
  similarTopK: 5,
  communityCount: 2,
  itemCount: 2,
  unavailableReason: null,
  items: [
    {
      knowledge: {
        id: "k-dead-high",
        title: "High Score DeadZone",
        bodyPreview: "Use when high score deadzone review is needed.",
        type: "procedure",
        status: "active",
        appliesTo: { domains: ["landscape"] },
        confidence: 80,
        importance: 75,
        compileSelectCount: 0,
        lastCompiledAt: null,
        sourceRefCount: 0,
        sourceRefDensity: 0,
        communityKey: "a".repeat(64),
        communityLabel: "DeadZone A",
      },
      classification: {
        primary: "dead_zone_reachability_risk",
        confidence: "high",
        reason: "unused and unreachable",
      },
      indicators: {
        deadZoneScore: 88,
        evidenceStrength: "none",
        usageStrength: "none",
        structureQuality: "partial",
        graphHealth: "thin",
        badges: ["Strong merge candidate", "Evidence thin"],
      },
      bestCanonicalCandidate: {
        id: "k-active",
        title: "Active Canonical",
        status: "active",
        similarity: 0.94,
        applicabilityMatch: "high",
        evidenceStrength: "strong",
        usageStrength: "moderate",
        suggestedAction: "merge_into_similar",
        reasons: ["similarity 94%"],
      },
      alternativeCandidates: [],
      recommendation: {
        action: "merge_deadzone_into_canonical",
        confidence: "high",
        reasons: ["similarity 94%", "canonical candidate has stronger signals"],
        blockers: [],
      },
      allowedActions: [
        "merge_deadzone_into_canonical",
        "keep_separate",
        "needs_evidence",
        "deprecate_deadzone",
      ],
      similarKnowledge: [
        {
          id: "k-active",
          title: "Active Canonical",
          status: "active",
          similarity: 0.94,
          applicabilityMatch: "high",
          evidenceStrength: "strong",
          usageStrength: "moderate",
          suggestedAction: "merge_into_similar",
          reasons: ["similarity 94%"],
        },
      ],
      reviewItemId: null,
    },
    {
      knowledge: {
        id: "k-dead-low",
        title: "Lower Score DeadZone",
        bodyPreview: "Use when lower score deadzone review is needed.",
        type: "rule",
        status: "active",
        appliesTo: {},
        confidence: 70,
        importance: 65,
        compileSelectCount: 1,
        lastCompiledAt: "2026-05-20T00:00:00.000Z",
        sourceRefCount: 1,
        sourceRefDensity: 0.5,
        communityKey: "b".repeat(64),
        communityLabel: "DeadZone B",
      },
      classification: {
        primary: "dead_zone_stale",
        confidence: "medium",
        reason: "stale",
      },
      indicators: {
        deadZoneScore: 48,
        evidenceStrength: "moderate",
        usageStrength: "moderate",
        structureQuality: "strong",
        graphHealth: "connected",
        badges: ["Niche but valid"],
      },
      bestCanonicalCandidate: null,
      alternativeCandidates: [],
      recommendation: {
        action: "keep_separate",
        confidence: "medium",
        reasons: ["Niche but valid"],
        blockers: [],
      },
      allowedActions: ["keep_separate", "needs_evidence"],
      similarKnowledge: [],
      reviewItemId: null,
    },
  ],
};

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", () => ({
  fetchDeadZoneKnowledgeReview: vi.fn(),
  fetchUnresolvedLandscapeCurationJobs: vi.fn(),
  applyDeadZoneKnowledgeReviewAction: vi.fn(),
  requestDeadZoneMergeReviewJob: vi.fn(),
  applyDeadZoneMergeReviewJob: vi.fn(),
}));

function renderLandscapePage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LandscapePage />
    </QueryClientProvider>,
  );
}

describe("LandscapePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "confirm", {
      configurable: true,
      value: vi.fn(() => true),
    });
    vi.mocked(fetchDeadZoneKnowledgeReview).mockResolvedValue(deadZoneReview);
    vi.mocked(fetchUnresolvedLandscapeCurationJobs).mockResolvedValue([]);
    vi.mocked(applyDeadZoneKnowledgeReviewAction).mockResolvedValue({
      action: "deprecate_deadzone",
      status: "applied",
      message: 'Deprecated DeadZone "High Score DeadZone".',
      deprecatedKnowledgeId: "k-dead-high",
    });
    vi.mocked(requestDeadZoneMergeReviewJob).mockResolvedValue({
      id: "merge-job-1",
      status: "pending",
      deadZoneKnowledgeId: "k-dead-high",
      canonicalKnowledgeId: "k-active",
      reviewItemId: null,
      provider: "local-llm",
      model: "gemma-4-e4b-it",
      lastError: null,
      lastOutcomeKind: null,
      result: null,
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
      completedAt: null,
    });
  });

  it("renders the DeadZone score queue without loading the Graph canvas", async () => {
    renderLandscapePage();

    expect(await screen.findByText("Landscape")).toBeInTheDocument();
    expect(await screen.findByText("High Score DeadZone")).toBeInTheDocument();
    expect(screen.getByText("Active Canonical")).toBeInTheDocument();
    expect(screen.getByText("score 88")).toBeInTheDocument();
    expect(screen.queryByText("DeadZone Items")).not.toBeInTheDocument();
    expect(screen.queryByText("Merge Candidates")).not.toBeInTheDocument();
    expect(screen.queryByText("Knowledge Graph")).not.toBeInTheDocument();

    expect(fetchDeadZoneKnowledgeReview).toHaveBeenCalledWith({
      windowDays: 30,
      limit: 50,
      page: 1,
      status: "active",
      reason: "all",
      minSimilarity: 0.9,
      similarTopK: 5,
      relationAxes: ["session", "project", "source"],
      badge: "all",
      sortBy: "deadZoneScore",
      sortDir: "desc",
    });
  });

  it("shows unresolved autonomous curation jobs without asking for user approval", async () => {
    vi.mocked(fetchUnresolvedLandscapeCurationJobs).mockResolvedValue([
      {
        id: "curation-1",
        reviewItemId: "review-1",
        findingType: "duplicate_candidate",
        subjectKnowledgeId: "knowledge-1",
        candidateKnowledgeIds: ["knowledge-2"],
        status: "failed",
        phase: "llm_review",
        decision: null,
        disposition: null,
        priority: 70,
        lastError: "provider unavailable",
        lastOutcomeKind: "failed",
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      },
    ]);

    renderLandscapePage();

    expect(await screen.findByText("duplicate candidate")).toBeInTheDocument();
    expect(screen.getByText(/provider unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  });

  it("updates the queue filters", async () => {
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    const selects = screen.getAllByRole("combobox");
    fireEvent.change(selects[0], { target: { value: "dead_zone_reachability_risk" } });

    await waitFor(() => {
      expect(fetchDeadZoneKnowledgeReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          reason: "dead_zone_reachability_risk",
        }),
      );
    });
  });

  it("updates the queue sort through the API query", async () => {
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    fireEvent.click(screen.getByRole("button", { name: /Knowledge/i }));

    await waitFor(() => {
      expect(fetchDeadZoneKnowledgeReview).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sortBy: "title",
          sortDir: "asc",
          page: 1,
        }),
      );
    });
  });

  it("runs DeadZone review actions from decision buttons", async () => {
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    fireEvent.click(
      screen.getByRole("button", { name: "Deprecate DeadZone for High Score DeadZone" }),
    );

    await waitFor(() => {
      expect(applyDeadZoneKnowledgeReviewAction).toHaveBeenCalledWith({
        action: "deprecate_deadzone",
        deadZoneKnowledgeId: "k-dead-high",
        reviewItemId: undefined,
      });
    });
  });

  it("shows a visible result after queueing DeadZone merge review", async () => {
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    fireEvent.click(
      screen.getByRole("button", { name: "Request merge review for High Score DeadZone" }),
    );

    await waitFor(() => {
      expect(requestDeadZoneMergeReviewJob).toHaveBeenCalledWith({
        deadZoneKnowledgeId: "k-dead-high",
        canonicalKnowledgeId: "k-active",
        reviewItemId: undefined,
      });
    });
    expect(await screen.findByText("Merge review queued.")).toBeInTheDocument();
  });

  it("blocks queue controls while a merge review request is pending", async () => {
    vi.mocked(requestDeadZoneMergeReviewJob).mockReturnValue(new Promise(() => undefined));
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    fireEvent.click(
      screen.getByRole("button", { name: "Request merge review for High Score DeadZone" }),
    );

    expect(await screen.findByText("Queueing merge review...")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: /Knowledge/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh DeadZone Queue" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Request merge review for High Score DeadZone" }),
    ).toBeDisabled();
  });

  it("does not render directional merge or deprecate-similar controls", async () => {
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    expect(screen.getByText("Best Candidate")).toBeInTheDocument();
    expect(screen.getByText("Recommendation")).toBeInTheDocument();
    expect(screen.queryByText("Into similar")).not.toBeInTheDocument();
    expect(screen.queryByText("Into DeadZone")).not.toBeInTheDocument();
    expect(screen.queryByText("Deprecate similar")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Keep separate for High Score DeadZone" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Needs evidence for High Score DeadZone" }),
    ).toBeInTheDocument();
  });

  it("uses pagination controls instead of show more", async () => {
    renderLandscapePage();

    await screen.findByText("High Score DeadZone");
    expect(screen.getByText("Showing 1 to 2 of 2 items | Page 1 / 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show More/i })).not.toBeInTheDocument();
  });
});
