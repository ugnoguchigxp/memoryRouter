import { randomUUID } from "node:crypto";
import { type SQL, and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../../src/db/backend.js";
import { db } from "../../../src/db/index.js";
import { contextPackItems, knowledgeItems } from "../../../src/db/schema.js";
import { SqliteCoreRepository } from "../../../src/db/sqlite/core-repository.js";
import { sqliteKnowledgeItems } from "../../../src/db/sqlite/schema.js";
import { normalizeKnowledgeScore } from "../../../src/lib/score-scale.js";
import {
  auditEventTypes,
  recordAuditLogSafe,
} from "../../../src/modules/audit/audit-log.service.js";
import {
  assertAuditedStoredProjectScopedIdentityCompatible,
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../../../src/modules/context-compiler/project-scoped-write.js";
import { embedOne } from "../../../src/modules/embedding/embedding.service.js";
import { canTransitionKnowledgeStatus } from "../../../src/modules/knowledge/knowledge-lifecycle.service.js";
import {
  type KnowledgeTagKind,
  type KnowledgeTagStatus,
  listKnowledgeTagDefinitions,
} from "../../../src/modules/knowledge/knowledge-tags.repository.js";
import {
  computeDecayFactor,
  computeDynamicScore,
} from "../../../src/modules/knowledge/knowledge-value.service.js";
import { linkKnowledgeFromMetadata } from "../../../src/modules/knowledge/source-linking.service.js";
import type { KnowledgeStatus } from "../../../src/shared/schemas/knowledge.schema.js";
import {
  asRecord,
  buildKnowledgeListOrderBy,
  buildKnowledgeListWhere,
  buildNormalizedApplicability,
  extractSourceRefs,
  extractSourceVibeMemoryIds,
  isMissingKnowledgeLifecycleColumnsError,
  mergeApplicabilityMetadata,
  mergeNormalizedApplicability,
} from "./knowledge.repository.helpers.js";
import type {
  BulkKnowledgeStatusUpdateParams,
  BulkKnowledgeStatusUpdateResult,
  KnowledgeCreateInput,
  KnowledgeFeedbackDirection,
  KnowledgeFeedbackResult,
  KnowledgeListItem,
  KnowledgeListParams,
  KnowledgeListSortBy,
  KnowledgeTagDefinitionApi,
  KnowledgeUpdateInput,
} from "./knowledge.repository.types.js";

export type {
  BulkKnowledgeStatusUpdateParams,
  BulkKnowledgeStatusUpdateResult,
  KnowledgeCreateInput,
  KnowledgeFeedbackDirection,
  KnowledgeFeedbackResult,
  KnowledgeListItem,
  KnowledgeListSortBy,
  KnowledgeTagDefinitionApi,
  KnowledgeUpdateInput,
};

async function getSqliteCoreDatabase() {
  const { getRuntimeSqliteCoreDatabase } = await import("../../../src/db/sqlite/runtime.js");
  return getRuntimeSqliteCoreDatabase();
}

function isSqliteBackend(): boolean {
  return resolveDatabaseBackendConfig().kind === "sqlite";
}

type SqliteKnowledgeApiRow = typeof sqliteKnowledgeItems.$inferSelect;

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const trimmed = value.trim();
  const unixMillis = trimmed.startsWith("unix-ms:")
    ? Number(trimmed.slice("unix-ms:".length))
    : Number.NaN;
  if (Number.isFinite(unixMillis)) {
    const date = new Date(unixMillis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed.replace(" ", "T")}Z`
    : trimmed;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function requiredDate(value: string | Date | null | undefined): Date {
  return toDate(value) ?? new Date(0);
}

function nowIso(): string {
  return new Date().toISOString();
}

function matchesKnowledgeApiFilters(
  row: SqliteKnowledgeApiRow,
  params: Pick<KnowledgeListParams, "status" | "type" | "query" | "displayFilter" | "minQuality">,
): boolean {
  const status = params.status?.trim();
  const type = params.type?.trim();
  if (status && status !== "all" && row.status !== status) return false;
  if (type && type !== "all" && row.type !== type) return false;
  if (params.displayFilter === "draft" && row.status !== "draft") return false;
  if (params.displayFilter === "active" && row.status !== "active") return false;
  if (params.displayFilter === "deprecated" && row.status !== "deprecated") return false;
  if (
    params.displayFilter === "unused-active" &&
    !(row.status === "active" && row.compileSelectCount === 0)
  ) {
    return false;
  }
  if (params.displayFilter === "high-value" && Math.max(row.importance, row.confidence) < 80) {
    return false;
  }
  if (
    typeof params.minQuality === "number" &&
    Math.max(row.importance, row.confidence) < params.minQuality
  ) {
    return false;
  }
  const query = params.query?.trim().toLowerCase();
  if (query) {
    const metadata = JSON.stringify(row.metadata ?? {}).toLowerCase();
    const haystack = `${row.title}\n${row.body}\n${metadata}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  return true;
}

function compareKnowledgeApiRows(
  params: KnowledgeListParams,
  left: SqliteKnowledgeApiRow,
  right: SqliteKnowledgeApiRow,
): number {
  const direction = params.sortDir === "asc" ? 1 : -1;
  const sortBy = params.sortBy ?? "updatedAt";
  const stringValue = (row: SqliteKnowledgeApiRow): string => {
    if (sortBy === "title") return row.title.toLowerCase();
    if (sortBy === "type") return row.type;
    if (sortBy === "status") return row.status;
    if (sortBy === "scope") return row.scope;
    return row.updatedAt;
  };
  const numberValue = (row: SqliteKnowledgeApiRow): number => {
    if (sortBy === "qualityScore") return Math.max(row.importance, row.confidence);
    return toDate(row.updatedAt)?.getTime() ?? 0;
  };
  const primary =
    sortBy === "qualityScore" || sortBy === "updatedAt"
      ? numberValue(left) === numberValue(right)
        ? 0
        : numberValue(left) > numberValue(right)
          ? 1
          : -1
      : stringValue(left).localeCompare(stringValue(right));
  if (primary !== 0) return primary * direction;
  return (toDate(right.updatedAt)?.getTime() ?? 0) - (toDate(left.updatedAt)?.getTime() ?? 0);
}

function mapSqliteKnowledgeApiRow(row: SqliteKnowledgeApiRow): KnowledgeListItem {
  const normalizedType = row.type === "procedure" ? "procedure" : "rule";
  const normalizedScope = row.scope === "global" ? "global" : "repo";
  const updatedAt = requiredDate(row.updatedAt);
  const lastVerifiedAt = toDate(row.lastVerifiedAt);
  const metadata = asRecord(row.metadata);
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    scope: row.scope,
    polarity: row.polarity,
    intentTags: Array.isArray(row.intentTags) ? row.intentTags.map(String) : [],
    title: row.title,
    body: row.body,
    appliesTo: asRecord(row.appliesTo),
    metadata,
    sourceRefs: extractSourceRefs(metadata),
    sourceVibeMemoryIds: extractSourceVibeMemoryIds(metadata),
    confidence: normalizeKnowledgeScore(row.confidence, 70),
    importance: normalizeKnowledgeScore(row.importance, 70),
    compileSelectCount: Math.max(0, Number(row.compileSelectCount ?? 0)),
    agenticAcceptCount: Math.max(0, Number(row.agenticAcceptCount ?? 0)),
    explicitUpvoteCount: Math.max(0, Number(row.explicitUpvoteCount ?? 0)),
    explicitDownvoteCount: Math.max(0, Number(row.explicitDownvoteCount ?? 0)),
    dynamicScore: Math.max(0, Number(row.dynamicScore ?? 0)),
    lastCompiledAt: toDate(row.lastCompiledAt),
    decayFactor: computeDecayFactor({
      type: normalizedType,
      scope: normalizedScope,
      lastVerifiedAt,
      updatedAt,
    }),
    lastVerifiedAt,
    createdAt: requiredDate(row.createdAt),
    updatedAt,
  };
}

async function loadSqliteKnowledgeApiRows(): Promise<SqliteKnowledgeApiRow[]> {
  const sqlite = await getSqliteCoreDatabase();
  return sqlite.orm.select().from(sqliteKnowledgeItems).all();
}

async function findSqliteKnowledgeApiRow(id: string): Promise<SqliteKnowledgeApiRow | null> {
  const sqlite = await getSqliteCoreDatabase();
  return (
    sqlite.orm
      .select()
      .from(sqliteKnowledgeItems)
      .where(eq(sqliteKnowledgeItems.id, id))
      .limit(1)
      .get() ?? null
  );
}

export async function countKnowledgeItems(
  params: Pick<KnowledgeListParams, "status" | "type" | "query" | "displayFilter" | "minQuality">,
): Promise<number> {
  if (isSqliteBackend()) {
    return (await loadSqliteKnowledgeApiRows()).filter((row) =>
      matchesKnowledgeApiFilters(row, params),
    ).length;
  }

  const rows = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(knowledgeItems)
    .where(buildKnowledgeListWhere(params));

  return Math.max(0, Number(rows[0]?.count ?? 0));
}

export async function listKnowledgeItems(
  params: KnowledgeListParams,
): Promise<KnowledgeListItem[]> {
  if (isSqliteBackend()) {
    const offset = Math.max(0, (params.page ?? 1) - 1) * params.limit;
    return (await loadSqliteKnowledgeApiRows())
      .filter((row) => matchesKnowledgeApiFilters(row, params))
      .sort((left, right) => compareKnowledgeApiRows(params, left, right))
      .slice(offset, offset + params.limit)
      .map(mapSqliteKnowledgeApiRow);
  }

  const where = buildKnowledgeListWhere(params);
  const offset = Math.max(0, (params.page ?? 1) - 1) * params.limit;
  const orderBy = buildKnowledgeListOrderBy(params);
  const commonSelect = {
    id: knowledgeItems.id,
    type: knowledgeItems.type,
    status: knowledgeItems.status,
    scope: knowledgeItems.scope,
    polarity: knowledgeItems.polarity,
    intentTags: knowledgeItems.intentTags,
    title: knowledgeItems.title,
    body: knowledgeItems.body,
    confidence: knowledgeItems.confidence,
    importance: knowledgeItems.importance,
    appliesTo: knowledgeItems.appliesTo,
    metadata: knowledgeItems.metadata,
    lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    createdAt: knowledgeItems.createdAt,
    updatedAt: knowledgeItems.updatedAt,
  } as const;

  let rows:
    | Array<
        (typeof commonSelect extends infer T ? T : never) & {
          compileSelectCount?: number;
          lastCompiledAt?: Date | null;
          agenticAcceptCount?: number;
          explicitUpvoteCount?: number;
          explicitDownvoteCount?: number;
          dynamicScore?: number;
        }
      >
    | Array<Record<string, unknown>>;

  try {
    rows = await db
      .select({
        ...commonSelect,
        compileSelectCount: knowledgeItems.compileSelectCount,
        lastCompiledAt: knowledgeItems.lastCompiledAt,
        agenticAcceptCount: knowledgeItems.agenticAcceptCount,
        explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
        explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
        dynamicScore: knowledgeItems.dynamicScore,
      })
      .from(knowledgeItems)
      .where(where)
      .orderBy(...orderBy)
      .limit(params.limit)
      .offset(offset);
  } catch (error) {
    if (!isMissingKnowledgeLifecycleColumnsError(error)) {
      throw error;
    }
    rows = await db
      .select(commonSelect)
      .from(knowledgeItems)
      .where(where)
      .orderBy(...orderBy)
      .limit(params.limit)
      .offset(offset);
  }

  return rows.map((row: Record<string, unknown>): KnowledgeListItem => {
    const normalizedType = row.type === "procedure" ? "procedure" : "rule";
    const normalizedScope = row.scope === "global" ? "global" : "repo";
    const decayFactor = computeDecayFactor({
      type: normalizedType,
      scope: normalizedScope,
      lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
      updatedAt: row.updatedAt as Date,
    });
    return {
      id: String(row.id),
      type: String(row.type ?? "rule"),
      status: String(row.status ?? "draft"),
      scope: String(row.scope ?? "repo"),
      polarity: String(row.polarity ?? "positive"),
      intentTags: Array.isArray(row.intentTags) ? row.intentTags.map(String) : [],
      title: String(row.title ?? ""),
      body: String(row.body ?? ""),
      appliesTo: asRecord(row.appliesTo),
      metadata: asRecord(row.metadata),
      sourceRefs: extractSourceRefs(asRecord(row.metadata)),
      sourceVibeMemoryIds: extractSourceVibeMemoryIds(asRecord(row.metadata)),
      confidence: normalizeKnowledgeScore(row.confidence, 70),
      importance: normalizeKnowledgeScore(row.importance, 70),
      compileSelectCount: Math.max(0, Number(row.compileSelectCount ?? 0)),
      agenticAcceptCount: Math.max(0, Number(row.agenticAcceptCount ?? 0)),
      explicitUpvoteCount: Math.max(0, Number(row.explicitUpvoteCount ?? 0)),
      explicitDownvoteCount: Math.max(0, Number(row.explicitDownvoteCount ?? 0)),
      dynamicScore: Math.max(0, Number(row.dynamicScore ?? 0)),
      lastCompiledAt: (row.lastCompiledAt as Date | null) ?? null,
      decayFactor,
      lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date,
    };
  });
}

async function tryEmbedKnowledge(input: { title: string; body: string }): Promise<
  number[] | undefined
> {
  try {
    return await embedOne(`${input.title}\n${input.body}`, "passage");
  } catch {
    return undefined;
  }
}

export async function createKnowledgeItem(input: KnowledgeCreateInput) {
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const normalizedApplicability = await buildNormalizedApplicability(input);
  const metadata = mergeApplicabilityMetadata(input.metadata ?? {}, normalizedApplicability);
  const embedding = await tryEmbedKnowledge(input);
  const appliesTo = mergeNormalizedApplicability({
    existingAppliesTo: undefined,
    inputAppliesTo: input.appliesTo,
    normalizedAppliesTo: normalizedApplicability.appliesTo,
  });
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: input.scope,
      projectRef: input.projectRef,
      repoKey:
        input.repoKey ?? (typeof appliesTo.repoKey === "string" ? appliesTo.repoKey : undefined),
      repoPath:
        input.repoPath ?? (typeof appliesTo.repoPath === "string" ? appliesTo.repoPath : undefined),
    },
    { producer: "knowledge.api-create", entityKind: "knowledge", actor: "user" },
  );

  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const repo = new SqliteCoreRepository(sqlite);
    const id = randomUUID();
    const now = nowIso();
    repo.upsertKnowledgeItem({
      id,
      type: input.type,
      status: input.status,
      scope: identity.scope,
      classificationStatus: identity.classificationStatus,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      polarity: input.polarity ?? "positive",
      intentTags: input.intentTags ?? [],
      title: input.title,
      body: input.body,
      confidence,
      importance,
      appliesTo,
      metadata,
      embedding,
      createdAt: now,
      updatedAt: now,
    });
    sqlite.orm
      .update(sqliteKnowledgeItems)
      .set({ lastVerifiedAt: now })
      .where(eq(sqliteKnowledgeItems.id, id))
      .run();
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeCreated,
      actor: "user",
      payload: {
        knowledgeId: id,
        type: input.type,
        status: input.status,
        scope: input.scope,
        title: input.title,
      },
    });
    await linkKnowledgeFromMetadata({
      knowledgeId: id,
      metadata,
      confidence,
      linkMetadataSource: "createKnowledgeItem",
    });
    await recordProjectScopedWritePersisted(identity, {
      producer: "knowledge.api-create",
      entityKind: "knowledge",
      entityId: id,
      actor: "user",
    });
    return { id };
  }

  const [inserted] = await db
    .insert(knowledgeItems)
    .values({
      type: input.type,
      status: input.status,
      scope: identity.scope,
      classificationStatus: identity.classificationStatus,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      polarity: input.polarity ?? "positive",
      intentTags: input.intentTags ?? [],
      title: input.title,
      body: input.body,
      confidence,
      importance,
      appliesTo,
      metadata,
      embedding,
      lastVerifiedAt: new Date(),
    })
    .returning({ id: knowledgeItems.id });
  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeCreated,
    actor: "user",
    payload: {
      knowledgeId: inserted.id,
      type: input.type,
      status: input.status,
      scope: input.scope,
      title: input.title,
    },
  });
  await linkKnowledgeFromMetadata({
    knowledgeId: inserted.id,
    metadata,
    confidence: confidence,
    linkMetadataSource: "createKnowledgeItem",
  });
  await recordProjectScopedWritePersisted(identity, {
    producer: "knowledge.api-create",
    entityKind: "knowledge",
    entityId: inserted.id,
    actor: "user",
  });
  return inserted;
}

