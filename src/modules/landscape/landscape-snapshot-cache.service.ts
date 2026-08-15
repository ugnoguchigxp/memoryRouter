import { createHash } from "node:crypto";
import { landscapeSnapshotCacheTypeValues } from "../../db/schema.js";
import { auditEventTypes, listAuditLogs, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  type LandscapeSnapshotCacheType,
  deleteLandscapeSnapshotCacheRows,
  deleteStaleOrExpiredLandscapeSnapshotCacheRows,
  findLandscapeSnapshotCache,
  listLandscapeSnapshotCacheSummaryRows,
  markExpiredLandscapeSnapshotCacheAsStale,
  upsertLandscapeSnapshotCache,
} from "./landscape-snapshot-cache.repository.js";

export type { LandscapeSnapshotCacheType } from "./landscape-snapshot-cache.repository.js";

const DEFAULT_TTL_SECONDS = 5 * 60;
const LANDSCAPE_CACHE_SEMANTICS_VERSION = 2;

type SnapshotPurgeSummary = {
  purgedAt: string;
  staleDeletedCount: number;
  expiredDeletedCount: number;
  deletedCount: number;
  snapshotTypes: LandscapeSnapshotCacheType[];
  error: string | null;
};

export type LandscapeSnapshotCacheStatus = {
  generatedAt: string;
  enabled: boolean;
  ttlSeconds: number;
  disabledReason?: string | null;
  snapshots: Array<{
    snapshotType: LandscapeSnapshotCacheType;
    readyCount: number;
    staleCount: number;
    expiredReadyCount: number;
    oldestGeneratedAt: string | null;
    latestGeneratedAt: string | null;
    latestExpiresAt: string | null;
    estimatedPayloadBytes: number;
    lastPurge: SnapshotPurgeSummary | null;
  }>;
};

export type LandscapeSnapshotCachePurgeResult = {
  purgedAt: string;
  requestedSnapshotTypes: LandscapeSnapshotCacheType[];
  staleDeletedCount: number;
  expiredDeletedCount: number;
  deletedCount: number;
  bySnapshotType: Record<
    LandscapeSnapshotCacheType,
    { deletedCount: number; staleDeletedCount: number; expiredDeletedCount: number }
  >;
  error: string | null;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}

