import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { getDb } from "../src/db/index.js";
import {
  PORTABLE_EXPORT_FORMAT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  PORTABLE_EXPORT_SECRET_PLACEHOLDER,
  PORTABLE_EXPORT_SUBSET_VERSION,
  type PortableEvidenceIndex,
  type PortableExportManifest,
} from "../src/modules/knowledge-portability/format.js";
import { importKnowledgeArchive } from "../src/modules/knowledge-portability/import.service.js";
import { writePostgresDataSql } from "../src/modules/knowledge-portability/sql-writer.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function createRoundtripArchive(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-still-roundtrip-integration-"));
  await mkdir(path.join(root, "sql"), { recursive: true });

  const createdAt = "2026-06-19T00:00:00.000Z";
  const manifest: PortableExportManifest = {
    format: PORTABLE_EXPORT_FORMAT,
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    createdAt,
    createdBy: {
      packageName: "context-still",
      packageVersion: "0.1.0",
    },
    source: {
      databaseProvider: "postgres",
      embeddingDimension: 384,
    },
    sql: {
      canonicalDialect: "postgres",
      availableDialects: ["postgres"],
      portableSubsetVersion: PORTABLE_EXPORT_SUBSET_VERSION,
    },
    counts: {
      knowledgeItems: 1,
      knowledgeTagDefinitions: 1,
      knowledgeCommunityLabels: 0,
      knowledgeQualityAdjustments: 1,
      knowledgeOriginLinks: 1,
      sources: 1,
      sourceFragments: 1,
      knowledgeSourceLinks: 1,
      historicalWorkflowEvidenceRecords: 0,
      contextDecisionEvidence: 0,
      contextDecisionCoverageTraces: 0,
      contextCompileEvals: 0,
      knowledgeUsageEvents: 0,
      contextDecisionHumanFeedback: 0,
      contextDecisionFeedback: 0,
    },
    redaction: {
      enabled: true,
      secretPlaceholder: PORTABLE_EXPORT_SECRET_PLACEHOLDER,
      localPathPolicy: "preserve",
    },
  };

  const evidenceIndex: PortableEvidenceIndex = {
    format: "context-still-portable-evidence-index",
    schemaVersion: 1,
    knowledge: {
      "11111111-1111-4111-8111-111111111111": {
        sourceRefs: [
          {
            knowledgeSourceLinkId: "44444444-4444-4444-8444-444444444444",
            sourceId: "22222222-2222-4222-8222-222222222222",
            sourceFragmentId: "33333333-3333-4333-8333-333333333333",
            sourceUri: "/tmp/context-still-roundtrip.md",
            locator: "L1",
            linkType: "derived_from",
            confidence: 0.9,
          },
        ],
        originRefs: [
          {
            originLinkId: "55555555-5555-4555-8555-555555555555",
            originKind: "vibe_memory",
            originUri: "vibe-memory://roundtrip",
            originKey: "roundtrip",
            confidence: 1,
          },
        ],
      },
    },
    skippedEvidence: [],
  };

  const sqlContent = writePostgresDataSql({
    createdAt,
    redactionEnabled: true,
    tables: [
      {
        table: {
          name: "sources",
          columns: [
            { name: "id", kind: "text" },
            { name: "source_kind", kind: "text" },
            { name: "classification_status", kind: "text" },
            { name: "scope", kind: "text" },
            { name: "project_ref", kind: "text" },
            { name: "repo_key", kind: "text" },
            { name: "repo_path", kind: "text" },
            { name: "uri", kind: "text" },
            { name: "title", kind: "text" },
            { name: "body", kind: "text" },
            { name: "metadata", kind: "jsonb" },
            { name: "created_at", kind: "timestamp" },
            { name: "updated_at", kind: "timestamp" },
            { name: "last_indexed_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            source_kind: "wiki",
            classification_status: "classified",
            scope: "global",
            project_ref: null,
            repo_key: null,
            repo_path: null,
            uri: "/tmp/context-still-roundtrip.md",
            title: "Roundtrip source",
            body: "Roundtrip source body",
            metadata: {},
            created_at: createdAt,
            updated_at: createdAt,
            last_indexed_at: createdAt,
          },
        ],
      },
      {
        table: {
          name: "source_fragments",
          columns: [
            { name: "id", kind: "text" },
            { name: "source_id", kind: "text" },
            { name: "locator", kind: "text" },
            { name: "heading", kind: "text" },
            { name: "content", kind: "text" },
            { name: "metadata", kind: "jsonb" },
            { name: "created_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "33333333-3333-4333-8333-333333333333",
            source_id: "22222222-2222-4222-8222-222222222222",
            locator: "L1",
            heading: "Roundtrip",
            content: "Roundtrip source fragment",
            metadata: {},
            created_at: createdAt,
          },
        ],
      },
      {
        table: {
          name: "knowledge_tag_definitions",
          columns: [
            { name: "id", kind: "text" },
            { name: "kind", kind: "text" },
            { name: "slug", kind: "text" },
            { name: "label", kind: "text" },
            { name: "description", kind: "text" },
            { name: "aliases", kind: "jsonb" },
            { name: "status", kind: "text" },
            { name: "sort_order", kind: "number" },
            { name: "created_at", kind: "timestamp" },
            { name: "updated_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            kind: "domain",
            slug: "roundtrip",
            label: "Roundtrip",
            description: "Roundtrip test tag",
            aliases: [],
            status: "active",
            sort_order: 100,
            created_at: createdAt,
            updated_at: createdAt,
          },
        ],
      },
      {
        table: {
          name: "knowledge_items",
          columns: [
            { name: "id", kind: "text" },
            { name: "type", kind: "text" },
            { name: "status", kind: "text" },
            { name: "classification_status", kind: "text" },
            { name: "scope", kind: "text" },
            { name: "project_ref", kind: "text" },
            { name: "repo_key", kind: "text" },
            { name: "repo_path", kind: "text" },
            { name: "polarity", kind: "text" },
            { name: "intent_tags", kind: "jsonb" },
            { name: "title", kind: "text" },
            { name: "body", kind: "text" },
            { name: "applies_to", kind: "jsonb" },
            { name: "confidence", kind: "number" },
            { name: "importance", kind: "number" },
            { name: "compile_select_count", kind: "number" },
            { name: "last_compiled_at", kind: "timestamp" },
            { name: "agentic_accept_count", kind: "number" },
            { name: "explicit_upvote_count", kind: "number" },
            { name: "explicit_downvote_count", kind: "number" },
            { name: "dynamic_score", kind: "number" },
            { name: "metadata", kind: "jsonb" },
            { name: "created_at", kind: "timestamp" },
            { name: "updated_at", kind: "timestamp" },
            { name: "last_verified_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            type: "rule",
            status: "active",
            classification_status: "classified",
            scope: "global",
            project_ref: null,
            repo_key: null,
            repo_path: null,
            polarity: "positive",
            intent_tags: ["roundtrip"],
            title: "Roundtrip knowledge",
            body: "Roundtrip body",
            applies_to: {},
            confidence: 80,
            importance: 70,
            compile_select_count: 0,
            last_compiled_at: null,
            agentic_accept_count: 0,
            explicit_upvote_count: 0,
            explicit_downvote_count: 0,
            dynamic_score: 0,
            metadata: {},
            created_at: createdAt,
            updated_at: createdAt,
            last_verified_at: null,
          },
        ],
      },
      {
        table: {
          name: "knowledge_source_links",
          columns: [
            { name: "id", kind: "text" },
            { name: "knowledge_id", kind: "text" },
            { name: "source_fragment_id", kind: "text" },
            { name: "link_type", kind: "text" },
            { name: "confidence", kind: "number" },
            { name: "metadata", kind: "jsonb" },
            { name: "created_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "44444444-4444-4444-8444-444444444444",
            knowledge_id: "11111111-1111-4111-8111-111111111111",
            source_fragment_id: "33333333-3333-4333-8333-333333333333",
            link_type: "derived_from",
            confidence: 0.9,
            metadata: {},
            created_at: createdAt,
          },
        ],
      },
      {
        table: {
          name: "knowledge_origin_links",
          columns: [
            { name: "id", kind: "text" },
            { name: "knowledge_id", kind: "text" },
            { name: "origin_kind", kind: "text" },
            { name: "origin_uri", kind: "text" },
            { name: "origin_key", kind: "text" },
            { name: "confidence", kind: "number" },
            { name: "metadata", kind: "jsonb" },
            { name: "created_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "55555555-5555-4555-8555-555555555555",
            knowledge_id: "11111111-1111-4111-8111-111111111111",
            origin_kind: "vibe_memory",
            origin_uri: "vibe-memory://roundtrip",
            origin_key: "roundtrip",
            confidence: 1,
            metadata: {},
            created_at: createdAt,
          },
        ],
      },
      {
        table: {
          name: "knowledge_quality_adjustments",
          columns: [
            { name: "id", kind: "text" },
            { name: "knowledge_id", kind: "text" },
            { name: "adjustment_kind", kind: "text" },
            { name: "window_start_at", kind: "timestamp" },
            { name: "window_end_at", kind: "timestamp" },
            { name: "negative_run_count", kind: "number" },
            { name: "off_topic_rate", kind: "number" },
            { name: "importance_delta", kind: "number" },
            { name: "confidence_delta", kind: "number" },
            { name: "created_at", kind: "timestamp" },
          ],
        },
        rows: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            knowledge_id: "11111111-1111-4111-8111-111111111111",
            adjustment_kind: "off_topic_quality_decrement",
            window_start_at: createdAt,
            window_end_at: createdAt,
            negative_run_count: 0,
            off_topic_rate: 0,
            importance_delta: 0,
            confidence_delta: 0,
            created_at: createdAt,
          },
        ],
      },
    ],
  });

  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
  const evidenceIndexContent = `${JSON.stringify(evidenceIndex, null, 2)}\n`;
  const checksumsContent = [
    `${checksum(manifestContent)}  manifest.json`,
    `${checksum(evidenceIndexContent)}  evidence-index.json`,
    `${checksum(sqlContent)}  sql/postgres.sql`,
    "",
  ].join("\n");

  await writeFile(path.join(root, "manifest.json"), manifestContent, "utf8");
  await writeFile(path.join(root, "evidence-index.json"), evidenceIndexContent, "utf8");
  await writeFile(path.join(root, "checksums.sha256"), checksumsContent, "utf8");
  await writeFile(path.join(root, "sql", "postgres.sql"), sqlContent, "utf8");

  return root;
}

async function portableCounts(): Promise<Record<string, number>> {
  const db = getDb();
  const result = await db.execute(sql`
    select 'knowledge_items' as table_name, count(*)::int as count from knowledge_items
    union all select 'sources', count(*)::int from sources
    union all select 'source_fragments', count(*)::int from source_fragments
    union all select 'knowledge_source_links', count(*)::int from knowledge_source_links
    union all select 'knowledge_origin_links', count(*)::int from knowledge_origin_links
    union all select 'knowledge_quality_adjustments', count(*)::int from knowledge_quality_adjustments
    union all select 'knowledge_tag_definitions', count(*)::int from knowledge_tag_definitions
  `);
  return Object.fromEntries(
    (result.rows as Array<{ table_name: string; count: number }>).map((row) => [
      row.table_name,
      row.count,
    ]),
  );
}

describeDb("knowledge portability roundtrip integration", () => {
  beforeEach(async () => {
    await ensureDbIntegrationReady();
    await truncateIntegrationTables();
    await getDb().execute(sql`
      delete from knowledge_tag_definitions
      where id = '66666666-6666-4666-8666-666666666666'
    `);
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("insert-only import is transactional and duplicate retry leaves counts unchanged", async () => {
    const archive = await createRoundtripArchive();
    try {
      const summary = await importKnowledgeArchive({ fromDir: archive, mode: "insert-only" });
      expect(summary.ok).toBe(true);
      expect(summary.applied).toBe(true);

      const importedCounts = await portableCounts();
      expect(importedCounts).toMatchObject({
        knowledge_items: 1,
        sources: 1,
        source_fragments: 1,
        knowledge_source_links: 1,
        knowledge_origin_links: 1,
        knowledge_quality_adjustments: 1,
        knowledge_tag_definitions: 1,
      });

      await expect(
        importKnowledgeArchive({ fromDir: archive, mode: "insert-only" }),
      ).rejects.toThrow(/Failed query|duplicate key|violates unique constraint/);

      await expect(portableCounts()).resolves.toEqual(importedCounts);
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });
});
