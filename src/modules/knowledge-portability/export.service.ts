import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { asc, inArray } from "drizzle-orm";
import { groupedConfig } from "../../config.js";
import { db } from "../../db/index.js";
import {
  knowledgeCommunityLabels,
  knowledgeItems,
  knowledgeOriginLinks,
  knowledgeQualityAdjustments,
  knowledgeSourceLinks,
  knowledgeTagDefinitions,
  sourceFragments,
  sources,
} from "../../db/schema.js";
import { projectIdentity } from "../../project-identity.js";
import { redactSecretsFromValue } from "../../shared/utils/secret-redaction.js";
import {
  PORTABLE_EXPORT_FORMAT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  PORTABLE_EXPORT_SECRET_PLACEHOLDER,
  PORTABLE_EXPORT_SUBSET_VERSION,
  type PortableEvidenceIndex,
  type PortableExportCounts,
  type PortableExportManifest,
  type PortableExportSummary,
} from "./format.js";
import {
  type PortableColumnDefinition,
  type PortableSqlRow,
  type PortableSqlTable,
  writePostgresDataSql,
} from "./sql-writer.js";

export type ExportKnowledgeArchiveOptions = {
  outDir: string;
};

type TableExportSpec = {
  table: PortableSqlTable;
  rows: PortableSqlRow[];
};

type KnowledgeItemExportRow = Omit<typeof knowledgeItems.$inferSelect, "embedding">;
type SourceFragmentExportRow = Omit<typeof sourceFragments.$inferSelect, "embedding">;

const fallbackPackageVersion = "0.1.0";

const knowledgeItemsTable: PortableSqlTable = {
  name: "knowledge_items",
  columns: [
    textColumn("id"),
    textColumn("type"),
    textColumn("status"),
    textColumn("scope"),
    textColumn("classification_status"),
    textColumn("project_ref"),
    textColumn("repo_key"),
    textColumn("repo_path"),
    textColumn("polarity"),
    jsonbColumn("intent_tags"),
    textColumn("title"),
    textColumn("body"),
    jsonbColumn("applies_to"),
    numberColumn("confidence"),
    numberColumn("importance"),
    numberColumn("compile_select_count"),
    timestampColumn("last_compiled_at"),
    numberColumn("agentic_accept_count"),
    numberColumn("explicit_upvote_count"),
    numberColumn("explicit_downvote_count"),
    numberColumn("dynamic_score"),
    jsonbColumn("metadata"),
    timestampColumn("created_at"),
    timestampColumn("updated_at"),
    timestampColumn("last_verified_at"),
  ],
};

const knowledgeTagDefinitionsTable: PortableSqlTable = {
  name: "knowledge_tag_definitions",
  columns: [
    textColumn("id"),
    textColumn("kind"),
    textColumn("slug"),
    textColumn("label"),
    textColumn("description"),
    jsonbColumn("aliases"),
    textColumn("status"),
    numberColumn("sort_order"),
    timestampColumn("created_at"),
    timestampColumn("updated_at"),
  ],
};

const knowledgeCommunityLabelsTable: PortableSqlTable = {
  name: "knowledge_community_labels",
  columns: [
    textColumn("community_key"),
    textColumn("label"),
    textColumn("note"),
    timestampColumn("updated_at"),
  ],
};

const knowledgeQualityAdjustmentsTable: PortableSqlTable = {
  name: "knowledge_quality_adjustments",
  columns: [
    textColumn("id"),
    textColumn("knowledge_id"),
    textColumn("adjustment_kind"),
    timestampColumn("window_start_at"),
    timestampColumn("window_end_at"),
    numberColumn("negative_run_count"),
    numberColumn("off_topic_rate"),
    numberColumn("importance_delta"),
    numberColumn("confidence_delta"),
    timestampColumn("created_at"),
  ],
};

