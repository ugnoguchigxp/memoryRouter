import { sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { db } from "../../../src/db/index.js";
import type { SqliteCoreDatabase } from "../../../src/db/sqlite/index.js";
import { resolveCoverEvidenceRouteByPolicy } from "../../../src/modules/coverEvidence/provider-policy.js";
import {
  type DistillationProviderSetting,
  resolveRouteModelForProvider,
} from "../../../src/modules/distillation/distillation-runtime.service.js";
import { resolveLocalLlmModelConfig } from "../../../src/modules/llm/providers/local-llm-config.js";
import {
  appendQueueEvent,
  getQueueControlStates,
  pauseQueueJob,
  pauseRunningQueueJobs,
  resumeQueueJob,
  retryQueueJob,
  setQueuePaused,
} from "../../../src/modules/queue/core/index.js";
import {
  type DistillationQueueName,
  type DistillationQueueStatus,
  type FinalizeQueueJobType,
  type QueueBackendKind,
  type QueueListItem,
  type QueueRetryMode,
  type QueueStatsByQueue,
  distillationQueueNames,
  distillationQueueStatuses,
  queueTableNameByQueue,
} from "../../../src/modules/queue/core/types.js";
import {
  ensureRuntimeSettingsLoaded,
  getRuntimeSettingsSnapshot,
  resolveCoverEvidenceRoutes,
  resolveDeadZoneMergeReviewRoute,
  resolveLandscapeCurationRoute,
  resolveEpisodeDistillerRoute,
  resolveFindCandidateRoute,
} from "../../../src/modules/settings/settings.service.js";
import type { RuntimeSettingsRoute } from "../../../src/modules/settings/settings.types.js";

export type QueueListQuery = {
  page: number;
  limit: number;
  query?: string;
  queue?: DistillationQueueName;
  status?: DistillationQueueStatus | "all";
  sortBy?: string;
  sortDir?: "asc" | "desc";
};

export type QueueControlState = {
  paused: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  reason: string | null;
};

type VisibleDistillationQueueName = Exclude<DistillationQueueName, "mergeActivationFinalize">;
type QueueStatsByVisibleQueue = Record<
  VisibleDistillationQueueName,
  QueueStatsByQueue[DistillationQueueName]
>;
export type QueueControlStatesByQueue = Record<VisibleDistillationQueueName, QueueControlState>;

const visibleDistillationQueueNames = distillationQueueNames.filter(
  (queueName): queueName is VisibleDistillationQueueName => queueName !== "mergeActivationFinalize",
);

type QueueStatsAggregateRow = {
  status: string;
  count: number;
  oldest_pending_at: Date | string | number | null;
  offline_count: number;
  non_registered_count: number;
};

type QueueListRow = {
  queue_name?: string | null;
  visible_queue_name?: string | null;
  job_type?: string | null;
  backend_kind?: string | null;
  id: string;
  status: string;
  priority: number;
  attempt_count: number;
  subject_title: string | null;
  subject_detail: string | null;
  provider: string | null;
  model: string | null;
  last_error: string | null;
  last_outcome_kind: string | null;
  locked_by: string | null;
  locked_at: Date | string | number | null;
  heartbeat_at: Date | string | number | null;
  created_at: Date | string | number;
  updated_at: Date | string | number;
  completed_at: Date | string | number | null;
  next_run_at: Date | string | number | null;
  metadata_summary: string | null;
  source_kind: string | null;
  provider_policy: string | null;
  active_lease_pool_id?: string | null;
  active_lease_target_id?: string | null;
  active_lease_worker_id?: string | null;
};

type QueueRowWithSource = {
  queueName: DistillationQueueName;
  row: QueueListRow;
};

type ActiveProviderLeaseRow = {
  pool_id: string;
  target_id: string;
  queue_name: string;
  queue_job_id: string;
  worker_id: string;
};

async function getSqliteCoreDatabase(): Promise<SqliteCoreDatabase> {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function emptyCounters(): Record<DistillationQueueStatus, number> {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    paused: 0,
  };
}

function toIsoTimestamp(value: Date | string | number | null): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // Driver-parsed `timestamp without time zone` values are interpreted as local time.
    // Rebuild as UTC wall-clock to avoid local offset drift in API responses.
    const rebuiltUtc = new Date(
      Date.UTC(
        value.getFullYear(),
        value.getMonth(),
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      ),
    );
    return Number.isNaN(rebuiltUtc.getTime()) ? null : rebuiltUtc.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    const unixMillis = trimmed.startsWith("unix-ms:")
      ? Number(trimmed.slice("unix-ms:".length))
      : Number.NaN;
    if (Number.isFinite(unixMillis)) {
      const parsedUnix = new Date(unixMillis);
      return Number.isNaN(parsedUnix.getTime()) ? null : parsedUnix.toISOString();
    }
    // PostgreSQL timestamp (without timezone) should be treated as UTC to avoid local offset drift.
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
      const parsedUtc = new Date(`${trimmed.replace(" ", "T")}Z`);
      return Number.isNaN(parsedUtc.getTime()) ? null : parsedUtc.toISOString();
    }
    const parsedString = new Date(trimmed);
    return Number.isNaN(parsedString.getTime()) ? null : parsedString.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeQueueLastError(
  queueName: DistillationQueueName,
  lastError: string | null,
): string | null {
  if (!lastError) return null;
  if (queueName !== "findingCandidate") return lastError;
  const maxRounds = lastError.match(/distillation tool loop exceeded max rounds \((\d+)\)/);
  if (!maxRounds) return lastError;
  const count = Number(maxRounds[1]);
  if (!Number.isInteger(count) || count <= 0) {
    return "findCandidate evidence_not_found: reader tool calls were exhausted without producing a final candidate response";
  }
  return `findCandidate evidence_not_found: exhausted ${count}/${count} reader tool calls without producing a final candidate response`;
}

