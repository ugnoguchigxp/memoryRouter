import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  auditLogs,
  coveringEvidenceQueue,
  distillationTargetStates,
  findCandidateResults,
  findingCandidateQueue,
  foundCandidates,
  securityCandidateBatchItems,
  securityCandidateBatchReceipts,
} from "../../db/schema.js";
import {
  SECURITY_KNOWLEDGE_CANDIDATE_BATCH_MAX_BYTES,
  SECURITY_KNOWLEDGE_CANDIDATE_CONTRACT_VERSION,
  type SecurityKnowledgeCandidateBatch,
  canonicalStringifySecurityIntelligenceValue,
  securityIntelligenceSafeBoundedTextSchema,
  securityIntelligenceSha256,
  securityKnowledgeCandidateBatchResponseSchema,
  securityKnowledgeCandidateItemSchema,
} from "../../shared/schemas/security-knowledge-candidate-batch.schema.js";
import { auditEventTypes } from "../audit/audit-log.service.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../distillationTarget/repository.js";

const ENDPOINT = "/api/integrations/security-intelligence/v1/candidate-batches";
const candidateRefSchema = z.string().regex(/^skc:v1:[a-f0-9]{64}$/);
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const opaqueRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const envelopeSchema = z
  .object({
    contractVersion: z.literal(SECURITY_KNOWLEDGE_CANDIDATE_CONTRACT_VERSION),
    batchRef: z.string().regex(/^skcb:v1:[a-f0-9]{64}$/),
    idempotencyKey: securityIntelligenceSafeBoundedTextSchema(256),
    batchPayloadDigest: digestSchema,
    producer: z
      .object({
        system: z.literal("nightworkers"),
        version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
      })
      .strict(),
    correlation: z.object({ taskRef: opaqueRefSchema, runRef: opaqueRefSchema }).strict(),
    items: z
      .array(z.object({ candidateRef: candidateRefSchema }).passthrough())
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.items.map((item) => item.candidateRef)).size !== value.items.length) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "security_intelligence:duplicate_candidate_ref",
      });
    }
  });

export class SecurityIntelligenceIngressError extends Error {
  constructor(
    public readonly status: number,
    public readonly reasonCode: string,
    message: string,
  ) {
    super(message);
  }
}

function validateEnvelope(rawInput: unknown): SecurityKnowledgeCandidateBatch {
  const encoded = JSON.stringify(rawInput);
  if (new TextEncoder().encode(encoded).byteLength > SECURITY_KNOWLEDGE_CANDIDATE_BATCH_MAX_BYTES) {
    throw new SecurityIntelligenceIngressError(
      413,
      "batch_too_large",
      "candidate batch exceeds 256 KiB",
    );
  }
  const parsed = envelopeSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new SecurityIntelligenceIngressError(400, "batch_schema_invalid", parsed.error.message);
  }
  const batch = parsed.data as unknown as SecurityKnowledgeCandidateBatch;
  const {
    idempotencyKey: _idempotencyKey,
    batchRef: _batchRef,
    batchPayloadDigest: _batchPayloadDigest,
    ...semantic
  } = batch;
  const digest = securityIntelligenceSha256(semantic);
  if (digest !== batch.batchPayloadDigest || batch.batchRef !== `skcb:v1:${digest.slice(7)}`) {
    throw new SecurityIntelligenceIngressError(
      400,
      "batch_digest_mismatch",
      "candidate batch digest mismatch",
    );
  }
  return batch;
}

function itemReason(error: z.ZodError) {
  const custom = error.issues.find((issue) => issue.code === "custom")?.message;
  return (custom?.replace(/^security_intelligence:/, "") ?? "item_schema_invalid").slice(0, 128);
}

function receiptRef(input: {
  producerPrincipal: string;
  batch: SecurityKnowledgeCandidateBatch;
}) {
  const digest = securityIntelligenceSha256({
    producerPrincipal: input.producerPrincipal,
    endpoint: ENDPOINT,
    contractVersion: input.batch.contractVersion,
    idempotencyKey: input.batch.idempotencyKey,
    batchRef: input.batch.batchRef,
    batchPayloadDigest: input.batch.batchPayloadDigest,
  });
  return `skcr:v1:${digest.slice(7)}`;
}

