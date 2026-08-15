import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openSqliteCoreDatabase } from "../src/db/sqlite/index.js";
import { runRepositoryIdentityBackfill } from "../src/modules/context-compiler/repository-identity-backfill.service.js";

const reviewMetadata = {
  reviewer: "repository-migration-reviewer",
  reason: "Reviewed against deterministic provenance",
  reviewedAt: "2026-08-15T00:00:00.000Z",
} as const;

describe("repository identity SQLite migration", () => {
  let directory = "";
  let sqlitePath = "";
  let previousBackend: string | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "context-still-identity-backfill-"));
    sqlitePath = path.join(directory, "core.sqlite");
    previousBackend = process.env.CONTEXT_STILL_DB_BACKEND;
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";

    const sqlite = await openSqliteCoreDatabase({ path: sqlitePath, loadVectorExtension: false });
    sqlite.db
      .query(
        `insert into knowledge_items
          (id, type, status, scope, classification_status, title, body, applies_to, metadata)
         values (?, 'rule', 'active', 'repo', 'unresolved', 'title', 'body', '{}', ?)`,
      )
      .run(
        "knowledge-exact",
        JSON.stringify({
          projectIdentity: {
            classificationStatus: "classified",
            scope: "repo",
            repoPath: "/work/repo-a/./",
          },
        }),
      );
    sqlite.db
      .query(
        `insert into knowledge_items
          (id, type, status, scope, classification_status, title, body, applies_to, metadata)
         values ('knowledge-unknown', 'rule', 'active', 'repo', 'unresolved', 'title', 'body', '{}', '{}')`,
      )
      .run();
    sqlite.db
      .query(
        `insert into sources
          (id, source_kind, classification_status, scope, uri, body, metadata)
         values ('source-capture', 'wiki', 'unresolved', 'repo', 'fixture://source', 'body', ?)`,
      )
      .run(JSON.stringify({ sourceCaptureIdentity: { repoPath: "/work/repo-a" } }));
    sqlite.db
      .query(
        `insert into context_compile_runs
          (id, goal, intent, project_ref, repo_key, repo_path, match_basis,
           identity_contract_version, scope_mode, input, retrieval_mode, status, degraded_reasons,
           token_budget, duration_ms, source)
         values ('run-a', 'goal', 'edit', 'project-A', null, '/work/repo-a', 'project_ref',
                 1, 'project', '{}', 'review_context', 'ok', '[]', 1000, 1, 'mcp')`,
      )
      .run();
    sqlite.db
      .query(
        `insert into episode_cards
          (id, title, situation, classification_status, scope, source_kind, source_key, metadata)
         values ('episode-run', 'title', 'situation', 'unresolved', 'repo', 'compile_run', 'run-a', '{}')`,
      )
      .run();
    sqlite.db.close();
  });

  afterEach(async () => {
    if (previousBackend === undefined) process.env.CONTEXT_STILL_DB_BACKEND = undefined;
    else process.env.CONTEXT_STILL_DB_BACKEND = previousBackend;
    await rm(directory, { recursive: true, force: true });
  });

  test("dry-run is deterministic, write is guarded and idempotent, and backup restores", async () => {
    const first = await runRepositoryIdentityBackfill({ mode: "dry-run", sqlitePath });
    const second = await runRepositoryIdentityBackfill({ mode: "dry-run", sqlitePath });
    expect(second.checksum).toBe(first.checksum);
    expect(first.counts).toMatchObject({ backfilled: 3, unresolved: 0, unchanged: 1 });
    await expect(runRepositoryIdentityBackfill({ mode: "write", sqlitePath })).rejects.toThrow(
      "backup-reference",
    );

    const backupPath = path.join(directory, "core.backup.sqlite");
    await copyFile(sqlitePath, backupPath);
    const written = await runRepositoryIdentityBackfill({
      mode: "write",
      sqlitePath,
      expectedChecksum: first.checksum,
      backupReference: backupPath,
      batchSize: 2,
    });
    expect(written.updatedCount).toBe(3);
    expect(written.auditInsertedCount).toBe(4);

    const rerun = await runRepositoryIdentityBackfill({ mode: "dry-run", sqlitePath });
    expect(rerun.decisions.every((item) => !item.changed)).toBe(true);
    const sqlite = await openSqliteCoreDatabase({ path: sqlitePath, loadVectorExtension: false });
    expect(
      sqlite.db
        .query<{ count: number }>(
          "select count(*) as count from repository_identity_migration_audits",
        )
        .get()?.count,
    ).toBe(4);
    expect(
      sqlite.db
        .query<{ classification_status: string; repo_path: string }>(
          "select classification_status, repo_path from knowledge_items where id = 'knowledge-exact'",
        )
        .get(),
    ).toEqual({ classification_status: "classified", repo_path: "/work/repo-a" });
    sqlite.db.close();

    await copyFile(backupPath, sqlitePath);
    const restored = await openSqliteCoreDatabase({ path: sqlitePath, loadVectorExtension: false });
    expect(
      restored.db
        .query<{ classification_status: string }>(
          "select classification_status from knowledge_items where id = 'knowledge-exact'",
        )
        .get()?.classification_status,
    ).toBe("unresolved");
    restored.db.close();
  });

  test("rejects review decisions that conflict with the deterministic plan", async () => {
    await expect(
      runRepositoryIdentityBackfill({
        mode: "dry-run",
        sqlitePath,
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "knowledge-exact",
            decision: "unresolved",
            ...reviewMetadata,
          },
        ],
      }),
    ).rejects.toThrow(
      "review decision conflicts with deterministic plan: knowledge:knowledge-exact",
    );
  });

  test("rejects review decisions for entities outside the migration plan", async () => {
    await expect(
      runRepositoryIdentityBackfill({
        mode: "dry-run",
        sqlitePath,
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "missing-knowledge",
            decision: "unresolved",
            ...reviewMetadata,
          },
        ],
      }),
    ).rejects.toThrow("review decision references an unknown entity: knowledge:missing-knowledge");
  });

  test("does not authorize a global promotion with an unrelated review", async () => {
    const explicitGlobalPromotions = { source: ["source-capture"] } as const;
    const dryRun = await runRepositoryIdentityBackfill({
      mode: "dry-run",
      sqlitePath,
      explicitGlobalPromotions,
    });

    await expect(
      runRepositoryIdentityBackfill({
        mode: "write",
        sqlitePath,
        explicitGlobalPromotions,
        expectedChecksum: dryRun.checksum,
        backupReference: "verified-test-backup",
        reviewDecisions: [
          {
            entityKind: "knowledge",
            entityId: "knowledge-unknown",
            decision: "unresolved",
            ...reviewMetadata,
          },
        ],
      }),
    ).rejects.toThrow(
      "write mode requires a matching global review decision for source:source-capture",
    );
  });

  test("allows a global promotion with the matching reviewed decision", async () => {
    const explicitGlobalPromotions = { source: ["source-capture"] } as const;
    const reviewDecisions = [
      {
        entityKind: "source" as const,
        entityId: "source-capture",
        decision: "global" as const,
        ...reviewMetadata,
      },
    ];
    const dryRun = await runRepositoryIdentityBackfill({
      mode: "dry-run",
      sqlitePath,
      explicitGlobalPromotions,
      reviewDecisions,
    });
    const written = await runRepositoryIdentityBackfill({
      mode: "write",
      sqlitePath,
      explicitGlobalPromotions,
      reviewDecisions,
      expectedChecksum: dryRun.checksum,
      backupReference: "verified-test-backup",
    });

    expect(written.decisions.find((item) => item.entityId === "source-capture")?.outcome).toBe(
      "global_promoted",
    );
    const sqlite = await openSqliteCoreDatabase({ path: sqlitePath, loadVectorExtension: false });
    expect(
      sqlite.db
        .query<{
          scope: string;
          project_ref: string | null;
          repo_key: string | null;
          repo_path: string | null;
        }>(
          "select scope, project_ref, repo_key, repo_path from sources where id = 'source-capture'",
        )
        .get(),
    ).toEqual({ scope: "global", project_ref: null, repo_key: null, repo_path: null });
    sqlite.db.close();
  });
});
