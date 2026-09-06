export const curationV2SchemaSql = `
CREATE TABLE IF NOT EXISTS curation_review_ledger (
  knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  content_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  candidate_index_epoch TEXT NOT NULL DEFAULT 'v2',
  outcome TEXT NOT NULL CHECK (outcome IN ('reviewed', 'waiting_provider', 'needs_evidence', 'failed')),
  curation_job_id TEXT REFERENCES landscape_curation_queue(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(knowledge_id, content_revision, evidence_revision, policy_version, candidate_index_epoch)
) STRICT;

CREATE TABLE IF NOT EXISTS curation_pair_reviews (
  left_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  right_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  left_revision TEXT NOT NULL,
  right_revision TEXT NOT NULL,
  evidence_revision TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('reviewed', 'merged', 'deprecated', 'keep_separate', 'needs_evidence', 'rejected')),
  curation_job_id TEXT REFERENCES landscape_curation_queue(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (left_knowledge_id < right_knowledge_id),
  PRIMARY KEY(left_knowledge_id, right_knowledge_id, left_revision, right_revision, evidence_revision, policy_version)
) STRICT;

CREATE TABLE IF NOT EXISTS curation_mutations (
  id TEXT PRIMARY KEY,
  curation_job_id TEXT NOT NULL REFERENCES landscape_curation_queue(id) ON DELETE CASCADE,
  survivor_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id),
  deprecated_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id),
  input_revision_hash TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  before_snapshot TEXT NOT NULL CHECK (json_valid(before_snapshot) AND json_type(before_snapshot) = 'object'),
  after_snapshot TEXT NOT NULL CHECK (json_valid(after_snapshot) AND json_type(after_snapshot) = 'object'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (survivor_knowledge_id <> deprecated_knowledge_id),
  UNIQUE(curation_job_id)
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_supersessions (
  deprecated_knowledge_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
  survivor_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id),
  curation_mutation_id TEXT NOT NULL REFERENCES curation_mutations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (deprecated_knowledge_id <> survivor_knowledge_id)
) STRICT;

CREATE INDEX IF NOT EXISTS curation_review_ledger_outcome_idx
  ON curation_review_ledger(outcome, updated_at);
CREATE INDEX IF NOT EXISTS curation_pair_reviews_job_idx
  ON curation_pair_reviews(curation_job_id, updated_at);
`;
