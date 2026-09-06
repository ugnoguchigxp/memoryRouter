import { groupedConfig } from "../../../config.js";
import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { getRuntimeSettingsSnapshot } from "../../settings/settings.service.js";
import { isLarmAgentConnectionRoute } from "../../settings/settings.types.js";
import type {
  RuntimeProviderPool,
  RuntimeProviderPoolTarget,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "../../settings/settings.types.js";
import { isQueuePaused } from "./control.js";
import { routeClaimGroupId } from "./scheduler.js";
import type { DistillationQueueName } from "./types.js";
import { queueTableNameByQueue } from "./types.js";

export type ProviderLease = {
  id: string;
  poolId: string;
  targetId: string;
  queueName: DistillationQueueName;
  queueJobId: string;
  workerId: string;
};

export type QueueJobWithProviderLease = {
  queueName: DistillationQueueName;
  id: string;
  providerLease: ProviderLease;
};

type RunnableCandidate = {
  queueName: DistillationQueueName;
  tableName: string;
  id: string;
  queueOrder: number;
  effectivePriority: number;
  priority: number;
  createdAtMs: number;
  preferredTargetIds: Set<string>;
};

type RunnableQueueRow = {
  id: string;
  priority: number;
  created_at: string;
  source_kind?: string | null;
  provider_policy?: string | null;
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

function targetId(target: RuntimeProviderPoolTarget): string {
  if (target.provider === "larm-agent-connection") return target.connectionId;
  if (target.provider === "local-llm") return target.localLlmModelId;
  if (target.provider === "azure-openai") return String(target.deploymentSlot);
  return target.targetId;
}

function parseLocalLlmRouteTarget(
  value: string | undefined,
): { apiBaseUrl: string; apiPath?: string; model: string } | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<{
      apiBaseUrl: string;
      apiPath: string;
      model: string;
    }>;
    if (typeof parsed.apiBaseUrl === "string" && typeof parsed.model === "string") {
      const apiBaseUrl = parsed.apiBaseUrl.trim().replace(/\/+$/, "");
      const apiPath =
        typeof parsed.apiPath === "string" && parsed.apiPath.trim()
          ? parsed.apiPath.trim()
          : undefined;
      const model = parsed.model.trim();
      if (apiBaseUrl && model) return { apiBaseUrl, apiPath, model };
    }
  } catch {
    // Legacy route values are plain model names.
  }
  return null;
}

function queueRoutes(
  settings: RuntimeSettingsEditable,
  queueName: DistillationQueueName,
): RuntimeSettingsRoute[] {
  if (queueName === "findingCandidate") {
    return [settings.taskRouting.findCandidate.source, settings.taskRouting.findCandidate.vibe];
  }
  if (queueName === "episodeDistiller") return [settings.taskRouting.episodeDistiller];
  if (queueName === "coveringEvidence") {
    return [
      settings.taskRouting.coverEvidence.sourceSupport,
      settings.taskRouting.coverEvidence.externalEvidence,
      settings.taskRouting.coverEvidence.mcpEvidence,
    ];
  }
  if (queueName === "deadZoneMergeReview") return [settings.taskRouting.deadZoneMergeReview];
  if (queueName === "mergeActivationFinalize") {
    return [settings.taskRouting.mergeActivationFinalize];
  }
  return [settings.taskRouting.finalizeDistille];
}

function routeForFindingCandidateRow(
  settings: RuntimeSettingsEditable,
  row: Pick<RunnableQueueRow, "source_kind">,
): RuntimeSettingsRoute {
  return row.source_kind === "vibe_memory"
    ? settings.taskRouting.findCandidate.vibe
    : settings.taskRouting.findCandidate.source;
}

function candidateRoutes(params: {
  settings: RuntimeSettingsEditable;
  queueName: DistillationQueueName;
  row: Pick<RunnableQueueRow, "source_kind" | "provider_policy">;
}): RuntimeSettingsRoute[] {
  if (params.queueName === "findingCandidate") {
    return [routeForFindingCandidateRow(params.settings, params.row)];
  }
  return queueRoutes(params.settings, params.queueName);
}