export async function updateKnowledgeItem(id: string, input: KnowledgeUpdateInput) {
  const [existing] = isSqliteBackend()
    ? [await findSqliteKnowledgeApiRow(id)]
    : await db
        .select({
          id: knowledgeItems.id,
          status: knowledgeItems.status,
          scope: knowledgeItems.scope,
          type: knowledgeItems.type,
          polarity: knowledgeItems.polarity,
          intentTags: knowledgeItems.intentTags,
          title: knowledgeItems.title,
          body: knowledgeItems.body,
          confidence: knowledgeItems.confidence,
          importance: knowledgeItems.importance,
          appliesTo: knowledgeItems.appliesTo,
          metadata: knowledgeItems.metadata,
          classificationStatus: knowledgeItems.classificationStatus,
          projectRef: knowledgeItems.projectRef,
          repoKey: knowledgeItems.repoKey,
          repoPath: knowledgeItems.repoPath,
          createdAt: knowledgeItems.createdAt,
          lastVerifiedAt: knowledgeItems.lastVerifiedAt,
        })
        .from(knowledgeItems)
        .where(eq(knowledgeItems.id, id))
        .limit(1);
  if (!existing) return null;

  const nextType = input.type ?? existing.type;
  const nextStatus = input.status ?? existing.status;
  const nextScope = input.scope ?? existing.scope;
  const nextPolarity = input.polarity ?? existing.polarity;
  const nextIntentTags = input.intentTags ?? existing.intentTags;
  const nextTitle = input.title ?? existing.title;
  const nextBody = input.body ?? existing.body;
  const confidence = normalizeKnowledgeScore(input.confidence, 70);
  const importance = normalizeKnowledgeScore(input.importance, 70);
  const nextConfidence =
    input.confidence === undefined ? normalizeKnowledgeScore(existing.confidence, 70) : confidence;
  const nextImportance =
    input.importance === undefined ? normalizeKnowledgeScore(existing.importance, 70) : importance;
  const existingAppliesTo = asRecord(existing.appliesTo);
  const explicitAppliesTo = asRecord(input.appliesTo);
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: nextScope as "repo" | "global",
      projectRef:
        input.projectRef ??
        (nextScope === "repo" && "projectRef" in existing
          ? (existing.projectRef as string | null | undefined)
          : undefined),
      repoKey:
        input.repoKey ??
        (typeof explicitAppliesTo.repoKey === "string" ? explicitAppliesTo.repoKey : undefined) ??
        (nextScope === "repo" && "repoKey" in existing
          ? (existing.repoKey as string | null | undefined)
          : undefined),
      repoPath:
        input.repoPath ??
        (typeof explicitAppliesTo.repoPath === "string" ? explicitAppliesTo.repoPath : undefined) ??
        (nextScope === "repo" && "repoPath" in existing
          ? (existing.repoPath as string | null | undefined)
          : undefined),
    },
    { producer: "knowledge.api-update", entityKind: "knowledge", actor: "user" },
  );
  await assertAuditedStoredProjectScopedIdentityCompatible(
    {
      classificationStatus: existing.classificationStatus,
      scope: existing.scope,
      projectRef: existing.projectRef,
      repoKey: existing.repoKey,
      repoPath: existing.repoPath,
    },
    identity,
    `Knowledge ${existing.id}`,
    { producer: "knowledge.api-update", entityKind: "knowledge", actor: "user" },
  );
  const hasApplicabilityPatch =
    input.appliesTo !== undefined ||
    input.general !== undefined ||
    input.technologies !== undefined ||
    input.changeTypes !== undefined ||
    input.domains !== undefined ||
    input.repoPath !== undefined ||
    input.repoKey !== undefined;

  const normalizedApplicability = hasApplicabilityPatch
    ? await buildNormalizedApplicability({
        appliesTo:
          input.appliesTo === undefined
            ? existingAppliesTo
            : {
                ...existingAppliesTo,
                ...asRecord(input.appliesTo),
              },
        general: input.general,
        technologies: input.technologies,
        changeTypes: input.changeTypes,
        domains: input.domains,
        repoPath: input.repoPath,
        repoKey: input.repoKey,
      })
    : null;
  let appliesTo =
    normalizedApplicability === null
      ? existingAppliesTo
      : mergeNormalizedApplicability({
          existingAppliesTo,
          inputAppliesTo: input.appliesTo,
          normalizedAppliesTo: normalizedApplicability.appliesTo,
        });
  if (identity.scope === "global") {
    appliesTo = Object.fromEntries(
      Object.entries(appliesTo).filter(([key]) => key !== "repoKey" && key !== "repoPath"),
    );
  }
  const metadataBase = {
    ...asRecord(existing.metadata),
    ...(input.metadata ?? {}),
  };
  const metadata =
    normalizedApplicability === null
      ? metadataBase
      : mergeApplicabilityMetadata(metadataBase, normalizedApplicability);
  const titleChanged = nextTitle !== existing.title;
  const bodyChanged = nextBody !== existing.body;
  const promotedToActive = existing.status === "draft" && nextStatus === "active";
  const shouldUpdateLastVerifiedAt = titleChanged || bodyChanged || promotedToActive;
  const embedding =
    titleChanged || bodyChanged
      ? await tryEmbedKnowledge({ title: nextTitle, body: nextBody })
      : undefined;

  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const repo = new SqliteCoreRepository(sqlite);
    const now = nowIso();
    const lastVerifiedAt = shouldUpdateLastVerifiedAt
      ? now
      : existing.lastVerifiedAt instanceof Date
        ? existing.lastVerifiedAt.toISOString()
        : existing.lastVerifiedAt;
    repo.upsertKnowledgeItem({
      id: existing.id,
      type: nextType,
      status: nextStatus,
      scope: identity.scope,
      classificationStatus: identity.classificationStatus,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      polarity: nextPolarity,
      intentTags: Array.isArray(nextIntentTags) ? nextIntentTags : [],
      title: nextTitle,
      body: nextBody,
      confidence: nextConfidence,
      importance: nextImportance,
      appliesTo,
      metadata,
      embedding,
      createdAt:
        existing.createdAt instanceof Date ? existing.createdAt.toISOString() : existing.createdAt,
      updatedAt: now,
    });
    sqlite.orm
      .update(sqliteKnowledgeItems)
      .set({ lastVerifiedAt: lastVerifiedAt ?? null })
      .where(eq(sqliteKnowledgeItems.id, existing.id))
      .run();
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeUpdated,
      actor: "user",
      payload: {
        knowledgeId: existing.id,
        type: nextType,
        status: nextStatus,
        scope: nextScope,
        title: nextTitle,
        previousStatus: existing.status,
      },
    });
    if (existing.status !== nextStatus) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.knowledgeStatusChanged,
        actor: "user",
        payload: {
          knowledgeId: existing.id,
          fromStatus: existing.status,
          toStatus: nextStatus,
        },
      });
    }
    await recordProjectScopedWritePersisted(identity, {
      producer: "knowledge.api-update",
      entityKind: "knowledge",
      entityId: existing.id,
      actor: "user",
    });
    return { id: existing.id };
  }

  const now = new Date();
  const [updated] = await db
    .update(knowledgeItems)
    .set({
      type: nextType,
      status: nextStatus,
      scope: identity.scope,
      classificationStatus: identity.classificationStatus,
      projectRef: identity.projectRef,
      repoKey: identity.repoKey,
      repoPath: identity.repoPath,
      polarity: nextPolarity,
      intentTags: nextIntentTags,
      title: nextTitle,
      body: nextBody,
      confidence: nextConfidence,
      importance: nextImportance,
      appliesTo,
      metadata,
      embedding,
      updatedAt: now,
      lastVerifiedAt: shouldUpdateLastVerifiedAt ? now : toDate(existing.lastVerifiedAt),
    })
    .where(eq(knowledgeItems.id, existing.id))
    .returning({ id: knowledgeItems.id });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeUpdated,
    actor: "user",
    payload: {
      knowledgeId: updated.id,
      type: nextType,
      status: nextStatus,
      scope: nextScope,
      title: nextTitle,
      previousStatus: existing.status,
    },
  });
  if (existing.status !== nextStatus) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeStatusChanged,
      actor: "user",
      payload: {
        knowledgeId: updated.id,
        fromStatus: existing.status,
        toStatus: nextStatus,
      },
    });
  }
  await recordProjectScopedWritePersisted(identity, {
    producer: "knowledge.api-update",
    entityKind: "knowledge",
    entityId: updated.id,
    actor: "user",
  });
  return updated ?? null;
}

