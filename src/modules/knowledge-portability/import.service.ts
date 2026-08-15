import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { type SQL, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  ProjectScopedWriteError,
  resolveProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import {
  PORTABLE_EXPORT_FORMAT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  type PortableEvidenceIndex,
  type PortableExportCounts,
  type PortableExportDialect,
  type PortableExportManifest,
} from "./format.js";
import {
  type PortableParsedSqlRow,
  buildPostgresInsertOnlyStatements,
  parsePostgresDataSql,
} from "./sql-reader.js";

export type ImportKnowledgeDryRunOptions = {
  fromDir: string;
  dialect?: Extract<PortableExportDialect, "postgres">;
};

export type ImportValidationIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  file?: string;
  table?: string;
  id?: string;
};

export type ImportKnowledgeDryRunSummary = {
  fromDir: string;
  dialect: "postgres";
  ok: boolean;
  manifest: PortableExportManifest | null;
  counts: Partial<PortableExportCounts>;
  files: {
    manifest: string;
    checksums: string;
    evidenceIndex: string;
    sql: string;
  };
  skippedEvidence: PortableEvidenceIndex["skippedEvidence"];
  issues: ImportValidationIssue[];
};

export type ImportKnowledgeApplyMode = "insert-only";

export type ImportSqlExecutor = {
  transaction<T>(
    callback: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<T>,
  ): Promise<T>;
};

export type ImportKnowledgeApplyOptions = {
  fromDir: string;
  mode: ImportKnowledgeApplyMode;
  dialect?: Extract<PortableExportDialect, "postgres">;
  executor?: ImportSqlExecutor;
};

export type ImportKnowledgeApplySummary = ImportKnowledgeDryRunSummary & {
  mode: ImportKnowledgeApplyMode;
  applied: boolean;
  statementsExecuted: number;
};

const tableCountKeys = {
  knowledge_items: "knowledgeItems",
  knowledge_tag_definitions: "knowledgeTagDefinitions",
  knowledge_community_labels: "knowledgeCommunityLabels",
  knowledge_quality_adjustments: "knowledgeQualityAdjustments",
  knowledge_origin_links: "knowledgeOriginLinks",
  sources: "sources",
  source_fragments: "sourceFragments",
  knowledge_source_links: "knowledgeSourceLinks",
} as const satisfies Record<string, keyof PortableExportCounts>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readRequiredFile(
  filePath: string,
  issues: ImportValidationIssue[],
): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    issues.push({
      severity: "error",
      code: "missing_required_file",
      message: `Required file is missing or unreadable: ${path.basename(filePath)}`,
      file: filePath,
    });
    if (error instanceof Error) return "";
    return "";
  }
}

function parseChecksums(raw: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(trimmed);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    entries.set(match[2] ?? "", match[1] ?? "");
  }
  return entries;
}

function validateManifest(
  manifest: unknown,
  dialect: "postgres",
  issues: ImportValidationIssue[],
): PortableExportManifest | null {
  if (!isRecord(manifest)) {
    issues.push({
      severity: "error",
      code: "invalid_manifest",
      message: "manifest.json must contain an object",
      file: "manifest.json",
    });
    return null;
  }

  if (manifest.format !== PORTABLE_EXPORT_FORMAT) {
    issues.push({
      severity: "error",
      code: "unsupported_format",
      message: `Unsupported export format: ${String(manifest.format)}`,
      file: "manifest.json",
    });
  }
  if (manifest.schemaVersion !== PORTABLE_EXPORT_SCHEMA_VERSION) {
    issues.push({
      severity: "error",
      code: "unsupported_schema_version",
      message: `Unsupported schema version: ${String(manifest.schemaVersion)}`,
      file: "manifest.json",
    });
  }

  const sql = isRecord(manifest.sql) ? manifest.sql : null;
  const availableDialects = Array.isArray(sql?.availableDialects) ? sql.availableDialects : [];
  if (!availableDialects.includes(dialect)) {
    issues.push({
      severity: "error",
      code: "missing_sql_dialect",
      message: `Archive does not include SQL dialect: ${dialect}`,
      file: "manifest.json",
    });
  }

  let hasInvalidShape = false;

  if (!isRecord(manifest.counts)) {
    hasInvalidShape = true;
    issues.push({
      severity: "error",
      code: "missing_manifest_counts",
      message: "manifest.json must include counts",
      file: "manifest.json",
    });
  }

  return hasInvalidShape ? null : (manifest as PortableExportManifest);
}

