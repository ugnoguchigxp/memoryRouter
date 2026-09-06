export type CandidateOutcome =
  | "stored"
  | "ready_not_finalized"
  | "rejected"
  | "retryable"
  | "retained_failure"
  | "candidate_only"
  | "target_pending";

export type CandidateListSortBy =
  | "targetKey"
  | "candidateTitle"
  | "coverageStatus"
  | "knowledgeStatus"
  | "outcome"
  | "qualityScore"
  | "latestUpdatedAt";

export type CandidateListSortDir = "asc" | "desc";

export type CandidateDiffSummary = {
  titleChanged: boolean;
  bodyChanged: boolean;
  typeChanged: boolean;
  importanceDelta: number | null;
  confidenceDelta: number | null;
  bodySimilarity: number;
  summary: string[];
};

export type LandscapeReviewCandidateLinkStatus =
  | "draft_created"
  | "review_required"
  | "approved"
  | "rejected"
  | "finalized";

export type CandidateListItem = {
  id: string;
  targetStateId: string;
  candidateIndex: number;
  targetKind: "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  targetKey: string;
  sourceUri: string;
  finalizeSourceUri: string;
  targetStatus: string;
  targetPhase: string;
  targetOutcomeKind: string | null;
  targetLastError: string | null;
  latestUpdatedAt: string;
  original: {
    title: string;
    body: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  cover: null | {
    status: string;
    stage: string;
    type: "rule" | "procedure" | null;
    title: string | null;
    body: string | null;
    importance: number | null;
    confidence: number | null;
    reason: string | null;
    referencesCount: number;
    duplicateRefsCount: number;
    toolEventsCount: number;
    updatedAt: string;
  };
  knowledge: null | {
    id: string;
    type: string;
    status: string;
    scope: string;
    title: string;
    body: string;
    importance: number | null;
    confidence: number | null;
    updatedAt: string;
  };
  outcome: CandidateOutcome;
  landscapeWarning: null | {
    source: "landscape_review_item";
    linkId: string | null;
    reviewItemId: string | null;
    reason: string | null;
    evidence: string[];
    linkStatus: LandscapeReviewCandidateLinkStatus | null;
    requiresManualApproval: boolean;
    warningReason: "promotion_gate_review" | "review_required";
  };
  diff: {
    originalToCover: CandidateDiffSummary | null;
    coverToKnowledge: CandidateDiffSummary | null;
    originalToKnowledge: CandidateDiffSummary | null;
  };
};

export type CandidateListStats = {
  total: number;
  stored: number;
  readyNotFinalized: number;
  rejected: number;
  retryable: number;
  retainedFailure: number;
  targetPending: number;
  candidateOnly: number;
};

export type CandidateListResponse = {
  items: CandidateListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  stats: CandidateListStats;
};

export type CandidateListRequest = {
  page?: number;
  limit?: number;
  query?: string;
  targetKind?: "all" | "wiki_file" | "vibe_memory" | "knowledge_candidate" | "web_ingest";
  outcome?: "all" | CandidateOutcome;
  hasKnowledge?: "all" | "yes" | "no";
  includeStored?: boolean;
  targetStateId?: string;
  sortBy?: CandidateListSortBy;
  sortDir?: CandidateListSortDir;
};
