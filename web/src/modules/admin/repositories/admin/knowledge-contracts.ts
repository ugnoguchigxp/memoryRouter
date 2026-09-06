export type KnowledgeType = "rule" | "procedure";

export type KnowledgeItem = {
  id: string;
  type: KnowledgeType | string;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  sourceRefs?: string[];
  sourceVibeMemoryIds?: string[];
  compileSelectCount: number;
  lastCompiledAt: string | null;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  decayFactor: number;
  lastVerifiedAt: string | null;
  updatedAt: string;
  polarity: "positive" | "negative";
  intentTags: string[];
};

export type KnowledgeListResponse = {
  items: KnowledgeItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

export type KnowledgeListRequest = {
  limit?: number;
  page?: number;
  status?: string;
  query?: string;
  displayFilter?:
    | "all"
    | "draft"
    | "active"
    | "deprecated"
    | "unused-active"
    | "stale"
    | "high-value";
  minQuality?: number;
  sortBy?: string;
  sortDir?: "asc" | "desc";
  polarities?: Array<"positive" | "negative">;
  intentTags?: string[];
};

export type KnowledgeFeedback = {
  id: string;
  direction: "up" | "down";
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  lastVerifiedAt: string | null;
};

export type KnowledgeBulkStatusResponse = {
  targetStatus: "active" | "deprecated";
  requestedIds: string[];
  updatedIds: string[];
  unchangedIds: string[];
  notFoundIds: string[];
  invalidTransitionIds: Array<{ id: string; fromStatus: string }>;
  outcome: "ok" | "partial" | "none";
};

export type KnowledgeBulkStatusSelection = {
  status?: string;
  type?: string;
  query?: string;
};

export type KnowledgeBulkStatusRequest =
  | {
      ids: string[];
      status: "active" | "deprecated";
    }
  | {
      selection: KnowledgeBulkStatusSelection;
      status: "active" | "deprecated";
    };

export type VibeMemory = {
  id: string;
  sessionId: string;
  content: string;
  memoryType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type AgentDiffEntry = {
  id: string;
  vibeMemoryId: string;
  filePath: string;
  diffHunk: string;
  changeType: string | null;
  language: string | null;
  symbolName: string | null;
  symbolKind: string | null;
  signature: string | null;
  startLine: number | null;
  endLine: number | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type EpisodeCardStatus = "active" | "deprecated";

export type EpisodeOutcomeKind = "success" | "failure" | "mixed" | "unknown";

export type EpisodeSourceKind =
  | "vibe_memory"
  | "compile_run"
  | "decision_run"
  | "audit_log"
  | "manual";

export type EpisodeRefKind =
  | "vibe_memory"
  | "agent_diff"
  | "compile_run"
  | "decision_run"
  | "audit_log"
  | "file"
  | "commit";

export type EpisodeRefInput = {
  refKind: EpisodeRefKind;
  refValue: string;
  locator?: string | null;
  queryHint?: string | null;
  metadata?: Record<string, unknown>;
};

export type EpisodeRef = EpisodeRefInput & {
  id: string;
  episodeCardId: string;
  createdAt: string;
};

export type EpisodeCard = {
  id: string;
  title: string;
  situation: string;
  observations: string;
  action: string;
  outcome: string;
  lesson: string;
  applicability: Record<string, unknown>;
  antiApplicability: Record<string, unknown>;
  domains: string[];
  technologies: string[];
  changeTypes: string[];
  tools: string[];
  repoPath?: string | null;
  repoKey?: string | null;
  sourceKind: EpisodeSourceKind;
  sourceKey: string;
  outcomeKind: EpisodeOutcomeKind;
  importance: number;
  confidence: number;
  compileUseCount: number;
  decisionUseCount: number;
  status: EpisodeCardStatus;
  staleAt?: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  score?: number;
  refs: EpisodeRef[];
};

export type EpisodeCardCreateInput = {
  title: string;
  situation: string;
  observations?: string;
  action?: string;
  outcome?: string;
  lesson?: string;
  applicability?: Record<string, unknown>;
  antiApplicability?: Record<string, unknown>;
  domains?: string[];
  technologies?: string[];
  changeTypes?: string[];
  tools?: string[];
  repoPath?: string | null;
  repoKey?: string | null;
  sourceKind: EpisodeSourceKind;
  sourceKey: string;
  outcomeKind?: EpisodeOutcomeKind;
  importance?: number;
  confidence?: number;
  compileUseCount?: number;
  decisionUseCount?: number;
  status?: EpisodeCardStatus;
  metadata?: Record<string, unknown>;
  refs?: EpisodeRefInput[];
};

export type EpisodeListRequest = {
  query?: string;
  status?: "active" | "deprecated";
  limit?: number;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  tools?: string[];
};

export type KnowledgeWriteInput = {
  type: KnowledgeType;
  status: string;
  scope: string;
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown> & {
    general?: boolean;
    technologies?: string[];
    changeTypes?: string[];
    domains?: string[];
    repoPath?: string;
    repoKey?: string;
  };
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  metadata?: Record<string, unknown>;
  polarity?: "positive" | "negative";
  intentTags?: string[];
};

export type KnowledgeUpdateInput = Partial<KnowledgeWriteInput>;

export type KnowledgeTagDefinition = {
  id: string;
  kind: "technology" | "change_type" | "retrieval_mode" | "domain";
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  status: "active" | "draft" | "deprecated";
  sortOrder: number;
};

export type SkippedRunReason = {
  reason: string;
  count: number;
};