function candidatePipelineValues(item: z.infer<typeof securityKnowledgeCandidateItemSchema>) {
  const candidateId = item.candidateRef.slice("skc:v1:".length);
  const now = new Date();
  const targetStateId = randomUUID();
  const findCandidateResultId = randomUUID();
  const findingJobId = randomUUID();
  const foundCandidateId = randomUUID();
  const coveringJobId = randomUUID();
  const sourceUri = `security-intelligence://candidate/${candidateId}`;
  const origin = {
    source: "security_intelligence_candidate_ingress",
    candidateRef: item.candidateRef,
    fingerprint: item.fingerprint,
    payloadDigest: item.payloadDigest,
    evidenceRefs: item.evidenceRefs,
    limitations: item.limitations,
    confidence: item.confidence,
    polarity: item.polarity,
    appliesTo: item.applicability,
  };
  const payload = {
    title: item.title,
    body: item.body,
    type: item.type,
    polarity: item.polarity,
    appliesTo: item.applicability,
    origin,
    legacyTargetStateId: targetStateId,
    legacyFindCandidateResultId: findCandidateResultId,
  };
  const metadata = {
    source: "security_intelligence_candidate_ingress",
    candidateRef: item.candidateRef,
    fingerprint: item.fingerprint,
    payloadDigest: item.payloadDigest,
  };
  return {
    now,
    targetStateId,
    findCandidateResultId,
    findingJobId,
    foundCandidateId,
    coveringJobId,
    sourceUri,
    origin,
    payload,
    metadata,
  };
}

function candidateProvenance(
  batch: SecurityKnowledgeCandidateBatch,
  item: z.infer<typeof securityKnowledgeCandidateItemSchema>,
) {
  return {
    contractVersion: batch.contractVersion,
    batchRef: batch.batchRef,
    producer: batch.producer,
    correlation: batch.correlation,
    candidateRef: item.candidateRef,
    fingerprint: item.fingerprint,
    payloadDigest: item.payloadDigest,
    evidenceRefs: item.evidenceRefs,
    confidence: item.confidence,
    limitations: item.limitations,
  };
}

export async function receiveSecurityKnowledgeCandidateBatch(input: {
  producerPrincipal: string;
  rawBatch: unknown;
}) {
  const batch = validateEnvelope(input.rawBatch);
  return resolveDatabaseBackendConfig().kind === "sqlite"
    ? receiveSqlite(input.producerPrincipal, batch)
    : receivePostgres(input.producerPrincipal, batch);
}

