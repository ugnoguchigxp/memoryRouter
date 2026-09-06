import type {
  GraphCommunityDisplayMode,
  GraphCommunityLabel,
  GraphNodeDetail,
  GraphRelationAxis,
  GraphSnapshot,
  GraphStatusFilter,
  GraphViewMode,
} from "./graph-contracts";
import { getJson, requestJson } from "./http";
import type {
  DeadZoneKnowledgeMaintenanceAction,
  DeadZoneKnowledgeMaintenanceResult,
  DeadZoneKnowledgeReviewActionResult,
  DeadZoneKnowledgeReviewBadge,
  DeadZoneKnowledgeReviewReason,
  DeadZoneKnowledgeReviewResponse,
  DeadZoneKnowledgeReviewSortBy,
  DeadZoneMergeReviewJob,
  DeadZoneRecommendationAction,
  LandscapeReplayComparisonResponse,
  LandscapeReplaySnapshot,
  LandscapeRunStatusFilter,
  LandscapeSnapshot,
  LandscapeSnapshotCacheStatus,
} from "./landscape-contracts";
import type {
  LandscapeContradictionOverlayList,
  LandscapeCurationJob,
  LandscapeCurationJobListResponse,
  LandscapeReviewCandidateCreateInput,
  LandscapeReviewCandidateCreateResult,
  LandscapeReviewCandidateLinkUpdateInput,
  LandscapeReviewCandidateLinkUpdateResult,
  LandscapeReviewItem,
  LandscapeReviewItemsListQuery,
  LandscapeReviewItemsListResponse,
  LandscapeReviewItemsMaterializeInput,
  LandscapeReviewItemsMaterializeResult,
  LandscapeReviewItemStatus,
  LandscapeTrajectoryResult,
} from "./landscape-review-contracts";

export async function fetchGraphSnapshot(
  input:
    | number
    | {
        limit?: number;
        status?: GraphStatusFilter;
        view?: GraphViewMode;
        communityDisplay?: GraphCommunityDisplayMode;
        relationAxes?: GraphRelationAxis[];
        minSimilarity?: number;
        semanticTopK?: number;
        maxContextEdgesPerNode?: number;
        sourceNodeLimit?: number;
      } = 1000,
): Promise<GraphSnapshot> {
  const params = new URLSearchParams();
  if (typeof input === "number") {
    params.set("limit", String(input));
  } else {
    params.set("limit", String(input.limit ?? 1000));
    if (input.status) params.set("status", input.status);
    if (input.view) params.set("view", input.view);
    if (input.communityDisplay) params.set("communityDisplay", input.communityDisplay);
    if (input.relationAxes && input.relationAxes.length > 0) {
      params.set("relationAxes", input.relationAxes.join(","));
    }
    if (input.minSimilarity !== undefined) {
      params.set("minSimilarity", String(input.minSimilarity));
    }
    if (input.semanticTopK !== undefined) {
      params.set("semanticTopK", String(input.semanticTopK));
    }
    if (input.maxContextEdgesPerNode !== undefined) {
      params.set("maxContextEdgesPerNode", String(input.maxContextEdgesPerNode));
    }
    if (input.sourceNodeLimit !== undefined) {
      params.set("sourceNodeLimit", String(input.sourceNodeLimit));
    }
  }
  return getJson<GraphSnapshot>(`/api/graph?${params}`);
}

export async function fetchLandscapeSnapshot(input?: {
  windowDays?: number;
  limit?: number;
  status?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
  minSelectedCount?: number;
  minFeedbackCount?: number;
}): Promise<LandscapeSnapshot> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 1000));
  params.set("status", input?.status ?? "active");
  params.set("format", "full");
  if (input?.relationAxes?.length) {
    params.set("relationAxes", input.relationAxes.join(","));
  } else {
    params.set("relationAxes", "session,project,source");
  }
  if (input?.minSelectedCount !== undefined) {
    params.set("minSelectedCount", String(input.minSelectedCount));
  }
  if (input?.minFeedbackCount !== undefined) {
    params.set("minFeedbackCount", String(input.minFeedbackCount));
  }
  return getJson<LandscapeSnapshot>(`/api/graph/landscape?${params.toString()}`);
}