function validateEvidenceIndex(
  evidenceIndex: unknown,
  issues: ImportValidationIssue[],
): PortableEvidenceIndex | null {
  if (!isRecord(evidenceIndex)) {
    issues.push({
      severity: "error",
      code: "invalid_evidence_index",
      message: "evidence-index.json must contain an object",
      file: "evidence-index.json",
    });
    return null;
  }
  if (evidenceIndex.format !== "context-still-portable-evidence-index") {
    issues.push({
      severity: "error",
      code: "unsupported_evidence_index_format",
      message: `Unsupported evidence index format: ${String(evidenceIndex.format)}`,
      file: "evidence-index.json",
    });
  }
  if (evidenceIndex.schemaVersion !== 1) {
    issues.push({
      severity: "error",
      code: "unsupported_evidence_index_schema",
      message: `Unsupported evidence index schema: ${String(evidenceIndex.schemaVersion)}`,
      file: "evidence-index.json",
    });
  }
  let hasInvalidShape = false;
  if (!isRecord(evidenceIndex.knowledge)) {
    hasInvalidShape = true;
    issues.push({
      severity: "error",
      code: "missing_evidence_index_knowledge",
      message: "evidence-index.json must include knowledge mapping",
      file: "evidence-index.json",
    });
  }
  if (!Array.isArray(evidenceIndex.skippedEvidence)) {
    hasInvalidShape = true;
    issues.push({
      severity: "error",
      code: "missing_skipped_evidence",
      message: "evidence-index.json must include skippedEvidence",
      file: "evidence-index.json",
    });
  }
  return hasInvalidShape ? null : (evidenceIndex as PortableEvidenceIndex);
}

function rowsByTable(
  tables: Map<string, PortableParsedSqlRow[]>,
  tableName: string,
): PortableParsedSqlRow[] {
  return tables.get(tableName) ?? [];
}

function stringField(row: PortableParsedSqlRow, field: string): string | null {
  return asString(row.values[field]);
}

function indexRows(rows: PortableParsedSqlRow[], field: string): Map<string, PortableParsedSqlRow> {
  const index = new Map<string, PortableParsedSqlRow>();
  for (const row of rows) {
    const id = stringField(row, field);
    if (id) index.set(id, row);
  }
  return index;
}

function pushMissingReferenceIssue(
  issues: ImportValidationIssue[],
  input: {
    table: string;
    id: string | null;
    field: string;
    targetTable: string;
    targetId: string | null;
  },
): void {
  issues.push({
    severity: "error",
    code: "missing_reference",
    message: `${input.table}.${input.field} references missing ${input.targetTable}: ${String(
      input.targetId,
    )}`,
    table: input.table,
    id: input.id ?? undefined,
  });
}

function validateSqlCounts(
  manifest: PortableExportManifest | null,
  counts: Partial<PortableExportCounts>,
  issues: ImportValidationIssue[],
): void {
  if (!manifest) return;
  for (const key of Object.values(tableCountKeys)) {
    const expected = manifest.counts[key];
    const actual = counts[key] ?? 0;
    if (expected !== actual) {
      issues.push({
        severity: "error",
        code: "manifest_count_mismatch",
        message: `Count mismatch for ${key}: manifest=${expected}, sql=${actual}`,
        file: "manifest.json",
      });
    }
  }
}

