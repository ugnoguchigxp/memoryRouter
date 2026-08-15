import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import { securityFeedbackBatchReceipts, securityFeedbackEvents } from "../../db/schema.js";
import { securityIntelligenceSha256 } from "../../shared/schemas/security-knowledge-candidate-batch.schema.js";
import {
  SECURITY_KNOWLEDGE_FEEDBACK_BATCH_MAX_BYTES,
  type SecurityKnowledgeFeedbackBatch,
  securityKnowledgeFeedbackBatchResponseSchema,
  securityKnowledgeFeedbackEventSchema,
} from "../../shared/schemas/security-knowledge-feedback-batch.schema.js";
import { SecurityIntelligenceIngressError } from "./candidate-batch-ingress.service.js";

const ENDPOINT = "/api/integrations/security-intelligence/v1/feedback-batches";
const envelopeSchema = z
  .object({
    contractVersion: z.literal(1),
    batchRef: z.string().regex(/^skfb:v1:[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(1).max(256),
    batchPayloadDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    producer: z
      .object({
        system: z.literal("nightworkers"),
        version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
      })
      .strict(),
    events: z
      .array(z.object({ eventRef: z.string().regex(/^skfe:v1:[a-f0-9]{64}$/) }).passthrough())
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.events.map((event) => event.eventRef)).size !== value.events.length) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "security_intelligence:duplicate_feedback_event_ref",
      });
    }
  });

function validateEnvelope(raw: unknown): SecurityKnowledgeFeedbackBatch {
  if (
    new TextEncoder().encode(JSON.stringify(raw)).byteLength >
    SECURITY_KNOWLEDGE_FEEDBACK_BATCH_MAX_BYTES
  ) {
    throw new SecurityIntelligenceIngressError(
      413,
      "feedback_batch_too_large",
      "feedback batch exceeds 128 KiB",
    );
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SecurityIntelligenceIngressError(
      400,
      "feedback_batch_schema_invalid",
      parsed.error.message,
    );
  }
  const batch = parsed.data as unknown as SecurityKnowledgeFeedbackBatch;
  const {
    idempotencyKey: _idempotencyKey,
    batchRef: _batchRef,
    batchPayloadDigest: _batchPayloadDigest,
    ...semantic
  } = batch;
  const digest = securityIntelligenceSha256(semantic);
  if (batch.batchPayloadDigest !== digest || batch.batchRef !== `skfb:v1:${digest.slice(7)}`) {
    throw new SecurityIntelligenceIngressError(
      400,
      "feedback_batch_digest_mismatch",
      "feedback batch digest mismatch",
    );
  }
  return batch;
}

function receiptRef(producerPrincipal: string, batch: SecurityKnowledgeFeedbackBatch) {
  const digest = securityIntelligenceSha256({
    producerPrincipal,
    endpoint: ENDPOINT,
    contractVersion: batch.contractVersion,
    idempotencyKey: batch.idempotencyKey,
    batchRef: batch.batchRef,
    batchPayloadDigest: batch.batchPayloadDigest,
  });
  return `skfr:v1:${digest.slice(7)}`;
}

function eventReason(error: z.ZodError) {
  return (
    error.issues
      .find((issue) => issue.code === "custom")
      ?.message.replace(/^security_intelligence:/, "") ?? "feedback_event_schema_invalid"
  ).slice(0, 128);
}

export async function receiveSecurityKnowledgeFeedbackBatch(input: {
  producerPrincipal: string;
  rawBatch: unknown;
}) {
  const batch = validateEnvelope(input.rawBatch);
  return resolveDatabaseBackendConfig().kind === "sqlite"
    ? receiveSqlite(input.producerPrincipal, batch)
    : receivePostgres(input.producerPrincipal, batch);
}