function normalizeRow(queueName: DistillationQueueName, row: QueueListRow): QueueListItem {
  const backendQueueName = distillationQueueNames.includes(row.queue_name as DistillationQueueName)
    ? (row.queue_name as DistillationQueueName)
    : queueName;
  const visibleQueueName = distillationQueueNames.includes(
    row.visible_queue_name as DistillationQueueName,
  )
    ? (row.visible_queue_name as DistillationQueueName)
    : backendQueueName === "mergeActivationFinalize"
      ? "finalizeDistille"
      : backendQueueName;
  const backendKind =
    (row.backend_kind as QueueBackendKind | null) ??
    (queueTableNameByQueue[backendQueueName] as QueueBackendKind);
  const jobType =
    row.job_type === "merge_activation_finalize" || row.job_type === "candidate_finalize"
      ? (row.job_type as FinalizeQueueJobType)
      : backendQueueName === "mergeActivationFinalize"
        ? "merge_activation_finalize"
        : backendQueueName === "finalizeDistille"
          ? "candidate_finalize"
          : undefined;
  const createdAt =
    toIsoTimestamp(row.created_at) ?? toIsoTimestamp(row.updated_at) ?? new Date(0).toISOString();
  const updatedAt = toIsoTimestamp(row.updated_at) ?? createdAt;
  const resolved = resolveQueueRuntimeModel(backendQueueName, row);
  return {
    queueName: backendQueueName,
    visibleQueueName,
    jobType,
    backendKind,
    id: row.id,
    status: row.status as DistillationQueueStatus,
    priority: Number(row.priority ?? 50),
    attemptCount: Number(row.attempt_count ?? 0),
    subjectTitle: row.subject_title ?? "-",
    subjectDetail: row.subject_detail ?? "-",
    provider: resolved.provider,
    model: resolved.model,
    activeProviderPoolId: row.active_lease_pool_id ?? null,
    activeProviderTargetId: row.active_lease_target_id ?? null,
    lastError: normalizeQueueLastError(backendQueueName, row.last_error ?? null),
    lastOutcomeKind: row.last_outcome_kind ?? null,
    lockedBy: row.active_lease_worker_id ?? row.locked_by ?? null,
    lockedAt: toIsoTimestamp(row.locked_at),
    heartbeatAt: toIsoTimestamp(row.heartbeat_at),
    createdAt,
    updatedAt,
    completedAt: toIsoTimestamp(row.completed_at),
    nextRunAt: toIsoTimestamp(row.next_run_at),
    metadataSummary: row.metadata_summary ?? null,
  };
}

function normalizeProviderPolicy(value: string | null): "default" | "cloud_api" {
  return value === "cloud_api" ? "cloud_api" : "default";
}

function resolveRouteModel(
  provider: string,
  configuredModel: string | undefined,
  localLlmModel?: string | undefined,
): string | null {
  try {
    const model = resolveRouteModelForProvider({
      provider: provider as DistillationProviderSetting,
      routeModel: configuredModel,
      localLlmModel,
    });
    return provider === "local-llm" ? resolveLocalLlmModelConfig(model).model : model;
  } catch {
    return null;
  }
}

function summarizeProviderPoolRoute(route: RuntimeSettingsRoute): string | null {
  const poolId = route.providerPoolId?.trim();
  if (!poolId) return null;

  const settings = getRuntimeSettingsSnapshot();
  const pool = settings.providerPools.find((item) => item.id === poolId);
  if (!pool) return `pool:${poolId}`;

  const targetModels = pool.targets
    .map((target) => {
      if (target.provider === "local-llm") {
        const model = settings.providers["local-llm"].models.find(
          (item) => item.id === target.localLlmModelId,
        );
        return model?.model || model?.name || target.localLlmModelId;
      }
      if (target.provider === "azure-openai") {
        return (
          settings.providers["azure-openai"].deployments[target.deploymentSlot]?.model ??
          `deployment:${target.deploymentSlot}`
        );
      }
      return target.targetId;
    })
    .filter((value): value is string => Boolean(value?.trim()));
  const uniqueTargets = [...new Set(targetModels)];
  const poolLabel = pool.label.trim() || pool.id;

  if (uniqueTargets.length === 0) return poolLabel;
  return `${poolLabel}: ${uniqueTargets.join(" / ")}`;
}

function resolveRouteRuntimeModel(route: RuntimeSettingsRoute): {
  provider: string | null;
  model: string | null;
} {
  const provider = route.provider;
  const poolSummary = summarizeProviderPoolRoute(route);
  return {
    provider,
    model: poolSummary ?? resolveRouteModel(provider, route.model, route.localLlmModel),
  };
}

function resolveQueueRuntimeModel(
  queueName: DistillationQueueName,
  row: QueueListRow,
): { provider: string | null; model: string | null } {
  const activeLeaseModel = resolveActiveLeaseRuntimeModel(row);
  if (activeLeaseModel) return activeLeaseModel;

  if (row.model?.trim()) {
    return { provider: row.provider ?? null, model: row.model.trim() };
  }

  if (queueName === "episodeDistiller") {
    const route = resolveEpisodeDistillerRoute();
    return resolveRouteRuntimeModel(route);
  }

  if (queueName === "findingCandidate") {
    const sourceKind = row.source_kind === "vibe_memory" ? "vibe_memory" : "wiki_file";
    const route = resolveFindCandidateRoute(sourceKind);
    return resolveRouteRuntimeModel(route);
  }

  if (queueName === "coveringEvidence") {
    const policy = normalizeProviderPolicy(row.provider_policy);
    const routes = resolveCoverEvidenceRoutes();
    try {
      const route = resolveCoverEvidenceRouteByPolicy({
        route: routes.externalEvidence,
        policy,
        routeName: "externalEvidence",
      });
      return resolveRouteRuntimeModel(route);
    } catch {
      const provider = row.provider ?? null;
      return { provider, model: provider ? resolveRouteModel(provider, undefined) : null };
    }
  }

  if (queueName === "deadZoneMergeReview") {
    const route = resolveDeadZoneMergeReviewRoute();
    const provider = row.provider?.trim() || route.provider;
    return {
      provider,
      model:
        row.model?.trim() ||
        summarizeProviderPoolRoute(route) ||
        resolveRouteModel(provider, route.model, route.localLlmModel),
    };
  }

  if (queueName === "landscapeCuration") {
    const route = resolveLandscapeCurationRoute();
    return {
      provider: row.provider?.trim() || route.provider,
      model:
        row.model?.trim() ||
        summarizeProviderPoolRoute(route) ||
        resolveRouteModel(route.provider, route.model, route.localLlmModel),
    };
  }

  const settings = getRuntimeSettingsSnapshot();
  const finalizeRoute = settings.taskRouting.finalizeDistille;
  const provider = finalizeRoute.provider;
  return {
    provider,
    model:
      summarizeProviderPoolRoute(finalizeRoute) ||
      resolveRouteModel(provider, finalizeRoute.model, finalizeRoute.localLlmModel),
  };
}

function resolveActiveLeaseRuntimeModel(
  row: QueueListRow,
): { provider: string | null; model: string | null } | null {
  const targetId = row.active_lease_target_id?.trim();
  if (!targetId) return null;

  const settings = getRuntimeSettingsSnapshot();
  const localModel = settings.providers["local-llm"].models.find((model) => model.id === targetId);
  if (localModel) {
    return { provider: "local-llm", model: localModel.model };
  }

  if (/^\d+$/.test(targetId)) {
    const deployment = settings.providers["azure-openai"].deployments[Number(targetId)];
    return {
      provider: "azure-openai",
      model: deployment?.model ?? settings.providers["azure-openai"].model,
    };
  }

  if (targetId === "openai") {
    return { provider: "openai", model: settings.providers.openai.model };
  }
  if (targetId === "bedrock") {
    return { provider: "bedrock", model: settings.providers.bedrock.model };
  }
  if (targetId === "codex") {
    return { provider: "codex", model: settings.providers.codex.model };
  }

  return { provider: null, model: targetId };
}

