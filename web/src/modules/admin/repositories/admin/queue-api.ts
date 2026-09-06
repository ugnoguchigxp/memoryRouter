import { getJson, requestJson } from "./http";

export type DistillationTargetState = {
  id: string;
  targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  targetKey: string;
  sourceUri: string;
  distillationVersion: string;
  status: "pending" | "running" | "completed" | "skipped" | "failed" | "paused";
  phase:
    | "selected"
    | "reading"
    | "researching_source"
    | "writing_source"
    | "finding_candidate"
    | "covering_evidence"
    | "finalizing"
    | "stored";
  priorityGroup: string;
  sortKey: string;
  attemptCount: number;
  lockedBy: string | null;
  activeModel?: string | null;
  activeProvider?: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  lastOutcomeKind: string | null;
  candidateCount: number;
  knowledgeIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DistillationQueueName =
  | "findingCandidate"
  | "episodeDistiller"
  | "coveringEvidence"
  | "deadZoneMergeReview"
  | "landscapeCuration"
  | "finalizeDistille"
  | "mergeActivationFinalize";

export type VisibleDistillationQueueName = Exclude<
  DistillationQueueName,
  "mergeActivationFinalize"
>;

export type DistillationQueueStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "paused";

export type QueueDashboardStatsV2 = {
  queueControls: Record<
    VisibleDistillationQueueName,
    {
      paused: boolean;
      updatedAt: string | null;
      updatedBy: string | null;
      reason: string | null;
    }
  >;
  queues: Record<
    VisibleDistillationQueueName,
    {
      counters: Record<DistillationQueueStatus, number>;
      oldestPendingAt: string | null;
      running: number;
      failed: number;
      offline: number;
      nonRegistered: number;
    }
  >;
  totals: {
    counters: Record<DistillationQueueStatus, number>;
    oldestPendingAt: string | null;
    running: number;
    failed: number;
    offline: number;
    nonRegistered: number;
  };
};

export type QueueListItemV2 = {
  queueName: DistillationQueueName;
  visibleQueueName: DistillationQueueName;
  jobType?: "candidate_finalize" | "merge_activation_finalize";
  backendKind:
    | "finding_candidate_queue"
    | "episode_distiller_queue"
    | "covering_evidence_queue"
    | "dead_zone_merge_review_queue"
    | "finalize_distille_queue"
    | "merge_activation_finalize_queue";
  id: string;
  status: DistillationQueueStatus;
  priority: number;
  attemptCount: number;
  subjectTitle: string;
  subjectDetail: string;
  provider: string | null;
  model: string | null;
  activeProviderPoolId?: string | null;
  activeProviderTargetId?: string | null;
  lastError: string | null;
  lastOutcomeKind: string | null;
  lockedBy: string | null;
  lockedAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  nextRunAt: string | null;
  metadataSummary: string | null;
};

export type QueueListResponseV2 = {
  queue: DistillationQueueName;
  items: QueueListItemV2[];
  total: number;
  page: number;
  limit: number;
};

export async function fetchQueueDashboardStatsV2(): Promise<QueueDashboardStatsV2> {
  return getJson<QueueDashboardStatsV2>("/api/queue/stats");
}

export async function fetchActiveQueueTasksV2(): Promise<QueueListItemV2[]> {
  return getJson<QueueListItemV2[]>("/api/queue/active");
}

export async function fetchQueueItemsV2(input: {
  page: number;
  limit: number;
  queue: DistillationQueueName;
  query?: string;
  status?: DistillationQueueStatus | "all";
  sortBy?: string;
  sortDir?: "asc" | "desc";
}): Promise<QueueListResponseV2> {
  const query = new URLSearchParams();
  query.set("page", String(input.page));
  query.set("limit", String(input.limit));
  query.set("queue", input.queue);
  if (input.query?.trim()) query.set("query", input.query.trim());
  if (input.status) query.set("status", input.status);
  if (input.sortBy) query.set("sortBy", input.sortBy);
  if (input.sortDir) query.set("sortDir", input.sortDir);
  return getJson<QueueListResponseV2>(`/api/queue?${query.toString()}`);
}

export async function pauseQueueJobV2(
  queue: DistillationQueueName,
  id: string,
  reason?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/queue/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/pause`,
    "POST",
    {
      reason,
    },
  );
}

export async function pauseQueueLaneV2(
  queue: DistillationQueueName,
  reason?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/queue/${encodeURIComponent(queue)}/pause`, "POST", {
    reason,
  });
}

export async function resumeQueueLaneV2(
  queue: DistillationQueueName,
  reason?: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/queue/${encodeURIComponent(queue)}/resume`, "POST", {
    reason,
  });
}

export async function resumeQueueJobV2(
  queue: DistillationQueueName,
  id: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/queue/${encodeURIComponent(queue)}/${encodeURIComponent(id)}/resume`,
    "POST",
  );
}

export async function retryQueueJobV2(input: {
  queue: DistillationQueueName;
  id: string;
  mode?: "default" | "cloud_api";
  forceRefreshEvidence?: boolean;
  reason?: string;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/queue/${encodeURIComponent(input.queue)}/${encodeURIComponent(input.id)}/retry`,
    "POST",
    {
      mode: input.mode ?? "default",
      forceRefreshEvidence: input.forceRefreshEvidence ?? true,
      reason: input.reason,
    },
  );
}