export async function fetchLandscapeSnapshotCacheStatus(): Promise<LandscapeSnapshotCacheStatus> {
  return getJson<LandscapeSnapshotCacheStatus>("/api/graph/landscape/cache-status");
}

export async function fetchUnresolvedLandscapeCurationJobs(): Promise<LandscapeCurationJob[]> {
  const response = await getJson<LandscapeCurationJobListResponse>(
    "/api/graph/landscape/curation-jobs?status=unresolved&findingType=all&limit=100",
  );
  return response.items;
}

export async function fetchDeadZoneKnowledgeReview(input?: {
  windowDays?: number;
  limit?: number;
  page?: number;
  status?: GraphStatusFilter;
  reason?: DeadZoneKnowledgeReviewReason;
  minSimilarity?: number;
  similarTopK?: number;
  relationAxes?: GraphRelationAxis[];
  communityKey?: string;
  badge?: DeadZoneKnowledgeReviewBadge | "all";
  sortBy?: DeadZoneKnowledgeReviewSortBy;
  sortDir?: "asc" | "desc";
}): Promise<DeadZoneKnowledgeReviewResponse> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 50));
  params.set("page", String(input?.page ?? 1));
  params.set("status", input?.status ?? "active");
  params.set("reason", input?.reason ?? "all");
  params.set("minSimilarity", String(input?.minSimilarity ?? 0.9));
  params.set("similarTopK", String(input?.similarTopK ?? 5));
  params.set("badge", input?.badge ?? "all");
  params.set("sortBy", input?.sortBy ?? "deadZoneScore");
  params.set("sortDir", input?.sortDir ?? "desc");
  if (input?.relationAxes?.length) {
    params.set("relationAxes", input.relationAxes.join(","));
  } else {
    params.set("relationAxes", "session,project,source");
  }
  if (input?.communityKey) params.set("communityKey", input.communityKey);
  return getJson<DeadZoneKnowledgeReviewResponse>(
    `/api/graph/landscape/dead-zone-knowledge?${params.toString()}`,
  );
}

export async function maintainDeadZoneKnowledge(input: {
  action: DeadZoneKnowledgeMaintenanceAction;
  deadZoneKnowledgeId: string;
  similarKnowledgeId?: string;
}): Promise<DeadZoneKnowledgeMaintenanceResult> {
  return requestJson<DeadZoneKnowledgeMaintenanceResult>(
    "/api/graph/landscape/dead-zone-knowledge/maintenance",
    "POST",
    input,
  );
}

export async function applyDeadZoneKnowledgeReviewAction(input: {
  action: DeadZoneRecommendationAction;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId?: string;
  reviewItemId?: string;
  note?: string;
}): Promise<DeadZoneKnowledgeReviewActionResult> {
  return requestJson<DeadZoneKnowledgeReviewActionResult>(
    "/api/graph/landscape/dead-zone-knowledge/actions",
    "POST",
    input,
  );
}

export async function requestDeadZoneMergeReviewJob(input: {
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId?: string;
  note?: string;
}): Promise<DeadZoneMergeReviewJob> {
  return requestJson<DeadZoneMergeReviewJob>(
    "/api/graph/landscape/dead-zone-knowledge/merge-review-jobs",
    "POST",
    input,
  );
}

export async function applyDeadZoneMergeReviewJob(jobId: string): Promise<{
  status: "applied";
  jobId: string;
  keptKnowledgeId: string;
  deprecatedKnowledgeId: string;
  reviewItemId: string | null;
}> {
  return requestJson(
    `/api/graph/landscape/dead-zone-knowledge/merge-review-jobs/${jobId}/apply`,
    "POST",
  );
}

