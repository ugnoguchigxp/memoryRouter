import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { db } from "../src/db/index.js";
import { runRepositoryIdentityBackfill } from "../src/modules/context-compiler/repository-identity-backfill.service.js";
import {
  closeIntegrationDb,
  ensureDbIntegrationReady,
  isDbIntegrationEnabled,
  truncateIntegrationTables,
} from "./helpers/integration.js";

const describeDb = isDbIntegrationEnabled() ? describe : describe.skip;

describeDb("PostgreSQL repository identity backfill", () => {
  beforeAll(async () => {
    await ensureDbIntegrationReady();
  });

  beforeEach(async () => {
    await truncateIntegrationTables();
  });

  afterAll(async () => {
    await closeIntegrationDb();
  });

  test("shares a reviewed checksum between dry-run and idempotent write", async () => {
    await db.execute(sql`
      insert into knowledge_items
        (id, type, status, scope, classification_status, title, body, applies_to, metadata)
      values
        ('10000000-0000-4000-8000-000000000001', 'rule', 'active', 'repo', 'unresolved',
         'title', 'body', '{}'::jsonb,
         '{"projectIdentity":{"classificationStatus":"classified","scope":"repo","repoPath":"/work/repo-a/./"}}'::jsonb),
        ('10000000-0000-4000-8000-000000000002', 'rule', 'active', 'repo', 'unresolved',
         'title', 'body', '{}'::jsonb, '{}'::jsonb)
    `);
    await db.execute(sql`
      insert into sources
        (id, source_kind, classification_status, scope, uri, body, metadata)
      values
        ('20000000-0000-4000-8000-000000000001', 'wiki', 'unresolved', 'repo',
         'fixture://source', 'body', '{"sourceCaptureIdentity":{"repoPath":"/work/repo-a"}}'::jsonb)
    `);
    await db.execute(sql`
      insert into context_compile_runs
        (id, goal, intent, project_ref, repo_path, match_basis, identity_contract_version,
         scope_mode, input, retrieval_mode, status, degraded_reasons, token_budget, duration_ms, source)
      values
        ('30000000-0000-4000-8000-000000000001', 'goal', 'edit', 'project-A', '/work/repo-a',
         'project_ref', 1, 'project', '{}'::jsonb, 'review_context', 'ok', '[]'::jsonb, 1000, 1, 'mcp')
    `);
    await db.execute(sql`
      insert into episode_cards
        (id, title, situation, classification_status, scope, source_kind, source_key, metadata)
      values
        ('40000000-0000-4000-8000-000000000001', 'title', 'situation', 'unresolved', 'repo',
         'compile_run', '30000000-0000-4000-8000-000000000001', '{}'::jsonb)
    `);

    const first = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    const second = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    expect(second.checksum).toBe(first.checksum);
    expect(first.counts).toMatchObject({ backfilled: 3, unchanged: 1 });
    await expect(runRepositoryIdentityBackfill({ mode: "write" })).rejects.toThrow(
      "backup-reference",
    );

    const written = await runRepositoryIdentityBackfill({
      mode: "write",
      expectedChecksum: first.checksum,
      backupReference: "pg_dump:context_still_test-before-repository-identity-v1",
      batchSize: 2,
    });
    expect(written.updatedCount).toBe(3);
    expect(written.auditInsertedCount).toBe(4);

    const rerun = await runRepositoryIdentityBackfill({ mode: "dry-run" });
    expect(rerun.decisions.every((item) => !item.changed)).toBe(true);
    const result = await db.execute(sql`
      select classification_status, repo_path, applies_to
      from knowledge_items
      where id = '10000000-0000-4000-8000-000000000001'
    `);
    expect(result.rows[0]).toMatchObject({
      classification_status: "classified",
      repo_path: "/work/repo-a",
      applies_to: { repoPath: "/work/repo-a" },
    });
    const audit = await db.execute(sql`
      select count(*)::int as count from repository_identity_migration_audits
    `);
    expect(audit.rows[0]).toMatchObject({ count: 4 });
  });
});