const knowledgeOriginLinksTable: PortableSqlTable = {
  name: "knowledge_origin_links",
  columns: [
    textColumn("id"),
    textColumn("knowledge_id"),
    textColumn("origin_kind"),
    textColumn("origin_uri"),
    textColumn("origin_key"),
    numberColumn("confidence"),
    jsonbColumn("metadata"),
    timestampColumn("created_at"),
  ],
};

const sourcesTable: PortableSqlTable = {
  name: "sources",
  columns: [
    textColumn("id"),
    textColumn("source_kind"),
    textColumn("classification_status"),
    textColumn("scope"),
    textColumn("project_ref"),
    textColumn("repo_key"),
    textColumn("repo_path"),
    textColumn("uri"),
    textColumn("title"),
    textColumn("body"),
    jsonbColumn("metadata"),
    timestampColumn("created_at"),
    timestampColumn("updated_at"),
    timestampColumn("last_indexed_at"),
  ],
};

const sourceFragmentsTable: PortableSqlTable = {
  name: "source_fragments",
  columns: [
    textColumn("id"),
    textColumn("source_id"),
    textColumn("locator"),
    textColumn("heading"),
    textColumn("content"),
    jsonbColumn("metadata"),
    timestampColumn("created_at"),
  ],
};

const knowledgeSourceLinksTable: PortableSqlTable = {
  name: "knowledge_source_links",
  columns: [
    textColumn("id"),
    textColumn("knowledge_id"),
    textColumn("source_fragment_id"),
    textColumn("link_type"),
    numberColumn("confidence"),
    jsonbColumn("metadata"),
    timestampColumn("created_at"),
  ],
};

function textColumn(name: string): PortableColumnDefinition {
  return { name, kind: "text" };
}

function numberColumn(name: string): PortableColumnDefinition {
  return { name, kind: "number" };
}

function jsonbColumn(name: string): PortableColumnDefinition {
  return { name, kind: "jsonb" };
}

function timestampColumn(name: string): PortableColumnDefinition {
  return { name, kind: "timestamp" };
}

function redactRow(row: PortableSqlRow): PortableSqlRow {
  return redactSecretsFromValue(row) as PortableSqlRow;
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function asJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function readPackageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : fallbackPackageVersion;
  } catch {
    return fallbackPackageVersion;
  }
}

function mapKnowledgeItem(row: KnowledgeItemExportRow): PortableSqlRow {
  return redactRow({
    id: row.id,
    type: row.type,
    status: row.status,
    scope: row.scope,
    classification_status: row.classificationStatus,
    project_ref: row.projectRef,
    repo_key: row.repoKey,
    repo_path: row.repoPath,
    polarity: row.polarity,
    intent_tags: row.intentTags,
    title: row.title,
    body: row.body,
    applies_to: row.appliesTo,
    confidence: row.confidence,
    importance: row.importance,
    compile_select_count: row.compileSelectCount,
    last_compiled_at: row.lastCompiledAt,
    agentic_accept_count: row.agenticAcceptCount,
    explicit_upvote_count: row.explicitUpvoteCount,
    explicit_downvote_count: row.explicitDownvoteCount,
    dynamic_score: row.dynamicScore,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_verified_at: row.lastVerifiedAt,
  });
}