function queueRowSourceKey(source: QueueRowWithSource): string {
  const queueName = distillationQueueNames.includes(source.row.queue_name as DistillationQueueName)
    ? (source.row.queue_name as DistillationQueueName)
    : source.queueName;
  return `${queueName}:${source.row.id}`;
}

function activeLeaseKey(lease: ActiveProviderLeaseRow): string {
  return `${lease.queue_name}:${lease.queue_job_id}`;
}

async function loadActiveProviderLeases(): Promise<ActiveProviderLeaseRow[]> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    return sqlite.db
      .query<ActiveProviderLeaseRow, []>(
        `
        select pool_id, target_id, queue_name, queue_job_id, worker_id
        from llm_provider_leases
        where status = 'active'
      `,
      )
      .all();
  }

  const result = await db.execute(sql`
    select pool_id, target_id, queue_name, queue_job_id, worker_id
    from llm_provider_leases
    where status = 'active'
  `);
  return result.rows as unknown as ActiveProviderLeaseRow[];
}

async function attachActiveProviderLeases(sources: QueueRowWithSource[]): Promise<QueueListRow[]> {
  if (sources.length === 0) return [];

  const sourceKeys = new Set(sources.map(queueRowSourceKey));
  const leases = await loadActiveProviderLeases();
  const leaseByKey = new Map(
    leases
      .filter((lease) => sourceKeys.has(activeLeaseKey(lease)))
      .map((lease) => [activeLeaseKey(lease), lease]),
  );

  return sources.map((source) => {
    const lease = leaseByKey.get(queueRowSourceKey(source));
    if (!lease) return source.row;
    return {
      ...source.row,
      active_lease_pool_id: lease.pool_id,
      active_lease_target_id: lease.target_id,
      active_lease_worker_id: lease.worker_id,
    };
  });
}

function buildDynamicOrderBy(
  queueName: DistillationQueueName,
  sortBy: string | null | undefined,
  sortDir: "asc" | "desc" | undefined,
) {
  const allowedFields = ["status", "priority", "subjectTitle", "attemptCount", "updatedAt"];
  const field = sortBy && allowedFields.includes(sortBy) ? sortBy : null;
  const dir = sortDir === "asc" || sortDir === "desc" ? sortDir : "desc";

  if (!field) {
    return sql`
      case
        when q.status = 'running' then 0
        when q.status = 'pending' then 1
        when q.status = 'paused' then 2
        when q.status = 'failed' then 3
        else 4
      end,
      q.priority desc,
      q.updated_at desc
    `;
  }

  let sortColumn = sql`q.updated_at`;
  switch (field) {
    case "status":
      sortColumn = sql`q.status`;
      break;
    case "priority":
      sortColumn = sql`q.priority`;
      break;
    case "attemptCount":
      sortColumn = sql`q.attempt_count`;
      break;
    case "updatedAt":
      sortColumn = sql`q.updated_at`;
      break;
    case "subjectTitle":
      if (queueName === "findingCandidate" || queueName === "episodeDistiller") {
        sortColumn = sql`q.source_key`;
      } else if (queueName === "coveringEvidence") {
        sortColumn = sql`c.title`;
      } else if (queueName === "deadZoneMergeReview") {
        sortColumn = sql`dz.title`;
      } else if (queueName === "landscapeCuration") {
        sortColumn = sql`subject.title`;
      } else if (queueName === "mergeActivationFinalize" || queueName === "finalizeDistille") {
        sortColumn = sql`q.subject_title`;
      } else {
        sortColumn = sql`coalesce(e.title, c.title)`;
      }
      break;
    default:
      sortColumn = sql`q.updated_at`;
  }

  return dir === "asc"
    ? sql`${sortColumn} asc, q.updated_at desc`
    : sql`${sortColumn} desc, q.updated_at desc`;
}

function buildSqliteOrderBy(
  queueName: DistillationQueueName,
  sortBy: string | null | undefined,
  sortDir: "asc" | "desc" | undefined,
): string {
  const allowedFields = ["status", "priority", "subjectTitle", "attemptCount", "updatedAt"];
  const field = sortBy && allowedFields.includes(sortBy) ? sortBy : null;
  const dir = sortDir === "asc" ? "asc" : "desc";

  if (!field) {
    return `
      case
        when q.status = 'running' then 0
        when q.status = 'pending' then 1
        when q.status = 'paused' then 2
        when q.status = 'failed' then 3
        else 4
      end,
      q.priority desc,
      q.updated_at desc
    `;
  }

  let sortColumn = "q.updated_at";
  switch (field) {
    case "status":
      sortColumn = "q.status";
      break;
    case "priority":
      sortColumn = "q.priority";
      break;
    case "attemptCount":
      sortColumn = "q.attempt_count";
      break;
    case "updatedAt":
      sortColumn = "q.updated_at";
      break;
    case "subjectTitle":
      if (queueName === "findingCandidate" || queueName === "episodeDistiller") {
        sortColumn = "q.source_key";
      } else if (queueName === "coveringEvidence") {
        sortColumn = "c.title";
      } else if (queueName === "deadZoneMergeReview") {
        sortColumn = "dz.title";
      } else if (queueName === "mergeActivationFinalize") {
        sortColumn = "canonical.title";
      } else {
        sortColumn = "q.subject_title";
      }
      break;
  }

  return `${sortColumn} ${dir}, q.updated_at desc`;
}

function sqliteStatusPatternValues(
  statusFilter: DistillationQueueStatus | null,
  pattern: string | null,
  patternCount: number,
): unknown[] {
  return [
    statusFilter,
    statusFilter,
    pattern,
    ...Array.from({ length: patternCount }, () => pattern),
  ];
}