export function candidateUsesLarmRoute(params: {
  settings: RuntimeSettingsEditable;
  queueName: DistillationQueueName;
  row: {
    source_kind?: string | null;
    provider_policy?: string | null;
  };
}): boolean {
  return candidateRoutes(params).some(isLarmAgentConnectionRoute);
}

function preferredTargetIdsForQueue(params: {
  settings: RuntimeSettingsEditable;
  queueName: DistillationQueueName;
  poolId: string;
  row?: RunnableQueueRow;
}): Set<string> {
  const preferred = new Set<string>();
  for (const route of params.row
    ? candidateRoutes({
        settings: params.settings,
        queueName: params.queueName,
        row: params.row,
      })
    : queueRoutes(params.settings, params.queueName)) {
    if (isLarmAgentConnectionRoute(route)) continue;
    if (routeClaimGroupId(route) !== params.poolId) continue;
    if (route.providerPoolId?.trim()) continue;
    if (route.provider === "local-llm") {
      const routeTarget = parseLocalLlmRouteTarget(route.localLlmModel ?? route.model);
      const matched = routeTarget
        ? params.settings.providers["local-llm"].models.find(
            (model) =>
              model.apiBaseUrl.trim().replace(/\/+$/, "") === routeTarget.apiBaseUrl &&
              (!routeTarget.apiPath || model.apiPath === routeTarget.apiPath) &&
              model.model === routeTarget.model,
          )
        : params.settings.providers["local-llm"].models.find(
            (model) =>
              model.id === route.model ||
              model.id === route.localLlmModel ||
              model.name === route.model ||
              model.name === route.localLlmModel ||
              model.model === route.model ||
              model.model === route.localLlmModel,
          );
      if (matched?.id) preferred.add(matched.id);
    } else if (route.provider === "azure-openai") {
      for (const slot of route.azureDeploymentSlots ?? []) preferred.add(String(slot));
    }
  }
  return preferred;
}

function sortTargetsForQueue(
  targets: RuntimeProviderPoolTarget[],
  preferredTargetIds: Set<string>,
): RuntimeProviderPoolTarget[] {
  return [...targets].sort((a, b) => {
    const aPreferred = preferredTargetIds.has(targetId(a));
    const bPreferred = preferredTargetIds.has(targetId(b));
    if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
    return 0;
  });
}

function eligibleTargetsForQueue(
  targets: RuntimeProviderPoolTarget[],
  preferredTargetIds: Set<string>,
): RuntimeProviderPoolTarget[] {
  const staticTargets = targets.filter((target) => target.provider !== "larm-agent-connection");
  if (preferredTargetIds.size === 0) return staticTargets;
  return staticTargets.filter((target) => preferredTargetIds.has(targetId(target)));
}

function activePoolCapacity(pool: RuntimeProviderPool): number {
  return Math.max(1, Math.min(pool.maxConcurrent, pool.targets.length));
}

