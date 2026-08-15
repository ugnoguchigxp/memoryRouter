import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  auditLogs,
  episodeCards,
  knowledgeItems,
  projectIdentityAliases,
  repositoryIdentityMigrationAudits,
  sources,
} from "../../db/schema.js";
import { type SqliteCoreDatabase, openSqliteCoreDatabase } from "../../db/sqlite/index.js";
import type { CompileProjectIdentityAlias } from "./compile-project-identity.js";
import {
  REPOSITORY_IDENTITY_BACKFILL_VERSION,
  type RepositoryIdentityBackfillDecision,
  type RepositoryIdentityBackfillPlan,
  type RepositoryIdentityBackfillRow,
  type RepositoryIdentityEntityKind,
  type RepositoryIdentityProvenance,
  planRepositoryIdentityBackfill,
} from "./repository-identity-backfill.js";

export type RepositoryIdentityBackfillMode = "dry-run" | "write";

export type RunRepositoryIdentityBackfillInput = {
  mode?: RepositoryIdentityBackfillMode;
  batchSize?: number;
  expectedChecksum?: string;
  backupReference?: string;
  sqlitePath?: string;
  explicitGlobalPromotions?: Partial<Record<RepositoryIdentityEntityKind, readonly string[]>>;
  reviewDecisions?: readonly RepositoryIdentityReviewDecision[];
};

export type RepositoryIdentityReviewDecision = {
  entityKind: RepositoryIdentityEntityKind;
  entityId: string;
  decision: "global" | "repo" | "unresolved";
  reviewer: string;
  reason: string;
  reviewedAt: string;
};

export type RepositoryIdentityBackfillSummary = RepositoryIdentityBackfillPlan & {
  mode: RepositoryIdentityBackfillMode;
  backend: "postgres" | "sqlite";
  batchSize: number;
  updatedCount: number;
  auditInsertedCount: number;
  backupReference: string | null;
};

type CollectedBackfillData = {
  rows: RepositoryIdentityBackfillRow[];
  aliases: CompileProjectIdentityAlias[];
  portableKnowledge: Map<string, Record<string, unknown>>;
};