async function querySqliteQueueRows(
  sqlite: SqliteCoreDatabase,
  queueName: DistillationQueueName,
  params: {
    limit: number;
    offset: number;
    query?: string;
    status?: DistillationQueueStatus | "all";
    sortBy?: string;
    sortDir?: "asc" | "desc";
  },
): Promise<QueueListRow[]> {
  const pattern = params.query?.trim() ? `%${params.query.trim().toLowerCase()}%` : null;
  const statusFilter = params.status && params.status !== "all" ? params.status : null;
  const orderBy = buildSqliteOrderBy(queueName, params.sortBy, params.sortDir);

  if (queueName === "findingCandidate") {
    return sqlite.db
      .query<QueueListRow, unknown[]>(
        `
        select
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          q.source_key as subject_title,
          q.source_kind || ' | ' || coalesce(q.source_uri, '') as subject_detail,
          null as provider,
          null as model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          q.next_run_at,
          'input=' || q.input_kind as metadata_summary,
          q.source_kind,
          null as provider_policy
        from finding_candidate_queue q
        where (? is null or q.status = ?)
          and (
            ? is null
            or lower(q.source_key) like ?
            or lower(coalesce(q.source_uri, '')) like ?
          )
        order by ${orderBy}
        limit ?
        offset ?
      `,
      )
      .all(...sqliteStatusPatternValues(statusFilter, pattern, 2), params.limit, params.offset);
  }

  if (queueName === "episodeDistiller") {
    return sqlite.db
      .query<QueueListRow, unknown[]>(
        `
        select
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          q.source_key as subject_title,
          q.source_kind || ' | ' || coalesce(q.source_uri, '') as subject_detail,
          q.provider_policy as provider,
          null as model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          q.next_run_at,
          cast(json_extract(q.metadata, '$.episodeDistiller.generated') as text) as metadata_summary,
          q.source_kind,
          q.provider_policy
        from episode_distiller_queue q
        where (? is null or q.status = ?)
          and (
            ? is null
            or lower(q.source_key) like ?
            or lower(coalesce(q.source_uri, '')) like ?
          )
        order by ${orderBy}
        limit ?
        offset ?
      `,
      )
      .all(...sqliteStatusPatternValues(statusFilter, pattern, 2), params.limit, params.offset);
  }

  if (queueName === "coveringEvidence") {
    return sqlite.db
      .query<QueueListRow, unknown[]>(
        `
        select
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          c.title as subject_title,
          'candidate=' || q.found_candidate_id || ' | policy=' || coalesce(q.provider_policy, '') as subject_detail,
          q.provider_policy as provider,
          null as model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          q.next_run_at,
          null as metadata_summary,
          null as source_kind,
          q.provider_policy
        from covering_evidence_queue q
        left join found_candidates c on c.id = q.found_candidate_id
        where (? is null or q.status = ?)
          and (
            ? is null
            or lower(coalesce(c.title, '')) like ?
            or lower(coalesce(q.found_candidate_id, '')) like ?
          )
        order by ${orderBy}
        limit ?
        offset ?
      `,
      )
      .all(...sqliteStatusPatternValues(statusFilter, pattern, 2), params.limit, params.offset);
  }

  if (queueName === "deadZoneMergeReview") {
    return sqlite.db
      .query<QueueListRow, unknown[]>(
        `
        select
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          dz.title as subject_title,
          'canonical=' || coalesce(q.canonical_knowledge_id, '-') ||
            ' | review=' || coalesce(q.review_item_id, '-') as subject_detail,
          q.provider,
          q.model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          q.next_run_at,
          coalesce(json_extract(q.result, '$.decision'), q.last_outcome_kind) as metadata_summary,
          null as source_kind,
          null as provider_policy
        from dead_zone_merge_review_queue q
        left join knowledge_items dz on dz.id = q.dead_zone_knowledge_id
        where (? is null or q.status = ?)
          and (
            ? is null
            or lower(coalesce(dz.title, '')) like ?
            or lower(coalesce(q.dead_zone_knowledge_id, '')) like ?
            or lower(coalesce(q.canonical_knowledge_id, '')) like ?
          )
        order by ${orderBy}
        limit ?
        offset ?
      `,
      )
      .all(...sqliteStatusPatternValues(statusFilter, pattern, 3), params.limit, params.offset);
  }

  if (queueName === "landscapeCuration") {
    return sqlite.db
      .query<QueueListRow, unknown[]>(`
      select q.id, q.status, q.priority, q.attempt_count, subject.title as subject_title,
        q.finding_type || ' | decision=' || coalesce(q.decision, '-') as subject_detail,
        q.provider, q.model, q.last_error, q.last_outcome_kind, q.locked_by, q.locked_at,
        q.heartbeat_at, q.created_at, q.updated_at, q.completed_at, q.next_run_at,
        json_extract(q.result, '$.decision') as metadata_summary, null as source_kind, null as provider_policy
      from landscape_curation_queue q left join knowledge_items subject on subject.id = q.subject_knowledge_id
      where (? is null or q.status = ?) and (? is null or lower(coalesce(subject.title,'')) like ? or lower(q.subject_knowledge_id) like ?)
      order by ${orderBy} limit ? offset ?`)
      .all(...sqliteStatusPatternValues(statusFilter, pattern, 2), params.limit, params.offset);
  }

  if (queueName === "mergeActivationFinalize") {
    return sqlite.db
      .query<QueueListRow, unknown[]>(
        `
        select
          'mergeActivationFinalize' as queue_name,
          'finalizeDistille' as visible_queue_name,
          'merge_activation_finalize' as job_type,
          'merge_activation_finalize_queue' as backend_kind,
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          canonical.title as subject_title,
          'deadZone=' || coalesce(q.dead_zone_knowledge_id, '') ||
            ' | canonical=' || coalesce(q.canonical_knowledge_id, '') ||
            ' | mergeReview=' || coalesce(q.merge_review_job_id, '') as subject_detail,
          q.provider,
          q.model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          q.next_run_at,
          coalesce(json_extract(q.activation_result, '$.outcome'), q.last_outcome_kind) as metadata_summary,
          null as source_kind,
          null as provider_policy
        from merge_activation_finalize_queue q
        left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
        where (? is null or q.status = ?)
          and (
            ? is null
            or lower(coalesce(canonical.title, '')) like ?
            or lower(coalesce(q.dead_zone_knowledge_id, '')) like ?
            or lower(coalesce(q.canonical_knowledge_id, '')) like ?
            or lower(coalesce(q.merge_review_job_id, '')) like ?
          )
        order by ${orderBy}
        limit ?
        offset ?
      `,
      )
      .all(...sqliteStatusPatternValues(statusFilter, pattern, 4), params.limit, params.offset);
  }

  return sqlite.db
    .query<QueueListRow, unknown[]>(
      `
      select
        q.queue_name,
        q.visible_queue_name,
        q.job_type,
        q.backend_kind,
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        q.subject_title,
        q.subject_detail,
        q.provider_policy as provider,
        q.model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        q.metadata_summary,
        q.source_kind,
        q.provider_policy
      from (
        select
          'finalizeDistille' as queue_name,
          'finalizeDistille' as visible_queue_name,
          'candidate_finalize' as job_type,
          'finalize_distille_queue' as backend_kind,
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          coalesce(e.title, c.title) as subject_title,
          'evidence=' || coalesce(q.evidence_result_id, '') ||
            ' | knowledge=' || coalesce(q.knowledge_id, '-') as subject_detail,
          q.provider_policy,
          null as model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          null as next_run_at,
          null as metadata_summary,
          null as source_kind
        from finalize_distille_queue q
        left join evidence_coverage_results e on e.id = q.evidence_result_id
        left join found_candidates c on c.id = e.found_candidate_id
        union all
        select
          'mergeActivationFinalize' as queue_name,
          'finalizeDistille' as visible_queue_name,
          'merge_activation_finalize' as job_type,
          'merge_activation_finalize_queue' as backend_kind,
          q.id,
          q.status,
          q.priority,
          q.attempt_count,
          canonical.title as subject_title,
          'deadZone=' || coalesce(q.dead_zone_knowledge_id, '') ||
            ' | canonical=' || coalesce(q.canonical_knowledge_id, '') ||
            ' | mergeReview=' || coalesce(q.merge_review_job_id, '') as subject_detail,
          q.provider as provider_policy,
          q.model,
          q.last_error,
          q.last_outcome_kind,
          q.locked_by,
          q.locked_at,
          q.heartbeat_at,
          q.created_at,
          q.updated_at,
          q.completed_at,
          q.next_run_at,
          coalesce(json_extract(q.activation_result, '$.outcome'), q.last_outcome_kind) as metadata_summary,
          null as source_kind
        from merge_activation_finalize_queue q
        left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
      ) q
      where (? is null or q.status = ?)
        and (
          ? is null
          or lower(coalesce(q.subject_title, '')) like ?
          or lower(coalesce(q.subject_detail, '')) like ?
        )
      order by ${orderBy}
      limit ?
      offset ?
    `,
    )
    .all(...sqliteStatusPatternValues(statusFilter, pattern, 2), params.limit, params.offset);
}