async function receivePostgres(producerPrincipal: string, batch: SecurityKnowledgeFeedbackBatch) {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(securityFeedbackBatchReceipts)
      .where(
        and(
          eq(securityFeedbackBatchReceipts.producerPrincipal, producerPrincipal),
          eq(securityFeedbackBatchReceipts.endpoint, ENDPOINT),
          eq(securityFeedbackBatchReceipts.contractVersion, String(batch.contractVersion)),
          eq(securityFeedbackBatchReceipts.idempotencyKey, batch.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      if (existing.batchPayloadDigest !== batch.batchPayloadDigest) {
        throw new SecurityIntelligenceIngressError(
          409,
          "idempotency_conflict",
          "idempotency key was reused with different feedback payload",
        );
      }
      return securityKnowledgeFeedbackBatchResponseSchema.parse({
        replayed: true,
        receipt: existing.receiptJson,
      });
    }
    const [receiptRow] = await tx
      .insert(securityFeedbackBatchReceipts)
      .values({
        receiptRef: receiptRef(producerPrincipal, batch),
        producerPrincipal,
        endpoint: ENDPOINT,
        contractVersion: String(batch.contractVersion),
        idempotencyKey: batch.idempotencyKey,
        batchRef: batch.batchRef,
        batchPayloadDigest: batch.batchPayloadDigest,
        receiptJson: {},
      })
      .returning();
    const acceptedEventRefs: string[] = [];
    const duplicateEventRefs: string[] = [];
    const rejectedEvents: Array<{ eventRef: string; reasonCode: string }> = [];
    for (const rawEvent of batch.events) {
      const parsed = securityKnowledgeFeedbackEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        rejectedEvents.push({ eventRef: rawEvent.eventRef, reasonCode: eventReason(parsed.error) });
        continue;
      }
      const [duplicate] = await tx
        .select({ eventRef: securityFeedbackEvents.eventRef })
        .from(securityFeedbackEvents)
        .where(eq(securityFeedbackEvents.eventRef, parsed.data.eventRef))
        .limit(1);
      if (duplicate) {
        duplicateEventRefs.push(parsed.data.eventRef);
        continue;
      }
      await tx.insert(securityFeedbackEvents).values({
        eventRef: parsed.data.eventRef,
        receiptId: receiptRow.id,
        eventType: parsed.data.eventType,
        knowledgeRef: parsed.data.knowledgeRef,
        knowledgeRevision: String(parsed.data.knowledgeRevision),
        payloadJson: parsed.data,
      });
      acceptedEventRefs.push(parsed.data.eventRef);
    }
    const response = securityKnowledgeFeedbackBatchResponseSchema.parse({
      replayed: false,
      receipt: {
        contractVersion: 1,
        batchRef: batch.batchRef,
        receiptRef: receiptRow.receiptRef,
        acceptedEventRefs,
        duplicateEventRefs,
        rejectedEvents,
      },
    });
    await tx
      .update(securityFeedbackBatchReceipts)
      .set({ receiptJson: response.receipt })
      .where(eq(securityFeedbackBatchReceipts.id, receiptRow.id));
    return response;
  });
}

async function receiveSqlite(producerPrincipal: string, batch: SecurityKnowledgeFeedbackBatch) {
  const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
  const sqlite = await getRuntimeSqliteCoreDatabase();
  const existing = sqlite.db
    .query<
      { batch_payload_digest: string; receipt_json: string },
      [string, string, string, string]
    >(
      `select batch_payload_digest, receipt_json from security_feedback_batch_receipts
       where producer_principal = ? and endpoint = ? and contract_version = ? and idempotency_key = ? limit 1`,
    )
    .get(producerPrincipal, ENDPOINT, String(batch.contractVersion), batch.idempotencyKey);
  if (existing) {
    if (existing.batch_payload_digest !== batch.batchPayloadDigest) {
      throw new SecurityIntelligenceIngressError(
        409,
        "idempotency_conflict",
        "idempotency key was reused with different feedback payload",
      );
    }
    return securityKnowledgeFeedbackBatchResponseSchema.parse({
      replayed: true,
      receipt: JSON.parse(existing.receipt_json),
    });
  }
  const receiptId = randomUUID();
  const ref = receiptRef(producerPrincipal, batch);
  const acceptedEventRefs: string[] = [];
  const duplicateEventRefs: string[] = [];
  const rejectedEvents: Array<{ eventRef: string; reasonCode: string }> = [];
  sqlite.db.exec("BEGIN IMMEDIATE");
  try {
    sqlite.db
      .query(
        `insert into security_feedback_batch_receipts (id, receipt_ref, producer_principal, endpoint, contract_version, idempotency_key, batch_ref, batch_payload_digest, receipt_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
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
    for (const rawEvent of batch.events) {
      const parsed = securityKnowledgeFeedbackEventSchema.safeParse(rawEvent);
      if (!parsed.success) {
        rejectedEvents.push({ eventRef: rawEvent.eventRef, reasonCode: eventReason(parsed.error) });
        continue;
      }
      const duplicate = sqlite.db
        .query<{ event_ref: string }, [string]>(
          "select event_ref from security_feedback_events where event_ref = ? limit 1",
        )
        .get(parsed.data.eventRef);
      if (duplicate) {
        duplicateEventRefs.push(parsed.data.eventRef);
        continue;
      }
      sqlite.db
        .query(
          "insert into security_feedback_events (id, event_ref, receipt_id, event_type, knowledge_ref, knowledge_revision, payload_json, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          randomUUID(),
          parsed.data.eventRef,
          receiptId,
          parsed.data.eventType,
          parsed.data.knowledgeRef,
          String(parsed.data.knowledgeRevision),
          JSON.stringify(parsed.data),
          new Date().toISOString(),
        );
      acceptedEventRefs.push(parsed.data.eventRef);
    }
    const response = securityKnowledgeFeedbackBatchResponseSchema.parse({
      replayed: false,
      receipt: {
        contractVersion: 1,
        batchRef: batch.batchRef,
        receiptRef: ref,
        acceptedEventRefs,
        duplicateEventRefs,
        rejectedEvents,
      },
    });
    sqlite.db
      .query("update security_feedback_batch_receipts set receipt_json = ? where id = ?")
      .run(JSON.stringify(response.receipt), receiptId);
    sqlite.db.exec("COMMIT");
    return response;
  } catch (error) {
    sqlite.db.exec("ROLLBACK");
    throw error;
  }
}