export async function sendDeadZoneMergeReviewToFinalize(jobId: string): Promise<{
  id: string;
  status: string;
  jobType: "merge_activation_finalize";
  mergeReviewJobId: string;
  deadZoneKnowledgeId: string;
  canonicalKnowledgeId: string;
  reviewItemId: string | null;
}> {
  return requestJson(
    `/api/graph/landscape/dead-zone-knowledge/merge-review-jobs/${jobId}/finalize`,
    "POST",
  );
}

export async function fetchLandscapeReplaySnapshot(input?: {
  windowDays?: number;
  limit?: number;
  landscapeLimit?: number;
  runStatus?: LandscapeRunStatusFilter;
  landscapeStatus?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
  minSelectedCount?: number;
  minFeedbackCount?: number;
  minSimilarity?: number;
  semanticTopK?: number;
  includeRuns?: boolean;
}): Promise<LandscapeReplaySnapshot> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 500));
  params.set("landscapeLimit", String(input?.landscapeLimit ?? 1000));
  params.set("runStatus", input?.runStatus ?? "all");
  params.set("landscapeStatus", input?.landscapeStatus ?? "active");
  params.set("format", "full");
  params.set("includeRuns", String(input?.includeRuns ?? false));
  if (input?.relationAxes?.length) {
    params.set("relationAxes", input.relationAxes.join(","));
  } else {
    params.set("relationAxes", "session,project,source");
  }
  if (input?.minSelectedCount !== undefined) {
    params.set("minSelectedCount", String(input.minSelectedCount));
  }
  if (input?.minFeedbackCount !== undefined) {
    params.set("minFeedbackCount", String(input.minFeedbackCount));
  }
  if (input?.minSimilarity !== undefined) {
    params.set("minSimilarity", String(input.minSimilarity));
  }
  if (input?.semanticTopK !== undefined) {
    params.set("semanticTopK", String(input.semanticTopK));
  }
  return getJson<LandscapeReplaySnapshot>(`/api/graph/landscape/replay?${params.toString()}`);
}

export async function fetchLandscapeReplayComparison(input?: {
  windowDays?: number;
  limit?: number;
  runStatus?: LandscapeRunStatusFilter;
  currentLimit?: number;
  includeRuns?: boolean;
}): Promise<LandscapeReplayComparisonResponse> {
  const params = new URLSearchParams();
  params.set("windowDays", String(input?.windowDays ?? 30));
  params.set("limit", String(input?.limit ?? 100));
  params.set("runStatus", input?.runStatus ?? "all");
  params.set("currentLimit", String(input?.currentLimit ?? 12));
  params.set("includeRuns", String(input?.includeRuns ?? true));
  params.set("format", "full");
  return getJson<LandscapeReplayComparisonResponse>(
    `/api/graph/landscape/replay/compare?${params.toString()}`,
  );
}

export async function fetchLandscapeTrajectory(input: {
  runId: string;
  includeCandidates?: boolean;
  limit?: number;
}): Promise<LandscapeTrajectoryResult | null> {
  const params = new URLSearchParams();
  params.set("includeCandidates", String(input.includeCandidates ?? true));
  params.set("limit", String(input.limit ?? 200));
  try {
    return await getJson<LandscapeTrajectoryResult>(
      `/api/graph/landscape/trajectory/${encodeURIComponent(input.runId)}?${params.toString()}`,
    );
  } catch {
    return null;
  }
}

export async function materializeLandscapeReviewItems(
  input: LandscapeReviewItemsMaterializeInput,
): Promise<LandscapeReviewItemsMaterializeResult> {
  const json = await requestJson<{ result: LandscapeReviewItemsMaterializeResult }>(
    "/api/graph/landscape/replay/queue",
    "POST",
    input,
  );
  return json.result;
}

