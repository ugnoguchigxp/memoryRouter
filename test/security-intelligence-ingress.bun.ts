import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getRuntimeSqliteCoreDatabase,
  resetRuntimeSqliteCoreDatabaseForTests,
} from "../src/db/sqlite/runtime.js";
import { receiveSecurityKnowledgeCandidateBatch } from "../src/modules/security-intelligence/candidate-batch-ingress.service.js";
import { auditDirectActiveKnowledge } from "../src/modules/security-intelligence/direct-active-audit.service.js";
import { receiveSecurityKnowledgeFeedbackBatch } from "../src/modules/security-intelligence/feedback-batch-ingress.service.js";
import { securityIntelligenceSha256 } from "../src/shared/schemas/security-knowledge-candidate-batch.schema.js";
import {
  deriveSecurityKnowledgeFeedbackBatch,
  deriveSecurityKnowledgeFeedbackEvent,
} from "../src/shared/schemas/security-knowledge-feedback-batch.schema.js";

let tempDir = "";
const oldBackend = process.env.CONTEXT_STILL_DB_BACKEND;
const oldPath = process.env.CONTEXT_STILL_SQLITE_CORE_PATH;

function restore(key: string, value: string | undefined) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function fixtureBatch() {
  const fixture = JSON.parse(
    await readFile(
      new URL("../shared/fixtures/security-knowledge-candidate-batch-v1.json", import.meta.url),
      "utf8",
    ),
  );
  return structuredClone(fixture.valid.batch) as Record<string, any>;
}

function refreshBatchDigest(batch: Record<string, any>) {
  const { idempotencyKey: _key, batchRef: _ref, batchPayloadDigest: _digest, ...semantic } = batch;
  const digest = securityIntelligenceSha256(semantic);
  batch.batchPayloadDigest = digest;
  batch.batchRef = `skcb:v1:${digest.slice(7)}`;
}

