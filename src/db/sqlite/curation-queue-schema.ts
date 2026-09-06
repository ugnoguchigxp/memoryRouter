import { curationV2SchemaSql } from "./curation-v2-schema.js";

export const curationQueueSchemaSql = `
CREATE TABLE IF NOT EXISTS landscape_curation_queue (
  id TEXT PRIMARY KEY,
  review_item_id TEXT,
  finding_type TEXT NOT NULL CHECK (finding_type IN ('duplicate_candidate', 'reachability_gap', 'stale_knowledge', 'applicability_issue', 'contradiction_candidate')),
  subject_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  candidate_knowledge_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(candidate_knowledge_ids) AND json_type(candidate_knowledge_ids) = 'array'),
  repository_identity TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(repository_identity) AND json_type(repository_identity) = 'object'),
  fingerprint TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  evidence_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed', 'paused')),
  phase TEXT NOT NULL DEFAULT 'evaluate' CHECK (phase IN ('evaluate', 'preflight', 'llm_review', 'policy', 'awaiting_downstream', 'mutation', 'postcheck', 'rollback')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('merge_review', 'deprecate_duplicate', 'repair_scope', 'keep_separate', 'needs_evidence', 'observe', 'escalate')),
  disposition TEXT CHECK (disposition IS NULL OR disposition IN ('auto_execute', 'enqueue_downstream', 'record_only', 'await_evidence', 'blocked')),
  priority INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_run_at TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  provider TEXT NOT NULL DEFAULT 'local-llm',
  model TEXT,
  input_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(input_snapshot) AND json_type(input_snapshot) = 'object'),
  result TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(result) AND json_type(result) = 'object'),
  policy_result TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_result) AND json_type(policy_result) = 'object'),
  mutation_plan TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(mutation_plan) AND json_type(mutation_plan) = 'object'),
  postcheck_result TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(postcheck_result) AND json_type(postcheck_result) = 'object'),
  rollback_snapshot TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(rollback_snapshot) AND json_type(rollback_snapshot) = 'object'),
  rollback_status TEXT NOT NULL DEFAULT 'not_requested' CHECK (rollback_status IN ('not_requested', 'pending', 'completed', 'failed')),
  schema_version INTEGER NOT NULL DEFAULT 1,
  detector_version TEXT NOT NULL DEFAULT 'curation-detector-v1',
  policy_version TEXT NOT NULL DEFAULT 'curation-policy-v1',
  prompt_version TEXT NOT NULL DEFAULT 'landscape-curation-v1',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  rollback_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS landscape_curation_queue_claim_idx
  ON landscape_curation_queue(status, next_run_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS landscape_curation_queue_subject_updated_idx
  ON landscape_curation_queue(subject_knowledge_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS landscape_curation_queue_fingerprint_created_idx
  ON landscape_curation_queue(fingerprint, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS landscape_curation_queue_active_fingerprint_unique
  ON landscape_curation_queue(fingerprint)
  WHERE status IN ('pending', 'running', 'paused') OR phase = 'awaiting_downstream';

CREATE TABLE IF NOT EXISTS landscape_curation_job_links (
  id TEXT PRIMARY KEY,
  curation_job_id TEXT NOT NULL REFERENCES landscape_curation_queue(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('merge_review', 'merge_finalize', 'evidence_repair')),
  queue_name TEXT NOT NULL,
  queue_job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  outcome_kind TEXT,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata) AND json_type(metadata) = 'object'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(curation_job_id, role)
) STRICT;

CREATE INDEX IF NOT EXISTS landscape_curation_job_links_queue_job_idx
  ON landscape_curation_job_links(queue_name, queue_job_id);

${curationV2SchemaSql}
`;