export async function fetchLandscapeReviewItems(
  input?: LandscapeReviewItemsListQuery,
): Promise<LandscapeReviewItemsListResponse> {
  const params = new URLSearchParams();
  params.set("status", input?.status ?? "pending");
  params.set("source", input?.source ?? "all");
  params.set("reason", input?.reason ?? "all");
  params.set("proposedAction", input?.proposedAction ?? "all");
  params.set("priorityMin", String(input?.priorityMin ?? 0));
  params.set("limit", String(input?.limit ?? 50));
  if (input?.knowledgeId) params.set("knowledgeId", input.knowledgeId);
  if (input?.runId) params.set("runId", input.runId);
  if (input?.communityKey) params.set("communityKey", input.communityKey);
  return getJson<LandscapeReviewItemsListResponse>(
    `/api/graph/landscape/review-items?${params.toString()}`,
  );
}

export async function fetchLandscapeContradictionOverlay(input?: {
  status?: LandscapeReviewItemStatus | "all";
  confidenceMin?: number;
  limit?: number;
}): Promise<LandscapeContradictionOverlayList> {
  const params = new URLSearchParams();
  params.set("status", input?.status ?? "pending");
  params.set("confidenceMin", String(input?.confidenceMin ?? 0.62));
  params.set("limit", String(input?.limit ?? 80));
  return getJson<LandscapeContradictionOverlayList>(
    `/api/graph/landscape/contradictions?${params.toString()}`,
  );
}

export async function updateLandscapeReviewItemStatus(
  id: string,
  input: { status: LandscapeReviewItemStatus; note?: string },
): Promise<LandscapeReviewItem> {
  const json = await requestJson<{ item: LandscapeReviewItem }>(
    `/api/graph/landscape/review-items/${encodeURIComponent(id)}`,
    "PATCH",
    input,
  );
  return json.item;
}

export async function createLandscapeReviewCandidates(
  input: LandscapeReviewCandidateCreateInput,
): Promise<LandscapeReviewCandidateCreateResult> {
  const json = await requestJson<{ result: LandscapeReviewCandidateCreateResult }>(
    "/api/graph/landscape/review-items/candidates",
    "POST",
    input,
  );
  return json.result;
}

export async function updateLandscapeReviewCandidateLink(
  reviewItemId: string,
  linkId: string,
  input: LandscapeReviewCandidateLinkUpdateInput,
): Promise<LandscapeReviewCandidateLinkUpdateResult> {
  return requestJson<LandscapeReviewCandidateLinkUpdateResult>(
    `/api/graph/landscape/review-items/${encodeURIComponent(reviewItemId)}/candidate-links/${encodeURIComponent(linkId)}`,
    "PATCH",
    input,
  );
}

export async function fetchGraphCommunityLabels(input?: {
  limit?: number;
  status?: GraphStatusFilter;
  relationAxes?: GraphRelationAxis[];
}): Promise<GraphCommunityLabel[]> {
  const params = new URLSearchParams();
  if (input?.limit !== undefined) params.set("limit", String(input.limit));
  if (input?.status) params.set("status", input.status);
  if (input?.relationAxes?.length) params.set("relationAxes", input.relationAxes.join(","));
  const query = params.toString();
  const path = query ? `/api/graph/community-labels?${query}` : "/api/graph/community-labels";
  const json = await getJson<{ labels: GraphCommunityLabel[] }>(path);
  return json.labels;
}

export async function updateGraphCommunityLabel(input: {
  communityKey: string;
  label: string;
  note?: string;
}): Promise<{
  communityKey: string;
  label: string;
  note: string | null;
  updatedAt: string;
}> {
  const payload = {
    label: input.label,
    note: input.note ?? "",
  };
  const json = await requestJson<{
    label: {
      communityKey: string;
      label: string;
      note: string | null;
      updatedAt: string;
    };
  }>(`/api/graph/community-labels/${encodeURIComponent(input.communityKey)}`, "PUT", payload);
  return json.label;
}

export async function fetchGraphNodeDetail(rawId: string): Promise<GraphNodeDetail | null> {
  try {
    return await getJson<GraphNodeDetail>(`/api/graph/nodes/${encodeURIComponent(rawId)}`);
  } catch {
    return null;
  }
}
