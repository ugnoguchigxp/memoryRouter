import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  PORTABLE_EXPORT_FORMAT,
  PORTABLE_EXPORT_SCHEMA_VERSION,
  PORTABLE_EXPORT_SECRET_PLACEHOLDER,
  PORTABLE_EXPORT_SUBSET_VERSION,
  type PortableEvidenceIndex,
  type PortableExportManifest,
} from "../src/modules/knowledge-portability/format.js";
import {
  importKnowledgeArchive,
  validateKnowledgeImportArchive,
} from "../src/modules/knowledge-portability/import.service.js";
import { writePostgresDataSql } from "../src/modules/knowledge-portability/sql-writer.js";

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function createArchive(input?: {
  evidenceIndex?: PortableEvidenceIndex;
  manifestOverride?: unknown;
  tamperManifestAfterChecksum?: boolean;
}): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-still-import-dry-run-"));
  await mkdir(path.join(root, "sql"), { recursive: true });

  const manifest: PortableExportManifest = {
    format: PORTABLE_EXPORT_FORMAT,
    schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
    createdAt: "2026-06-19T00:00:00.000Z",
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
      knowledgeTagDefinitions: 0,
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

  const evidenceIndex: PortableEvidenceIndex = input?.evidenceIndex ?? {
    format: "context-still-portable-evidence-index",
    schemaVersion: 1,
    knowledge: {
      k1: {
        sourceRefs: [
          {
            knowledgeSourceLinkId: "ksl1",
            sourceId: "s1",
            sourceFragmentId: "sf1",
            sourceUri: "file:///a.md",
            locator: "L1",
            linkType: "supports",
            confidence: 0.9,
          },
        ],
        originRefs: [
          {
            originLinkId: "ko1",
            originKind: "manual",
            originUri: "manual://one",
            originKey: "one",
            confidence: 1,
          },
        ],
      },
    },
    skippedEvidence: [],
  };

  const sql = writePostgresDataSql({
    createdAt: manifest.createdAt,
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
            id: "s1",
            source_kind: "markdown",
            classification_status: "classified",
            scope: "global",
            project_ref: null,
            repo_key: null,
            repo_path: null,
            uri: "file:///a.md",
            title: "A",
            body: "Body",
            metadata: {},
            created_at: manifest.createdAt,
            updated_at: manifest.createdAt,
            last_indexed_at: manifest.createdAt,
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
            id: "sf1",
            source_id: "s1",
            locator: "L1",
            heading: "H",
            content: "C",
            metadata: {},
            created_at: manifest.createdAt,
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
            { name: "scope", kind: "text" },
            { name: "classification_status", kind: "text" },
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
            id: "k1",
            type: "rule",
            status: "active",
            scope: "global",
            classification_status: "classified",
            project_ref: null,
            repo_key: null,
            repo_path: null,
            polarity: "positive",
            intent_tags: ["portable"],
            title: "Portable",
            body: "Keep evidence",
            applies_to: {},
            confidence: 0.8,
            importance: 0.7,
            compile_select_count: 0,
            last_compiled_at: null,
            agentic_accept_count: 0,
            explicit_upvote_count: 0,
            explicit_downvote_count: 0,
            dynamic_score: 0,
            metadata: {},
            created_at: manifest.createdAt,
            updated_at: manifest.createdAt,
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
            id: "ksl1",
            knowledge_id: "k1",
            source_fragment_id: "sf1",
            link_type: "supports",
            confidence: 0.9,
            metadata: {},
            created_at: manifest.createdAt,
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
            id: "ko1",
            knowledge_id: "k1",
            origin_kind: "manual",
            origin_uri: "manual://one",
            origin_key: "one",
            confidence: 1,
            metadata: {},
            created_at: manifest.createdAt,
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
            id: "qa1",
            knowledge_id: "k1",
            adjustment_kind: "decay",
            window_start_at: manifest.createdAt,
            window_end_at: manifest.createdAt,
            negative_run_count: 0,
            off_topic_rate: 0,
            importance_delta: 0,
            confidence_delta: 0,
            created_at: manifest.createdAt,
          },
        ],
      },
    ],
  });

  const manifestContent = `${JSON.stringify(input?.manifestOverride ?? manifest, null, 2)}\n`;
  const evidenceContent = `${JSON.stringify(evidenceIndex, null, 2)}\n`;
  const checksumsContent = [
    `${checksum(manifestContent)}  manifest.json`,
    `${checksum(evidenceContent)}  evidence-index.json`,
    `${checksum(sql)}  sql/postgres.sql`,
    "",
  ].join("\n");

  await writeFile(path.join(root, "manifest.json"), manifestContent, "utf8");
  await writeFile(path.join(root, "evidence-index.json"), evidenceContent, "utf8");
  await writeFile(path.join(root, "sql", "postgres.sql"), sql, "utf8");
  await writeFile(path.join(root, "checksums.sha256"), checksumsContent, "utf8");

  if (input?.tamperManifestAfterChecksum) {
    await writeFile(
      path.join(root, "manifest.json"),
      `${JSON.stringify({ ...manifest, schemaVersion: 999 }, null, 2)}\n`,
      "utf8",
    );
  }

  return root;
}