function sqliteTimestamp(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function staleCutoffTimestamp(pool: RuntimeProviderPool): string {
  const seconds = Math.max(30, Math.floor(pool.staleLeaseSeconds));
  return sqliteTimestamp(new Date(Date.now() - seconds * 1000));
}

function recoverStaleQueueJobsSql(tableName: string): string {
  return `
    update ${tableName}
    set
      status = 'paused',
      next_run_at = CURRENT_TIMESTAMP,
      locked_by = null,
      locked_at = null,
      heartbeat_at = null,
      last_error = coalesce(last_error, 'stale_running_recovered'),
      last_outcome_kind = 'stale_recovered',
      updated_at = CURRENT_TIMESTAMP
    where status = 'running'
      and coalesce(heartbeat_at, locked_at, updated_at) < ?
  `;
}

function runnableSql(queueName: DistillationQueueName, tableName: string): string {
  const extraColumns =
    queueName === "findingCandidate"
      ? ", source_kind"
      : queueName === "coveringEvidence"
        ? ", provider_policy"
        : "";
  return `
    select id, priority, created_at${extraColumns}
    from ${tableName}
    where (
      (status = 'pending' and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP))
      or (status = 'paused' and next_run_at is not null and datetime(next_run_at) <= CURRENT_TIMESTAMP)
    )
    order by priority desc, created_at asc, id asc
    limit 20
  `;
}

function sortCandidates(a: RunnableCandidate, b: RunnableCandidate): number {
  if (a.queueOrder !== b.queueOrder) return a.queueOrder - b.queueOrder;
  if (a.effectivePriority !== b.effectivePriority) return a.effectivePriority - b.effectivePriority;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  return a.id.localeCompare(b.id);
}

function rowCreatedAtMs(value: unknown): number {
  const ms = new Date(String(value)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export async function recoverStaleProviderLeases(pool: RuntimeProviderPool): Promise<number> {
  if (!isSqliteBackend()) return 0;
  const sqlite = await getSqliteCoreDatabase();
  const result = sqlite.db
    .query(
      `
      update llm_provider_leases
      set
        status = 'stale_recovered',
        released_at = CURRENT_TIMESTAMP,
        release_reason = 'stale_heartbeat',
        updated_at = CURRENT_TIMESTAMP
      where pool_id = ?
        and status = 'active'
        and coalesce(heartbeat_at, locked_at, updated_at) < ?
    `,
    )
    .run(pool.id, staleCutoffTimestamp(pool));
  return Number(result.changes ?? 0);
}

export async function heartbeatProviderLease(leaseId: string): Promise<void> {
  if (!isSqliteBackend()) return;
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `
      update llm_provider_leases
      set heartbeat_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      where id = ?
        and status = 'active'
    `,
    )
    .run(leaseId);
}

export async function releaseProviderLease(
  leaseId: string,
  reason = "worker_finished",
): Promise<void> {
  if (!isSqliteBackend()) return;
  const sqlite = await getSqliteCoreDatabase();
  sqlite.db
    .query(
      `
      update llm_provider_leases
      set status = 'released',
          released_at = CURRENT_TIMESTAMP,
          release_reason = ?,
          updated_at = CURRENT_TIMESTAMP
      where id = ?
        and status = 'active'
    `,
    )
    .run(reason, leaseId);
}

export async function countAvailableProviderPoolSlots(pool: RuntimeProviderPool): Promise<number> {
  if (!isSqliteBackend() || !pool.enabled) return 0;
  await recoverStaleProviderLeases(pool);
  const sqlite = await getSqliteCoreDatabase();
  const row = sqlite.db
    .query<{ count: number }, [string]>(
      "select count(*) as count from llm_provider_leases where pool_id = ? and status = 'active'",
    )
    .get(pool.id);
  return Math.max(0, activePoolCapacity(pool) - Number(row?.count ?? 0));
}

export async function claimNextJobWithProviderLease(params: {
  pool: RuntimeProviderPool;
  priorityQueues: DistillationQueueName[];
  workerId: string;
}): Promise<QueueJobWithProviderLease | null> {
  if (!params.pool.enabled || params.pool.targets.length === 0) return null;
  if (!isSqliteBackend()) return null;

  const sqlite = await getSqliteCoreDatabase();
  const queueStaleSeconds = Math.max(
    30,
    Math.min(120, Math.floor(groupedConfig.distillation.lockTtlSeconds)),
  );
  const queueStaleCutoff = sqliteTimestamp(new Date(Date.now() - queueStaleSeconds * 1000));
  const nowMs = Date.now();
  const agingSeconds = Math.max(60, Math.floor(params.pool.lowPriorityAgingSeconds));
  const pausedQueues = new Set<DistillationQueueName>();
  await Promise.all(
    params.priorityQueues.map(async (queueName) => {
      if (await isQueuePaused(queueName)) pausedQueues.add(queueName);
    }),
  );

  sqlite.db.query("BEGIN IMMEDIATE").run();
  try {
    sqlite.db
      .query(
        `
        update llm_provider_leases
        set
          status = 'stale_recovered',
          released_at = CURRENT_TIMESTAMP,
          release_reason = 'stale_heartbeat',
          updated_at = CURRENT_TIMESTAMP
        where pool_id = ?
          and status = 'active'
          and coalesce(heartbeat_at, locked_at, updated_at) < ?
      `,
      )
      .run(params.pool.id, staleCutoffTimestamp(params.pool));

    const activeLeaseCount =
      sqlite.db
        .query<{ count: number }, [string]>(
          "select count(*) as count from llm_provider_leases where pool_id = ? and status = 'active'",
        )
        .get(params.pool.id)?.count ?? 0;
    if (Number(activeLeaseCount) >= activePoolCapacity(params.pool)) {
      sqlite.db.query("COMMIT").run();
      return null;
    }

    const activeTargets = new Set(
      (
        sqlite.db
          .query<{ target_id: string }, []>(
            "select target_id from llm_provider_leases where status = 'active'",
          )
          .all() ?? []
      ).map((row) => row.target_id),
    );
    const freeTargets = params.pool.targets.filter(
      (target) => !activeTargets.has(targetId(target)),
    );
    if (freeTargets.length === 0) {
      sqlite.db.query("COMMIT").run();
      return null;
    }

    const settings = getRuntimeSettingsSnapshot();
    const candidates: RunnableCandidate[] = [];
    for (const [queueOrder, queueName] of params.priorityQueues.entries()) {
      if (pausedQueues.has(queueName)) continue;
      const tableName = queueTableNameByQueue[queueName];
      sqlite.db.query(recoverStaleQueueJobsSql(tableName)).run(queueStaleCutoff);
      const rows = sqlite.db.query<RunnableQueueRow, []>(runnableSql(queueName, tableName)).all();
      for (const row of rows) {
        if (candidateUsesLarmRoute({ settings, queueName, row })) continue;
        const createdAtMs = rowCreatedAtMs(row.created_at);
        const waitingSeconds = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
        const preferredTargetIds = preferredTargetIdsForQueue({
          settings,
          queueName,
          poolId: params.pool.id,
          row,
        });
        candidates.push({
          queueName,
          tableName,
          id: row.id,
          queueOrder,
          effectivePriority: -Math.floor(waitingSeconds / agingSeconds),
          priority: Number(row.priority ?? 0),
          createdAtMs,
          preferredTargetIds,
        });
      }
    }

    let picked: RunnableCandidate | null = null;
    let selectedTarget: RuntimeProviderPoolTarget | undefined;
    for (const candidate of candidates.sort(sortCandidates)) {
      const eligibleTargets = eligibleTargetsForQueue(freeTargets, candidate.preferredTargetIds);
      selectedTarget = sortTargetsForQueue(eligibleTargets, candidate.preferredTargetIds)[0];
      if (!selectedTarget) continue;
      picked = candidate;
      break;
    }
    if (!picked || !selectedTarget) {
      sqlite.db.query("COMMIT").run();
      return null;
    }
    const selectedTargetId = targetId(selectedTarget);

    sqlite.db
      .query(
        `
        update ${picked.tableName}
        set
          status = 'running',
          locked_by = ?,
          locked_at = CURRENT_TIMESTAMP,
          heartbeat_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        where id = ?
          and (
            (status = 'pending' and (next_run_at is null or datetime(next_run_at) <= CURRENT_TIMESTAMP))
            or (status = 'paused' and next_run_at is not null and datetime(next_run_at) <= CURRENT_TIMESTAMP)
          )
      `,
      )
      .run(params.workerId, picked.id);

    const leaseId = crypto.randomUUID();
    sqlite.db
      .query(
        `
        insert into llm_provider_leases (
          id, pool_id, target_id, queue_name, queue_job_id, worker_id,
          status, locked_at, heartbeat_at, expires_at, metadata, created_at, updated_at
        ) values (
          ?, ?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
          datetime(CURRENT_TIMESTAMP, '+' || ? || ' seconds'), '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `,
      )
      .run(
        leaseId,
        params.pool.id,
        selectedTargetId,
        picked.queueName,
        picked.id,
        params.workerId,
        Math.max(30, Math.floor(params.pool.staleLeaseSeconds)),
      );

    sqlite.db.query("COMMIT").run();
    return {
      queueName: picked.queueName,
      id: picked.id,
      providerLease: {
        id: leaseId,
        poolId: params.pool.id,
        targetId: selectedTargetId,
        queueName: picked.queueName,
        queueJobId: picked.id,
        workerId: params.workerId,
      },
    };
  } catch (error) {
    sqlite.db.query("ROLLBACK").run();
    throw error;
  }
}