type RawIdentityRow = {
  id: string;
  classification_status: string | null;
  scope: string | null;
  project_ref: string | null;
  repo_key: string | null;
  repo_path: string | null;
  metadata: unknown;
  applies_to?: unknown;
  source_kind?: string | null;
  source_key?: string | null;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function promotionSet(
  input: RunRepositoryIdentityBackfillInput,
  kind: RepositoryIdentityEntityKind,
): Set<string> {
  return new Set([
    ...(input.explicitGlobalPromotions?.[kind] ?? []),
    ...(input.reviewDecisions ?? [])
      .filter((decision) => decision.entityKind === kind && decision.decision === "global")
      .map((decision) => decision.entityId),
  ]);
}

function globalPromotionReview(
  input: RunRepositoryIdentityBackfillInput,
  kind: RepositoryIdentityEntityKind,
  id: string,
) {
  const review = input.reviewDecisions?.find(
    (decision) =>
      decision.entityKind === kind && decision.entityId === id && decision.decision === "global",
  );
  return review
    ? {
        reviewer: review.reviewer,
        reason: review.reason,
        reviewedAt: review.reviewedAt,
      }
    : undefined;
}

function toBackfillRow(
  row: RawIdentityRow,
  entityKind: RepositoryIdentityEntityKind,
  input: RunRepositoryIdentityBackfillInput,
): RepositoryIdentityBackfillRow {
  return {
    id: String(row.id),
    entityKind,
    classificationStatus: row.classification_status,
    scope: row.scope,
    projectRef: row.project_ref,
    repoKey: row.repo_key,
    repoPath: row.repo_path,
    metadata: row.metadata,
    explicitGlobalPromotion: promotionSet(input, entityKind).has(String(row.id)),
    explicitGlobalPromotionReview: globalPromotionReview(input, entityKind, String(row.id)),
  };
}

function addProvenance(
  byEntityId: Map<string, RepositoryIdentityProvenance[]>,
  entityId: string,
  source: string,
  snapshots: unknown,
): void {
  const current = byEntityId.get(entityId) ?? [];
  for (const snapshot of array(snapshots)) current.push({ source, snapshot });
  byEntityId.set(entityId, current);
}

function runIdentitySnapshot(row: Record<string, unknown>): Record<string, unknown> | null {
  if (
    row.scope_mode !== "project" ||
    Number(row.identity_contract_version) !== 1 ||
    !["project_ref", "repo_key", "repo_path"].includes(String(row.match_basis))
  ) {
    return null;
  }
  const snapshot = {
    classificationStatus: "classified",
    scope: "repo",
    projectRef: typeof row.project_ref === "string" ? row.project_ref : undefined,
    repoKey: typeof row.repo_key === "string" ? row.repo_key : undefined,
    repoPath: typeof row.repo_path === "string" ? row.repo_path : undefined,
  };
  return snapshot.projectRef || snapshot.repoKey || snapshot.repoPath ? snapshot : null;
}

function compileRunId(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  const prefix = "context-compile-run://";
  return sourceKey.startsWith(prefix) ? sourceKey.slice(prefix.length) || null : sourceKey;
}

function attachProvenance(
  rows: RepositoryIdentityBackfillRow[],
  byEntityId: Map<string, RepositoryIdentityProvenance[]>,
): void {
  for (const row of rows) {
    const provenance = byEntityId.get(row.id);
    if (provenance?.length) row.provenance = provenance;
  }
}

async function collectPostgresData(
  input: RunRepositoryIdentityBackfillInput,
): Promise<CollectedBackfillData> {
  const [
    knowledgeResult,
    sourceResult,
    episodeResult,
    aliasRows,
    targetResult,
    legacyCoverResult,
    finalResult,
    runResult,
  ] = await Promise.all([
    db.execute(
      sql`select id::text, classification_status, scope, project_ref, repo_key, repo_path, metadata, applies_to from knowledge_items`,
    ),
    db.execute(
      sql`select id::text, classification_status, scope, project_ref, repo_key, repo_path, metadata from sources`,
    ),
    db.execute(
      sql`select id::text, classification_status, scope, project_ref, repo_key, repo_path, metadata, source_kind, source_key from episode_cards`,
    ),
    db
      .select({
        projectRef: projectIdentityAliases.projectRef,
        aliasKind: projectIdentityAliases.aliasKind,
        normalizedValue: projectIdentityAliases.normalizedValue,
      })
      .from(projectIdentityAliases)
      .where(eq(projectIdentityAliases.status, "active")),
    db.execute(sql`select knowledge_ids, metadata from distillation_target_states`),
    db.execute(sql`
        select c.id::text as cover_id,
               jsonb_build_array(t.metadata, f.origin) as provenance
        from cover_evidence_results c
        join find_candidate_results f on f.id = c.id
        join distillation_target_states t on t.id = f.target_state_id
      `),
    db.execute(sql`
        select z.knowledge_id::text as entity_id,
               jsonb_build_array(z.metadata, e.metadata, f.metadata, f.origin, q.payload, q.metadata) as provenance
        from finalize_distille_queue z
        join evidence_coverage_results e on e.id = z.evidence_result_id
        join found_candidates f on f.id = e.found_candidate_id
        join finding_candidate_queue q on q.id = f.finding_job_id
        where z.knowledge_id is not null
      `),
    db.execute(sql`
        select id::text, project_ref, repo_key, repo_path, match_basis,
               identity_contract_version, scope_mode
        from context_compile_runs
      `),
  ]);

  const knowledgeRaw = knowledgeResult.rows as unknown as RawIdentityRow[];
  const sourceRaw = sourceResult.rows as unknown as RawIdentityRow[];
  const episodeRaw = episodeResult.rows as unknown as RawIdentityRow[];
  const knowledgeRows = knowledgeRaw.map((row) => toBackfillRow(row, "knowledge", input));
  const sourceRows = sourceRaw.map((row) => toBackfillRow(row, "source", input));
  const episodeRows = episodeRaw.map((row) => toBackfillRow(row, "episode", input));
  const provenance = new Map<string, RepositoryIdentityProvenance[]>();

  for (const row of targetResult.rows as Array<{
    knowledge_ids: unknown;
    metadata: unknown;
  }>) {
    for (const knowledgeId of array(row.knowledge_ids)) {
      if (typeof knowledgeId === "string") {
        addProvenance(provenance, knowledgeId, "distillation_target_state", [row.metadata]);
      }
    }
  }
  for (const row of finalResult.rows as Array<{
    entity_id: string;
    provenance: unknown;
  }>) {
    addProvenance(provenance, row.entity_id, "cover_evidence_chain", row.provenance);
  }
  const legacyCover = new Map<string, unknown>();
  for (const row of legacyCoverResult.rows as Array<{
    cover_id: string;
    provenance: unknown;
  }>) {
    legacyCover.set(row.cover_id, row.provenance);
  }
  for (const row of knowledgeRaw) {
    const sourceUri = record(row.metadata).sourceUri;
    if (typeof sourceUri !== "string" || !sourceUri.startsWith("cover-evidence-result://"))
      continue;
    const linked = legacyCover.get(sourceUri.slice("cover-evidence-result://".length));
    if (linked) addProvenance(provenance, row.id, "legacy_cover_evidence_chain", linked);
  }

  const runs = new Map<string, Record<string, unknown>>();
  for (const raw of runResult.rows as Array<Record<string, unknown>>) {
    const snapshot = runIdentitySnapshot(raw);
    if (snapshot) runs.set(String(raw.id), snapshot);
  }
  for (const raw of episodeRaw) {
    if (raw.source_kind !== "compile_run") continue;
    const runId = compileRunId(raw.source_key);
    const snapshot = runId ? runs.get(runId) : undefined;
    if (snapshot) addProvenance(provenance, raw.id, "compile_run", [snapshot]);
  }
  attachProvenance(knowledgeRows, provenance);
  attachProvenance(episodeRows, provenance);

  return {
    rows: [...knowledgeRows, ...sourceRows, ...episodeRows],
    aliases: aliasRows
      .filter(
        (item): item is typeof item & { aliasKind: "repo_key" | "repo_path" } =>
          item.aliasKind === "repo_key" || item.aliasKind === "repo_path",
      )
      .map((item) => ({
        projectRef: item.projectRef,
        aliasKind: item.aliasKind,
        normalizedValue: item.normalizedValue,
      })),
    portableKnowledge: new Map(knowledgeRaw.map((row) => [row.id, record(row.applies_to)])),
  };
}

function sqliteRows<T>(sqlite: SqliteCoreDatabase, query: string): T[] {
  return sqlite.db.query<T, []>(query).all();
}

function collectSqliteData(
  sqlite: SqliteCoreDatabase,
  input: RunRepositoryIdentityBackfillInput,
): CollectedBackfillData {
  const knowledgeRaw = sqliteRows<RawIdentityRow>(
    sqlite,
    "select id, classification_status, scope, project_ref, repo_key, repo_path, metadata, applies_to from knowledge_items",
  );
  const sourceRaw = sqliteRows<RawIdentityRow>(
    sqlite,
    "select id, classification_status, scope, project_ref, repo_key, repo_path, metadata from sources",
  );
  const episodeRaw = sqliteRows<RawIdentityRow>(
    sqlite,
    "select id, classification_status, scope, project_ref, repo_key, repo_path, metadata, source_kind, source_key from episode_cards",
  );
  const aliases = sqliteRows<{
    project_ref: string;
    alias_kind: string;
    normalized_value: string;
  }>(
    sqlite,
    "select project_ref, alias_kind, normalized_value from project_identity_aliases where status = 'active'",
  )
    .filter((item) => item.alias_kind === "repo_key" || item.alias_kind === "repo_path")
    .map((item) => ({
      projectRef: item.project_ref,
      aliasKind: item.alias_kind as "repo_key" | "repo_path",
      normalizedValue: item.normalized_value,
    }));

  const knowledgeRows = knowledgeRaw.map((row) => toBackfillRow(row, "knowledge", input));
  const sourceRows = sourceRaw.map((row) => toBackfillRow(row, "source", input));
  const episodeRows = episodeRaw.map((row) => toBackfillRow(row, "episode", input));
  const provenance = new Map<string, RepositoryIdentityProvenance[]>();
  for (const row of sqliteRows<{ knowledge_ids: unknown; metadata: unknown }>(
    sqlite,
    "select knowledge_ids, metadata from distillation_target_states",
  )) {
    for (const knowledgeId of array(row.knowledge_ids)) {
      if (typeof knowledgeId === "string") {
        addProvenance(provenance, knowledgeId, "distillation_target_state", [row.metadata]);
      }
    }
  }
  for (const row of sqliteRows<{ entity_id: string; provenance: unknown }>(
    sqlite,
    `select z.knowledge_id as entity_id,
            json_array(z.metadata, e.metadata, f.metadata, f.origin, q.payload, q.metadata) as provenance
       from finalize_distille_queue z
       join evidence_coverage_results e on e.id = z.evidence_result_id
       join found_candidates f on f.id = e.found_candidate_id
       join finding_candidate_queue q on q.id = f.finding_job_id
      where z.knowledge_id is not null`,
  )) {
    addProvenance(provenance, row.entity_id, "cover_evidence_chain", row.provenance);
  }
  const legacyCover = new Map(
    sqliteRows<{ cover_id: string; provenance: unknown }>(
      sqlite,
      `select c.id as cover_id, json_array(t.metadata, f.origin) as provenance
         from cover_evidence_results c
         join find_candidate_results f on f.id = c.id
         join distillation_target_states t on t.id = f.target_state_id`,
    ).map((row) => [row.cover_id, row.provenance]),
  );
  for (const row of knowledgeRaw) {
    const sourceUri = record(row.metadata).sourceUri;
    if (typeof sourceUri !== "string" || !sourceUri.startsWith("cover-evidence-result://"))
      continue;
    const linked = legacyCover.get(sourceUri.slice("cover-evidence-result://".length));
    if (linked) addProvenance(provenance, row.id, "legacy_cover_evidence_chain", linked);
  }
  const runs = new Map<string, Record<string, unknown>>();
  for (const raw of sqliteRows<Record<string, unknown>>(
    sqlite,
    "select id, project_ref, repo_key, repo_path, match_basis, identity_contract_version, scope_mode from context_compile_runs",
  )) {
    const snapshot = runIdentitySnapshot(raw);
    if (snapshot) runs.set(String(raw.id), snapshot);
  }
  for (const raw of episodeRaw) {
    if (raw.source_kind !== "compile_run") continue;
    const runId = compileRunId(raw.source_key);
    const snapshot = runId ? runs.get(runId) : undefined;
    if (snapshot) addProvenance(provenance, raw.id, "compile_run", [snapshot]);
  }
  attachProvenance(knowledgeRows, provenance);
  attachProvenance(episodeRows, provenance);
  return {
    rows: [...knowledgeRows, ...sourceRows, ...episodeRows],
    aliases,
    portableKnowledge: new Map(knowledgeRaw.map((row) => [row.id, record(row.applies_to)])),
  };
}

function withPortableIdentity(
  current: Record<string, unknown>,
  decision: RepositoryIdentityBackfillDecision,
): Record<string, unknown> {
  const { projectRef: _projectRef, repoKey: _repoKey, repoPath: _repoPath, ...next } = current;
  if (decision.after.classificationStatus === "classified" && decision.after.scope === "repo") {
    if (decision.after.projectRef) next.projectRef = decision.after.projectRef;
    if (decision.after.repoKey) next.repoKey = decision.after.repoKey;
    if (decision.after.repoPath) next.repoPath = decision.after.repoPath;
  }
  return next;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push(items.slice(index, index + size));
  return result;
}

async function applyPostgresPlan(
  plan: RepositoryIdentityBackfillPlan,
  portableKnowledge: Map<string, Record<string, unknown>>,
  batchSize: number,
  reviews: readonly RepositoryIdentityReviewDecision[],
): Promise<{ updatedCount: number; auditInsertedCount: number }> {
  let updatedCount = 0;
  let auditInsertedCount = 0;
  for (const batch of chunks(plan.decisions, batchSize)) {
    await db.transaction(async (tx) => {
      for (const item of batch) {
        if (item.changed) {
          const values = {
            classificationStatus: item.after.classificationStatus,
            scope: item.after.scope,
            projectRef: item.after.projectRef,
            repoKey: item.after.repoKey,
            repoPath: item.after.repoPath,
          };
          if (item.entityKind === "knowledge") {
            await tx
              .update(knowledgeItems)
              .set({
                ...values,
                appliesTo: withPortableIdentity(portableKnowledge.get(item.entityId) ?? {}, item),
                updatedAt: new Date(),
              })
              .where(eq(knowledgeItems.id, item.entityId));
          } else if (item.entityKind === "source") {
            await tx
              .update(sources)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(sources.id, item.entityId));
          } else {
            await tx
              .update(episodeCards)
              .set({ ...values, updatedAt: new Date() })
              .where(eq(episodeCards.id, item.entityId));
          }
          updatedCount += 1;
        }
        const inserted = await tx
          .insert(repositoryIdentityMigrationAudits)
          .values({
            migrationVersion: plan.migrationVersion,
            entityKind: item.entityKind,
            entityId: item.entityId,
            beforeFingerprint: item.beforeFingerprint,
            afterFingerprint: item.afterFingerprint,
            reasonCode: item.reasonCode,
            provenanceSource: item.provenanceSource,
            outcome: item.outcome,
          })
          .onConflictDoNothing()
          .returning({ id: repositoryIdentityMigrationAudits.id });
        auditInsertedCount += inserted.length;
      }
      const batchReviews = reviews.filter((review) =>
        batch.some(
          (item) => item.entityKind === review.entityKind && item.entityId === review.entityId,
        ),
      );
      if (batchReviews.length > 0) {
        await tx.insert(auditLogs).values(
          batchReviews.map((review) => ({
            eventType: "REPOSITORY_IDENTITY_REVIEW_DECISION",
            actor: "user" as const,
            payload: {
              migrationVersion: plan.migrationVersion,
              planChecksum: plan.checksum,
              entityKind: review.entityKind,
              entityId: review.entityId,
              decision: review.decision,
              reviewer: review.reviewer,
              reason: review.reason,
              reviewedAt: review.reviewedAt,
            },
          })),
        );
      }
      await tx.insert(auditLogs).values({
        eventType: "REPOSITORY_IDENTITY_MIGRATION_BATCH",
        actor: "system",
        payload: {
          migrationVersion: plan.migrationVersion,
          planChecksum: plan.checksum,
          batchRows: batch.length,
          changedRows: batch.filter((item) => item.changed).length,
        },
      });
    });
  }
  return { updatedCount, auditInsertedCount };
}

