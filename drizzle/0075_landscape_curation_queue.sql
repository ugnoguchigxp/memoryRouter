ALTER TABLE "landscape_review_items"
  DROP CONSTRAINT IF EXISTS "landscape_review_items_reason_check";
--> statement-breakpoint
ALTER TABLE "landscape_review_items"
  ADD CONSTRAINT "landscape_review_items_reason_check"
  CHECK ("reason" IN (
    'duplicate_candidate',
    'used_baseline_lost',
    'baseline_off_topic',
    'baseline_wrong',
    'baseline_missing_after_recompile',
    'negative_attractor_candidate',
    'wrong_review_required',
    'over_selected_not_used',
    'dead_zone_reachability_risk',
    'dead_zone_stale',
    'semantic_reachable_dead_zone',
    'semantic_split',
    'semantic_merge',
    'relation_orphan',
    'promotion_gate_review',
    'contradiction_review'
  ));
--> statement-breakpoint
CREATE TABLE "landscape_curation_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "review_item_id" uuid,
  "finding_type" text NOT NULL,
  "subject_knowledge_id" uuid NOT NULL,
  "candidate_knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "repository_identity" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "fingerprint" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "evidence_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "phase" text DEFAULT 'evaluate' NOT NULL,
  "decision" text,
  "disposition" text,
  "priority" integer DEFAULT 50 NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "max_attempts" integer DEFAULT 3 NOT NULL,
  "next_run_at" timestamp,
  "locked_by" text,
  "locked_at" timestamp,
  "heartbeat_at" timestamp,
  "last_error" text,
  "last_outcome_kind" text,
  "provider" text DEFAULT 'local-llm' NOT NULL,
  "model" text,
  "input_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "policy_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "mutation_plan" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "postcheck_result" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rollback_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "rollback_status" text DEFAULT 'not_requested' NOT NULL,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "detector_version" text DEFAULT 'curation-detector-v1' NOT NULL,
  "policy_version" text DEFAULT 'curation-policy-v1' NOT NULL,
  "prompt_version" text DEFAULT 'landscape-curation-v1' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  "rollback_at" timestamp,
  CONSTRAINT "landscape_curation_queue_status_check" CHECK ("status" IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
  CONSTRAINT "landscape_curation_queue_finding_type_check" CHECK ("finding_type" IN ('duplicate_candidate', 'reachability_gap', 'stale_knowledge', 'applicability_issue', 'contradiction_candidate')),
  CONSTRAINT "landscape_curation_queue_phase_check" CHECK ("phase" IN ('evaluate', 'preflight', 'llm_review', 'policy', 'awaiting_downstream', 'mutation', 'postcheck', 'rollback')),
  CONSTRAINT "landscape_curation_queue_decision_check" CHECK ("decision" IS NULL OR "decision" IN ('merge_review', 'deprecate_duplicate', 'repair_scope', 'keep_separate', 'needs_evidence', 'observe', 'escalate')),
  CONSTRAINT "landscape_curation_queue_disposition_check" CHECK ("disposition" IS NULL OR "disposition" IN ('auto_execute', 'enqueue_downstream', 'record_only', 'await_evidence', 'blocked')),
  CONSTRAINT "landscape_curation_queue_rollback_status_check" CHECK ("rollback_status" IN ('not_requested', 'pending', 'completed', 'failed')),
  CONSTRAINT "landscape_curation_queue_priority_check" CHECK ("priority" >= 0 AND "priority" <= 100),
  CONSTRAINT "landscape_curation_queue_candidate_ids_array_check" CHECK (jsonb_typeof("candidate_knowledge_ids") = 'array'),
  CONSTRAINT "landscape_curation_queue_repository_identity_object_check" CHECK (jsonb_typeof("repository_identity") = 'object'),
  CONSTRAINT "landscape_curation_queue_input_snapshot_object_check" CHECK (jsonb_typeof("input_snapshot") = 'object'),
  CONSTRAINT "landscape_curation_queue_result_object_check" CHECK (jsonb_typeof("result") = 'object'),
  CONSTRAINT "landscape_curation_queue_policy_result_object_check" CHECK (jsonb_typeof("policy_result") = 'object'),
  CONSTRAINT "landscape_curation_queue_mutation_plan_object_check" CHECK (jsonb_typeof("mutation_plan") = 'object'),
  CONSTRAINT "landscape_curation_queue_postcheck_result_object_check" CHECK (jsonb_typeof("postcheck_result") = 'object'),
  CONSTRAINT "landscape_curation_queue_rollback_snapshot_object_check" CHECK (jsonb_typeof("rollback_snapshot") = 'object')
);
--> statement-breakpoint
ALTER TABLE "landscape_curation_queue"
  ADD CONSTRAINT "landscape_curation_queue_review_item_id_landscape_review_items_id_fk"
  FOREIGN KEY ("review_item_id") REFERENCES "public"."landscape_review_items"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "landscape_curation_queue"
  ADD CONSTRAINT "landscape_curation_queue_subject_knowledge_id_knowledge_items_id_fk"
  FOREIGN KEY ("subject_knowledge_id") REFERENCES "public"."knowledge_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "landscape_curation_queue_idempotency_unique" ON "landscape_curation_queue" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX "landscape_curation_queue_claim_idx" ON "landscape_curation_queue" USING btree ("status", "next_run_at", "priority", "created_at");