function sqliteCountFromRow(row: { count: number } | null): number {
  return Number(row?.count ?? 0);
}

function countSqliteQueueRows(
  sqlite: SqliteCoreDatabase,
  queueName: DistillationQueueName,
  params: { query?: string; status?: DistillationQueueStatus | "all" },
): number {
  const pattern = params.query?.trim() ? `%${params.query.trim().toLowerCase()}%` : null;
  const statusFilter = params.status && params.status !== "all" ? params.status : null;

  if (queueName === "findingCandidate") {
    return sqliteCountFromRow(
      sqlite.db
        .query<{ count: number }, unknown[]>(
          `
          select count(*) as count
          from finding_candidate_queue q
          where (? is null or q.status = ?)
            and (
              ? is null
              or lower(q.source_key) like ?
              or lower(coalesce(q.source_uri, '')) like ?
            )
        `,
        )
        .get(...sqliteStatusPatternValues(statusFilter, pattern, 2)),
    );
  }

  if (queueName === "episodeDistiller") {
    return sqliteCountFromRow(
      sqlite.db
        .query<{ count: number }, unknown[]>(
          `
          select count(*) as count
          from episode_distiller_queue q
          where (? is null or q.status = ?)
            and (
              ? is null
              or lower(q.source_key) like ?
              or lower(coalesce(q.source_uri, '')) like ?
            )
        `,
        )
        .get(...sqliteStatusPatternValues(statusFilter, pattern, 2)),
    );
  }

  if (queueName === "coveringEvidence") {
    return sqliteCountFromRow(
      sqlite.db
        .query<{ count: number }, unknown[]>(
          `
          select count(*) as count
          from covering_evidence_queue q
          left join found_candidates c on c.id = q.found_candidate_id
          where (? is null or q.status = ?)
            and (
              ? is null
              or lower(coalesce(c.title, '')) like ?
              or lower(coalesce(q.found_candidate_id, '')) like ?
            )
        `,
        )
        .get(...sqliteStatusPatternValues(statusFilter, pattern, 2)),
    );
  }

  if (queueName === "deadZoneMergeReview") {
    return sqliteCountFromRow(
      sqlite.db
        .query<{ count: number }, unknown[]>(
          `
          select count(*) as count
          from dead_zone_merge_review_queue q
          left join knowledge_items dz on dz.id = q.dead_zone_knowledge_id
          where (? is null or q.status = ?)
            and (
              ? is null
              or lower(coalesce(dz.title, '')) like ?
              or lower(coalesce(q.dead_zone_knowledge_id, '')) like ?
              or lower(coalesce(q.canonical_knowledge_id, '')) like ?
            )
        `,
        )
        .get(...sqliteStatusPatternValues(statusFilter, pattern, 3)),
    );
  }

  if (queueName === "landscapeCuration") {
    return sqliteCountFromRow(
      sqlite.db
        .query<{ count: number }, unknown[]>(`
      select count(*) as count from landscape_curation_queue q left join knowledge_items subject on subject.id = q.subject_knowledge_id
      where (? is null or q.status = ?) and (? is null or lower(coalesce(subject.title,'')) like ? or lower(q.subject_knowledge_id) like ?)
    `)
        .get(...sqliteStatusPatternValues(statusFilter, pattern, 2)),
    );
  }

  if (queueName === "mergeActivationFinalize") {
    return sqliteCountFromRow(
      sqlite.db
        .query<{ count: number }, unknown[]>(
          `
          select count(*) as count
          from merge_activation_finalize_queue q
          left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
          where (? is null or q.status = ?)
            and (
              ? is null
              or lower(coalesce(canonical.title, '')) like ?
              or lower(coalesce(q.dead_zone_knowledge_id, '')) like ?
              or lower(coalesce(q.canonical_knowledge_id, '')) like ?
              or lower(coalesce(q.merge_review_job_id, '')) like ?
            )
        `,
        )
        .get(...sqliteStatusPatternValues(statusFilter, pattern, 4)),
    );
  }

  return sqliteCountFromRow(
    sqlite.db
      .query<{ count: number }, unknown[]>(
        `
        select count(*) as count
        from (
          select
            q.status,
            coalesce(e.title, c.title) as subject_title,
            'evidence=' || coalesce(q.evidence_result_id, '') ||
              ' | knowledge=' || coalesce(q.knowledge_id, '-') as subject_detail
          from finalize_distille_queue q
          left join evidence_coverage_results e on e.id = q.evidence_result_id
          left join found_candidates c on c.id = e.found_candidate_id
          union all
          select
            q.status,
            canonical.title as subject_title,
            'deadZone=' || coalesce(q.dead_zone_knowledge_id, '') ||
              ' | canonical=' || coalesce(q.canonical_knowledge_id, '') ||
              ' | mergeReview=' || coalesce(q.merge_review_job_id, '') as subject_detail
          from merge_activation_finalize_queue q
          left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
        ) q
        where (? is null or q.status = ?)
          and (
            ? is null
            or lower(coalesce(q.subject_title, '')) like ?
            or lower(coalesce(q.subject_detail, '')) like ?
          )
      `,
      )
      .get(...sqliteStatusPatternValues(statusFilter, pattern, 2)),
  );
}