export async function deleteKnowledgeItem(id: string) {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const existing = await findSqliteKnowledgeApiRow(id);
    if (!existing) return null;
    sqlite.db.query("DELETE FROM knowledge_items_fts WHERE id = ?;").run(id);
    sqlite.orm.delete(sqliteKnowledgeItems).where(eq(sqliteKnowledgeItems.id, id)).run();
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeDeleted,
      actor: "user",
      payload: {
        knowledgeId: id,
      },
    });
    return { id };
  }

  const [deleted] = await db
    .delete(knowledgeItems)
    .where(eq(knowledgeItems.id, id))
    .returning({ id: knowledgeItems.id });
  if (deleted) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeDeleted,
      actor: "user",
      payload: {
        knowledgeId: deleted.id,
      },
    });
  }
  return deleted ?? null;
}

async function resolveBulkKnowledgeStatusIds(
  params: BulkKnowledgeStatusUpdateParams,
): Promise<string[]> {
  if ("ids" in params) {
    return [...new Set(params.ids.map((id) => id.trim()).filter(Boolean))];
  }

  if (isSqliteBackend()) {
    return (await loadSqliteKnowledgeApiRows())
      .filter((row) => matchesKnowledgeApiFilters(row, params.selection))
      .map((row) => row.id);
  }

  const rows = await db
    .select({
      id: knowledgeItems.id,
    })
    .from(knowledgeItems)
    .where(buildKnowledgeListWhere(params.selection));
  return rows.map((row) => row.id);
}

