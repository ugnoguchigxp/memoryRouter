import {
  distillationQueueNameValues,
  distillationQueueStatusValues,
} from "../../../db/schema.constants.js";

export const distillationQueueNames = [...distillationQueueNameValues];
export const distillationQueueStatuses = [...distillationQueueStatusValues];
export { distillationQueueNameValues, distillationQueueStatusValues };

export type DistillationQueueName = (typeof distillationQueueNameValues)[number];
export type DistillationQueueStatus = (typeof distillationQueueStatusValues)[number];

export const queueTableNameByQueue: Record<DistillationQueueName, string> = {
  findingCandidate: "finding_candidate_queue",
  episodeDistiller: "episode_distiller_queue",
  coveringEvidence: "covering_evidence_queue",
  deadZoneMergeReview: "dead_zone_merge_review_queue",
  landscapeCuration: "landscape_curation_queue",
  finalizeDistille: "finalize_distille_queue",
  mergeActivationFinalize: "merge_activation_finalize_queue",
};

export type QueueRetryMode = "default" | "cloud_api";
export type FinalizeQueueJobType = "candidate_finalize" | "merge_activation_finalize";
export type QueueBackendKind =
  | "finding_candidate_queue"
  | "episode_distiller_queue"
  | "covering_evidence_queue"
  | "dead_zone_merge_review_queue"
  | "landscape_curation_queue"
  | "finalize_distille_queue"
  | "merge_activation_finalize_queue";

export type QueueListItem = {
  queueName: DistillationQueueName;
  visibleQueueName: DistillationQueueName;
  jobType?: FinalizeQueueJobType;
  backendKind: QueueBackendKind;
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

export type QueueStatsCounter = Record<DistillationQueueStatus, number>;

export type QueueStatsByQueue = Record<
  DistillationQueueName,
  {
    counters: QueueStatsCounter;
    oldestPendingAt: string | null;
    running: number;
    failed: number;
    offline: number;
    nonRegistered: number;
  }
>;