async function queryQueueRows(
  queueName: DistillationQueueName,
  params: {
    limit: number;
    offset: number;
    query?: string;
    status?: DistillationQueueStatus | "all";
    sortBy?: string;
    sortDir?: "asc" | "desc";
  },
): Promise<QueueListRow[]> {
  if (isSqliteBackend()) {
    return querySqliteQueueRows(await getSqliteCoreDatabase(), queueName, params);
  }

  const pattern = params.query?.trim() ? `%${params.query.trim()}%` : null;
  const statusFilter = params.status && params.status !== "all" ? params.status : null;
  const { sortBy, sortDir } = params;

  if (queueName === "findingCandidate") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        q.source_key as subject_title,
        concat(q.source_kind, ' | ', coalesce(q.source_uri, '')) as subject_detail,
        null::text as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        concat('input=', q.input_kind) as metadata_summary,
        q.source_kind,
        null::text as provider_policy
      from finding_candidate_queue q
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or q.source_key ilike ${pattern}
          or q.source_uri ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("findingCandidate", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "episodeDistiller") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        q.source_key as subject_title,
        concat(q.source_kind, ' | ', coalesce(q.source_uri, '')) as subject_detail,
        q.provider_policy as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        q.metadata->'episodeDistiller'->>'generated' as metadata_summary,
        q.source_kind,
        q.provider_policy
      from episode_distiller_queue q
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or q.source_key ilike ${pattern}
          or q.source_uri ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("episodeDistiller", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "coveringEvidence") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        c.title as subject_title,
        concat('candidate=', q.found_candidate_id, ' | policy=', q.provider_policy) as subject_detail,
        q.provider_policy as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        null::text as metadata_summary,
        null::text as source_kind,
        q.provider_policy
      from covering_evidence_queue q
      left join found_candidates c on c.id = q.found_candidate_id
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or c.title ilike ${pattern}
          or q.found_candidate_id::text ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("coveringEvidence", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "deadZoneMergeReview") {
    const result = await db.execute(sql`
      select
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        dz.title as subject_title,
        concat(
          'canonical=', coalesce(q.canonical_knowledge_id::text, '-'),
          ' | review=', coalesce(q.review_item_id::text, '-')
        ) as subject_detail,
        q.provider,
        q.model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        q.result->>'decision' as metadata_summary,
        null::text as source_kind,
        null::text as provider_policy
      from dead_zone_merge_review_queue q
      left join knowledge_items dz on dz.id = q.dead_zone_knowledge_id
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or dz.title ilike ${pattern}
          or q.dead_zone_knowledge_id::text ilike ${pattern}
          or q.canonical_knowledge_id::text ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("deadZoneMergeReview", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "landscapeCuration") {
    const result = await db.execute(sql`
      select q.id, q.status, q.priority, q.attempt_count, subject.title as subject_title,
        concat(q.finding_type, ' | decision=', coalesce(q.decision, '-')) as subject_detail,
        q.provider, q.model, q.last_error, q.last_outcome_kind, q.locked_by, q.locked_at, q.heartbeat_at,
        q.created_at, q.updated_at, q.completed_at, q.next_run_at, q.result->>'decision' as metadata_summary,
        null::text as source_kind, null::text as provider_policy
      from landscape_curation_queue q left join knowledge_items subject on subject.id = q.subject_knowledge_id
      where (${statusFilter}::text is null or q.status = ${statusFilter}) and (${pattern}::text is null or subject.title ilike ${pattern} or q.subject_knowledge_id::text ilike ${pattern})
      order by ${buildDynamicOrderBy("landscapeCuration", sortBy, sortDir)} limit ${params.limit} offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  if (queueName === "mergeActivationFinalize") {
    const result = await db.execute(sql`
      select
        'mergeActivationFinalize'::text as queue_name,
        'finalizeDistille'::text as visible_queue_name,
        'merge_activation_finalize'::text as job_type,
        'merge_activation_finalize_queue'::text as backend_kind,
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        canonical.title as subject_title,
        concat(
          'deadZone=', q.dead_zone_knowledge_id,
          ' | canonical=', q.canonical_knowledge_id,
          ' | mergeReview=', q.merge_review_job_id
        ) as subject_detail,
        q.provider,
        q.model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        coalesce(q.activation_result->>'outcome', q.last_outcome_kind) as metadata_summary,
        null::text as source_kind,
        null::text as provider_policy
      from merge_activation_finalize_queue q
      left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
      where (${statusFilter}::text is null or q.status = ${statusFilter})
        and (
          ${pattern}::text is null
          or canonical.title ilike ${pattern}
          or q.dead_zone_knowledge_id::text ilike ${pattern}
          or q.canonical_knowledge_id::text ilike ${pattern}
          or q.merge_review_job_id::text ilike ${pattern}
        )
      order by
        ${buildDynamicOrderBy("mergeActivationFinalize", sortBy, sortDir)}
      limit ${params.limit}
      offset ${params.offset}
    `);
    return result.rows as unknown as QueueListRow[];
  }

  const result = await db.execute(sql`
    select
      q.queue_name,
      q.visible_queue_name,
      q.job_type,
      q.backend_kind,
      q.id,
      q.status,
      q.priority,
      q.attempt_count,
      q.subject_title,
      q.subject_detail,
      q.provider_policy as provider,
      null::text as model,
      q.last_error,
      q.last_outcome_kind,
      q.locked_by,
      q.locked_at,
      q.heartbeat_at,
      q.created_at,
      q.updated_at,
      q.completed_at,
      null::timestamp as next_run_at,
      null::text as metadata_summary,
      null::text as source_kind,
      q.provider_policy
    from (
      select
        'finalizeDistille'::text as queue_name,
        'finalizeDistille'::text as visible_queue_name,
        'candidate_finalize'::text as job_type,
        'finalize_distille_queue'::text as backend_kind,
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        coalesce(e.title, c.title) as subject_title,
        concat(
          'evidence=', q.evidence_result_id,
          ' | knowledge=', coalesce(q.knowledge_id::text, '-')
        ) as subject_detail,
        q.provider_policy as provider,
        null::text as model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        null::timestamp as next_run_at,
        null::text as metadata_summary,
        null::text as source_kind,
        q.provider_policy
      from finalize_distille_queue q
      left join evidence_coverage_results e on e.id = q.evidence_result_id
      left join found_candidates c on c.id = e.found_candidate_id
      union all
      select
        'mergeActivationFinalize'::text as queue_name,
        'finalizeDistille'::text as visible_queue_name,
        'merge_activation_finalize'::text as job_type,
        'merge_activation_finalize_queue'::text as backend_kind,
        q.id,
        q.status,
        q.priority,
        q.attempt_count,
        canonical.title as subject_title,
        concat(
          'deadZone=', q.dead_zone_knowledge_id,
          ' | canonical=', q.canonical_knowledge_id,
          ' | mergeReview=', q.merge_review_job_id
        ) as subject_detail,
        q.provider,
        q.model,
        q.last_error,
        q.last_outcome_kind,
        q.locked_by,
        q.locked_at,
        q.heartbeat_at,
        q.created_at,
        q.updated_at,
        q.completed_at,
        q.next_run_at,
        coalesce(q.activation_result->>'outcome', q.last_outcome_kind) as metadata_summary,
        null::text as source_kind,
        null::text as provider_policy
      from merge_activation_finalize_queue q
      left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
    ) q
    where (${statusFilter}::text is null or q.status = ${statusFilter})
      and (
        ${pattern}::text is null
        or q.subject_title ilike ${pattern}
        or q.subject_detail ilike ${pattern}
      )
    order by
      ${buildDynamicOrderBy("finalizeDistille", sortBy, sortDir)}
    limit ${params.limit}
    offset ${params.offset}
  `);
  return result.rows as unknown as QueueListRow[];
}

async function countQueueRows(
  queueName: DistillationQueueName,
  params: { query?: string; status?: DistillationQueueStatus | "all" },
): Promise<number> {
  if (isSqliteBackend()) {
    return countSqliteQueueRows(await getSqliteCoreDatabase(), queueName, params);
  }

  const pattern = params.query?.trim() ? `%${params.query.trim()}%` : null;
  const statusFilter = params.status && params.status !== "all" ? params.status : null;
  const tableName = queueTableNameByQueue[queueName];

  const column =
    queueName === "findingCandidate" || queueName === "episodeDistiller"
      ? sql`q.source_key || ' ' || coalesce(q.source_uri, '')`
      : queueName === "finalizeDistille" || queueName === "mergeActivationFinalize"
        ? sql`coalesce(q.subject_title, q.subject_detail, q.id::text)`
        : queueName === "deadZoneMergeReview"
          ? sql`coalesce(dz.title, q.dead_zone_knowledge_id::text, q.canonical_knowledge_id::text)`
          : queueName === "landscapeCuration"
            ? sql`coalesce(subject.title, q.subject_knowledge_id::text)`
            : sql`coalesce(c.title, q.found_candidate_id::text)`;

  const joinSql =
    queueName === "findingCandidate" || queueName === "episodeDistiller"
      ? sql``
      : queueName === "finalizeDistille" || queueName === "mergeActivationFinalize"
        ? sql``
        : queueName === "deadZoneMergeReview"
          ? sql`left join knowledge_items dz on dz.id = q.dead_zone_knowledge_id`
          : queueName === "landscapeCuration"
            ? sql`left join knowledge_items subject on subject.id = q.subject_knowledge_id`
            : sql`left join found_candidates c on c.id = q.found_candidate_id`;

  const fromSql =
    queueName === "finalizeDistille"
      ? sql`(
          select
            q.id,
            coalesce(e.title, c.title) as subject_title,
            concat('evidence=', q.evidence_result_id, ' | knowledge=', coalesce(q.knowledge_id::text, '-')) as subject_detail,
            q.status
          from finalize_distille_queue q
          left join evidence_coverage_results e on e.id = q.evidence_result_id
          left join found_candidates c on c.id = e.found_candidate_id
          union all
          select
            q.id,
            canonical.title as subject_title,
            concat('deadZone=', q.dead_zone_knowledge_id, ' | canonical=', q.canonical_knowledge_id, ' | mergeReview=', q.merge_review_job_id) as subject_detail,
            q.status
          from merge_activation_finalize_queue q
          left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
        )`
      : queueName === "mergeActivationFinalize"
        ? sql`(
            select
              q.id,
              canonical.title as subject_title,
              concat('deadZone=', q.dead_zone_knowledge_id, ' | canonical=', q.canonical_knowledge_id, ' | mergeReview=', q.merge_review_job_id) as subject_detail,
              q.status
            from merge_activation_finalize_queue q
            left join knowledge_items canonical on canonical.id = q.canonical_knowledge_id
          )`
        : sql.raw(tableName);

  const result = await db.execute(sql`
    select count(*)::int as count
    from ${fromSql} q
    ${joinSql}
    where (${statusFilter}::text is null or q.status = ${statusFilter})
      and (${pattern}::text is null or ${column} ilike ${pattern})
  `);
  const row = result.rows[0] as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

async function queueStatsFor(queueName: DistillationQueueName) {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const tableName = queueTableNameByQueue[queueName];
    const fromSql =
      queueName === "finalizeDistille"
        ? `(
            select status, created_at, last_outcome_kind from finalize_distille_queue
            union all
            select status, created_at, last_outcome_kind from merge_activation_finalize_queue
          )`
        : tableName;
    const rows = sqlite.db
      .query<QueueStatsAggregateRow, []>(
        `
        select
          status,
          count(*) as count,
          min(case when status = 'pending' then created_at end) as oldest_pending_at,
          sum(
            case
              when status = 'failed'
                and (
                  coalesce(last_outcome_kind, '') = 'provider_failed'
                  or coalesce(last_outcome_kind, '') like '%provider_timeout%'
                  or coalesce(last_outcome_kind, '') like '%provider_failed%'
                )
              then 1
              else 0
            end
          ) as offline_count,
          sum(
            case
              when status = 'completed'
                and coalesce(last_outcome_kind, '') = 'insufficient'
              then 1
              else 0
            end
          ) as non_registered_count
        from ${fromSql}
        group by status
      `,
      )
      .all();
    return normalizeQueueStatsRows(queueName, rows);
  }

  const tableName = queueTableNameByQueue[queueName];
  const fromSql =
    queueName === "finalizeDistille"
      ? sql`(
          select status, created_at, last_outcome_kind from finalize_distille_queue
          union all
          select status, created_at, last_outcome_kind from merge_activation_finalize_queue
        )`
      : sql.raw(tableName);
  const result = await db.execute(sql`
    select
      status,
      count(*)::int as count,
      min(case when status = 'pending' then created_at end) as oldest_pending_at,
      count(*) filter (
        where status = 'failed'
          and (
            coalesce(last_outcome_kind, '') = 'provider_failed'
            or coalesce(last_outcome_kind, '') like '%provider_timeout%'
            or coalesce(last_outcome_kind, '') like '%provider_failed%'
          )
      )::int as offline_count,
      count(*) filter (
        where status = 'completed'
          and coalesce(last_outcome_kind, '') = 'insufficient'
      )::int as non_registered_count
    from ${fromSql}
    group by status
  `);
  const rows = result.rows as unknown as QueueStatsAggregateRow[];
  return normalizeQueueStatsRows(queueName, rows);
}

function normalizeQueueStatsRows(
  queueName: DistillationQueueName,
  rows: QueueStatsAggregateRow[],
): QueueStatsByQueue[DistillationQueueName] {
  const counters = emptyCounters();
  let oldestPendingAt: string | null = null;
  let offline = 0;
  let nonRegistered = 0;
  for (const row of rows) {
    if (distillationQueueStatuses.includes(row.status as DistillationQueueStatus)) {
      counters[row.status as DistillationQueueStatus] = Number(row.count ?? 0);
    }
    if (!oldestPendingAt) {
      const normalized = toIsoTimestamp(row.oldest_pending_at);
      if (normalized) {
        oldestPendingAt = normalized;
      }
    }
    offline += Number(row.offline_count ?? 0);
    nonRegistered += Number(row.non_registered_count ?? 0);
  }
  if (queueName !== "coveringEvidence") {
    nonRegistered = 0;
  }
  return {
    counters,
    oldestPendingAt,
    running: counters.running,
    failed: counters.failed,
    offline,
    nonRegistered,
  };
}

export async function fetchQueueDashboardStats(): Promise<{
  queues: QueueStatsByVisibleQueue;
  totals: QueueStatsByQueue[DistillationQueueName];
  queueControls: QueueControlStatesByQueue;
}> {
  const [values, queueControls] = await Promise.all([
    Promise.all(distillationQueueNames.map((queueName) => queueStatsFor(queueName))),
    getQueueControlStates(),
  ]);
  const allQueues = Object.fromEntries(
    distillationQueueNames.map((queueName, index) => [queueName, values[index]]),
  ) as QueueStatsByQueue;
  const queues = Object.fromEntries(
    visibleDistillationQueueNames.map((queueName) => [queueName, allQueues[queueName]]),
  ) as QueueStatsByVisibleQueue;
  const visibleQueueControls = Object.fromEntries(
    visibleDistillationQueueNames.map((queueName) => [queueName, queueControls[queueName]]),
  ) as QueueControlStatesByQueue;

  const totals = {
    counters: emptyCounters(),
    oldestPendingAt: null,
    running: 0,
    failed: 0,
    offline: 0,
    nonRegistered: 0,
  } as QueueStatsByQueue[DistillationQueueName];

  for (const queueName of visibleDistillationQueueNames) {
    const snapshot = queues[queueName];
    for (const status of distillationQueueStatuses) {
      totals.counters[status] += snapshot.counters[status];
    }
    totals.running += snapshot.running;
    totals.failed += snapshot.failed;
    totals.offline += snapshot.offline;
    totals.nonRegistered += snapshot.nonRegistered;
    if (snapshot.oldestPendingAt) {
      if (
        !totals.oldestPendingAt ||
        Date.parse(snapshot.oldestPendingAt) < Date.parse(totals.oldestPendingAt)
      ) {
        totals.oldestPendingAt = snapshot.oldestPendingAt;
      }
    }
  }

  return { queues, totals, queueControls: visibleQueueControls };
}

export async function listQueueItems(params: QueueListQuery) {
  await ensureRuntimeSettingsLoaded();
  const queueName = params.queue ?? "findingCandidate";
  const page = Math.max(1, params.page);
  const limit = Math.max(1, Math.min(100, params.limit));
  const offset = (page - 1) * limit;

  const [rows, total] = await Promise.all([
    queryQueueRows(queueName, {
      limit,
      offset,
      query: params.query,
      status: params.status,
      sortBy: params.sortBy,
      sortDir: params.sortDir,
    }),
    countQueueRows(queueName, {
      query: params.query,
      status: params.status,
    }),
  ]);

  const enrichedRows = await attachActiveProviderLeases(rows.map((row) => ({ queueName, row })));

  return {
    queue: queueName,
    items: enrichedRows.map((row) => normalizeRow(queueName, row)),
    total,
    page,
    limit,
  };
}

export async function fetchActiveTasks(): Promise<QueueListItem[]> {
  await ensureRuntimeSettingsLoaded();
  const responses = await Promise.all(
    distillationQueueNames.map((queueName) =>
      queryQueueRows(queueName, { limit: 50, offset: 0, status: "running" }),
    ),
  );

  const sources = responses.flatMap((rows, index) =>
    rows.map((row) => ({ queueName: distillationQueueNames[index], row })),
  );
  const enrichedRows = await attachActiveProviderLeases(sources);

  return enrichedRows
    .map((row, index) => normalizeRow(sources[index].queueName, row))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function pauseTarget(queueName: DistillationQueueName, id: string, reason: string) {
  const row = await pauseQueueJob({ queueName, id, reason });
  if (!row) return null;
  await appendQueueEvent({
    queueName,
    queueJobId: id,
    eventType: "paused",
    message: reason,
  });
  return row;
}

export async function resumeTarget(queueName: DistillationQueueName, id: string) {
  const row = await resumeQueueJob({ queueName, id });
  if (!row) return null;
  await appendQueueEvent({
    queueName,
    queueJobId: id,
    eventType: "resumed",
    message: "resumed from queue control",
  });
  return row;
}

export async function retryTarget(params: {
  queueName: DistillationQueueName;
  id: string;
  mode: QueueRetryMode;
  forceRefreshEvidence: boolean;
  reason?: string;
}) {
  const row = await retryQueueJob(params);
  if (!row) return null;
  await appendQueueEvent({
    queueName: params.queueName,
    queueJobId: params.id,
    eventType: "retried",
    message: params.reason ?? null,
    metadata: {
      mode: params.mode,
      forceRefreshEvidence: params.forceRefreshEvidence,
    },
  });
  return row;
}

export async function pauseQueueLane(queueName: DistillationQueueName, reason?: string) {
  const queueControls = await setQueuePaused({
    queueName,
    paused: true,
    reason,
    updatedBy: "queue-dashboard",
  });

  const pausedRunningCount = await pauseRunningQueueJobs({
    queueName,
    reason: reason ?? "paused from queue lane control",
  });
  let mergedPausedRunningCount = 0;
  if (queueName === "finalizeDistille") {
    await setQueuePaused({
      queueName: "mergeActivationFinalize",
      paused: true,
      reason,
      updatedBy: "queue-dashboard",
    });
    mergedPausedRunningCount = await pauseRunningQueueJobs({
      queueName: "mergeActivationFinalize",
      reason: reason ?? "paused from queue lane control",
    });
  }

  return {
    queueName,
    state: queueControls[queueName],
    pausedRunningCount: pausedRunningCount + mergedPausedRunningCount,
  };
}

export async function resumeQueueLane(queueName: DistillationQueueName, reason?: string) {
  const queueControls = await setQueuePaused({
    queueName,
    paused: false,
    reason,
    updatedBy: "queue-dashboard",
  });
  if (queueName === "finalizeDistille") {
    await setQueuePaused({
      queueName: "mergeActivationFinalize",
      paused: false,
      reason,
      updatedBy: "queue-dashboard",
    });
  }

  return {
    queueName,
    state: queueControls[queueName],
    reason: reason ?? null,
  };
}
