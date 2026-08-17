export function createSqliteCoreSchemaSql(input: { vectorDimension: number }): string {
  const dimension = Math.max(1, Math.trunc(input.vectorDimension));
  return `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS knowledge_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'repo',
  classification_status TEXT NOT NULL DEFAULT 'unresolved',
  project_ref TEXT,
  repo_key TEXT,
  repo_path TEXT,
  polarity TEXT NOT NULL DEFAULT 'positive',
  intent_tags TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  applies_to TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 70,
  importance REAL NOT NULL DEFAULT 70,
  compile_select_count INTEGER NOT NULL DEFAULT 0,
  last_compiled_at TEXT,
  agentic_accept_count INTEGER NOT NULL DEFAULT 0,
  explicit_upvote_count INTEGER NOT NULL DEFAULT 0,
  explicit_downvote_count INTEGER NOT NULL DEFAULT 0,
  dynamic_score REAL NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_items_status_idx ON knowledge_items(status);
CREATE INDEX IF NOT EXISTS knowledge_items_type_status_idx ON knowledge_items(type, status);
CREATE INDEX IF NOT EXISTS knowledge_items_polarity_idx ON knowledge_items(polarity);
CREATE INDEX IF NOT EXISTS knowledge_items_dynamic_score_idx ON knowledge_items(dynamic_score);
CREATE INDEX IF NOT EXISTS knowledge_items_last_compiled_at_idx ON knowledge_items(last_compiled_at);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
  id UNINDEXED,
  title,
  body
);

CREATE TABLE IF NOT EXISTS knowledge_tag_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slug TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  sort_order INTEGER NOT NULL DEFAULT 1000,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(kind, slug)
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_community_labels (
  community_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  note TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_quality_adjustments (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  adjustment_kind TEXT NOT NULL,
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  negative_run_count INTEGER NOT NULL,
  off_topic_rate REAL NOT NULL,
  importance_delta REAL NOT NULL,
  confidence_delta REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_origin_links (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_uri TEXT NOT NULL,
  origin_key TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE,
  UNIQUE(knowledge_id, origin_kind, origin_uri)
) STRICT;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  classification_status TEXT NOT NULL DEFAULT 'unresolved',
  scope TEXT NOT NULL DEFAULT 'repo',
  project_ref TEXT,
  repo_key TEXT,
  repo_path TEXT,
  uri TEXT NOT NULL UNIQUE,
  title TEXT,
  body TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_indexed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sources_kind_idx ON sources(source_kind);

CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
  id UNINDEXED,
  title,
  uri,
  body
);

CREATE TABLE IF NOT EXISTS source_fragments (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE,
  UNIQUE(source_id, locator)
) STRICT;

CREATE INDEX IF NOT EXISTS source_fragments_source_id_idx ON source_fragments(source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS source_fragments_fts USING fts5(
  id UNINDEXED,
  heading,
  content
);

CREATE TABLE IF NOT EXISTS knowledge_source_links (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  source_fragment_id TEXT NOT NULL,
  link_type TEXT NOT NULL DEFAULT 'derived_from',
  confidence REAL NOT NULL DEFAULT 0.5,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_source_links_knowledge_idx
  ON knowledge_source_links(knowledge_id);
CREATE INDEX IF NOT EXISTS knowledge_source_links_source_fragment_idx
  ON knowledge_source_links(source_fragment_id);

CREATE TABLE IF NOT EXISTS knowledge_usage_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  knowledge_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_usage_events_run_id_idx
  ON knowledge_usage_events(run_id);
CREATE INDEX IF NOT EXISTS knowledge_usage_events_knowledge_id_idx
  ON knowledge_usage_events(knowledge_id);

CREATE TABLE IF NOT EXISTS knowledge_review_queue (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL,
  trigger_event_id TEXT NOT NULL,
  trigger_verdict TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_action TEXT NOT NULL DEFAULT 'review_only',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS knowledge_review_queue_status_created_at_idx
  ON knowledge_review_queue(status, created_at);

CREATE TABLE IF NOT EXISTS core_vector_metadata (
  name TEXT PRIMARY KEY,
  dimension INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  rebuilt_at TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  uses_sqlite_vec INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_items_vec_map (
  vec_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS knowledge_items_vec_fallback (
  knowledge_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL DEFAULT ${dimension},
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS source_fragments_vec_map (
  vec_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  source_fragment_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS source_fragments_vec_fallback (
  source_fragment_id TEXT PRIMARY KEY,
  embedding_json TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL DEFAULT ${dimension},
  content_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_fragment_id) REFERENCES source_fragments(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS context_compile_runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  intent TEXT NOT NULL,
  session_id TEXT,
  project_ref TEXT,
  repo_key TEXT,
  repo_path TEXT,
  match_basis TEXT NOT NULL DEFAULT 'none',
  identity_contract_version INTEGER NOT NULL DEFAULT 1,
  scope_mode TEXT NOT NULL DEFAULT 'global_only',
  input TEXT NOT NULL DEFAULT '{}',
  retrieval_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  degraded_reasons TEXT NOT NULL DEFAULT '[]',
  token_budget INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'unknown',
  pack_snapshot TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS context_compile_runs_created_at_idx
  ON context_compile_runs(created_at);
CREATE INDEX IF NOT EXISTS context_compile_runs_session_created_idx
  ON context_compile_runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS project_identity_aliases (
  id TEXT PRIMARY KEY,
  project_ref TEXT NOT NULL,
  alias_kind TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_ref, alias_kind, normalized_value)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS project_identity_aliases_active_alias_unique
  ON project_identity_aliases(alias_kind, normalized_value)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS project_identity_aliases_project_status_idx
  ON project_identity_aliases(project_ref, status);

CREATE TABLE IF NOT EXISTS repository_identity_migration_audits (
  id TEXT PRIMARY KEY,
  migration_version TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('knowledge', 'source', 'episode')),
  entity_id TEXT NOT NULL,
  before_fingerprint TEXT NOT NULL,
  after_fingerprint TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  provenance_source TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('backfilled', 'unresolved', 'conflict', 'malformed', 'global_promoted')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(migration_version, entity_kind, entity_id, after_fingerprint)
) STRICT;

CREATE INDEX IF NOT EXISTS repository_identity_migration_audits_version_outcome_idx
  ON repository_identity_migration_audits(migration_version, outcome);
CREATE INDEX IF NOT EXISTS repository_identity_migration_audits_entity_idx
  ON repository_identity_migration_audits(entity_kind, entity_id);

CREATE TABLE IF NOT EXISTS context_pack_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  postgres_id TEXT,
  run_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  section TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0,
  ranking_reason TEXT NOT NULL DEFAULT '',
  source_refs TEXT NOT NULL DEFAULT '[]',
  scope_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES context_compile_runs(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS context_pack_items_run_idx
  ON context_pack_items(run_id);

CREATE TABLE IF NOT EXISTS context_compile_candidate_traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  postgres_id TEXT,
  run_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  text_rank INTEGER,
  text_score REAL,
  vector_rank INTEGER,
  vector_score REAL,
  merged_rank INTEGER,
  merged_score REAL,
  final_rank INTEGER,
  final_score REAL,
  selected INTEGER NOT NULL DEFAULT 0,
  suppressed INTEGER NOT NULL DEFAULT 0,
  suppression_reason TEXT,
  agentic_decision TEXT NOT NULL DEFAULT 'not_evaluated',
  ranking_reason TEXT,
  community_key TEXT,
  evidence TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES context_compile_runs(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS context_compile_candidate_traces_run_idx
  ON context_compile_candidate_traces(run_id);

CREATE TABLE IF NOT EXISTS context_compile_task_traces (
  run_id TEXT PRIMARY KEY,
  postgres_id TEXT,
  retrieval_mode TEXT NOT NULL,
  project_ref TEXT,
  repo_path TEXT,
  repo_key TEXT,
  match_basis TEXT NOT NULL DEFAULT 'none',
  identity_contract_version INTEGER NOT NULL DEFAULT 1,
  scope_mode TEXT NOT NULL DEFAULT 'global_only',
  identity_fingerprint TEXT,
  identity_trust TEXT NOT NULL DEFAULT 'request_hint',
  binding_status TEXT NOT NULL DEFAULT 'not_applicable',
  technologies TEXT NOT NULL DEFAULT '[]',
  change_types TEXT NOT NULL DEFAULT '[]',
  domains TEXT NOT NULL DEFAULT '[]',
  embedding_status TEXT NOT NULL DEFAULT 'facets_only',
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  embedding TEXT,
  goal_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES context_compile_runs(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS context_compile_evals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT,
  score INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'mcp',
  metadata TEXT NOT NULL DEFAULT '{}',
  relevance INTEGER,
  actionability INTEGER,
  coverage INTEGER,
  clarity INTEGER,
  specificity INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES context_compile_runs(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS context_compile_evals_run_created_at_idx
  ON context_compile_evals(run_id, created_at);
CREATE INDEX IF NOT EXISTS context_compile_evals_session_created_at_idx
  ON context_compile_evals(session_id, created_at);
CREATE INDEX IF NOT EXISTS context_compile_evals_outcome_created_at_idx
  ON context_compile_evals(outcome, created_at);

CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  value_kind TEXT NOT NULL DEFAULT 'json',
  secret_ref TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  UNIQUE(namespace, key)
) STRICT;

CREATE INDEX IF NOT EXISTS settings_namespace_idx ON settings(namespace);
CREATE INDEX IF NOT EXISTS settings_key_idx ON settings(key);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS audit_logs_event_type_idx ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor);
CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS episode_cards (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  situation TEXT NOT NULL,
  observations TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  lesson TEXT NOT NULL DEFAULT '',
  applicability TEXT NOT NULL DEFAULT '{}',
  anti_applicability TEXT NOT NULL DEFAULT '{}',
  domains TEXT NOT NULL DEFAULT '[]',
  technologies TEXT NOT NULL DEFAULT '[]',
  change_types TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  classification_status TEXT NOT NULL DEFAULT 'unresolved',
  scope TEXT NOT NULL DEFAULT 'repo',
  project_ref TEXT,
  repo_path TEXT,
  repo_key TEXT,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  outcome_kind TEXT NOT NULL DEFAULT 'unknown',
  importance INTEGER NOT NULL DEFAULT 50,
  confidence INTEGER NOT NULL DEFAULT 50,
  compile_use_count INTEGER NOT NULL DEFAULT 0,
  decision_use_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  stale_at TEXT,
  embedding TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS episode_cards_source_unique_idx
  ON episode_cards(source_kind, source_key);
CREATE INDEX IF NOT EXISTS episode_cards_status_idx ON episode_cards(status);
CREATE INDEX IF NOT EXISTS episode_cards_repo_key_idx ON episode_cards(repo_key);
CREATE INDEX IF NOT EXISTS episode_cards_repo_path_idx ON episode_cards(repo_path);
CREATE INDEX IF NOT EXISTS episode_cards_outcome_kind_idx ON episode_cards(outcome_kind);
CREATE INDEX IF NOT EXISTS episode_cards_created_at_idx ON episode_cards(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS episode_cards_fts USING fts5(
  id UNINDEXED,
  title,
  situation,
  observations,
  action,
  outcome,
  lesson
);

CREATE TABLE IF NOT EXISTS episode_refs (
  id TEXT PRIMARY KEY,
  episode_card_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_value TEXT NOT NULL,
  locator TEXT,
  query_hint TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_card_id) REFERENCES episode_cards(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS episode_refs_episode_card_id_idx
  ON episode_refs(episode_card_id);
CREATE INDEX IF NOT EXISTS episode_refs_kind_value_idx
  ON episode_refs(ref_kind, ref_value);

CREATE TABLE IF NOT EXISTS episode_retrieval_feedback (
  id TEXT PRIMARY KEY,
  episode_card_id TEXT NOT NULL,
  run_kind TEXT NOT NULL,
  run_id TEXT NOT NULL,
  used_for TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (episode_card_id) REFERENCES episode_cards(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS episode_retrieval_feedback_episode_run_idx
  ON episode_retrieval_feedback(episode_card_id, run_kind, run_id);
CREATE INDEX IF NOT EXISTS episode_retrieval_feedback_verdict_created_at_idx
  ON episode_retrieval_feedback(verdict, created_at);

CREATE TABLE IF NOT EXISTS llm_usage_logs (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cost_jpy REAL NOT NULL DEFAULT 0,
  usage_mode TEXT NOT NULL DEFAULT 'estimated',
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS llm_usage_logs_created_at_idx ON llm_usage_logs(created_at);
CREATE INDEX IF NOT EXISTS llm_usage_logs_provider_idx ON llm_usage_logs(provider);

CREATE TABLE IF NOT EXISTS llm_provider_leases (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  queue_job_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  locked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  heartbeat_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

DROP INDEX IF EXISTS llm_provider_leases_active_target_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS llm_provider_leases_active_target_unique_idx
  ON llm_provider_leases(target_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS llm_provider_leases_pool_status_expires_idx
  ON llm_provider_leases(pool_id, status, expires_at);
CREATE INDEX IF NOT EXISTS llm_provider_leases_job_status_idx
  ON llm_provider_leases(queue_name, queue_job_id, status);

CREATE TABLE IF NOT EXISTS vibe_goals (
  id TEXT PRIMARY KEY,
  goal_uri TEXT NOT NULL UNIQUE,
  goal_anchor_ref TEXT NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS vibe_migration_runs (
  id TEXT PRIMARY KEY,
  from_table TEXT NOT NULL,
  deleted_count INTEGER NOT NULL,
  preserved_tables TEXT NOT NULL DEFAULT '[]',
  executed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  app_version TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS vibe_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'chat',
  dedupe_key TEXT,
  embedding TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  goal_id TEXT,
  parent_id TEXT,
  subject TEXT,
  intent TEXT,
  wants TEXT NOT NULL DEFAULT '[]',
  refs TEXT NOT NULL DEFAULT '[]',
  confidence TEXT,
  evidence_status TEXT,
  actor_id TEXT,
  ttl_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS vibe_memories_session_id_idx ON vibe_memories(session_id);
CREATE INDEX IF NOT EXISTS vibe_memories_memory_type_idx ON vibe_memories(memory_type);
CREATE UNIQUE INDEX IF NOT EXISTS vibe_memories_session_dedupe_key_idx
  ON vibe_memories(session_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE VIRTUAL TABLE IF NOT EXISTS vibe_memories_fts USING fts5(
  id UNINDEXED,
  content
);

CREATE TABLE IF NOT EXISTS agent_diff_entries (
  id TEXT PRIMARY KEY,
  vibe_memory_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  diff_hunk TEXT NOT NULL,
  change_type TEXT,
  language TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vibe_memory_id) REFERENCES vibe_memories(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS agent_diff_entries_vibe_memory_id_idx
  ON agent_diff_entries(vibe_memory_id);
CREATE INDEX IF NOT EXISTS agent_diff_entries_file_path_idx ON agent_diff_entries(file_path);
CREATE INDEX IF NOT EXISTS agent_diff_entries_symbol_idx
  ON agent_diff_entries(symbol_name, symbol_kind);
CREATE INDEX IF NOT EXISTS agent_diff_entries_line_range_idx
  ON agent_diff_entries(start_line, end_line);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_diff_entries_fts USING fts5(
  id UNINDEXED,
  vibe_memory_id UNINDEXED,
  file_path,
  diff_hunk,
  symbol_name,
  symbol_kind,
  signature
);

CREATE TABLE IF NOT EXISTS vibe_memory_marks (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  mark TEXT NOT NULL,
  note TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS vibe_memory_marks_goal_id_idx ON vibe_memory_marks(goal_id);
CREATE INDEX IF NOT EXISTS vibe_memory_marks_target_memory_id_idx
  ON vibe_memory_marks(target_memory_id);

CREATE TABLE IF NOT EXISTS sync_states (
  id TEXT PRIMARY KEY,
  last_synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cursor TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS context_decision_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  premise TEXT,
  decision_point TEXT NOT NULL,
  proposed_action TEXT,
  options TEXT NOT NULL DEFAULT '[]',
  retrieval_hints TEXT NOT NULL DEFAULT '{}',
  decision TEXT NOT NULL,
  selected_action TEXT,
  rejected_actions TEXT NOT NULL DEFAULT '[]',
  mandate TEXT NOT NULL,
  agent_message TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  confidence_trace TEXT NOT NULL DEFAULT '{}',
  autonomy_level TEXT NOT NULL DEFAULT 'high',
  risk_budget TEXT NOT NULL DEFAULT 'medium',
  knowledge_policy TEXT NOT NULL DEFAULT 'optional',
  available_rollback TEXT,
  verification_plan TEXT,
  guardrails TEXT NOT NULL DEFAULT '{}',
  unsupported_alternatives TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'completed',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS context_decision_runs_created_at_idx
  ON context_decision_runs(created_at);
CREATE INDEX IF NOT EXISTS context_decision_runs_decision_created_at_idx
  ON context_decision_runs(decision, created_at);
CREATE INDEX IF NOT EXISTS context_decision_runs_status_created_at_idx
  ON context_decision_runs(status, created_at);
CREATE INDEX IF NOT EXISTS context_decision_runs_session_created_at_idx
  ON context_decision_runs(session_id, created_at);

CREATE TABLE IF NOT EXISTS context_decision_evidence (
  id TEXT PRIMARY KEY,
  decision_run_id TEXT NOT NULL,
  knowledge_id TEXT,
  role TEXT NOT NULL,
  weight_at_decision INTEGER NOT NULL,
  dynamic_score_at_decision INTEGER,
  applicability_score INTEGER,
  temporal_relevance INTEGER,
  summary TEXT NOT NULL,
  source_refs TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (decision_run_id) REFERENCES context_decision_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS context_decision_evidence_decision_role_idx
  ON context_decision_evidence(decision_run_id, role);
CREATE INDEX IF NOT EXISTS context_decision_evidence_knowledge_role_idx
  ON context_decision_evidence(knowledge_id, role);

CREATE TABLE IF NOT EXISTS context_decision_coverage_traces (
  id TEXT PRIMARY KEY,
  decision_run_id TEXT NOT NULL,
  query TEXT NOT NULL,
  query_role TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '{}',
  hit_count INTEGER NOT NULL DEFAULT 0,
  max_similarity INTEGER,
  selected_knowledge_ids TEXT NOT NULL DEFAULT '[]',
  rejected_knowledge_ids TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (decision_run_id) REFERENCES context_decision_runs(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS context_decision_coverage_decision_role_idx
  ON context_decision_coverage_traces(decision_run_id, query_role);

CREATE TABLE IF NOT EXISTS context_decision_human_feedback (
  id TEXT PRIMARY KEY,
  decision_run_id TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (decision_run_id) REFERENCES context_decision_runs(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS context_decision_feedback (
  id TEXT PRIMARY KEY,
  decision_run_id TEXT NOT NULL,
  source TEXT NOT NULL,
  outcome TEXT NOT NULL,
  inferred_reason TEXT NOT NULL,
  affected_knowledge_ids TEXT NOT NULL DEFAULT '[]',
  suggested_adjustment TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (decision_run_id) REFERENCES context_decision_runs(id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS context_decision_feedback_run_idx
  ON context_decision_feedback(decision_run_id);
CREATE INDEX IF NOT EXISTS context_decision_feedback_outcome_created_at_idx
  ON context_decision_feedback(outcome, created_at);

CREATE TABLE IF NOT EXISTS context_decision_feedback_effects (
  id TEXT PRIMARY KEY,
  feedback_id TEXT,
  human_feedback_id TEXT,
  decision_run_id TEXT NOT NULL,
  knowledge_id TEXT,
  effect TEXT NOT NULL,
  amount INTEGER NOT NULL,
  reason TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'applied',
  applied_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (feedback_id) REFERENCES context_decision_feedback(id) ON DELETE CASCADE,
  FOREIGN KEY (human_feedback_id) REFERENCES context_decision_human_feedback(id) ON DELETE CASCADE,
  FOREIGN KEY (decision_run_id) REFERENCES context_decision_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (knowledge_id) REFERENCES knowledge_items(id) ON DELETE SET NULL
) STRICT;

CREATE INDEX IF NOT EXISTS context_decision_feedback_effects_run_status_idx
  ON context_decision_feedback_effects(decision_run_id, status);
CREATE INDEX IF NOT EXISTS context_decision_feedback_effects_knowledge_status_idx
  ON context_decision_feedback_effects(knowledge_id, status);

CREATE TABLE IF NOT EXISTS distillation_target_states (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  distillation_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  phase TEXT NOT NULL DEFAULT 'selected',
  priority_group TEXT NOT NULL,
  sort_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_retry_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  knowledge_ids TEXT NOT NULL DEFAULT '[]',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS distillation_target_states_status_idx
  ON distillation_target_states(status);

CREATE TABLE IF NOT EXISTS distillation_evidence_cache (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  query_text TEXT NOT NULL,
  url TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  excerpt TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS find_candidate_results (
  id TEXT PRIMARY KEY,
  target_state_id TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'selected',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS cover_evidence_results (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  type TEXT,
  title TEXT,
  body TEXT,
  importance REAL,
  confidence REAL,
  applies_to TEXT NOT NULL DEFAULT '{}',
  "references" TEXT NOT NULL DEFAULT '[]',
  duplicate_refs TEXT NOT NULL DEFAULT '[]',
  tool_events TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS finding_candidate_queue (
  id TEXT PRIMARY KEY,
  input_kind TEXT NOT NULL DEFAULT 'source_target',
  source_kind TEXT NOT NULL DEFAULT 'knowledge_candidate',
  source_key TEXT NOT NULL DEFAULT '',
  source_uri TEXT NOT NULL DEFAULT '',
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider_policy TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS episode_distiller_queue (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL DEFAULT 'vibe_memory',
  source_key TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider_policy TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS episode_distiller_queue_unique_idx
  ON episode_distiller_queue(source_kind, source_key, distillation_version);

CREATE INDEX IF NOT EXISTS episode_distiller_queue_status_priority_created_at_idx
  ON episode_distiller_queue(status, priority, created_at);

CREATE TABLE IF NOT EXISTS covering_evidence_queue (
  id TEXT PRIMARY KEY,
  found_candidate_id TEXT,
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider_policy TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS found_candidates (
  id TEXT PRIMARY KEY,
  finding_job_id TEXT NOT NULL,
  candidate_index INTEGER NOT NULL,
  type TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_summary TEXT,
  origin TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS finding_candidate_escalations (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  source_dedupe_key TEXT,
  primary_job_id TEXT,
  escalation_provider TEXT NOT NULL,
  escalation_model TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  output_summary TEXT,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

DROP INDEX IF EXISTS finding_candidate_escalations_source_provider_model_unique_idx;
CREATE UNIQUE INDEX IF NOT EXISTS finding_candidate_escalations_source_provider_model_unique_idx
  ON finding_candidate_escalations(source_kind, source_key, distillation_version, escalation_provider, escalation_model);
CREATE INDEX IF NOT EXISTS finding_candidate_escalations_source_dedupe_idx
  ON finding_candidate_escalations(source_dedupe_key);
CREATE INDEX IF NOT EXISTS finding_candidate_escalations_primary_job_idx
  ON finding_candidate_escalations(primary_job_id);

CREATE TABLE IF NOT EXISTS evidence_coverage_results (
  id TEXT PRIMARY KEY,
  found_candidate_id TEXT NOT NULL,
  producer_queue TEXT NOT NULL,
  producer_job_id TEXT NOT NULL,
  distillation_version TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  type TEXT,
  title TEXT,
  body TEXT,
  importance REAL,
  confidence REAL,
  applies_to TEXT NOT NULL DEFAULT '{}',
  "references" TEXT NOT NULL DEFAULT '[]',
  duplicate_refs TEXT NOT NULL DEFAULT '[]',
  tool_events TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

DROP INDEX IF EXISTS covering_evidence_queue_found_candidate_unique_idx;
DROP INDEX IF EXISTS evidence_coverage_results_found_candidate_producer_unique_idx;

CREATE INDEX IF NOT EXISTS covering_evidence_queue_found_candidate_idx
  ON covering_evidence_queue(found_candidate_id)
  WHERE found_candidate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS covering_evidence_queue_status_priority_created_at_idx
  ON covering_evidence_queue(status, priority, created_at);
CREATE INDEX IF NOT EXISTS evidence_coverage_results_found_candidate_producer_idx
  ON evidence_coverage_results(found_candidate_id, producer_queue);
CREATE INDEX IF NOT EXISTS evidence_coverage_results_status_idx
  ON evidence_coverage_results(status);

CREATE TRIGGER IF NOT EXISTS covering_evidence_queue_found_candidate_no_duplicate_insert
BEFORE INSERT ON covering_evidence_queue
WHEN NEW.found_candidate_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM covering_evidence_queue
    WHERE found_candidate_id = NEW.found_candidate_id
    LIMIT 1
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate covering_evidence_queue found_candidate_id');
END;

CREATE TRIGGER IF NOT EXISTS covering_evidence_queue_found_candidate_no_duplicate_update
BEFORE UPDATE OF found_candidate_id ON covering_evidence_queue
WHEN NEW.found_candidate_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM covering_evidence_queue
    WHERE found_candidate_id = NEW.found_candidate_id
      AND id <> NEW.id
    LIMIT 1
  )
BEGIN
  SELECT RAISE(ABORT, 'duplicate covering_evidence_queue found_candidate_id');
END;

CREATE TRIGGER IF NOT EXISTS evidence_coverage_results_producer_no_duplicate_insert
BEFORE INSERT ON evidence_coverage_results
WHEN EXISTS (
  SELECT 1
  FROM evidence_coverage_results
  WHERE found_candidate_id = NEW.found_candidate_id
    AND producer_queue = NEW.producer_queue
  LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate evidence_coverage_results producer');
END;

CREATE TRIGGER IF NOT EXISTS evidence_coverage_results_producer_no_duplicate_update
BEFORE UPDATE OF found_candidate_id, producer_queue ON evidence_coverage_results
WHEN EXISTS (
  SELECT 1
  FROM evidence_coverage_results
  WHERE found_candidate_id = NEW.found_candidate_id
    AND producer_queue = NEW.producer_queue
    AND id <> NEW.id
  LIMIT 1
)
BEGIN
  SELECT RAISE(ABORT, 'duplicate evidence_coverage_results producer');
END;

CREATE TABLE IF NOT EXISTS landscape_review_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  proposed_action TEXT NOT NULL DEFAULT 'review_only',
  priority INTEGER NOT NULL DEFAULT 50,
  confidence TEXT NOT NULL DEFAULT 'low',
  idempotency_key TEXT NOT NULL,
  knowledge_id TEXT,
  run_id TEXT,
  trigger_event_id TEXT,
  community_key TEXT,
  community_label TEXT,
  suggested_applies_to TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS landscape_review_item_candidate_links (
  id TEXT PRIMARY KEY,
  review_item_id TEXT NOT NULL,
  target_state_id TEXT,
  find_candidate_result_id TEXT,
  finding_job_id TEXT,
  found_candidate_id TEXT,
  evidence_result_id TEXT,
  legacy_target_state_id TEXT,
  legacy_find_candidate_result_id TEXT,
  candidate_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft_created',
  approval_note TEXT,
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS dead_zone_merge_review_queue (
  id TEXT PRIMARY KEY,
  review_item_id TEXT,
  dead_zone_knowledge_id TEXT,
  canonical_knowledge_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  payload TEXT NOT NULL DEFAULT '{}',
  input_snapshot TEXT NOT NULL DEFAULT '{}',
  result TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL DEFAULT 'local-llm',
  model TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS finalize_distille_queue (
  id TEXT PRIMARY KEY,
  evidence_result_id TEXT,
  distillation_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  metadata TEXT NOT NULL DEFAULT '{}',
  provider_policy TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  knowledge_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS merge_activation_finalize_queue (
  id TEXT PRIMARY KEY,
  merge_review_job_id TEXT,
  dead_zone_knowledge_id TEXT,
  canonical_knowledge_id TEXT,
  review_item_id TEXT,
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  payload TEXT NOT NULL DEFAULT '{}',
  input_snapshot TEXT NOT NULL DEFAULT '{}',
  activation_result TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  provider TEXT NOT NULL DEFAULT 'local-llm',
  model TEXT,
  knowledge_id TEXT,
  locked_by TEXT,
  locked_at TEXT,
  heartbeat_at TEXT,
  next_run_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  last_outcome_kind TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS distillation_queue_events (
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  queue_job_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  message TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS distillation_queue_events_job_idx
  ON distillation_queue_events(queue_name, queue_job_id, created_at);

CREATE TABLE IF NOT EXISTS security_candidate_batch_receipts (
  id TEXT PRIMARY KEY,
  receipt_ref TEXT NOT NULL UNIQUE,
  producer_principal TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  batch_ref TEXT NOT NULL,
  batch_payload_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(producer_principal, endpoint, contract_version, idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS security_candidate_batch_receipts_batch_digest_idx
  ON security_candidate_batch_receipts(batch_payload_digest);

CREATE TABLE IF NOT EXISTS security_candidate_batch_items (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES security_candidate_batch_receipts(id) ON DELETE CASCADE,
  candidate_ref TEXT NOT NULL,
  fingerprint TEXT,
  payload_digest TEXT,
  provenance_json TEXT,
  status TEXT NOT NULL,
  reason_code TEXT,
  target_state_ref TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(receipt_id, candidate_ref)
) STRICT;

CREATE INDEX IF NOT EXISTS security_candidate_batch_items_fingerprint_payload_idx
  ON security_candidate_batch_items(fingerprint, payload_digest);

CREATE TABLE IF NOT EXISTS security_feedback_batch_receipts (
  id TEXT PRIMARY KEY,
  receipt_ref TEXT NOT NULL UNIQUE,
  producer_principal TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  batch_ref TEXT NOT NULL,
  batch_payload_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(producer_principal, endpoint, contract_version, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS security_feedback_events (
  id TEXT PRIMARY KEY,
  event_ref TEXT NOT NULL UNIQUE,
  receipt_id TEXT NOT NULL REFERENCES security_feedback_batch_receipts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  knowledge_ref TEXT NOT NULL,
  knowledge_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE INDEX IF NOT EXISTS security_feedback_events_receipt_idx
  ON security_feedback_events(receipt_id);

CREATE TABLE IF NOT EXISTS distillation_queue_migration_map (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  legacy_target_state_id TEXT,
  legacy_find_candidate_result_id TEXT,
  legacy_cover_evidence_result_id TEXT,
  legacy_target_kind TEXT,
  legacy_target_key TEXT,
  distillation_version TEXT,
  finding_job_id TEXT,
  found_candidate_id TEXT,
  covering_job_id TEXT,
  evidence_result_id TEXT,
  finalize_job_id TEXT,
  migration_run_id TEXT,
  migration_status TEXT NOT NULL DEFAULT 'migrated',
  skip_reason TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;

CREATE TABLE IF NOT EXISTS landscape_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  params_hash TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
`;
}