function cacheEnabled(): boolean {
  const raw = (process.env.LANDSCAPE_SNAPSHOT_CACHE_ENABLED ?? "false").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

function cacheTtlSeconds(): number {
  const parsed = Number(process.env.LANDSCAPE_SNAPSHOT_CACHE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  return Math.trunc(parsed);
}

function cacheHash(params: Record<string, unknown>): string {
  return createHash("sha1")
    .update(
      stableStringify({
        landscapeCacheSemanticsVersion: LANDSCAPE_CACHE_SEMANTICS_VERSION,
        params,
      }),
    )
    .digest("hex");
}

function toIsoStringOrNull(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function emptyPurgeSummaryMap(): Record<LandscapeSnapshotCacheType, SnapshotPurgeSummary | null> {
  return {
    landscape_snapshot: null,
    landscape_replay_snapshot: null,
    landscape_replay_comparison: null,
  };
}

function asLandscapeSnapshotTypes(value: unknown): LandscapeSnapshotCacheType[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is LandscapeSnapshotCacheType =>
      item === "landscape_snapshot" ||
      item === "landscape_replay_snapshot" ||
      item === "landscape_replay_comparison",
  );
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

async function loadLastPurgeBySnapshotType(): Promise<
  Record<LandscapeSnapshotCacheType, SnapshotPurgeSummary | null>
> {
  try {
    const logs = await listAuditLogs({
      eventType: auditEventTypes.landscapeSnapshotCachePurge,
      page: 1,
      limit: 50,
    });
    const byType = emptyPurgeSummaryMap();

    for (const log of logs.items) {
      const payload = log.payload ?? {};
      const snapshotTypes = asLandscapeSnapshotTypes(payload.requestedSnapshotTypes);
      if (snapshotTypes.length === 0) continue;

      const summary: SnapshotPurgeSummary = {
        purgedAt: asNullableString(payload.purgedAt) ?? log.createdAt.toISOString(),
        staleDeletedCount: asNonNegativeInt(payload.staleDeletedCount),
        expiredDeletedCount: asNonNegativeInt(payload.expiredDeletedCount),
        deletedCount: asNonNegativeInt(payload.deletedCount),
        snapshotTypes,
        error: asNullableString(payload.error),
      };

      for (const snapshotType of snapshotTypes) {
        if (!byType[snapshotType]) {
          byType[snapshotType] = summary;
        }
      }

      if (Object.values(byType).every((value) => value !== null)) {
        break;
      }
    }

    return byType;
  } catch {
    return emptyPurgeSummaryMap();
  }
}

export function isLandscapeSnapshotCacheEnabled(): boolean {
  return cacheEnabled();
}

export function landscapeSnapshotCacheTtlSeconds(): number {
  return cacheTtlSeconds();
}

export async function getLandscapeSnapshotCacheStatus(): Promise<LandscapeSnapshotCacheStatus> {
  const [summaryRows, lastPurgeByType] = await Promise.all([
    listLandscapeSnapshotCacheSummaryRows(),
    loadLastPurgeBySnapshotType(),
  ]);
  const rowByType = new Map(summaryRows.map((row) => [row.snapshotType, row]));
  const enabled = cacheEnabled();

  return {
    generatedAt: new Date().toISOString(),
    enabled,
    ttlSeconds: cacheTtlSeconds(),
    disabledReason: enabled ? null : "LANDSCAPE_SNAPSHOT_CACHE_ENABLED is false",
    snapshots: landscapeSnapshotCacheTypeValues.map((snapshotType) => {
      const row = rowByType.get(snapshotType);
      return {
        snapshotType,
        readyCount: row?.readyCount ?? 0,
        staleCount: row?.staleCount ?? 0,
        expiredReadyCount: row?.expiredReadyCount ?? 0,
        oldestGeneratedAt: toIsoStringOrNull(row?.oldestGeneratedAt ?? null),
        latestGeneratedAt: toIsoStringOrNull(row?.latestGeneratedAt ?? null),
        latestExpiresAt: toIsoStringOrNull(row?.latestExpiresAt ?? null),
        estimatedPayloadBytes: row?.estimatedPayloadBytes ?? 0,
        lastPurge: lastPurgeByType[snapshotType],
      };
    }),
  };
}

export async function clearLandscapeSnapshotCache(input?: {
  snapshotTypes?: LandscapeSnapshotCacheType[];
}): Promise<number> {
  return deleteLandscapeSnapshotCacheRows(input);
}

export async function purgeLandscapeSnapshotCache(input?: {
  snapshotTypes?: LandscapeSnapshotCacheType[];
}): Promise<LandscapeSnapshotCachePurgeResult> {
  const requestedSnapshotTypes =
    input?.snapshotTypes && input.snapshotTypes.length > 0
      ? input.snapshotTypes
      : [...landscapeSnapshotCacheTypeValues];

  const purgedAt = new Date().toISOString();
  try {
    const deleted = await deleteStaleOrExpiredLandscapeSnapshotCacheRows({
      snapshotTypes: requestedSnapshotTypes,
    });

    const result: LandscapeSnapshotCachePurgeResult = {
      purgedAt,
      requestedSnapshotTypes,
      staleDeletedCount: deleted.staleDeletedCount,
      expiredDeletedCount: deleted.expiredDeletedCount,
      deletedCount: deleted.deletedCount,
      bySnapshotType: deleted.bySnapshotType,
      error: null,
    };

    await recordAuditLogSafe({
      eventType: auditEventTypes.landscapeSnapshotCachePurge,
      actor: "agent",
      payload: result,
    });

    return result;
  } catch (error) {
    const result: LandscapeSnapshotCachePurgeResult = {
      purgedAt,
      requestedSnapshotTypes,
      staleDeletedCount: 0,
      expiredDeletedCount: 0,
      deletedCount: 0,
      bySnapshotType: {
        landscape_snapshot: { deletedCount: 0, staleDeletedCount: 0, expiredDeletedCount: 0 },
        landscape_replay_snapshot: {
          deletedCount: 0,
          staleDeletedCount: 0,
          expiredDeletedCount: 0,
        },
        landscape_replay_comparison: {
          deletedCount: 0,
          staleDeletedCount: 0,
          expiredDeletedCount: 0,
        },
      },
      error: error instanceof Error ? error.message : String(error),
    };

    await recordAuditLogSafe({
      eventType: auditEventTypes.landscapeSnapshotCachePurge,
      actor: "system",
      payload: result,
    });

    return result;
  }
}

export async function runWithLandscapeSnapshotCache<T extends Record<string, unknown>>(input: {
  snapshotType: LandscapeSnapshotCacheType;
  params: Record<string, unknown>;
  build: () => Promise<T>;
}): Promise<T> {
  if (!cacheEnabled()) {
    return input.build();
  }

  const ttlSeconds = cacheTtlSeconds();
  const paramsHash = cacheHash(input.params);
  try {
    void markExpiredLandscapeSnapshotCacheAsStale().catch(() => undefined);
    const cached = await findLandscapeSnapshotCache({
      snapshotType: input.snapshotType,
      paramsHash,
    });
    if (cached) {
      return cached.payload as T;
    }
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.landscapeSnapshotCacheReadFailed,
      actor: "system",
      payload: {
        snapshotType: input.snapshotType,
        paramsHash,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  const built = await input.build();

  try {
    await upsertLandscapeSnapshotCache({
      snapshotType: input.snapshotType,
      paramsHash,
      params: input.params,
      payload: built,
      ttlSeconds,
    });
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.landscapeSnapshotCacheWriteFailed,
      actor: "system",
      payload: {
        snapshotType: input.snapshotType,
        paramsHash,
        ttlSeconds,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  return built;
}