function mapTagDefinition(row: typeof knowledgeTagDefinitions.$inferSelect): PortableSqlRow {
  return redactRow({
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    label: row.label,
    description: row.description,
    aliases: row.aliases,
    status: row.status,
    sort_order: row.sortOrder,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

function mapCommunityLabel(row: typeof knowledgeCommunityLabels.$inferSelect): PortableSqlRow {
  return redactRow({
    community_key: row.communityKey,
    label: row.label,
    note: row.note,
    updated_at: row.updatedAt,
  });
}

function mapQualityAdjustment(
  row: typeof knowledgeQualityAdjustments.$inferSelect,
): PortableSqlRow {
  return redactRow({
    id: row.id,
    knowledge_id: row.knowledgeId,
    adjustment_kind: row.adjustmentKind,
    window_start_at: row.windowStartAt,
    window_end_at: row.windowEndAt,
    negative_run_count: row.negativeRunCount,
    off_topic_rate: row.offTopicRate,
    importance_delta: row.importanceDelta,
    confidence_delta: row.confidenceDelta,
    created_at: row.createdAt,
  });
}

function mapOriginLink(row: typeof knowledgeOriginLinks.$inferSelect): PortableSqlRow {
  return redactRow({
    id: row.id,
    knowledge_id: row.knowledgeId,
    origin_kind: row.originKind,
    origin_uri: row.originUri,
    origin_key: row.originKey,
    confidence: row.confidence,
    metadata: row.metadata,
    created_at: row.createdAt,
  });
}

function mapSource(row: typeof sources.$inferSelect): PortableSqlRow {
  return redactRow({
    id: row.id,
    source_kind: row.sourceKind,
    classification_status: row.classificationStatus,
    scope: row.scope,
    project_ref: row.projectRef,
    repo_key: row.repoKey,
    repo_path: row.repoPath,
    uri: row.uri,
    title: row.title,
    body: row.body,
    metadata: row.metadata,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_indexed_at: row.lastIndexedAt,
  });
}

function mapSourceFragment(row: SourceFragmentExportRow): PortableSqlRow {
  return redactRow({
    id: row.id,
    source_id: row.sourceId,
    locator: row.locator,
    heading: row.heading,
    content: row.content,
    metadata: row.metadata,
    created_at: row.createdAt,
  });
}

function mapKnowledgeSourceLink(row: typeof knowledgeSourceLinks.$inferSelect): PortableSqlRow {
  return redactRow({
    id: row.id,
    knowledge_id: row.knowledgeId,
    source_fragment_id: row.sourceFragmentId,
    link_type: row.linkType,
    confidence: row.confidence,
    metadata: row.metadata,
    created_at: row.createdAt,
  });
}

async function collectExportRows(): Promise<{
  tables: TableExportSpec[];
  counts: PortableExportCounts;
  evidenceIndex: PortableEvidenceIndex;
}> {
  const knowledgeRows = await db
    .select({
      id: knowledgeItems.id,
      type: knowledgeItems.type,
      status: knowledgeItems.status,
      scope: knowledgeItems.scope,
      classificationStatus: knowledgeItems.classificationStatus,
      projectRef: knowledgeItems.projectRef,
      repoKey: knowledgeItems.repoKey,
      repoPath: knowledgeItems.repoPath,
      polarity: knowledgeItems.polarity,
      intentTags: knowledgeItems.intentTags,
      title: knowledgeItems.title,
      body: knowledgeItems.body,
      appliesTo: knowledgeItems.appliesTo,
      confidence: knowledgeItems.confidence,
      importance: knowledgeItems.importance,
      compileSelectCount: knowledgeItems.compileSelectCount,
      lastCompiledAt: knowledgeItems.lastCompiledAt,
      agenticAcceptCount: knowledgeItems.agenticAcceptCount,
      explicitUpvoteCount: knowledgeItems.explicitUpvoteCount,
      explicitDownvoteCount: knowledgeItems.explicitDownvoteCount,
      dynamicScore: knowledgeItems.dynamicScore,
      metadata: knowledgeItems.metadata,
      createdAt: knowledgeItems.createdAt,
      updatedAt: knowledgeItems.updatedAt,
      lastVerifiedAt: knowledgeItems.lastVerifiedAt,
    })
    .from(knowledgeItems)
    .orderBy(asc(knowledgeItems.id));
  const knowledgeIds = knowledgeRows.map((row) => row.id);

  const tagRows = await db
    .select()
    .from(knowledgeTagDefinitions)
    .orderBy(asc(knowledgeTagDefinitions.kind), asc(knowledgeTagDefinitions.slug));
  const communityRows = await db
    .select()
    .from(knowledgeCommunityLabels)
    .orderBy(asc(knowledgeCommunityLabels.communityKey));

  const qualityRows =
    knowledgeIds.length > 0
      ? await db
          .select()
          .from(knowledgeQualityAdjustments)
          .where(inArray(knowledgeQualityAdjustments.knowledgeId, knowledgeIds))
          .orderBy(
            asc(knowledgeQualityAdjustments.knowledgeId),
            asc(knowledgeQualityAdjustments.id),
          )
      : [];

  const originRows =
    knowledgeIds.length > 0
      ? await db
          .select()
          .from(knowledgeOriginLinks)
          .where(inArray(knowledgeOriginLinks.knowledgeId, knowledgeIds))
          .orderBy(asc(knowledgeOriginLinks.knowledgeId), asc(knowledgeOriginLinks.id))
      : [];

  const linkRows =
    knowledgeIds.length > 0
      ? await db
          .select()
          .from(knowledgeSourceLinks)
          .where(inArray(knowledgeSourceLinks.knowledgeId, knowledgeIds))
          .orderBy(asc(knowledgeSourceLinks.knowledgeId), asc(knowledgeSourceLinks.id))
      : [];

  const sourceFragmentIds = unique(linkRows.map((row) => row.sourceFragmentId));
  const fragmentRows =
    sourceFragmentIds.length > 0
      ? await db
          .select({
            id: sourceFragments.id,
            sourceId: sourceFragments.sourceId,
            locator: sourceFragments.locator,
            heading: sourceFragments.heading,
            content: sourceFragments.content,
            metadata: sourceFragments.metadata,
            createdAt: sourceFragments.createdAt,
          })
          .from(sourceFragments)
          .where(inArray(sourceFragments.id, sourceFragmentIds))
          .orderBy(
            asc(sourceFragments.sourceId),
            asc(sourceFragments.locator),
            asc(sourceFragments.id),
          )
      : [];

  const sourceIds = unique(fragmentRows.map((row) => row.sourceId));
  const sourceRows =
    sourceIds.length > 0
      ? await db
          .select()
          .from(sources)
          .where(inArray(sources.id, sourceIds))
          .orderBy(asc(sources.uri), asc(sources.id))
      : [];

  const fragmentsById = new Map(fragmentRows.map((row) => [row.id, row]));
  const sourcesById = new Map(sourceRows.map((row) => [row.id, row]));

  const evidenceIndex: PortableEvidenceIndex = {
    format: "context-still-portable-evidence-index",
    schemaVersion: 1,
    knowledge: Object.fromEntries(
      knowledgeRows.map((knowledge) => [
        knowledge.id,
        {
          sourceRefs: [],
          originRefs: [],
        },
      ]),
    ),
    skippedEvidence: [
      {
        kind: "historical_workflow_evidence",
        reason: "historical workflow evidence projection is not implemented in this export slice",
        count: 0,
      },
    ],
  };

  for (const link of linkRows) {
    const fragment = fragmentsById.get(link.sourceFragmentId);
    const source = fragment ? sourcesById.get(fragment.sourceId) : undefined;
    if (!fragment || !source) continue;
    evidenceIndex.knowledge[link.knowledgeId]?.sourceRefs.push({
      knowledgeSourceLinkId: link.id,
      sourceId: source.id,
      sourceFragmentId: fragment.id,
      sourceUri: source.uri,
      locator: fragment.locator,
      linkType: link.linkType,
      confidence: link.confidence,
    });
  }

  for (const origin of originRows) {
    evidenceIndex.knowledge[origin.knowledgeId]?.originRefs.push({
      originLinkId: origin.id,
      originKind: origin.originKind,
      originUri: origin.originUri,
      originKey: origin.originKey,
      confidence: origin.confidence,
    });
  }

  const tables: TableExportSpec[] = [
    { table: sourcesTable, rows: sourceRows.map(mapSource) },
    { table: sourceFragmentsTable, rows: fragmentRows.map(mapSourceFragment) },
    { table: knowledgeTagDefinitionsTable, rows: tagRows.map(mapTagDefinition) },
    { table: knowledgeCommunityLabelsTable, rows: communityRows.map(mapCommunityLabel) },
    { table: knowledgeItemsTable, rows: knowledgeRows.map(mapKnowledgeItem) },
    { table: knowledgeSourceLinksTable, rows: linkRows.map(mapKnowledgeSourceLink) },
    { table: knowledgeOriginLinksTable, rows: originRows.map(mapOriginLink) },
    { table: knowledgeQualityAdjustmentsTable, rows: qualityRows.map(mapQualityAdjustment) },
  ];

  return {
    tables,
    counts: {
      knowledgeItems: knowledgeRows.length,
      knowledgeTagDefinitions: tagRows.length,
      knowledgeCommunityLabels: communityRows.length,
      knowledgeQualityAdjustments: qualityRows.length,
      knowledgeOriginLinks: originRows.length,
      sources: sourceRows.length,
      sourceFragments: fragmentRows.length,
      knowledgeSourceLinks: linkRows.length,
      historicalWorkflowEvidenceRecords: 0,
      contextDecisionEvidence: 0,
      contextDecisionCoverageTraces: 0,
      contextCompileEvals: 0,
      knowledgeUsageEvents: 0,
      contextDecisionHumanFeedback: 0,
      contextDecisionFeedback: 0,
    },
    evidenceIndex,
  };
}

export async function exportKnowledgeArchive(
  options: ExportKnowledgeArchiveOptions,
): Promise<PortableExportSummary> {
  const outDir = path.resolve(options.outDir);
  const sqlDir = path.join(outDir, "sql");
  await mkdir(sqlDir, { recursive: true });

  const createdAt = new Date().toISOString();
  const packageVersion = await readPackageVersion();
  const { tables, counts, evidenceIndex } = await collectExportRows();

  const manifest: PortableExportManifest = {
    format: PORTABLE_EXPORT_FORMAT,
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    createdAt,
    createdBy: {
      packageName: projectIdentity.packageName,
      packageVersion,
    },
    source: {
      databaseProvider: "postgres",
      embeddingDimension: groupedConfig.embedding.dimension,
    },
    sql: {
      canonicalDialect: "postgres",
      availableDialects: ["postgres"],
      portableSubsetVersion: PORTABLE_EXPORT_SUBSET_VERSION,
    },
    counts,
    redaction: {
      enabled: true,
      secretPlaceholder: PORTABLE_EXPORT_SECRET_PLACEHOLDER,
      localPathPolicy: "preserve",
    },
  };

  const manifestContent = asJson(manifest);
  const evidenceIndexContent = asJson(evidenceIndex);
  const sqlContent = writePostgresDataSql({
    tables,
    createdAt,
    redactionEnabled: true,
  });

  const manifestPath = path.join(outDir, "manifest.json");
  const evidenceIndexPath = path.join(outDir, "evidence-index.json");
  const sqlPath = path.join(sqlDir, "postgres.sql");
  const checksumsPath = path.join(outDir, "checksums.sha256");

  await writeFile(manifestPath, manifestContent, "utf8");
  await writeFile(evidenceIndexPath, evidenceIndexContent, "utf8");
  await writeFile(sqlPath, sqlContent, "utf8");

  const checksumsContent = [
    `${checksum(manifestContent)}  manifest.json`,
    `${checksum(evidenceIndexContent)}  evidence-index.json`,
    `${checksum(sqlContent)}  sql/postgres.sql`,
    "",
  ].join("\n");
  await writeFile(checksumsPath, checksumsContent, "utf8");

  return {
    outDir,
    manifestPath,
    sqlPath,
    evidenceIndexPath,
    checksumsPath,
    manifest,
  };
}
