import type { GraphNode } from "./overview-contracts";

export type GraphNodeDetail = {
  id: string;
  label: string;
  kind: "knowledge";
  group: string;
  detail: string;
  weight: number;
  status: string;
  confidence: number;
  importance: number;
  bodyPreview: string;
  embedded: boolean;
  communityId?: string;
  communityRank?: number;
  communitySize?: number;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  relationType: string;
  edgeKind: "semantic" | "session" | "project" | "source" | "evidence";
  relationAxis: "semantic" | "session" | "project" | "source" | "evidence";
  derived: boolean;
  weight: number;
};

export type GraphStatusFilter = "current" | "active" | "draft" | "deprecated" | "all";

export type GraphViewMode = "relation" | "semantic" | "community" | "evidence";

export type GraphRelationAxis = "session" | "project" | "source";

export type GraphCommunityDisplayMode = "detail" | "supernode";

export type GraphCommunityHealth = {
  dead: boolean;
  stale: boolean;
  thinEvidence: boolean;
};

export type GraphCommunitySummary = {
  communityId: string;
  communityKey: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  typeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  embeddedCount: number;
  compileSelectCount: number;
  staleNodeCount: number;
  sourceRefCount: number;
  sourceRefDensity: number;
  health: GraphCommunityHealth;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSupernode = {
  id: string;
  label: string;
  communityKey: string;
  size: number;
  communityRank: number;
  health: GraphCommunityHealth;
};

export type GraphSuperedge = {
  id: string;
  source: string;
  target: string;
  weight: number;
};

export type GraphCommunityLabel = {
  communityKey: string;
  communityId: string;
  communityLabel: string;
  communityRank: number;
  size: number;
  note?: string;
  labelUpdatedAt?: string;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  communities: GraphCommunitySummary[];
  supernodes: GraphSupernode[];
  superedges: GraphSuperedge[];
  stats: {
    visibleKnowledgeCount: number;
    totalKnowledgeCount: number;
    embeddedKnowledgeCount: number;
    semanticEdgeCount: number;
    sessionEdgeCount: number;
    projectEdgeCount: number;
    sourceEdgeCount: number;
    sourceNodeCount: number;
    evidenceEdgeCount: number;
    evidenceLinkedKnowledgeCount: number;
    evidenceUnlinkedKnowledgeCount: number;
    truncatedSourceNodeCount: number;
    relationEdgeCount: number;
    sourceRefCount: number;
    communityCount: number;
    largestCommunitySize: number;
    orphanNodeCount: number;
    deadCommunityCount: number;
    staleCommunityCount: number;
    thinEvidenceCommunityCount: number;
  };
};