export async function bulkUpdateKnowledgeStatus(
  params: BulkKnowledgeStatusUpdateParams,
): Promise<BulkKnowledgeStatusUpdateResult> {
  const requestedIds = await resolveBulkKnowledgeStatusIds(params);
  const result: BulkKnowledgeStatusUpdateResult = {
    targetStatus: params.status,
    requestedIds,
    updatedIds: [],
    unchangedIds: [],
    notFoundIds: [],
    invalidTransitionIds: [],
  };
  if (requestedIds.length === 0) {
    return result;
  }

  const rows = isSqliteBackend()
    ? (await loadSqliteKnowledgeApiRows())
        .filter((row) => requestedIds.includes(row.id))
        .map((row) => ({ id: row.id, status: row.status }))
    : await db
        .select({
          id: knowledgeItems.id,
          status: knowledgeItems.status,
        })
        .from(knowledgeItems)
        .where(inArray(knowledgeItems.id, requestedIds));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const id of requestedIds) {
    const row = rowById.get(id);
    if (!row) {
      result.notFoundIds.push(id);
      continue;
    }
    const fromStatus = row.status as KnowledgeStatus;
    if (fromStatus === params.status) {
      result.unchangedIds.push(id);
      continue;
    }
    if (!canTransitionKnowledgeStatus(fromStatus, params.status)) {
      result.invalidTransitionIds.push({ id, fromStatus });
      continue;
    }
    result.updatedIds.push(id);
  }

  if (result.updatedIds.length > 0) {
    const now = new Date();
    const promoteIds = result.updatedIds.filter((id) => {
      const row = rowById.get(id);
      return row?.status === "draft" && params.status === "active";
    });
    if (isSqliteBackend()) {
      const sqlite = await getSqliteCoreDatabase();
      const nowValue = now.toISOString();
      for (const id of result.updatedIds) {
        sqlite.orm
          .update(sqliteKnowledgeItems)
          .set({
            status: params.status,
            updatedAt: nowValue,
            ...(promoteIds.includes(id) ? { lastVerifiedAt: nowValue } : {}),
          })
          .where(eq(sqliteKnowledgeItems.id, id))
          .run();
      }
    } else {
      await db
        .update(knowledgeItems)
        .set({
          status: params.status,
          updatedAt: now,
        })
        .where(inArray(knowledgeItems.id, result.updatedIds));
      if (promoteIds.length > 0) {
        await db
          .update(knowledgeItems)
          .set({
            lastVerifiedAt: now,
          })
          .where(inArray(knowledgeItems.id, promoteIds));
      }
    }
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeStatusChanged,
      actor: "user",
      payload: {
        targetStatus: params.status,
        updatedIds: result.updatedIds,
        unchangedIds: result.unchangedIds,
        notFoundIds: result.notFoundIds,
        invalidTransitionIds: result.invalidTransitionIds,
      },
    });
  }

  return result;
}