async function receivePostgres(producerPrincipal: string, batch: SecurityKnowledgeCandidateBatch) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(securityCandidateBatchReceipts)
      .where(
        and(
          eq(securityCandidateBatchReceipts.producerPrincipal, producerPrincipal),
          eq(securityCandidateBatchReceipts.endpoint, ENDPOINT),
          eq(securityCandidateBatchReceipts.contractVersion, String(batch.contractVersion)),
          eq(securityCandidateBatchReceipts.idempotencyKey, batch.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.batchPayloadDigest !== batch.batchPayloadDigest) {
        throw new SecurityIntelligenceIngressError(
          409,
          "idempotency_conflict",
          "idempotency key was reused with different payload",
        );
      }
      return securityKnowledgeCandidateBatchResponseSchema.parse({
        replayed: true,
        receipt: existing.receiptJson,
      });
    }
    const [receiptRow] = await tx
      .insert(securityCandidateBatchReceipts)
      .values({
        receiptRef: receiptRef({ producerPrincipal, batch }),
        producerPrincipal,
        endpoint: ENDPOINT,
        contractVersion: String(batch.contractVersion),
        idempotencyKey: batch.idempotencyKey,
        batchRef: batch.batchRef,
        batchPayloadDigest: batch.batchPayloadDigest,
        receiptJson: {},
      })
      .onConflictDoNothing()
      .returning();
    if (!receiptRow) {
      const [concurrent] = await tx
        .select()
        .from(securityCandidateBatchReceipts)
        .where(
          and(
            eq(securityCandidateBatchReceipts.producerPrincipal, producerPrincipal),
            eq(securityCandidateBatchReceipts.endpoint, ENDPOINT),
            eq(securityCandidateBatchReceipts.contractVersion, String(batch.contractVersion)),
            eq(securityCandidateBatchReceipts.idempotencyKey, batch.idempotencyKey),
          ),
        )
        .limit(1);
      if (!concurrent) {
        throw new SecurityIntelligenceIngressError(
          409,
          "receipt_conflict",
          "candidate receipt conflicted with another persisted batch",
        );
      }
      if (concurrent.batchPayloadDigest !== batch.batchPayloadDigest) {
        throw new SecurityIntelligenceIngressError(
          409,
          "idempotency_conflict",
          "idempotency key was reused with different payload",
        );
      }
      return securityKnowledgeCandidateBatchResponseSchema.parse({
        replayed: true,
        receipt: concurrent.receiptJson,
      });
    }
    const itemReceipts: Array<Record<string, unknown>> = [];
    for (const rawItem of batch.items) {
      const parsed = securityKnowledgeCandidateItemSchema.safeParse(rawItem);
      if (!parsed.success) {
        const reasonCode = itemReason(parsed.error);
        itemReceipts.push({ candidateRef: rawItem.candidateRef, status: "rejected", reasonCode });
        await tx.insert(securityCandidateBatchItems).values({
          receiptId: receiptRow.id,
          candidateRef: rawItem.candidateRef,
          status: "rejected",
          reasonCode,
        });
        continue;
      }
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${parsed.data.fingerprint}))`);
      const [duplicate] = await tx
        .select({
          targetStateRef: securityCandidateBatchItems.targetStateRef,
        })
        .from(securityCandidateBatchItems)
        .innerJoin(
          distillationTargetStates,
          sql`${securityCandidateBatchItems.targetStateRef} = ${"candidate-target:"} || ${distillationTargetStates.id}`,
        )
        .where(eq(securityCandidateBatchItems.fingerprint, parsed.data.fingerprint))
        .limit(1);
      if (duplicate?.targetStateRef) {
        itemReceipts.push({
          candidateRef: parsed.data.candidateRef,
          status: "duplicate",
          targetStateRef: duplicate.targetStateRef,
        });
        await tx.insert(securityCandidateBatchItems).values({
          receiptId: receiptRow.id,
          candidateRef: parsed.data.candidateRef,
          fingerprint: parsed.data.fingerprint,
          payloadDigest: parsed.data.payloadDigest,
          provenanceJson: candidateProvenance(batch, parsed.data),
          status: "duplicate",
          targetStateRef: duplicate.targetStateRef,
        });
        continue;
      }
      const value = candidatePipelineValues(parsed.data);
      await tx.insert(distillationTargetStates).values({
        id: value.targetStateId,
        targetKind: "knowledge_candidate",
        targetKey: parsed.data.candidateRef,
        sourceUri: value.sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        phase: "selected",
        priorityGroup: "knowledge_candidate",
        sortKey: value.now.toISOString(),
        metadata: value.metadata,
        updatedAt: value.now,
      });
      await tx.insert(findCandidateResults).values({
        id: value.findCandidateResultId,
        targetStateId: value.targetStateId,
        candidateIndex: 0,
        title: parsed.data.title,
        content: parsed.data.body,
        origin: value.origin,
        status: "selected",
        updatedAt: value.now,
      });
      await tx.insert(findingCandidateQueue).values({
        id: value.findingJobId,
        inputKind: "provided_candidate",
        sourceKind: "knowledge_candidate",
        sourceKey: parsed.data.candidateRef,
        sourceUri: value.sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        payload: value.payload,
        metadata: value.metadata,
        priority: 90,
        status: "completed",
        completedAt: value.now,
        lastOutcomeKind: "provided_candidate_registered",
        updatedAt: value.now,
      });
      await tx.insert(foundCandidates).values({
        id: value.foundCandidateId,
        findingJobId: value.findingJobId,
        candidateIndex: 0,
        type: parsed.data.type,
        title: parsed.data.title,
        content: parsed.data.body,
        origin: value.origin,
        metadata: value.metadata,
        updatedAt: value.now,
      });
      await tx.insert(coveringEvidenceQueue).values({
        id: value.coveringJobId,
        foundCandidateId: value.foundCandidateId,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        priority: 90,
        providerPolicy: "default",
        payload: {},
        metadata: {},
        updatedAt: value.now,
      });
      const targetStateRef = `candidate-target:${value.targetStateId}`;
      itemReceipts.push({
        candidateRef: parsed.data.candidateRef,
        status: "accepted",
        targetStateRef,
      });
      await tx.insert(securityCandidateBatchItems).values({
        receiptId: receiptRow.id,
        candidateRef: parsed.data.candidateRef,
        fingerprint: parsed.data.fingerprint,
        payloadDigest: parsed.data.payloadDigest,
        provenanceJson: candidateProvenance(batch, parsed.data),
        status: "accepted",
        targetStateRef,
      });
    }
    const receipt = {
      contractVersion: 1 as const,
      batchRef: batch.batchRef,
      receiptRef: receiptRow.receiptRef,
      items: itemReceipts,
    };
    const response = securityKnowledgeCandidateBatchResponseSchema.parse({
      replayed: false,
      receipt,
    });
    await tx
      .update(securityCandidateBatchReceipts)
      .set({ receiptJson: response.receipt })
      .where(eq(securityCandidateBatchReceipts.id, receiptRow.id));
    await tx.insert(auditLogs).values({
      eventType: auditEventTypes.securityIntelligenceCandidateBatchReceived,
      actor: "system",
      payload: {
        producerPrincipal,
        scope: "security-intelligence:candidates:write",
        endpoint: ENDPOINT,
        batchRef: batch.batchRef,
        receiptRef: receiptRow.receiptRef,
      },
    });
    return response;
  });
}

async function receiveSqlite(producerPrincipal: string, batch: SecurityKnowledgeCandidateBatch) {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const receiptId = randomUUID();
  const ref = receiptRef({ producerPrincipal, batch });
  const itemReceipts: Array<Record<string, unknown>> = [];
  sqlite.db.exec("BEGIN IMMEDIATE");
  try {
    const existing = sqlite.db
      .query<
        { batch_payload_digest: string; receipt_json: string },
        [string, string, string, string]
      >(
        `select batch_payload_digest, receipt_json from security_candidate_batch_receipts
         where producer_principal = ? and endpoint = ? and contract_version = ? and idempotency_key = ? limit 1`,
      )
      .get(producerPrincipal, ENDPOINT, String(batch.contractVersion), batch.idempotencyKey);
    if (existing) {
      if (existing.batch_payload_digest !== batch.batchPayloadDigest) {
        throw new SecurityIntelligenceIngressError(
          409,
          "idempotency_conflict",
          "idempotency key was reused with different payload",
        );
      }
      const response = securityKnowledgeCandidateBatchResponseSchema.parse({
        replayed: true,
        receipt: JSON.parse(existing.receipt_json),
      });
      sqlite.db.exec("COMMIT");
      return response;
    }
    sqlite.db
      .query(
        `insert into security_candidate_batch_receipts (
           id, receipt_ref, producer_principal, endpoint, contract_version,
           idempotency_key, batch_ref, batch_payload_digest, receipt_json, created_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
      )
      .run(
        receiptId,
        ref,
        producerPrincipal,
        ENDPOINT,
        String(batch.contractVersion),
        batch.idempotencyKey,
        batch.batchRef,
        batch.batchPayloadDigest,
        new Date().toISOString(),
      );
    for (const rawItem of batch.items) {
      const parsed = securityKnowledgeCandidateItemSchema.safeParse(rawItem);
      if (!parsed.success) {
        const reasonCode = itemReason(parsed.error);
        itemReceipts.push({ candidateRef: rawItem.candidateRef, status: "rejected", reasonCode });
        sqlite.db
          .query(
            `insert into security_candidate_batch_items (id, receipt_id, candidate_ref, status, reason_code) values (?, ?, ?, 'rejected', ?)`,
          )
          .run(randomUUID(), receiptId, rawItem.candidateRef, reasonCode);
        continue;
      }
      const duplicate = sqlite.db
        .query<{ target_state_ref: string }, [string]>(
          `select i.target_state_ref
           from security_candidate_batch_items i
           inner join distillation_target_states d
             on i.target_state_ref = 'candidate-target:' || d.id
           where i.fingerprint = ?
           limit 1`,
        )
        .get(parsed.data.fingerprint);
      if (duplicate?.target_state_ref) {
        itemReceipts.push({
          candidateRef: parsed.data.candidateRef,
          status: "duplicate",
          targetStateRef: duplicate.target_state_ref,
        });
        sqlite.db
          .query(
            `insert into security_candidate_batch_items (id, receipt_id, candidate_ref, fingerprint, payload_digest, provenance_json, status, target_state_ref) values (?, ?, ?, ?, ?, ?, 'duplicate', ?)`,
          )
          .run(
            randomUUID(),
            receiptId,
            parsed.data.candidateRef,
            parsed.data.fingerprint,
            parsed.data.payloadDigest,
            canonicalStringifySecurityIntelligenceValue(candidateProvenance(batch, parsed.data)),
            duplicate.target_state_ref,
          );
        continue;
      }
      const value = candidatePipelineValues(parsed.data);
      const now = value.now.toISOString();
      sqlite.db
        .query(
          `insert into distillation_target_states (id, target_kind, target_key, source_uri, distillation_version, status, phase, priority_group, sort_key, metadata, created_at, updated_at) values (?, 'knowledge_candidate', ?, ?, ?, 'pending', 'selected', 'knowledge_candidate', ?, ?, ?, ?)`,
        )
        .run(
          value.targetStateId,
          parsed.data.candidateRef,
          value.sourceUri,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          now,
          JSON.stringify(value.metadata),
          now,
          now,
        );
      sqlite.db
        .query(
          `insert into find_candidate_results (id, target_state_id, candidate_index, title, content, origin, status, created_at, updated_at) values (?, ?, 0, ?, ?, ?, 'selected', ?, ?)`,
        )
        .run(
          value.findCandidateResultId,
          value.targetStateId,
          parsed.data.title,
          parsed.data.body,
          JSON.stringify(value.origin),
          now,
          now,
        );
      sqlite.db
        .query(
          `insert into finding_candidate_queue (id, input_kind, source_kind, source_key, source_uri, distillation_version, status, priority, payload, metadata, completed_at, last_outcome_kind, created_at, updated_at) values (?, 'provided_candidate', 'knowledge_candidate', ?, ?, ?, 'completed', 90, ?, ?, ?, 'provided_candidate_registered', ?, ?)`,
        )
        .run(
          value.findingJobId,
          parsed.data.candidateRef,
          value.sourceUri,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          JSON.stringify(value.payload),
          JSON.stringify(value.metadata),
          now,
          now,
          now,
        );
      sqlite.db
        .query(
          "insert into found_candidates (id, finding_job_id, candidate_index, type, title, content, origin, metadata, created_at, updated_at) values (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          value.foundCandidateId,
          value.findingJobId,
          parsed.data.type,
          parsed.data.title,
          parsed.data.body,
          JSON.stringify(value.origin),
          JSON.stringify(value.metadata),
          now,
          now,
        );
      sqlite.db
        .query(
          `insert into covering_evidence_queue (id, found_candidate_id, distillation_version, status, priority, provider_policy, payload, metadata, created_at, updated_at) values (?, ?, ?, 'pending', 90, 'default', '{}', '{}', ?, ?)`,
        )
        .run(
          value.coveringJobId,
          value.foundCandidateId,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          now,
          now,
        );
      const targetStateRef = `candidate-target:${value.targetStateId}`;
      itemReceipts.push({
        candidateRef: parsed.data.candidateRef,
        status: "accepted",
        targetStateRef,
      });
      sqlite.db
        .query(
          `insert into security_candidate_batch_items (id, receipt_id, candidate_ref, fingerprint, payload_digest, provenance_json, status, target_state_ref) values (?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(
          randomUUID(),
          receiptId,
          parsed.data.candidateRef,
          parsed.data.fingerprint,
          parsed.data.payloadDigest,
          canonicalStringifySecurityIntelligenceValue(candidateProvenance(batch, parsed.data)),
          targetStateRef,
        );
    }
    const response = securityKnowledgeCandidateBatchResponseSchema.parse({
      replayed: false,
      receipt: {
        contractVersion: 1,
        batchRef: batch.batchRef,
        receiptRef: ref,
        items: itemReceipts,
      },
    });
    sqlite.db
      .query("update security_candidate_batch_receipts set receipt_json = ? where id = ?")
      .run(canonicalStringifySecurityIntelligenceValue(response.receipt), receiptId);
    sqlite.db
      .query(
        "insert into audit_logs (id, event_type, actor, payload, created_at) values (?, ?, 'system', ?, ?)",
      )
      .run(
        randomUUID(),
        auditEventTypes.securityIntelligenceCandidateBatchReceived,
        canonicalStringifySecurityIntelligenceValue({
          producerPrincipal,
          scope: "security-intelligence:candidates:write",
          endpoint: ENDPOINT,
          batchRef: batch.batchRef,
          receiptRef: ref,
        }),
        new Date().toISOString(),
      );
    sqlite.db.exec("COMMIT");
    return response;
  } catch (error) {
    sqlite.db.exec("ROLLBACK");
    throw error;
  }
}