describe("knowledge import dry-run validation", () => {
  test("validates a portable export archive without writing", async () => {
    const archive = await createArchive();
    try {
      const summary = await validateKnowledgeImportArchive({ fromDir: archive });
      expect(summary.ok).toBe(true);
      expect(summary.counts.knowledgeItems).toBe(1);
      expect(summary.counts.knowledgeSourceLinks).toBe(1);
      expect(summary.issues).toEqual([]);
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });

  test("reports checksum mismatches", async () => {
    const archive = await createArchive({ tamperManifestAfterChecksum: true });
    try {
      const summary = await validateKnowledgeImportArchive({ fromDir: archive });
      expect(summary.ok).toBe(false);
      expect(summary.issues.map((issue) => issue.code)).toContain("checksum_mismatch");
      expect(summary.issues.map((issue) => issue.code)).toContain("unsupported_schema_version");
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });

  test("reports invalid manifest shape without cascading into SQL validation", async () => {
    const archive = await createArchive({
      manifestOverride: {
        format: PORTABLE_EXPORT_FORMAT,
        schemaVersion: PORTABLE_EXPORT_SCHEMA_VERSION,
        sql: {
          canonicalDialect: "postgres",
          availableDialects: ["postgres"],
          portableSubsetVersion: PORTABLE_EXPORT_SUBSET_VERSION,
        },
      },
    });
    try {
      const summary = await validateKnowledgeImportArchive({ fromDir: archive });
      const codes = summary.issues.map((issue) => issue.code);
      expect(summary.ok).toBe(false);
      expect(codes).toContain("missing_manifest_counts");
      expect(codes).not.toContain("invalid_sql");
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });

  test("reports invalid evidence index shape without cascading into SQL validation", async () => {
    const archive = await createArchive({
      evidenceIndex: {
        format: "context-still-portable-evidence-index",
        schemaVersion: 1,
        skippedEvidence: [],
      } as unknown as PortableEvidenceIndex,
    });
    try {
      const summary = await validateKnowledgeImportArchive({ fromDir: archive });
      const codes = summary.issues.map((issue) => issue.code);
      expect(summary.ok).toBe(false);
      expect(codes).toContain("missing_evidence_index_knowledge");
      expect(codes).not.toContain("invalid_sql");
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });

  test("reports evidence index references that are not present in SQL", async () => {
    const archive = await createArchive({
      evidenceIndex: {
        format: "context-still-portable-evidence-index",
        schemaVersion: 1,
        knowledge: {
          missing: {
            sourceRefs: [],
            originRefs: [],
          },
        },
        skippedEvidence: [],
      },
    });
    try {
      const summary = await validateKnowledgeImportArchive({ fromDir: archive });
      expect(summary.ok).toBe(false);
      expect(summary.issues.map((issue) => issue.code)).toContain(
        "evidence_index_unknown_knowledge",
      );
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });

  test("applies insert-only imports through one transaction", async () => {
    const archive = await createArchive();
    const executed: unknown[] = [];
    try {
      const summary = await importKnowledgeArchive({
        fromDir: archive,
        mode: "insert-only",
        executor: {
          async transaction(callback) {
            return callback({
              async execute(query) {
                executed.push(query);
              },
            });
          },
        },
      });

      expect(summary.ok).toBe(true);
      expect(summary.applied).toBe(true);
      expect(summary.statementsExecuted).toBe(6);
      expect(executed).toHaveLength(6);
    } finally {
      await rm(archive, { recursive: true, force: true });
    }
  });
});
