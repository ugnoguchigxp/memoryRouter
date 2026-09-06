export type SourceTreeItem = {
  slug: string;
  title: string;
  path: string;
  updatedAt: string;
};

export type SourceFolderItem = {
  path: string;
};

export type SourceTreeResponse = {
  items: SourceTreeItem[];
  folders: SourceFolderItem[];
};

export type SourcePageDocument = {
  slug: string;
  title: string;
  body: string;
  path: string;
  meta: Record<string, unknown>;
};

export type SourceMutationResponse = {
  ok: true;
  slug?: string;
  path?: string;
  from?: string;
  commit: string | null;
  hash?: string;
  movedPages?: Array<{ from: string; to: string }>;
  deletedSlugs?: string[];
};

export type SourceHistoryItem = {
  commit: string;
  author: string;
  date: string;
  message: string;
};

export type SourceHealth = {
  app: string;
  version: string;
  git: {
    branch: string;
    commit: string;
  } | null;
};

export type SourceSearchItem = {
  slug: string;
  excerpt: string;
};

export type WebSourceQueueItem = {
  url: string;
  normalizedUrl: string;
  state: {
    id: string;
    status: string;
    priority: number;
    attemptCount: number;
    sourceKind: "web_ingest";
    sourceKey: string;
    sourceUri: string;
    distillationVersion: string;
    createdAt: string;
    updatedAt: string;
  };
  existing: boolean;
};

export type QueueWebSourceResult =
  | { ok: true; item: WebSourceQueueItem }
  | { ok: false; url: string; reason: string };

export type QueueWebSourcesBulkResponse = {
  ok: true;
  total: number;
  queued: number;
  invalid: number;
  duplicateInRequest: number;
  items: QueueWebSourceResult[];
};

export type QueueWebSourceUploadResponse = QueueWebSourcesBulkResponse & {
  file: {
    name: string;
    size: number;
    extractedUrls: number;
  };
};

export type AuditLogActor = "agent" | "user" | "system";

export type AuditLogItem = {
  id: string;
  eventType: string;
  actor: AuditLogActor | string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type AuditLogsPagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};

export type AuditLogsResponse = {
  items: AuditLogItem[];
  availableEventTypes: string[];
  pagination: AuditLogsPagination;
};

export type SourceReindexResponse = {
  ok: true;
  indexed: number;
  removed: number;
};