function applySqlitePlan(
  sqlite: SqliteCoreDatabase,
  plan: RepositoryIdentityBackfillPlan,
  portableKnowledge: Map<string, Record<string, unknown>>,
  batchSize: number,
  reviews: readonly RepositoryIdentityReviewDecision[],
): { updatedCount: number; auditInsertedCount: number } {
  let updatedCount = 0;
  let auditInsertedCount = 0;
  for (const batch of chunks(plan.decisions, batchSize)) {
    sqlite.db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of batch) {
        if (item.changed) {
          const table =
            item.entityKind === "knowledge"
              ? "knowledge_items"
              : item.entityKind === "source"
                ? "sources"
                : "episode_cards";
          if (item.entityKind === "knowledge") {
            sqlite.db
              .query(
                `update ${table}
                    set classification_status = ?, scope = ?, project_ref = ?, repo_key = ?, repo_path = ?,
                        applies_to = ?, updated_at = CURRENT_TIMESTAMP
                  where id = ?`,
              )
              .run(
                item.after.classificationStatus,
                item.after.scope,
                item.after.projectRef,
                item.after.repoKey,
                item.after.repoPath,
                JSON.stringify(
                  withPortableIdentity(portableKnowledge.get(item.entityId) ?? {}, item),
                ),
                item.entityId,
              );
          } else {
            sqlite.db
              .query(
                `update ${table}
                    set classification_status = ?, scope = ?, project_ref = ?, repo_key = ?, repo_path = ?,
                        updated_at = CURRENT_TIMESTAMP
                  where id = ?`,
              )
              .run(
                item.after.classificationStatus,
                item.after.scope,
                item.after.projectRef,
                item.after.repoKey,
                item.after.repoPath,
                item.entityId,
              );
          }
          updatedCount += 1;
        }
        const result = sqlite.db
          .query(
            `insert or ignore into repository_identity_migration_audits
              (id, migration_version, entity_kind, entity_id, before_fingerprint, after_fingerprint,
               reason_code, provenance_source, outcome)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            plan.migrationVersion,
            item.entityKind,
            item.entityId,
            item.beforeFingerprint,
            item.afterFingerprint,
            item.reasonCode,
            item.provenanceSource,
            item.outcome,
          );
        auditInsertedCount += result.changes;
        const review = reviews.find(
          (candidate) =>
            candidate.entityKind === item.entityKind && candidate.entityId === item.entityId,
        );
        if (review) {
          sqlite.db
            .query("insert into audit_logs (id, event_type, actor, payload) values (?, ?, ?, ?)")
            .run(
              randomUUID(),
              "REPOSITORY_IDENTITY_REVIEW_DECISION",
              "user",
              JSON.stringify({
                migrationVersion: plan.migrationVersion,
                planChecksum: plan.checksum,
                entityKind: item.entityKind,
                entityId: item.entityId,
                decision: review.decision,
                reviewer: review.reviewer,
                reason: review.reason,
                reviewedAt: review.reviewedAt,
              }),
            );
        }
      }
      sqlite.db
        .query("insert into audit_logs (id, event_type, actor, payload) values (?, ?, ?, ?)")
        .run(
          randomUUID(),
          "REPOSITORY_IDENTITY_MIGRATION_BATCH",
          "system",
          JSON.stringify({
            migrationVersion: plan.migrationVersion,
            planChecksum: plan.checksum,
            batchRows: batch.length,
            changedRows: batch.filter((item) => item.changed).length,
          }),
        );
      sqlite.db.exec("COMMIT");
    } catch (error) {
      sqlite.db.exec("ROLLBACK");
      throw error;
    }
  }
  return { updatedCount, auditInsertedCount };
}

function requireWriteInputs(input: RunRepositoryIdentityBackfillInput): void {
  if (!input.backupReference?.trim()) {
    throw new Error(
      "write mode requires --backup-reference for a verified offline backup or snapshot",
    );
  }
  if (!input.expectedChecksum?.trim()) {
    throw new Error("write mode requires the checksum from a reviewed dry-run");
  }
}

function requireWriteSafety(input: RunRepositoryIdentityBackfillInput, checksum: string): void {
  requireWriteInputs(input);
  if (input.expectedChecksum !== checksum) {
    throw new Error(
      `backfill plan checksum changed: expected ${input.expectedChecksum}, received ${checksum}`,
    );
  }
  for (const entityKind of ["knowledge", "source", "episode"] as const) {
    for (const entityId of input.explicitGlobalPromotions?.[entityKind] ?? []) {
      const hasMatchingReview = input.reviewDecisions?.some(
        (review) =>
          review.entityKind === entityKind &&
          review.entityId === entityId &&
          review.decision === "global",
      );
      if (!hasMatchingReview) {
        throw new Error(
          `write mode requires a matching global review decision for ${entityKind}:${entityId}`,
        );
      }
    }
  }
}

async function requireSeparateSqliteBackupReference(
  sqlitePath: string,
  backupReference: string,
): Promise<void> {
  if (path.resolve(backupReference) === path.resolve(sqlitePath)) {
    throw new Error("SQLite backup reference must not be the target database path");
  }
  try {
    const [targetRealPath, backupRealPath, targetStat, backupStat] = await Promise.all([
      realpath(sqlitePath),
      realpath(backupReference),
      stat(sqlitePath),
      stat(backupReference),
    ]);
    if (
      targetRealPath === backupRealPath ||
      (targetStat.dev === backupStat.dev && targetStat.ino === backupStat.ino)
    ) {
      throw new Error("SQLite backup reference must not resolve to the target database file");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SQLite backup reference")) throw error;
    // A backup reference may be an external snapshot identifier rather than a local file.
  }
}

function isValidIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[7] ?? 0);
  const offsetMinute = Number(match[8] ?? 0);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(new Date(value).getTime())
  );
}

function validateReviewDecisions(input: RunRepositoryIdentityBackfillInput): void {
  const seen = new Set<string>();
  for (const decision of input.reviewDecisions ?? []) {
    const key = `${decision.entityKind}:${decision.entityId}`;
    if (seen.has(key)) throw new Error(`duplicate review decision: ${key}`);
    seen.add(key);
    if (!decision.entityId.trim() || !decision.reviewer.trim() || !decision.reason.trim()) {
      throw new Error(`review decision requires entityId, reviewer, and reason: ${key}`);
    }
    if (!isValidIsoTimestamp(decision.reviewedAt)) {
      throw new Error(`review decision has invalid reviewedAt: ${key}`);
    }
  }
}

function validateReviewDecisionsAgainstPlan(
  input: RunRepositoryIdentityBackfillInput,
  plan: RepositoryIdentityBackfillPlan,
): void {
  const decisionsByEntity = new Map(
    plan.decisions.map((decision) => [`${decision.entityKind}:${decision.entityId}`, decision]),
  );
  for (const review of input.reviewDecisions ?? []) {
    const key = `${review.entityKind}:${review.entityId}`;
    const planned = decisionsByEntity.get(key);
    if (!planned) throw new Error(`review decision references an unknown entity: ${key}`);
    const hasIdentity = Boolean(
      planned.after.projectRef || planned.after.repoKey || planned.after.repoPath,
    );
    const hasNoIdentity =
      planned.after.projectRef === null &&
      planned.after.repoKey === null &&
      planned.after.repoPath === null;
    const matches =
      review.decision === "global"
        ? planned.after.classificationStatus === "classified" &&
          planned.after.scope === "global" &&
          hasNoIdentity
        : review.decision === "repo"
          ? planned.after.classificationStatus === "classified" &&
            planned.after.scope === "repo" &&
            hasIdentity
          : planned.after.classificationStatus === "unresolved" && hasNoIdentity;
    if (!matches) {
      throw new Error(`review decision conflicts with deterministic plan: ${key}`);
    }
  }
}

export async function runRepositoryIdentityBackfill(
  input: RunRepositoryIdentityBackfillInput = {},
): Promise<RepositoryIdentityBackfillSummary> {
  const mode = input.mode ?? "dry-run";
  validateReviewDecisions(input);
  if (mode === "write") requireWriteInputs(input);
  const batchSize = Math.min(1000, Math.max(1, Math.trunc(input.batchSize ?? 200)));
  const backendConfig = resolveDatabaseBackendConfig({
    sqlitePath: input.sqlitePath,
  });
  if (backendConfig.kind === "postgres") {
    const data = await collectPostgresData(input);
    const plan = planRepositoryIdentityBackfill(data);
    validateReviewDecisionsAgainstPlan(input, plan);
    if (mode === "dry-run") {
      return {
        ...plan,
        mode,
        backend: "postgres",
        batchSize,
        updatedCount: 0,
        auditInsertedCount: 0,
        backupReference: null,
      };
    }
    requireWriteSafety(input, plan.checksum);
    const applied = await applyPostgresPlan(
      plan,
      data.portableKnowledge,
      batchSize,
      input.reviewDecisions ?? [],
    );
    return {
      ...plan,
      ...applied,
      mode,
      backend: "postgres",
      batchSize,
      backupReference: input.backupReference?.trim() ?? null,
    };
  }

  if (!backendConfig.sqlitePath) throw new Error("SQLite path is required");
  if (mode === "write") {
    await requireSeparateSqliteBackupReference(
      backendConfig.sqlitePath,
      input.backupReference?.trim() ?? "",
    );
  }
  const sqlite = await openSqliteCoreDatabase({
    path: backendConfig.sqlitePath,
    loadVectorExtension: false,
  });
  try {
    const data = collectSqliteData(sqlite, input);
    const plan = planRepositoryIdentityBackfill(data);
    validateReviewDecisionsAgainstPlan(input, plan);
    if (mode === "dry-run") {
      return {
        ...plan,
        mode,
        backend: "sqlite",
        batchSize,
        updatedCount: 0,
        auditInsertedCount: 0,
        backupReference: null,
      };
    }
    requireWriteSafety(input, plan.checksum);
    const applied = applySqlitePlan(
      sqlite,
      plan,
      data.portableKnowledge,
      batchSize,
      input.reviewDecisions ?? [],
    );
    return {
      ...plan,
      ...applied,
      mode,
      backend: "sqlite",
      batchSize,
      backupReference: input.backupReference?.trim() ?? null,
    };
  } finally {
    sqlite.db.close();
  }
}
