ALTER TABLE "security_candidate_batch_items"
ADD COLUMN IF NOT EXISTS "provenance_json" jsonb;
