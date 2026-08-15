import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const securityCandidateBatchReceipts = pgTable(
  "security_candidate_batch_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptRef: text("receipt_ref").notNull().unique(),
    producerPrincipal: text("producer_principal").notNull(),
    endpoint: text("endpoint").notNull(),
    contractVersion: text("contract_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    batchRef: text("batch_ref").notNull(),
    batchPayloadDigest: text("batch_payload_digest").notNull(),
    receiptJson: jsonb("receipt_json").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    idempotencyScope: uniqueIndex("security_candidate_batch_receipts_idempotency_scope_idx").on(
      table.producerPrincipal,
      table.endpoint,
      table.contractVersion,
      table.idempotencyKey,
    ),
    batchDigestIdx: index("security_candidate_batch_receipts_batch_digest_idx").on(
      table.batchPayloadDigest,
    ),
  }),
);

export const securityCandidateBatchItems = pgTable(
  "security_candidate_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => securityCandidateBatchReceipts.id, { onDelete: "cascade" }),
    candidateRef: text("candidate_ref").notNull(),
    fingerprint: text("fingerprint"),
    payloadDigest: text("payload_digest"),
    status: text("status").notNull(),
    reasonCode: text("reason_code"),
    targetStateRef: text("target_state_ref"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    receiptCandidateIdx: uniqueIndex("security_candidate_batch_items_receipt_candidate_idx").on(
      table.receiptId,
      table.candidateRef,
    ),
    fingerprintPayloadIdx: index("security_candidate_batch_items_fingerprint_payload_idx").on(
      table.fingerprint,
      table.payloadDigest,
    ),
  }),
);

export const securityFeedbackBatchReceipts = pgTable(
  "security_feedback_batch_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptRef: text("receipt_ref").notNull().unique(),
    producerPrincipal: text("producer_principal").notNull(),
    endpoint: text("endpoint").notNull(),
    contractVersion: text("contract_version").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    batchRef: text("batch_ref").notNull(),
    batchPayloadDigest: text("batch_payload_digest").notNull(),
    receiptJson: jsonb("receipt_json").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    idempotencyScope: uniqueIndex("security_feedback_batch_receipts_idempotency_scope_idx").on(
      table.producerPrincipal,
      table.endpoint,
      table.contractVersion,
      table.idempotencyKey,
    ),
  }),
);

export const securityFeedbackEvents = pgTable(
  "security_feedback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventRef: text("event_ref").notNull().unique(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => securityFeedbackBatchReceipts.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    knowledgeRef: text("knowledge_ref").notNull(),
    knowledgeRevision: text("knowledge_revision").notNull(),
    payloadJson: jsonb("payload_json").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    receiptIdx: index("security_feedback_events_receipt_idx").on(table.receiptId),
  }),
);