describe("Security Intelligence candidate ingress on SQLite", () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "context-still-si-ingress-"));
    process.env.CONTEXT_STILL_DB_BACKEND = "sqlite";
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH = path.join(tempDir, "core.sqlite");
    resetRuntimeSqliteCoreDatabaseForTests();
  });

  afterEach(async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    sqlite.db.close();
    resetRuntimeSqliteCoreDatabaseForTests();
    restore("CONTEXT_STILL_DB_BACKEND", oldBackend);
    restore("CONTEXT_STILL_SQLITE_CORE_PATH", oldPath);
    await rm(tempDir, { recursive: true, force: true });
  });

  test("persists accepted candidates to the pipeline without active Knowledge and replays receipt", async () => {
    const batch = await fixtureBatch();
    const first = await receiveSecurityKnowledgeCandidateBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    expect(first.replayed).toBe(false);
    expect(first.receipt.items[0]?.status).toBe("accepted");

    const sqlite = await getRuntimeSqliteCoreDatabase();
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from knowledge_items where status = 'active'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from distillation_target_states where status = 'pending'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from covering_evidence_queue where status = 'pending'",
        )
        .get()?.count,
    ).toBe(1);

    const replay = await receiveSecurityKnowledgeCandidateBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    expect(replay).toEqual({ ...first, replayed: true });
  });

  test("commits valid and rejected item receipts together", async () => {
    const batch = await fixtureBatch();
    const invalid = structuredClone(batch.items[0]);
    invalid.candidateRef = `skc:v1:${"f".repeat(64)}`;
    invalid.body = "api_key=not-a-real-secret";
    batch.items.push(invalid);
    refreshBatchDigest(batch);

    const response = await receiveSecurityKnowledgeCandidateBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    expect(response.receipt.items.map((item) => item.status)).toEqual(["accepted", "rejected"]);
    const sqlite = await getRuntimeSqliteCoreDatabase();
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from security_candidate_batch_items",
        )
        .get()?.count,
    ).toBe(2);
    expect(
      sqlite.db
        .query<{ count: number }, []>("select count(*) as count from distillation_target_states")
        .get()?.count,
    ).toBe(1);
  });

  test("rejects same idempotency key with a different valid batch digest without mutation", async () => {
    const batch = await fixtureBatch();
    await receiveSecurityKnowledgeCandidateBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    const conflict = structuredClone(batch);
    conflict.correlation.runRef = "run:another";
    refreshBatchDigest(conflict);
    await expect(
      receiveSecurityKnowledgeCandidateBatch({
        producerPrincipal: "nightworkers:test",
        rawBatch: conflict,
      }),
    ).rejects.toMatchObject({
      status: 409,
      reasonCode: "idempotency_conflict",
    });
    const sqlite = await getRuntimeSqliteCoreDatabase();
    expect(
      sqlite.db
        .query<{ count: number }, []>(
          "select count(*) as count from security_candidate_batch_receipts",
        )
        .get()?.count,
    ).toBe(1);
  });

  test("stores feedback as append-only observations without mutating Knowledge", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    sqlite.db
      .query(
        `insert into knowledge_items (
           id, type, status, scope, polarity, intent_tags, title, body, applies_to,
           confidence, importance, metadata, created_at, updated_at
         ) values ('knowledge:test', 'rule', 'draft', 'repo', 'positive', '[]',
           'Original title', 'Original body', '{}', 70, 70, '{}', ?, ?)`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
    const event = deriveSecurityKnowledgeFeedbackEvent({
      eventType: "retrieved",
      occurredAt: "2026-08-15T00:00:00.000Z",
      correlation: { taskRef: "task:test", runRef: "run:test", compileRunRef: "compile:test" },
      knowledgeRef: "knowledge:test",
      knowledgeRevision: 1,
      evidenceRefs: [],
    });
    const batch = deriveSecurityKnowledgeFeedbackBatch({
      idempotencyKey: "feedback:test:1",
      producer: { system: "nightworkers", version: "1.0.0" },
      events: [event],
    });
    const first = await receiveSecurityKnowledgeFeedbackBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    expect(first.receipt.acceptedEventRefs).toEqual([event.eventRef]);
    const knowledge = sqlite.db
      .query<{ status: string; body: string }, []>(
        "select status, body from knowledge_items where id = 'knowledge:test'",
      )
      .get();
    expect(knowledge).toEqual({ status: "draft", body: "Original body" });

    const replay = await receiveSecurityKnowledgeFeedbackBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    expect(replay).toEqual({ ...first, replayed: true });

    const duplicateBatch = deriveSecurityKnowledgeFeedbackBatch({
      idempotencyKey: "feedback:test:2",
      producer: { system: "nightworkers", version: "1.0.0" },
      events: [event],
    });
    const duplicate = await receiveSecurityKnowledgeFeedbackBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: duplicateBatch,
    });
    expect(duplicate.receipt.duplicateEventRefs).toEqual([event.eventRef]);
    expect(
      sqlite.db
        .query<{ count: number }, []>("select count(*) as count from security_feedback_events")
        .get()?.count,
    ).toBe(1);
  });

  test("rejects evidence-free verification feedback as an item result", async () => {
    const valid = deriveSecurityKnowledgeFeedbackEvent({
      eventType: "verification_outcome",
      occurredAt: "2026-08-15T00:00:00.000Z",
      correlation: { taskRef: "task:test", runRef: "run:test" },
      knowledgeRef: "knowledge:test",
      knowledgeRevision: 1,
      outcome: "supported",
      evidenceRefs: ["verification:test"],
    });
    const invalid = { ...valid, evidenceRefs: [] };
    const semantic = {
      contractVersion: 1 as const,
      producer: { system: "nightworkers" as const, version: "1.0.0" },
      events: [invalid],
    };
    const digest = securityIntelligenceSha256(semantic);
    const batch = {
      ...semantic,
      idempotencyKey: "feedback:test:invalid",
      batchRef: `skfb:v1:${digest.slice(7)}`,
      batchPayloadDigest: digest,
    };
    const response = await receiveSecurityKnowledgeFeedbackBatch({
      producerPrincipal: "nightworkers:test",
      rawBatch: batch,
    });
    expect(response.receipt.acceptedEventRefs).toEqual([]);
    expect(response.receipt.rejectedEvents).toEqual([
      { eventRef: valid.eventRef, reasonCode: "independent_evidence_required" },
    ]);
  });

  test("audits only active direct registrations and tolerates malformed metadata", async () => {
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const insert = sqlite.db.query(
      "insert into knowledge_items (id, type, status, title, body, metadata) values (?, 'rule', ?, ?, 'body', ?)",
    );
    insert.run(
      "direct-active",
      "active",
      "Direct active",
      JSON.stringify({ sqliteDirectRegistration: true }),
    );
    insert.run(
      "direct-draft",
      "draft",
      "Direct draft",
      JSON.stringify({ rustDirectRegistration: true }),
    );
    insert.run("malformed-metadata", "active", "Malformed metadata", "{");

    const report = await auditDirectActiveKnowledge();

    expect(report.total).toBe(1);
    expect(report.groups).toEqual([
      {
        runtime: "typescript_sqlite",
        source: "unknown",
        status: "active",
        count: 1,
      },
    ]);
  });
});
