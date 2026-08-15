import { and, gte, inArray } from "drizzle-orm";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import {
  auditLogs,
  contextCompileRuns,
  contextPackItems,
  episodeCards,
  knowledgeItems,
  projectIdentityAliases,
  sources,
} from "../../db/schema.js";
import { getDefaultDbSession } from "../../db/session.js";
import { asRecord } from "../../shared/utils/normalize.js";
import {
  type CompileProjectIdentityAlias,
  type CompileProjectIdentityInput,
  resolveCompileProjectIdentity,
} from "./compile-project-identity.js";
import {
  type RepositoryIdentityProducerEvent,
  type RepositoryIsolationReport,
  type RepositoryIsolationRunObservation,
  type RepositoryIsolationSchemaCapabilities,
  buildRepositoryIsolationReport,
} from "./repository-isolation-report.js";
import type { RepositoryIsolationProducerManifest } from "./repository-isolation-producer-manifest.js";
import type {
  RepositoryEntityKind,
  RepositoryFacets,
  RepositoryScopeCandidate,
} from "./repository-scope.js";

type SqliteReader = {
  query<T = unknown, P extends unknown[] = unknown[]>(sql: string): { all(...params: P): T[] };
};

type RawCandidate = {
  id: string;
  entityKind: RepositoryEntityKind;
  status: string | null;
  classificationStatus: string | null;
  scope: string | null;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  producer: string | null;
  metadata: unknown;
  facets: unknown;
};

type RawRun = {
  id: string;
  createdAt: unknown;
  durationMs: unknown;
  status: unknown;
  degradedReasons: unknown;
  scopeMode: unknown;
  matchBasis: unknown;
  projectRef: unknown;
  repoKey: unknown;
  repoPath: unknown;
  identityContractVersion: unknown;
  packSnapshot: unknown;
};

