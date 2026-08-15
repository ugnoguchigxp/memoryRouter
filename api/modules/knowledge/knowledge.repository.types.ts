import type {
  KnowledgeTagKind,
  KnowledgeTagStatus,
} from "../../../src/modules/knowledge/knowledge-tags.repository.js";
import type { KnowledgeStatus } from "../../../src/shared/schemas/knowledge.schema.js";

export type KnowledgeCreateInput = {
  type: string;
  status: string;
  scope: "repo" | "global";
  polarity?: string;
  intentTags?: string[];
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo?: Record<string, unknown>;
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  projectRef?: string;
  repoPath?: string;
  repoKey?: string;
  metadata?: Record<string, unknown>;
};

export type KnowledgeUpdateInput = {
  type?: string;
  status?: string;
  scope?: "repo" | "global";
  polarity?: string;
  intentTags?: string[];
  title?: string;
  body?: string;
  confidence?: number;
  importance?: number;
  appliesTo?: Record<string, unknown>;
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  projectRef?: string;
  repoPath?: string;
  repoKey?: string;
  metadata?: Record<string, unknown>;
};

export type BulkKnowledgeStatusUpdateResult = {
  targetStatus: KnowledgeStatus;
  requestedIds: string[];
  updatedIds: string[];
  unchangedIds: string[];
  notFoundIds: string[];
  invalidTransitionIds: Array<{ id: string; fromStatus: KnowledgeStatus }>;
};

export type BulkKnowledgeStatusSelection = {
  status?: KnowledgeStatus;
  type?: string;
  query?: string;
};

export type BulkKnowledgeStatusUpdateParams =
  | {
      ids: string[];
      status: KnowledgeStatus;
    }
  | {
      selection: BulkKnowledgeStatusSelection;
      status: KnowledgeStatus;
    };

export type KnowledgeFeedbackDirection = "up" | "down";

export type KnowledgeFeedbackResult = {
  id: string;
  direction: KnowledgeFeedbackDirection;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  lastVerifiedAt: Date | null;
};

export type KnowledgeTagDefinitionApi = {
  id: string;
  kind: KnowledgeTagKind;
  slug: string;
  label: string;
  description: string | null;
  aliases: string[];
  status: KnowledgeTagStatus;
  sortOrder: number;
};

export type KnowledgeListItem = {
  id: string;
  type: string;
  status: string;
  scope: string;
  polarity: string;
  intentTags: string[];
  title: string;
  body: string;
  confidence: number;
  importance: number;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceRefs: string[];
  sourceVibeMemoryIds: string[];
  compileSelectCount: number;
  lastCompiledAt: Date | null;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  dynamicScore: number;
  decayFactor: number;
  lastVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type KnowledgeListSortBy =
  | "title"
  | "type"
  | "status"
  | "scope"
  | "qualityScore"
  | "updatedAt";

export type KnowledgeListSortDir = "asc" | "desc";

export type KnowledgeDisplayFilter =
  | "all"
  | "draft"
  | "active"
  | "deprecated"
  | "unused-active"
  | "stale"
  | "high-value";

export type KnowledgeListParams = {
  limit: number;
  page?: number;
  status?: string;
  type?: string;
  query?: string;
  polarities?: string[];
  intentTags?: string[];
  displayFilter?: KnowledgeDisplayFilter;
  minQuality?: number;
  sortBy?: KnowledgeListSortBy;
  sortDir?: KnowledgeListSortDir;
};