function validateReferentialConsistency(
  tables: Map<string, PortableParsedSqlRow[]>,
  evidenceIndex: PortableEvidenceIndex | null,
  issues: ImportValidationIssue[],
): void {
  const knowledge = indexRows(rowsByTable(tables, "knowledge_items"), "id");
  const sources = indexRows(rowsByTable(tables, "sources"), "id");
  const fragments = indexRows(rowsByTable(tables, "source_fragments"), "id");
  const links = indexRows(rowsByTable(tables, "knowledge_source_links"), "id");
  const origins = indexRows(rowsByTable(tables, "knowledge_origin_links"), "id");
  const qualityAdjustments = rowsByTable(tables, "knowledge_quality_adjustments");

  for (const fragment of fragments.values()) {
    const sourceId = stringField(fragment, "source_id");
    if (!sourceId || !sources.has(sourceId)) {
      pushMissingReferenceIssue(issues, {
        table: "source_fragments",
        id: stringField(fragment, "id"),
        field: "source_id",
        targetTable: "sources",
        targetId: sourceId,
      });
    }
  }

  for (const link of links.values()) {
    const knowledgeId = stringField(link, "knowledge_id");
    const fragmentId = stringField(link, "source_fragment_id");
    if (!knowledgeId || !knowledge.has(knowledgeId)) {
      pushMissingReferenceIssue(issues, {
        table: "knowledge_source_links",
        id: stringField(link, "id"),
        field: "knowledge_id",
        targetTable: "knowledge_items",
        targetId: knowledgeId,
      });
    }
    if (!fragmentId || !fragments.has(fragmentId)) {
      pushMissingReferenceIssue(issues, {
        table: "knowledge_source_links",
        id: stringField(link, "id"),
        field: "source_fragment_id",
        targetTable: "source_fragments",
        targetId: fragmentId,
      });
    }
  }

  for (const origin of origins.values()) {
    const knowledgeId = stringField(origin, "knowledge_id");
    if (!knowledgeId || !knowledge.has(knowledgeId)) {
      pushMissingReferenceIssue(issues, {
        table: "knowledge_origin_links",
        id: stringField(origin, "id"),
        field: "knowledge_id",
        targetTable: "knowledge_items",
        targetId: knowledgeId,
      });
    }
  }

  for (const adjustment of qualityAdjustments) {
    const knowledgeId = stringField(adjustment, "knowledge_id");
    if (!knowledgeId || !knowledge.has(knowledgeId)) {
      pushMissingReferenceIssue(issues, {
        table: "knowledge_quality_adjustments",
        id: stringField(adjustment, "id"),
        field: "knowledge_id",
        targetTable: "knowledge_items",
        targetId: knowledgeId,
      });
    }
  }

  if (!evidenceIndex) return;

  for (const knowledgeId of Object.keys(evidenceIndex.knowledge)) {
    if (!knowledge.has(knowledgeId)) {
      issues.push({
        severity: "error",
        code: "evidence_index_unknown_knowledge",
        message: `Evidence index references missing knowledge item: ${knowledgeId}`,
        file: "evidence-index.json",
        id: knowledgeId,
      });
      continue;
    }

    const entry = evidenceIndex.knowledge[knowledgeId];
    for (const sourceRef of entry.sourceRefs) {
      const link = links.get(sourceRef.knowledgeSourceLinkId);
      const fragment = fragments.get(sourceRef.sourceFragmentId);
      if (!link) {
        issues.push({
          severity: "error",
          code: "evidence_index_missing_source_link",
          message: `Evidence index references missing knowledge_source_link: ${sourceRef.knowledgeSourceLinkId}`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      }
      if (!fragment) {
        issues.push({
          severity: "error",
          code: "evidence_index_missing_fragment",
          message: `Evidence index references missing source_fragment: ${sourceRef.sourceFragmentId}`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      }
      if (!sources.has(sourceRef.sourceId)) {
        issues.push({
          severity: "error",
          code: "evidence_index_missing_source",
          message: `Evidence index references missing source: ${sourceRef.sourceId}`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      }
      if (link && stringField(link, "knowledge_id") !== knowledgeId) {
        issues.push({
          severity: "error",
          code: "evidence_index_link_mismatch",
          message: `Evidence source link ${sourceRef.knowledgeSourceLinkId} belongs to another knowledge item`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      }
      if (fragment && stringField(fragment, "source_id") !== sourceRef.sourceId) {
        issues.push({
          severity: "error",
          code: "evidence_index_fragment_source_mismatch",
          message: `Evidence source fragment ${sourceRef.sourceFragmentId} belongs to another source`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      }
    }

    for (const originRef of entry.originRefs) {
      const origin = origins.get(originRef.originLinkId);
      if (!origin) {
        issues.push({
          severity: "error",
          code: "evidence_index_missing_origin",
          message: `Evidence index references missing knowledge_origin_link: ${originRef.originLinkId}`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      } else if (stringField(origin, "knowledge_id") !== knowledgeId) {
        issues.push({
          severity: "error",
          code: "evidence_index_origin_mismatch",
          message: `Evidence origin link ${originRef.originLinkId} belongs to another knowledge item`,
          file: "evidence-index.json",
          id: knowledgeId,
        });
      }
    }
  }
}

function validateProjectIdentityRows(
  tables: Map<string, PortableParsedSqlRow[]>,
  issues: ImportValidationIssue[],
): void {
  for (const table of ["knowledge_items", "sources"] as const) {
    for (const row of rowsByTable(tables, table)) {
      const id = stringField(row, "id") ?? undefined;
      const classificationStatus = stringField(row, "classification_status");
      const scope = stringField(row, "scope");
      if (classificationStatus !== "classified") {
        issues.push({
          severity: "error",
          code: "project_identity_not_classified",
          message: `${table} import row must have classification_status=classified`,
          table,
          id,
        });
        continue;
      }
      if (scope !== "repo" && scope !== "global") {
        issues.push({
          severity: "error",
          code: "project_identity_scope_invalid",
          message: `${table} import row must have scope=repo or scope=global`,
          table,
          id,
        });
        continue;
      }
      try {
        const identity = resolveProjectScopedWriteIdentity({
          scope,
          projectRef: stringField(row, "project_ref"),
          repoKey: stringField(row, "repo_key"),
          repoPath: stringField(row, "repo_path"),
        });
        if (
          identity.projectRef !== stringField(row, "project_ref") ||
          identity.repoKey !== stringField(row, "repo_key") ||
          identity.repoPath !== stringField(row, "repo_path")
        ) {
          throw new Error("canonical identity values are not normalized");
        }
      } catch (error) {
        issues.push({
          severity: "error",
          code: "project_identity_contract_violation",
          message: `${table} import row violates the project identity contract: ${
            error instanceof ProjectScopedWriteError ? error.code : "NON_CANONICAL_IDENTITY"
          }`,
          table,
          id,
        });
      }
    }
  }
}

export async function validateKnowledgeImportArchive(
  options: ImportKnowledgeDryRunOptions,
): Promise<ImportKnowledgeDryRunSummary> {
  const fromDir = path.resolve(options.fromDir);
  const dialect = options.dialect ?? "postgres";
  const files = {
    manifest: path.join(fromDir, "manifest.json"),
    checksums: path.join(fromDir, "checksums.sha256"),
    evidenceIndex: path.join(fromDir, "evidence-index.json"),
    sql: path.join(fromDir, "sql", `${dialect}.sql`),
  };
  const issues: ImportValidationIssue[] = [];

  const manifestRaw = await readRequiredFile(files.manifest, issues);
  const checksumsRaw = await readRequiredFile(files.checksums, issues);
  const evidenceIndexRaw = await readRequiredFile(files.evidenceIndex, issues);
  const sqlRaw = await readRequiredFile(files.sql, issues);

  if (issues.some((issue) => issue.code === "missing_required_file")) {
    return {
      fromDir,
      dialect,
      ok: false,
      manifest: null,
      counts: {},
      files,
      skippedEvidence: [],
      issues,
    };
  }

  let manifest: PortableExportManifest | null = null;
  let evidenceIndex: PortableEvidenceIndex | null = null;
  let parsedCounts: Partial<PortableExportCounts> = {};

  try {
    manifest = validateManifest(JSON.parse(manifestRaw), dialect, issues);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "invalid_manifest_json",
      message: error instanceof Error ? error.message : String(error),
      file: "manifest.json",
    });
  }

  try {
    evidenceIndex = validateEvidenceIndex(JSON.parse(evidenceIndexRaw), issues);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "invalid_evidence_index_json",
      message: error instanceof Error ? error.message : String(error),
      file: "evidence-index.json",
    });
  }

  try {
    const checksums = parseChecksums(checksumsRaw);
    const expectedFiles = [
      ["manifest.json", manifestRaw],
      ["evidence-index.json", evidenceIndexRaw],
      [`sql/${dialect}.sql`, sqlRaw],
    ] as const;
    for (const [relativePath, content] of expectedFiles) {
      const expected = checksums.get(relativePath);
      if (!expected) {
        issues.push({
          severity: "error",
          code: "missing_checksum",
          message: `Missing checksum entry: ${relativePath}`,
          file: "checksums.sha256",
        });
      } else if (expected !== checksum(content)) {
        issues.push({
          severity: "error",
          code: "checksum_mismatch",
          message: `Checksum mismatch: ${relativePath}`,
          file: "checksums.sha256",
        });
      }
    }
  } catch (error) {
    issues.push({
      severity: "error",
      code: "invalid_checksums",
      message: error instanceof Error ? error.message : String(error),
      file: "checksums.sha256",
    });
  }

  try {
    const parsedSql = parsePostgresDataSql(sqlRaw);
    const countEntries: Array<[keyof PortableExportCounts, number]> = [];
    for (const [tableName, count] of parsedSql.counts.entries()) {
      const countKey = tableCountKeys[tableName as keyof typeof tableCountKeys];
      if (countKey) countEntries.push([countKey, count]);
    }
    parsedCounts = Object.fromEntries(countEntries);
    validateSqlCounts(manifest, parsedCounts, issues);
    validateReferentialConsistency(parsedSql.tables, evidenceIndex, issues);
    validateProjectIdentityRows(parsedSql.tables, issues);
  } catch (error) {
    issues.push({
      severity: "error",
      code: "invalid_sql",
      message: error instanceof Error ? error.message : String(error),
      file: `sql/${dialect}.sql`,
    });
  }

  return {
    fromDir,
    dialect,
    ok: !issues.some((issue) => issue.severity === "error"),
    manifest,
    counts: parsedCounts,
    files,
    skippedEvidence: evidenceIndex?.skippedEvidence ?? [],
    issues,
  };
}

export async function importKnowledgeArchive(
  options: ImportKnowledgeApplyOptions,
): Promise<ImportKnowledgeApplySummary> {
  if (options.mode !== "insert-only") {
    throw new Error(`Unsupported import mode: ${String(options.mode)}`);
  }

  const validation = await validateKnowledgeImportArchive({
    fromDir: options.fromDir,
    dialect: options.dialect ?? "postgres",
  });
  if (!validation.ok) {
    return {
      ...validation,
      mode: options.mode,
      applied: false,
      statementsExecuted: 0,
    };
  }

  const sqlRaw = await readFile(validation.files.sql, "utf8");
  const statements = buildPostgresInsertOnlyStatements(sqlRaw);
  const executor = options.executor ?? db;

  await executor.transaction(async (tx) => {
    for (const statement of statements) {
      await tx.execute(sql.raw(statement));
    }
  });

  return {
    ...validation,
    mode: options.mode,
    applied: true,
    statementsExecuted: statements.length,
  };
}