type RawPackItem = {
  runId: string;
  itemKind: string;
  itemId: string;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function producerFromMetadata(metadata: unknown, fallback: string | null): string {
  const record = asRecord(parseJson(metadata));
  for (const key of ["producer", "sourceKind", "source_kind", "originKind", "origin_kind"]) {
    const value = stringOrNull(record[key]);
    if (value) return value.slice(0, 120);
  }
  return fallback?.slice(0, 120) || "unknown";
}

function facetsFromUnknown(value: unknown): RepositoryFacets & { general?: boolean } {
  const record = asRecord(parseJson(value));
  return {
    technologies: stringArray(record.technologies),
    changeTypes: stringArray(record.changeTypes ?? record.change_types),
    domains: stringArray(record.domains),
    general: record.general === true,
  };
}

function normalizeCandidate(raw: RawCandidate): RepositoryScopeCandidate {
  const facets = facetsFromUnknown(raw.facets);
  return {
    id: raw.id,
    entityKind: raw.entityKind,
    status: raw.status,
    classificationStatus: raw.classificationStatus,
    scope: raw.scope,
    projectRef: raw.projectRef,
    repoKey: raw.repoKey,
    repoPath: raw.repoPath,
    general: facets.general === true,
    facets,
    producer: producerFromMetadata(raw.metadata, raw.producer),
  };
}

function dateFromUnknown(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" && value.startsWith("unix-ms:")) {
    const milliseconds = Number(value.slice("unix-ms:".length));
    if (Number.isFinite(milliseconds)) return new Date(milliseconds);
  }
  const parsed = new Date(typeof value === "string" || typeof value === "number" ? value : 0);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

function runMatchBasis(value: unknown): RepositoryIsolationRunObservation["matchBasis"] {
  if (value === "project_ref" || value === "repo_key" || value === "repo_path") return value;
  return "none";
}

function runScopeMode(value: unknown): RepositoryIsolationRunObservation["scopeMode"] {
  return value === "project" ? "project" : "global_only";
}

function identityContractVersion(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function outputMarkdownKind(value: unknown): "narrative" | "no-content" | null {
  const pack = asRecord(parseJson(value));
  const diagnostics = asRecord(pack.diagnostics);
  const retrievalStats = asRecord(diagnostics.retrievalStats);
  const responseComposer = asRecord(
    Object.keys(retrievalStats).length > 0
      ? retrievalStats.responseComposer
      : diagnostics.responseComposer,
  );
  if (responseComposer.markdownKind === "narrative") return "narrative";
  if (responseComposer.markdownKind === "no-content") return "no-content";
  const markdown =
    stringOrNull(responseComposer.outputMarkdown) ?? stringOrNull(pack.outputMarkdown) ?? "";
  if (markdown === "No Content") return "no-content";
  return markdown.length > 0 ? "narrative" : null;
}

function entityKindFromPackItem(itemKind: string): RepositoryEntityKind {
  if (itemKind === "episode" || itemKind === "episode_card") return "episode";
  if (itemKind === "source" || itemKind === "source_fragment" || itemKind === "code_context") {
    return "source";
  }
  return "knowledge";
}

function normalizeRuns(
  rawRuns: RawRun[],
  packItems: RawPackItem[],
): RepositoryIsolationRunObservation[] {
  const selectedByRun = new Map<string, Record<RepositoryEntityKind, string[]>>();
  for (const item of packItems) {
    const selected = selectedByRun.get(item.runId) ?? {
      knowledge: [],
      source: [],
      episode: [],
    };
    selected[entityKindFromPackItem(item.itemKind)].push(item.itemId);
    selectedByRun.set(item.runId, selected);
  }
  return rawRuns.map((run) => ({
    id: run.id,
    createdAt: dateFromUnknown(run.createdAt),
    durationMs: Math.max(0, Number(run.durationMs) || 0),
    status: stringOrNull(run.status) ?? "unknown",
    degradedReasons: stringArray(parseJson(run.degradedReasons)),
    scopeMode: runScopeMode(run.scopeMode),
    matchBasis: runMatchBasis(run.matchBasis),
    projectRef: stringOrNull(run.projectRef),
    repoKey: stringOrNull(run.repoKey),
    repoPath: stringOrNull(run.repoPath),
    identityContractVersion: identityContractVersion(run.identityContractVersion),
    outputMarkdownKind: outputMarkdownKind(run.packSnapshot),
    selectedIdsByEntity: selectedByRun.get(run.id) ?? {
      knowledge: [],
      source: [],
      episode: [],
    },
  }));
}

function sqliteTableExists(db: SqliteReader, tableName: string): boolean {
  return (
    db
      .query<{ present: number }, [string]>(
        "select 1 as present from sqlite_master where type = 'table' and name = ? limit 1",
      )
      .all(tableName).length > 0
  );
}

function sqliteTableColumns(db: SqliteReader, tableName: string): Set<string> {
  if (!sqliteTableExists(db, tableName)) return new Set();
  return new Set(
    db
      .query<{ name: string }, []>(`pragma table_info(${tableName})`)
      .all()
      .map((row) => row.name),
  );
}

function sqliteColumn(columns: Set<string>, name: string, fallback: string): string {
  return columns.has(name) ? name : `${fallback} as ${name}`;
}

function sqliteTimestampMillis(column: string): string {
  return `case
    when ${column} like 'unix-ms:%' then cast(substr(${column}, 9) as integer)
    else cast(round((julianday(${column}) - 2440587.5) * 86400000) as integer)
  end`;
}

function sqliteSchemaCapabilities(db: SqliteReader): RepositoryIsolationSchemaCapabilities {
  const entity = (tableName: string) => {
    const columns = sqliteTableColumns(db, tableName);
    return {
      classificationStatus: columns.has("classification_status"),
      scope: columns.has("scope"),
      projectRef: columns.has("project_ref"),
      repoKey: columns.has("repo_key"),
      repoPath: columns.has("repo_path"),
    };
  };
  const runColumns = sqliteTableColumns(db, "context_compile_runs");
  return {
    entities: {
      knowledge: entity("knowledge_items"),
      source: entity("sources"),
      episode: entity("episode_cards"),
    },
    runIdentity:
      runColumns.has("scope_mode") &&
      runColumns.has("match_basis") &&
      runColumns.has("identity_contract_version") &&
      runColumns.has("project_ref") &&
      runColumns.has("repo_key") &&
      runColumns.has("repo_path"),
    identityAliases: sqliteTableExists(db, "project_identity_aliases"),
  };
}

function sqliteCandidates(db: SqliteReader): RepositoryScopeCandidate[] {
  const knowledgeColumns = sqliteTableColumns(db, "knowledge_items");
  const sourceColumns = sqliteTableColumns(db, "sources");
  const episodeColumns = sqliteTableColumns(db, "episode_cards");
  if (knowledgeColumns.size === 0 && sourceColumns.size === 0 && episodeColumns.size === 0)
    return [];
  const knowledge = db
    .query<Record<string, unknown>, []>(
      `select id,
              ${sqliteColumn(knowledgeColumns, "status", "'active'")},
              ${sqliteColumn(knowledgeColumns, "classification_status", "'unresolved'")},
              ${sqliteColumn(knowledgeColumns, "scope", "'repo'")},
              ${sqliteColumn(knowledgeColumns, "project_ref", "null")},
              ${sqliteColumn(knowledgeColumns, "repo_key", "null")},
              ${sqliteColumn(knowledgeColumns, "repo_path", "null")},
              ${sqliteColumn(knowledgeColumns, "metadata", "'{}'")},
              ${sqliteColumn(knowledgeColumns, "applies_to", "'{}'")}
         from knowledge_items`,
    )
    .all()
    .map(
      (row): RawCandidate => ({
        id: String(row.id),
        entityKind: "knowledge",
        status: stringOrNull(row.status),
        classificationStatus: stringOrNull(row.classification_status),
        scope: stringOrNull(row.scope),
        projectRef: stringOrNull(row.project_ref),
        repoKey: stringOrNull(row.repo_key),
        repoPath: stringOrNull(row.repo_path),
        producer: null,
        metadata: row.metadata,
        facets: row.applies_to,
      }),
    );
  const sourceRows = db
    .query<Record<string, unknown>, []>(
      `select id,
              ${sqliteColumn(sourceColumns, "source_kind", "'unknown'")},
              ${sqliteColumn(sourceColumns, "classification_status", "'unresolved'")},
              ${sqliteColumn(sourceColumns, "scope", "'repo'")},
              ${sqliteColumn(sourceColumns, "project_ref", "null")},
              ${sqliteColumn(sourceColumns, "repo_key", "null")},
              ${sqliteColumn(sourceColumns, "repo_path", "null")},
              ${sqliteColumn(sourceColumns, "metadata", "'{}'")}
         from sources`,
    )
    .all()
    .map(
      (row): RawCandidate => ({
        id: String(row.id),
        entityKind: "source",
        status: "active",
        classificationStatus: stringOrNull(row.classification_status),
        scope: stringOrNull(row.scope),
        projectRef: stringOrNull(row.project_ref),
        repoKey: stringOrNull(row.repo_key),
        repoPath: stringOrNull(row.repo_path),
        producer: stringOrNull(row.source_kind),
        metadata: row.metadata,
        facets: row.metadata,
      }),
    );
  const episodes = db
    .query<Record<string, unknown>, []>(
      `select id,
              ${sqliteColumn(episodeColumns, "status", "'active'")},
              ${sqliteColumn(episodeColumns, "source_kind", "'unknown'")},
              ${sqliteColumn(episodeColumns, "classification_status", "'unresolved'")},
              ${sqliteColumn(episodeColumns, "scope", "'repo'")},
              ${sqliteColumn(episodeColumns, "project_ref", "null")},
              ${sqliteColumn(episodeColumns, "repo_key", "null")},
              ${sqliteColumn(episodeColumns, "repo_path", "null")},
              ${sqliteColumn(episodeColumns, "metadata", "'{}'")},
              ${sqliteColumn(episodeColumns, "technologies", "'[]'")},
              ${sqliteColumn(episodeColumns, "change_types", "'[]'")},
              ${sqliteColumn(episodeColumns, "domains", "'[]'")},
              ${sqliteColumn(episodeColumns, "applicability", "'{}'")}
         from episode_cards`,
    )
    .all()
    .map((row): RawCandidate => {
      const applicability = asRecord(parseJson(row.applicability));
      return {
        id: String(row.id),
        entityKind: "episode",
        status: stringOrNull(row.status),
        classificationStatus: stringOrNull(row.classification_status),
        scope: stringOrNull(row.scope),
        projectRef: stringOrNull(row.project_ref),
        repoKey: stringOrNull(row.repo_key),
        repoPath: stringOrNull(row.repo_path),
        producer: stringOrNull(row.source_kind),
        metadata: row.metadata,
        facets: {
          technologies: stringArray(parseJson(row.technologies)),
          changeTypes: stringArray(parseJson(row.change_types)),
          domains: stringArray(parseJson(row.domains)),
          general: applicability.general === true,
        },
      };
    });
  return [...knowledge, ...sourceRows, ...episodes].map(normalizeCandidate);
}

function sqliteAliases(db: SqliteReader): CompileProjectIdentityAlias[] {
  if (!sqliteTableExists(db, "project_identity_aliases")) return [];
  return db
    .query<Record<string, unknown>, []>(
      `select project_ref, alias_kind, normalized_value
         from project_identity_aliases
        where status = 'active'`,
    )
    .all()
    .flatMap((row) => {
      const aliasKind = row.alias_kind;
      const projectRef = stringOrNull(row.project_ref);
      const normalizedValue = stringOrNull(row.normalized_value);
      return projectRef &&
        normalizedValue &&
        (aliasKind === "repo_key" || aliasKind === "repo_path")
        ? [{ projectRef, aliasKind, normalizedValue }]
        : [];
    });
}

function sqliteRuns(db: SqliteReader, now: Date): RepositoryIsolationRunObservation[] {
  const runColumns = sqliteTableColumns(db, "context_compile_runs");
  if (runColumns.size === 0) return [];
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const rows = db
    .query<Record<string, unknown>, [number]>(
      `select id,
              ${sqliteColumn(runColumns, "created_at", "CURRENT_TIMESTAMP")},
              ${sqliteColumn(runColumns, "duration_ms", "0")},
              ${sqliteColumn(runColumns, "status", "'unknown'")},
              ${sqliteColumn(runColumns, "degraded_reasons", "'[]'")},
              ${sqliteColumn(runColumns, "scope_mode", "'global_only'")},
              ${sqliteColumn(runColumns, "match_basis", "'none'")},
              ${sqliteColumn(runColumns, "project_ref", "null")},
              ${sqliteColumn(runColumns, "repo_key", "null")},
              ${
                runColumns.has("match_basis")
                  ? sqliteColumn(runColumns, "repo_path", "null")
                  : "null as repo_path"
              },
              ${sqliteColumn(runColumns, "identity_contract_version", "0")},
              ${sqliteColumn(runColumns, "pack_snapshot", "null")}
         from context_compile_runs
        where ${sqliteTimestampMillis("created_at")} >= ?`,
    )
    .all(cutoff)
    .map(
      (row): RawRun => ({
        id: String(row.id),
        createdAt: row.created_at,
        durationMs: row.duration_ms,
        status: row.status,
        degradedReasons: row.degraded_reasons,
        scopeMode: row.scope_mode,
        matchBasis: row.match_basis,
        projectRef: row.project_ref,
        repoKey: row.repo_key,
        repoPath: row.repo_path,
        identityContractVersion: row.identity_contract_version,
        packSnapshot: row.pack_snapshot,
      }),
    );
  const packItems = !sqliteTableExists(db, "context_pack_items")
    ? []
    : db
        .query<Record<string, unknown>, [number]>(
          `select item.run_id, item.item_kind, item.item_id
         from context_pack_items item
         join context_compile_runs run on run.id = item.run_id
        where ${sqliteTimestampMillis("run.created_at")} >= ?`,
        )
        .all(cutoff)
        .map(
          (row): RawPackItem => ({
            runId: String(row.run_id),
            itemKind: String(row.item_kind),
            itemId: String(row.item_id),
          }),
        );
  return normalizeRuns(rows, packItems);
}

function sqliteProducerEvents(db: SqliteReader, now: Date): RepositoryIdentityProducerEvent[] {
  if (!sqliteTableExists(db, "audit_logs")) return [];
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  return db
    .query<Record<string, unknown>, [string, string, string, number]>(
      `select event_type, payload, created_at
         from audit_logs
        where event_type in (?, ?, ?)
          and ${sqliteTimestampMillis("created_at")} >= ?`,
    )
    .all(
      "PROJECT_IDENTITY_PRODUCER_VALIDATED",
      "PROJECT_IDENTITY_PRODUCER_PERSISTED",
      "PROJECT_IDENTITY_PRODUCER_REJECTED",
      cutoff,
    )
    .flatMap((row) => {
      const eventType = row.event_type;
      if (
        eventType !== "PROJECT_IDENTITY_PRODUCER_VALIDATED" &&
        eventType !== "PROJECT_IDENTITY_PRODUCER_PERSISTED" &&
        eventType !== "PROJECT_IDENTITY_PRODUCER_REJECTED"
      ) {
        return [];
      }
      return [
        {
          eventType,
          createdAt: dateFromUnknown(row.created_at),
          payload: asRecord(parseJson(row.payload)),
        },
      ];
    });
}

function sqliteNewUnresolvedCounts(
  db: SqliteReader,
  now: Date,
): Record<RepositoryEntityKind, number> {
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const count = (table: string): number => {
    const columns = sqliteTableColumns(db, table);
    if (!columns.has("classification_status") || !columns.has("created_at")) return 0;
    const row = db
      .query<{ count: number }, [number]>(
        `select count(*) as count
           from ${table}
          where ${sqliteTimestampMillis("created_at")} >= ?
            and coalesce(classification_status, 'unresolved') <> 'classified'`,
      )
      .all(cutoff)[0];
    return Math.max(0, Number(row?.count ?? 0));
  };
  return {
    knowledge: count("knowledge_items"),
    source: count("sources"),
    episode: count("episode_cards"),
  };
}

export function collectRepositoryIsolationReportFromSqlite(input: {
  db: SqliteReader;
  identityInput?: CompileProjectIdentityInput;
  requestFacets?: RepositoryFacets;
  previewLimit?: number;
  recentRunLimit?: number;
  producerManifest?: RepositoryIsolationProducerManifest;
  now?: Date;
}): RepositoryIsolationReport {
  const now = input.now ?? new Date();
  const aliases = sqliteAliases(input.db);
  const requestIdentity = input.identityInput
    ? resolveCompileProjectIdentity(input.identityInput, { aliases })
    : undefined;
  return buildRepositoryIsolationReport({
    backend: "sqlite",
    candidates: sqliteCandidates(input.db),
    runs: sqliteRuns(input.db, now),
    producerEvents: sqliteProducerEvents(input.db, now),
    newUnresolvedByEntity: sqliteNewUnresolvedCounts(input.db, now),
    requestIdentity,
    requestFacets: input.requestFacets,
    previewLimit: input.previewLimit,
    recentRunLimit: input.recentRunLimit,
    producerManifest: input.producerManifest,
    now,
    schemaCapabilities: sqliteSchemaCapabilities(input.db),
  });
}

async function collectPostgresData(now: Date): Promise<{
  candidates: RepositoryScopeCandidate[];
  aliases: CompileProjectIdentityAlias[];
  runs: RepositoryIsolationRunObservation[];
  producerEvents: RepositoryIdentityProducerEvent[];
  newUnresolvedByEntity: Record<RepositoryEntityKind, number>;
}> {
  const db = getDefaultDbSession().db;
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const producerCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [knowledgeRows, sourceRows, episodeRows, aliasRows, runRows, producerRows] =
    await Promise.all([
      db
        .select({
          id: knowledgeItems.id,
          status: knowledgeItems.status,
          classificationStatus: knowledgeItems.classificationStatus,
          scope: knowledgeItems.scope,
          projectRef: knowledgeItems.projectRef,
          repoKey: knowledgeItems.repoKey,
          repoPath: knowledgeItems.repoPath,
          metadata: knowledgeItems.metadata,
          facets: knowledgeItems.appliesTo,
          createdAt: knowledgeItems.createdAt,
        })
        .from(knowledgeItems),
      db
        .select({
          id: sources.id,
          sourceKind: sources.sourceKind,
          classificationStatus: sources.classificationStatus,
          scope: sources.scope,
          projectRef: sources.projectRef,
          repoKey: sources.repoKey,
          repoPath: sources.repoPath,
          metadata: sources.metadata,
          createdAt: sources.createdAt,
        })
        .from(sources),
      db
        .select({
          id: episodeCards.id,
          status: episodeCards.status,
          sourceKind: episodeCards.sourceKind,
          classificationStatus: episodeCards.classificationStatus,
          scope: episodeCards.scope,
          projectRef: episodeCards.projectRef,
          repoKey: episodeCards.repoKey,
          repoPath: episodeCards.repoPath,
          metadata: episodeCards.metadata,
          technologies: episodeCards.technologies,
          changeTypes: episodeCards.changeTypes,
          domains: episodeCards.domains,
          applicability: episodeCards.applicability,
          createdAt: episodeCards.createdAt,
        })
        .from(episodeCards),
      db
        .select({
          projectRef: projectIdentityAliases.projectRef,
          aliasKind: projectIdentityAliases.aliasKind,
          normalizedValue: projectIdentityAliases.normalizedValue,
        })
        .from(projectIdentityAliases),
      db
        .select({
          id: contextCompileRuns.id,
          createdAt: contextCompileRuns.createdAt,
          durationMs: contextCompileRuns.durationMs,
          status: contextCompileRuns.status,
          degradedReasons: contextCompileRuns.degradedReasons,
          scopeMode: contextCompileRuns.scopeMode,
          matchBasis: contextCompileRuns.matchBasis,
          projectRef: contextCompileRuns.projectRef,
          repoKey: contextCompileRuns.repoKey,
          repoPath: contextCompileRuns.repoPath,
          identityContractVersion: contextCompileRuns.identityContractVersion,
          packSnapshot: contextCompileRuns.packSnapshot,
        })
        .from(contextCompileRuns)
        .where(gte(contextCompileRuns.createdAt, cutoff)),
      db
        .select({
          eventType: auditLogs.eventType,
          payload: auditLogs.payload,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            gte(auditLogs.createdAt, producerCutoff),
            inArray(auditLogs.eventType, [
              "PROJECT_IDENTITY_PRODUCER_VALIDATED",
              "PROJECT_IDENTITY_PRODUCER_PERSISTED",
              "PROJECT_IDENTITY_PRODUCER_REJECTED",
            ]),
          ),
        ),
    ]);

  const runIds = runRows.map((run) => run.id);
  const packRows =
    runIds.length === 0
      ? []
      : await db
          .select({
            runId: contextPackItems.runId,
            itemKind: contextPackItems.itemKind,
            itemId: contextPackItems.itemId,
          })
          .from(contextPackItems)
          .where(inArray(contextPackItems.runId, runIds));
  const candidates: RawCandidate[] = [
    ...knowledgeRows.map((row) => ({
      ...row,
      id: String(row.id),
      entityKind: "knowledge" as const,
      producer: null,
    })),
    ...sourceRows.map((row) => ({
      ...row,
      id: String(row.id),
      entityKind: "source" as const,
      status: "active",
      producer: row.sourceKind,
      facets: row.metadata,
    })),
    ...episodeRows.map((row) => ({
      ...row,
      id: String(row.id),
      entityKind: "episode" as const,
      producer: row.sourceKind,
      facets: {
        technologies: row.technologies,
        changeTypes: row.changeTypes,
        domains: row.domains,
        general: asRecord(row.applicability).general === true,
      },
    })),
  ];
  return {
    candidates: candidates.map(normalizeCandidate),
    aliases: aliasRows.flatMap((row) =>
      row.aliasKind === "repo_key" || row.aliasKind === "repo_path"
        ? [
            {
              projectRef: row.projectRef,
              aliasKind: row.aliasKind,
              normalizedValue: row.normalizedValue,
            },
          ]
        : [],
    ),
    runs: normalizeRuns(
      runRows.map((row) => ({ ...row })),
      packRows.map((row) => ({ ...row })),
    ),
    producerEvents: producerRows.flatMap((row) =>
      row.createdAt >= producerCutoff &&
      (row.eventType === "PROJECT_IDENTITY_PRODUCER_VALIDATED" ||
        row.eventType === "PROJECT_IDENTITY_PRODUCER_PERSISTED" ||
        row.eventType === "PROJECT_IDENTITY_PRODUCER_REJECTED")
        ? [
            {
              eventType: row.eventType,
              createdAt: row.createdAt,
              payload: asRecord(row.payload),
            },
          ]
        : [],
    ),
    newUnresolvedByEntity: {
      knowledge: knowledgeRows.filter(
        (row) => row.createdAt >= producerCutoff && row.classificationStatus !== "classified",
      ).length,
      source: sourceRows.filter(
        (row) => row.createdAt >= producerCutoff && row.classificationStatus !== "classified",
      ).length,
      episode: episodeRows.filter(
        (row) => row.createdAt >= producerCutoff && row.classificationStatus !== "classified",
      ).length,
    },
  };
}

export async function collectRepositoryIsolationReport(
  input: {
    identityInput?: CompileProjectIdentityInput;
    requestFacets?: RepositoryFacets;
    previewLimit?: number;
    recentRunLimit?: number;
    producerManifest?: RepositoryIsolationProducerManifest;
    now?: Date;
  } = {},
): Promise<RepositoryIsolationReport> {
  const now = input.now ?? new Date();
  const backend = resolveDatabaseBackendConfig().kind;
  if (backend === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    return collectRepositoryIsolationReportFromSqlite({
      db: sqlite.db,
      ...input,
      now,
    });
  }
  const data = await collectPostgresData(now);
  const requestIdentity = input.identityInput
    ? resolveCompileProjectIdentity(input.identityInput, {
        aliases: data.aliases,
      })
    : undefined;
  return buildRepositoryIsolationReport({
    backend: "postgres",
    candidates: data.candidates,
    runs: data.runs,
    producerEvents: data.producerEvents,
    newUnresolvedByEntity: data.newUnresolvedByEntity,
    requestIdentity,
    requestFacets: input.requestFacets,
    previewLimit: input.previewLimit,
    recentRunLimit: input.recentRunLimit,
    producerManifest: input.producerManifest,
    now,
  });
}
