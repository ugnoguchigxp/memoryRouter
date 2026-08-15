CREATE TABLE IF NOT EXISTS "security_candidate_batch_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_ref" text NOT NULL UNIQUE,
	"producer_principal" text NOT NULL,
	"endpoint" text NOT NULL,
	"contract_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"batch_ref" text NOT NULL,
	"batch_payload_digest" text NOT NULL,
	"receipt_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "security_candidate_batch_receipts_idempotency_scope_idx" ON "security_candidate_batch_receipts" USING btree ("producer_principal","endpoint","contract_version","idempotency_key");
CREATE INDEX IF NOT EXISTS "security_candidate_batch_receipts_batch_digest_idx" ON "security_candidate_batch_receipts" USING btree ("batch_payload_digest");
CREATE TABLE IF NOT EXISTS "security_candidate_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL REFERENCES "security_candidate_batch_receipts"("id") ON DELETE cascade,
	"candidate_ref" text NOT NULL,
	"fingerprint" text,
	"payload_digest" text,
	"status" text NOT NULL,
	"reason_code" text,
	"target_state_ref" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "security_candidate_batch_items_receipt_candidate_idx" ON "security_candidate_batch_items" USING btree ("receipt_id","candidate_ref");
CREATE INDEX IF NOT EXISTS "security_candidate_batch_items_fingerprint_payload_idx" ON "security_candidate_batch_items" USING btree ("fingerprint","payload_digest");
CREATE TABLE IF NOT EXISTS "security_feedback_batch_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_ref" text NOT NULL UNIQUE,
	"producer_principal" text NOT NULL,
	"endpoint" text NOT NULL,
	"contract_version" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"batch_ref" text NOT NULL,
	"batch_payload_digest" text NOT NULL,
	"receipt_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "security_feedback_batch_receipts_idempotency_scope_idx" ON "security_feedback_batch_receipts" USING btree ("producer_principal","endpoint","contract_version","idempotency_key");
CREATE TABLE IF NOT EXISTS "security_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_ref" text NOT NULL UNIQUE,
	"receipt_id" uuid NOT NULL REFERENCES "security_feedback_batch_receipts"("id") ON DELETE cascade,
	"event_type" text NOT NULL,
	"knowledge_ref" text NOT NULL,
	"knowledge_revision" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "security_feedback_events_receipt_idx" ON "security_feedback_events" USING btree ("receipt_id");