--> statement-breakpoint
CREATE INDEX "landscape_curation_queue_subject_updated_idx" ON "landscape_curation_queue" USING btree ("subject_knowledge_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "landscape_curation_queue_fingerprint_created_idx" ON "landscape_curation_queue" USING btree ("fingerprint", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "landscape_curation_queue_active_fingerprint_unique"
  ON "landscape_curation_queue" USING btree ("fingerprint")
  WHERE "status" IN ('pending', 'running', 'paused') OR "phase" = 'awaiting_downstream';
--> statement-breakpoint
CREATE TABLE "landscape_curation_job_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "curation_job_id" uuid NOT NULL,
  "role" text NOT NULL,
  "queue_name" text NOT NULL,
  "queue_job_id" uuid NOT NULL,
  "status" text NOT NULL,
  "outcome_kind" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  "completed_at" timestamp,
  CONSTRAINT "landscape_curation_job_links_role_check" CHECK ("role" IN ('merge_review', 'merge_finalize', 'evidence_repair')),
  CONSTRAINT "landscape_curation_job_links_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object')
);
--> statement-breakpoint
ALTER TABLE "landscape_curation_job_links"
  ADD CONSTRAINT "landscape_curation_job_links_curation_job_id_landscape_curation_queue_id_fk"
  FOREIGN KEY ("curation_job_id") REFERENCES "public"."landscape_curation_queue"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "landscape_curation_job_links_curation_role_unique" ON "landscape_curation_job_links" USING btree ("curation_job_id", "role");
--> statement-breakpoint
CREATE INDEX "landscape_curation_job_links_queue_job_idx" ON "landscape_curation_job_links" USING btree ("queue_name", "queue_job_id");
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_queue_name_check";
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_queue_name_check"
  CHECK ("queue_name" IN ('findingCandidate', 'episodeDistiller', 'coveringEvidence', 'deadZoneMergeReview', 'landscapeCuration', 'finalizeDistille', 'mergeActivationFinalize'));
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  DROP CONSTRAINT IF EXISTS "distillation_queue_events_event_type_check";
--> statement-breakpoint
ALTER TABLE "distillation_queue_events"
  ADD CONSTRAINT "distillation_queue_events_event_type_check"
  CHECK ("event_type" IN ('claimed', 'completed', 'failed', 'paused', 'resumed', 'retried', 'reprocess_requested', 'enqueued', 'migration_mapped', 'migration_failed', 'phase_changed', 'policy_decided', 'downstream_linked', 'rollback_started', 'rollback_completed'));
