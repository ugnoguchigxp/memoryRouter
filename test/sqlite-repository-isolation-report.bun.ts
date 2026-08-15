import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type SqliteCoreDatabase, openSqliteCoreDatabase } from "../src/db/sqlite/client.js";
import type { RepositoryIsolationProducerManifest } from "../src/modules/context-compiler/repository-isolation-producer-manifest.js";
import { collectRepositoryIsolationReportFromSqlite } from "../src/modules/context-compiler/repository-isolation-report.repository.js";

type FixtureCandidate = {
  id: string;
  entityKind: "knowledge" | "source" | "episode";
  status: string;
  classificationStatus: string;
  scope: string;
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
  general: boolean;
  producer?: string;
  facets: Record<string, unknown>;
};

type Fixture = {
  aliases: Array<{
    projectRef: string;
    aliasKind: "repo_key" | "repo_path";
    normalizedValue: string;
  }>;
  candidates: FixtureCandidate[];
};

const fixturePath = fileURLToPath(
  new URL("./fixtures/context-compile-repository-isolation-v1.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
const tempDirs: string[] = [];
const databases: SqliteCoreDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.db.close();
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixtureDatabase(): Promise<SqliteCoreDatabase> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-repo-inventory-"));
  tempDirs.push(tempDir);
  const database = await openSqliteCoreDatabase({
    path: path.join(tempDir, "inventory.sqlite"),
    vectorDimension: 3,
    loadVectorExtension: false,
  });
  databases.push(database);
  for (const [index, alias] of fixture.aliases.entries()) {
    database.db
      .query(
        `insert into project_identity_aliases
           (id, project_ref, alias_kind, normalized_value, status, source)
         values (?, ?, ?, ?, 'active', 'fixture')`,
      )
      .run(`alias-${index}`, alias.projectRef, alias.aliasKind, alias.normalizedValue);
  }
  for (const item of fixture.candidates) {
    const identity = [
      item.projectRef ?? null,
      item.repoKey ?? null,
      item.repoPath ?? null,
    ] as const;
    if (item.entityKind === "knowledge") {
      database.db
        .query(
          `insert into knowledge_items
             (id, type, status, scope, classification_status, project_ref, repo_key, repo_path,
              title, body, applies_to, metadata)
           values (?, 'rule', ?, ?, ?, ?, ?, ?, 'fixture title', 'fixture body', ?, ?)`,
        )
        .run(
          item.id,
          item.status,
          item.scope,
          item.classificationStatus,
          ...identity,
          JSON.stringify({ ...item.facets, general: item.general }),
          JSON.stringify({ producer: item.producer ?? "fixture" }),
        );
    } else if (item.entityKind === "source") {
      database.db
        .query(
          `insert into sources
             (id, source_kind, classification_status, scope, project_ref, repo_key, repo_path,
              uri, body, metadata)
           values (?, ?, ?, ?, ?, ?, ?, ?, 'fixture body', ?)`,
        )
        .run(
          item.id,
          item.producer ?? "wiki",
          item.classificationStatus,
          item.scope,
          ...identity,
          `fixture://${item.id}`,
          JSON.stringify({ ...item.facets, general: item.general }),
        );
    } else {
      database.db
        .query(
          `insert into episode_cards
             (id, title, situation, applicability, domains, technologies, change_types,
              classification_status, scope, project_ref, repo_key, repo_path, source_kind,
              source_key, status, metadata)
           values (?, 'fixture title', 'fixture situation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
        )
        .run(
          item.id,
          JSON.stringify({ general: item.general }),
          JSON.stringify(item.facets.domains ?? []),
          JSON.stringify(item.facets.technologies ?? []),
          JSON.stringify(item.facets.changeTypes ?? []),
          item.classificationStatus,
          item.scope,
          ...identity,
          item.producer ?? "compile_run",
          item.id,
          item.status,
        );
    }
  }
  database.db
    .query(
      `insert into context_compile_runs
         (id, goal, intent, project_ref, match_basis, identity_contract_version, scope_mode,
          retrieval_mode, status, degraded_reasons, duration_ms, pack_snapshot, created_at)
       values (?, 'fixture', 'fixture', 'project-A', 'project_ref', 1, 'project',
               'sqlite_text', 'ok', '[]', 40, ?, ?)`,
    )
    .run(
      "run-project-a",
      JSON.stringify({ outputMarkdown: "fixture narrative" }),
      "2026-08-14T00:00:00.000Z",
    );
  database.db
    .query(
      `insert into context_compile_runs
         (id, goal, intent, match_basis, identity_contract_version, scope_mode,
          retrieval_mode, status, degraded_reasons, duration_ms, pack_snapshot, created_at)
       values (?, 'fixture global', 'fixture', 'none', 1, 'global_only',
               'sqlite_text', 'ok', '[]', 20, ?, ?)`,
    )
    .run(
      "run-global",
      JSON.stringify({ outputMarkdown: "No Content" }),
      "2026-08-14T01:00:00.000Z",
    );
  for (const [index, itemId] of ["knowledge-repo-b-general", "knowledge-unresolved"].entries()) {
    database.db
      .query(
        `insert into context_pack_items
           (run_id, item_kind, item_id, section, ranking_reason)
         values ('run-project-a', 'rule', ?, 'rules', 'legacy_fixture')`,
      )
      .run(itemId);
    expect(index).toBeLessThan(2);
  }
  database.db
    .query(
      `insert into context_pack_items
         (run_id, item_kind, item_id, section, ranking_reason)
       values ('run-global', 'rule', 'knowledge-global-general', 'rules', 'legacy_fixture')`,
    )
    .run();
  return database;
}

describe("SQLite repository isolation read-only report", () => {
  test("uses the shared fixture without exposing content or absolute paths", async () => {
    const database = await fixtureDatabase();
    const report = collectRepositoryIsolationReportFromSqlite({
      db: database.db,
      identityInput: { projectRef: "project-A" },
      requestFacets: {},
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    expect(report.inventory.knowledge).toMatchObject({
      total: 12,
      classifications: { global: 2, repo: 7, unresolved: 1, malformed: 1, conflict: 1 },
    });
    expect(report.inventory.source).toMatchObject({
      total: 5,
      classifications: { global: 1, repo: 2, unresolved: 1, malformed: 1, conflict: 0 },
    });
    expect(report.inventory.episode).toMatchObject({
      total: 5,
      classifications: { global: 1, repo: 2, unresolved: 1, malformed: 0, conflict: 1 },
    });
    expect(report.requestComparison).toMatchObject({
      matchBasis: "project_ref",
      wouldSelectCount: 8,
    });
    expect(report.recentRunReevaluation[0]).toMatchObject({
      runId: "run-global",
      identityKnown: false,
      mismatchCount: 0,
    });
    expect(report.recentRunReevaluation[1]).toMatchObject({
      runId: "run-project-a",
      identityKnown: true,
      selectedCount: 2,
      mismatchCount: 2,
    });
    expect(report.baseline).toMatchObject({
      actualWindowDays: 30,
      totalCompileRuns: 2,
      identityPresentRuns: 1,
      insufficientIdentityPresentSamples: true,
      noContentRate: 0,
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("fixture title");
    expect(serialized).not.toContain("fixture body");
    expect(serialized).not.toContain("/work/");
    expect(report.privacy).toEqual({
      contentFieldsIncluded: false,
      absolutePathsIncluded: false,
      previewLimit: 20,
    });
  });

  test("normalizes mixed SQLite timestamp formats at the 7-day boundary", async () => {
    const database = await fixtureDatabase();
    const now = new Date("2026-08-15T12:00:00.000Z");
    const observationStartedAt = new Date("2026-08-08T12:00:00.000Z");
    const before = collectRepositoryIsolationReportFromSqlite({ db: database.db, now });
    const persistedPayload = JSON.stringify({
      producer: "source.boundary-fixture",
      entityKind: "source",
      scope: "repo",
      matchBasis: "repo_path",
      identityFingerprint: "a".repeat(64),
      bindingStatus: "unverified",
    });
    const insertAudit = database.db.query(
      `insert into audit_logs (id, event_type, actor, payload, created_at)
       values (?, 'PROJECT_IDENTITY_PRODUCER_PERSISTED', 'system', ?, ?)`,
    );
    insertAudit.run("audit-space", persistedPayload, "2026-08-08 13:00:00");
    insertAudit.run(
      "audit-unix",
      persistedPayload,
      `unix-ms:${new Date("2026-08-14T00:00:00.000Z").getTime()}`,
    );
    insertAudit.run("audit-old", persistedPayload, "2026-08-08T11:59:59.000Z");

    const insertSource = database.db.query(
      `insert into sources
         (id, source_kind, classification_status, scope, uri, body, metadata, created_at)
       values (?, 'wiki', 'unresolved', 'repo', ?, 'body', '{}', ?)`,
    );
    insertSource.run("source-boundary-recent", "fixture://boundary-recent", "2026-08-08 13:00:00");
    insertSource.run("source-boundary-old", "fixture://boundary-old", "2026-08-08T11:59:59.000Z");

    const report = collectRepositoryIsolationReportFromSqlite({
      db: database.db,
      producerManifest: {
        contractVersion: 1,
        profile: "resident-local",
        status: "finalized",
        finalizedAt: new Date("2026-08-08T11:00:00.000Z"),
        observationStartedAt,
        fingerprint: "f".repeat(64),
        producers: [
          {
            name: "source.boundary-fixture",
            disposition: "enabled",
            runtime: "resident",
            entityKinds: ["source"],
          },
        ],
        enabledProducers: ["source.boundary-fixture"],
      } satisfies RepositoryIsolationProducerManifest,
      now,
    });

    expect(report.producerObservation).toMatchObject({
      persistedCount: 2,
      identityBearingPersistedCount: 2,
      malformedPersistedCount: 0,
      observedEnabledProducers: ["source.boundary-fixture"],
    });
    expect(report.producerObservation.newUnresolvedByEntity.source).toBe(
      before.producerObservation.newUnresolvedByEntity.source + 1,
    );
  });
});