async function loadRecentSelectionCount30d(knowledgeId: string): Promise<number> {
  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const row = sqlite.db
      .query<{ count: number }, [string, string]>(
        `
SELECT count(*) AS count
FROM context_pack_items
WHERE item_id = ?
  AND item_kind IN ('rule', 'procedure')
  AND created_at >= ?;
`,
      )
      .get(knowledgeId, cutoff);
    return Math.max(0, Number(row?.count ?? 0));
  }

  const result = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(contextPackItems)
    .where(
      and(
        eq(contextPackItems.itemId, knowledgeId),
        inArray(contextPackItems.itemKind, ["rule", "procedure"]),
        sql`${contextPackItems.createdAt} >= now() - (30 * interval '1 day')`,
      ),
    );

  return Math.max(0, Number(result[0]?.count ?? 0));
}

export async function recordKnowledgeFeedback(params: {
  id: string;
  direction: KnowledgeFeedbackDirection;
  reason?: string;
}): Promise<KnowledgeFeedbackResult | null> {
  const [row] = isSqliteBackend()
    ? [await findSqliteKnowledgeApiRow(params.id)]
    : await db
        .select({
          id: knowledgeItems.id,
          compileSelectCount: knowledgeItems.compileSelectCount,
          agenticAcceptCount: knowledgeItems.agenticAcceptCount,
          explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
          explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
          lastVerifiedAt: knowledgeItems.lastVerifiedAt,
        })
        .from(knowledgeItems)
        .where(eq(knowledgeItems.id, params.id))
        .limit(1);
  if (!row) return null;

  const recentSelectCount30d = await loadRecentSelectionCount30d(row.id);
  const nextUpvoteCount =
    Math.max(0, Number(row.explicitUpvoteCount ?? 0)) + (params.direction === "up" ? 1 : 0);
  const nextDownvoteCount =
    Math.max(0, Number(row.explicitDownvoteCount ?? 0)) + (params.direction === "down" ? 1 : 0);
  const dynamicScore = computeDynamicScore({
    compileSelectCount: Math.max(0, Number(row.compileSelectCount ?? 0)),
    recentSelectCount30d,
    agenticAcceptCount: Math.max(0, Number(row.agenticAcceptCount ?? 0)),
    explicitUpvoteCount: nextUpvoteCount,
    explicitDownvoteCount: nextDownvoteCount,
  });
  const now = new Date();
  const lastVerifiedAt = params.direction === "up" ? now : row.lastVerifiedAt;

  if (isSqliteBackend()) {
    const sqlite = await getSqliteCoreDatabase();
    const lastVerifiedAtValue =
      lastVerifiedAt instanceof Date ? lastVerifiedAt.toISOString() : lastVerifiedAt;
    sqlite.orm
      .update(sqliteKnowledgeItems)
      .set({
        explicitUpvoteCount: nextUpvoteCount,
        explicitDownvoteCount: nextDownvoteCount,
        dynamicScore,
        lastVerifiedAt: lastVerifiedAtValue ?? null,
      })
      .where(eq(sqliteKnowledgeItems.id, params.id))
      .run();
    await recordAuditLogSafe({
      eventType: auditEventTypes.knowledgeFeedbackRecorded,
      actor: "user",
      payload: {
        knowledgeId: row.id,
        direction: params.direction,
        reason: params.reason?.trim() || undefined,
        dynamicScore,
        explicitUpvoteCount: nextUpvoteCount,
        explicitDownvoteCount: nextDownvoteCount,
      },
    });
    return {
      id: row.id,
      direction: params.direction,
      explicitUpvoteCount: nextUpvoteCount,
      explicitDownvoteCount: nextDownvoteCount,
      dynamicScore,
      lastVerifiedAt: toDate(lastVerifiedAtValue),
    };
  }

  const [updated] = await db
    .update(knowledgeItems)
    .set({
      explicitUpvoteCount: nextUpvoteCount,
      explicitDownvoteCount: nextDownvoteCount,
      dynamicScore,
      lastVerifiedAt: toDate(lastVerifiedAt),
    })
    .where(eq(knowledgeItems.id, params.id))
    .returning({
      id: knowledgeItems.id,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      dynamicScore: knowledgeItems.dynamicScore,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    });
  if (!updated) return null;

  await recordAuditLogSafe({
    eventType: auditEventTypes.knowledgeFeedbackRecorded,
    actor: "user",
    payload: {
      knowledgeId: updated.id,
      direction: params.direction,
      reason: params.reason?.trim() || undefined,
      dynamicScore: updated.dynamicScore,
      explicitUpvoteCount: updated.explicitUpvoteCount,
      explicitDownvoteCount: updated.explicitDownvoteCount,
    },
  });

  return {
    id: updated.id,
    direction: params.direction,
    explicitUpvoteCount: updated.explicitUpvoteCount,
    explicitDownvoteCount: updated.explicitDownvoteCount,
    dynamicScore: updated.dynamicScore,
    lastVerifiedAt: updated.lastVerifiedAt,
  };
}

export async function listKnowledgeTagDefinitionsForApi(params?: {
  kind?: KnowledgeTagKind;
  status?: KnowledgeTagStatus;
}): Promise<KnowledgeTagDefinitionApi[]> {
  const definitions = await listKnowledgeTagDefinitions({
    kinds: params?.kind ? [params.kind] : undefined,
    statuses: params?.status ? [params.status] : undefined,
  });
  return definitions.map((definition) => ({
    id: definition.id,
    kind: definition.kind,
    slug: definition.slug,
    label: definition.label,
    description: definition.description,
    aliases: definition.aliases,
    status: definition.status,
    sortOrder: definition.sortOrder,
  }));
}
