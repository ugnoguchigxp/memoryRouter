ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "classification_status" text DEFAULT 'unresolved' NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "project_ref" text;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "repo_key" text;
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN IF NOT EXISTS "repo_path" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "classification_status" text DEFAULT 'unresolved' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'repo' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "project_ref" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "repo_key" text;
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN IF NOT EXISTS "repo_path" text;
--> statement-breakpoint
ALTER TABLE "episode_cards" ADD COLUMN IF NOT EXISTS "classification_status" text DEFAULT 'unresolved' NOT NULL;
--> statement-breakpoint
ALTER TABLE "episode_cards" ADD COLUMN IF NOT EXISTS "scope" text DEFAULT 'repo' NOT NULL;
--> statement-breakpoint
ALTER TABLE "episode_cards" ADD COLUMN IF NOT EXISTS "project_ref" text;
--> statement-breakpoint
ALTER TABLE "context_compile_runs" ADD COLUMN IF NOT EXISTS "project_ref" text;
--> statement-breakpoint
ALTER TABLE "context_compile_runs" ADD COLUMN IF NOT EXISTS "repo_key" text;
--> statement-breakpoint
ALTER TABLE "context_compile_runs" ADD COLUMN IF NOT EXISTS "match_basis" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_runs" ADD COLUMN IF NOT EXISTS "identity_contract_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_runs" ADD COLUMN IF NOT EXISTS "scope_mode" text DEFAULT 'global_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "project_ref" text;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "match_basis" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "identity_contract_version" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "scope_mode" text DEFAULT 'global_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "identity_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "identity_trust" text DEFAULT 'request_hint' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_compile_task_traces" ADD COLUMN IF NOT EXISTS "binding_status" text DEFAULT 'not_applicable' NOT NULL;
--> statement-breakpoint
ALTER TABLE "context_pack_items" ADD COLUMN IF NOT EXISTS "scope_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_identity_aliases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_ref" text NOT NULL,
  "alias_kind" text NOT NULL,
  "normalized_value" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "source" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_identity_aliases_project_alias_unique" ON "project_identity_aliases" USING btree ("project_ref","alias_kind","normalized_value");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_identity_aliases_active_alias_unique" ON "project_identity_aliases" USING btree ("alias_kind","normalized_value") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_identity_aliases_project_status_idx" ON "project_identity_aliases" USING btree ("project_ref","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_classification_status_idx" ON "knowledge_items" USING btree ("classification_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_status_scope_project_ref_idx" ON "knowledge_items" USING btree ("status","scope","project_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_status_scope_repo_key_idx" ON "knowledge_items" USING btree ("status","scope","repo_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_items_status_scope_repo_path_idx" ON "knowledge_items" USING btree ("status","scope","repo_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_classification_status_idx" ON "sources" USING btree ("classification_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_scope_project_ref_idx" ON "sources" USING btree ("scope","project_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_scope_repo_key_idx" ON "sources" USING btree ("scope","repo_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_scope_repo_path_idx" ON "sources" USING btree ("scope","repo_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_cards_classification_status_idx" ON "episode_cards" USING btree ("classification_status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "episode_cards_scope_project_ref_idx" ON "episode_cards" USING btree ("scope","project_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_runs_project_ref_idx" ON "context_compile_runs" USING btree ("project_ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_runs_repo_key_idx" ON "context_compile_runs" USING btree ("repo_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_runs_repo_path_idx" ON "context_compile_runs" USING btree ("repo_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "context_compile_task_traces_project_ref_idx" ON "context_compile_task_traces" USING btree ("project_ref");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_classification_status_check" CHECK ("classification_status" IN ('classified','unresolved','conflict','malformed'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sources" ADD CONSTRAINT "sources_classification_status_check" CHECK ("classification_status" IN ('classified','unresolved','conflict','malformed'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sources" ADD CONSTRAINT "sources_scope_check" CHECK ("scope" IN ('repo','global'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "episode_cards" ADD CONSTRAINT "episode_cards_classification_status_check" CHECK ("classification_status" IN ('classified','unresolved','conflict','malformed'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "episode_cards" ADD CONSTRAINT "episode_cards_scope_check" CHECK ("scope" IN ('repo','global'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_identity_aliases" ADD CONSTRAINT "project_identity_aliases_alias_kind_check" CHECK ("alias_kind" IN ('repo_key','repo_path'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_identity_aliases" ADD CONSTRAINT "project_identity_aliases_status_check" CHECK ("status" IN ('active','revoked'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_compile_runs" ADD CONSTRAINT "context_compile_runs_match_basis_check" CHECK ("match_basis" IN ('project_ref','repo_key','repo_path','none'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_compile_runs" ADD CONSTRAINT "context_compile_runs_scope_mode_check" CHECK ("scope_mode" IN ('global_only','project'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_compile_task_traces" ADD CONSTRAINT "context_compile_task_traces_match_basis_check" CHECK ("match_basis" IN ('project_ref','repo_key','repo_path','none'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_compile_task_traces" ADD CONSTRAINT "context_compile_task_traces_scope_mode_check" CHECK ("scope_mode" IN ('global_only','project'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_compile_task_traces" ADD CONSTRAINT "context_compile_task_traces_identity_trust_check" CHECK ("identity_trust" IN ('request_hint','trusted_adapter'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "context_compile_task_traces" ADD CONSTRAINT "context_compile_task_traces_binding_status_check" CHECK ("binding_status" IN ('verified','not_applicable','unverified'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;
