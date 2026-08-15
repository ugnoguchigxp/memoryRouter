CREATE TABLE IF NOT EXISTS "repository_identity_migration_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_version" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_fingerprint" text NOT NULL,
	"after_fingerprint" text NOT NULL,
	"reason_code" text NOT NULL,
	"provenance_source" text NOT NULL,
	"outcome" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "repository_identity_migration_audits_entity_kind_check" CHECK ("entity_kind" IN ('knowledge','source','episode')),
	CONSTRAINT "repository_identity_migration_audits_outcome_check" CHECK ("outcome" IN ('backfilled','unresolved','conflict','malformed','global_promoted'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repository_identity_migration_audits_replay_unique_idx" ON "repository_identity_migration_audits" USING btree ("migration_version","entity_kind","entity_id","after_fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repository_identity_migration_audits_version_outcome_idx" ON "repository_identity_migration_audits" USING btree ("migration_version","outcome");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "repository_identity_migration_audits_entity_idx" ON "repository_identity_migration_audits" USING btree ("entity_kind","entity_id");
