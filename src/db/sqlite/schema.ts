import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sqliteKnowledgeItems = sqliteTable(
  "knowledge_items",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    scope: text("scope").notNull().default("repo"),
    classificationStatus: text("classification_status").notNull().default("unresolved"),
    projectRef: text("project_ref"),
    repoKey: text("repo_key"),
    repoPath: text("repo_path"),
    polarity: text("polarity").notNull().default("positive"),
    intentTags: text("intent_tags", { mode: "json" }).$type<unknown[]>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    appliesTo: text("applies_to", { mode: "json" }).$type<unknown>().notNull(),
    confidence: real("confidence").notNull().default(70),
    importance: real("importance").notNull().default(70),
    compileSelectCount: integer("compile_select_count").notNull().default(0),
    lastCompiledAt: text("last_compiled_at"),
    agenticAcceptCount: integer("agentic_accept_count").notNull().default(0),
    explicitUpvoteCount: integer("explicit_upvote_count").notNull().default(0),
    explicitDownvoteCount: integer("explicit_downvote_count").notNull().default(0),
    dynamicScore: real("dynamic_score").notNull().default(0),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastVerifiedAt: text("last_verified_at"),
  },
  (table) => [
    index("knowledge_items_status_idx").on(table.status),
    index("knowledge_items_type_status_idx").on(table.type, table.status),
    index("knowledge_items_classification_status_idx").on(table.classificationStatus),
    index("knowledge_items_status_scope_project_ref_idx").on(
      table.status,
      table.scope,
      table.projectRef,
    ),
    index("knowledge_items_status_scope_repo_key_idx").on(table.status, table.scope, table.repoKey),
    index("knowledge_items_status_scope_repo_path_idx").on(
      table.status,
      table.scope,
      table.repoPath,
    ),
    index("knowledge_items_polarity_idx").on(table.polarity),
    index("knowledge_items_dynamic_score_idx").on(table.dynamicScore),
    index("knowledge_items_last_compiled_at_idx").on(table.lastCompiledAt),
  ],
);

export const sqliteKnowledgeTagDefinitions = sqliteTable(
  "knowledge_tag_definitions",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    aliases: text("aliases", { mode: "json" }).$type<unknown[]>().notNull(),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(1000),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [uniqueIndex("knowledge_tag_definitions_kind_slug_unique").on(table.kind, table.slug)],
);

export const sqliteKnowledgeCommunityLabels = sqliteTable("knowledge_community_labels", {
  communityKey: text("community_key").primaryKey(),
  label: text("label").notNull(),
  note: text("note"),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteKnowledgeQualityAdjustments = sqliteTable("knowledge_quality_adjustments", {
  id: text("id").primaryKey(),
  knowledgeId: text("knowledge_id")
    .notNull()
    .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
  adjustmentKind: text("adjustment_kind").notNull(),
  windowStartAt: text("window_start_at").notNull(),
  windowEndAt: text("window_end_at").notNull(),
  negativeRunCount: integer("negative_run_count").notNull(),
  offTopicRate: real("off_topic_rate").notNull(),
  importanceDelta: real("importance_delta").notNull(),
  confidenceDelta: real("confidence_delta").notNull(),
  createdAt: text("created_at").notNull(),
});

export const sqliteKnowledgeOriginLinks = sqliteTable(
  "knowledge_origin_links",
  {
    id: text("id").primaryKey(),
    knowledgeId: text("knowledge_id")
      .notNull()
      .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
    originKind: text("origin_kind").notNull(),
    originUri: text("origin_uri").notNull(),
    originKey: text("origin_key").notNull(),
    confidence: real("confidence").notNull().default(1.0),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("knowledge_origin_links_knowledge_kind_uri_unique").on(
      table.knowledgeId,
      table.originKind,
      table.originUri,
    ),
  ],
);

export const sqliteSources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    sourceKind: text("source_kind").notNull(),
    classificationStatus: text("classification_status").notNull().default("unresolved"),
    scope: text("scope").notNull().default("repo"),
    projectRef: text("project_ref"),
    repoKey: text("repo_key"),
    repoPath: text("repo_path"),
    uri: text("uri").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastIndexedAt: text("last_indexed_at"),
  },
  (table) => [
    index("sources_kind_idx").on(table.sourceKind),
    index("sources_classification_status_idx").on(table.classificationStatus),
    index("sources_scope_project_ref_idx").on(table.scope, table.projectRef),
    index("sources_scope_repo_key_idx").on(table.scope, table.repoKey),
    index("sources_scope_repo_path_idx").on(table.scope, table.repoPath),
    uniqueIndex("sources_uri_unique_idx").on(table.uri),
  ],
);

export const sqliteProjectIdentityAliases = sqliteTable(
  "project_identity_aliases",
  {
    id: text("id").primaryKey(),
    projectRef: text("project_ref").notNull(),
    aliasKind: text("alias_kind").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_identity_aliases_project_alias_unique").on(
      table.projectRef,
      table.aliasKind,
      table.normalizedValue,
    ),
    uniqueIndex("project_identity_aliases_active_alias_unique")
      .on(table.aliasKind, table.normalizedValue)
      .where(sql`${table.status} = 'active'`),
    index("project_identity_aliases_project_status_idx").on(table.projectRef, table.status),
  ],
);

export const sqliteRepositoryIdentityMigrationAudits = sqliteTable(
  "repository_identity_migration_audits",
  {
    id: text("id").primaryKey(),
    migrationVersion: text("migration_version").notNull(),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    beforeFingerprint: text("before_fingerprint").notNull(),
    afterFingerprint: text("after_fingerprint").notNull(),
    reasonCode: text("reason_code").notNull(),
    provenanceSource: text("provenance_source").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("repository_identity_migration_audits_replay_unique_idx").on(
      table.migrationVersion,
      table.entityKind,
      table.entityId,
      table.afterFingerprint,
    ),
    index("repository_identity_migration_audits_version_outcome_idx").on(
      table.migrationVersion,
      table.outcome,
    ),
    index("repository_identity_migration_audits_entity_idx").on(table.entityKind, table.entityId),
  ],
);

export const sqliteSourceFragments = sqliteTable(
  "source_fragments",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sqliteSources.id, { onDelete: "cascade" }),
    locator: text("locator").notNull(),
    heading: text("heading"),
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("source_fragments_source_id_idx").on(table.sourceId),
    uniqueIndex("source_fragments_source_locator_unique").on(table.sourceId, table.locator),
  ],
);

export const sqliteKnowledgeSourceLinks = sqliteTable(
  "knowledge_source_links",
  {
    id: text("id").primaryKey(),
    knowledgeId: text("knowledge_id")
      .notNull()
      .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
    sourceFragmentId: text("source_fragment_id")
      .notNull()
      .references(() => sqliteSourceFragments.id, { onDelete: "cascade" }),
    linkType: text("link_type").notNull().default("derived_from"),
    confidence: real("confidence").notNull().default(0.5),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("knowledge_source_links_knowledge_idx").on(table.knowledgeId),
    index("knowledge_source_links_source_fragment_idx").on(table.sourceFragmentId),
  ],
);

export const sqliteCoreVectorMetadata = sqliteTable("core_vector_metadata", {
  name: text("name").primaryKey(),
  dimension: integer("dimension").notNull(),
  provider: text("provider"),
  model: text("model"),
  rebuiltAt: text("rebuilt_at"),
  rowCount: integer("row_count").notNull().default(0),
  usesSqliteVec: integer("uses_sqlite_vec", { mode: "boolean" }).notNull().default(false),
});

export const sqliteKnowledgeItemsVecMap = sqliteTable("knowledge_items_vec_map", {
  vecRowid: integer("vec_rowid").primaryKey({ autoIncrement: true }),
  knowledgeId: text("knowledge_id")
    .notNull()
    .unique()
    .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
});

export const sqliteKnowledgeItemsVecFallback = sqliteTable("knowledge_items_vec_fallback", {
  knowledgeId: text("knowledge_id")
    .primaryKey()
    .references(() => sqliteKnowledgeItems.id, { onDelete: "cascade" }),
  embeddingJson: text("embedding_json").notNull(),
  embeddingDimension: integer("embedding_dimension").notNull(),
  contentHash: text("content_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteSourceFragmentsVecMap = sqliteTable("source_fragments_vec_map", {
  vecRowid: integer("vec_rowid").primaryKey({ autoIncrement: true }),
  sourceFragmentId: text("source_fragment_id")
    .notNull()
    .unique()
    .references(() => sqliteSourceFragments.id, { onDelete: "cascade" }),
});

export const sqliteSourceFragmentsVecFallback = sqliteTable("source_fragments_vec_fallback", {
  sourceFragmentId: text("source_fragment_id")
    .primaryKey()
    .references(() => sqliteSourceFragments.id, { onDelete: "cascade" }),
  embeddingJson: text("embedding_json").notNull(),
  embeddingDimension: integer("embedding_dimension").notNull(),
  contentHash: text("content_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sqliteEpisodeCards = sqliteTable(
  "episode_cards",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    situation: text("situation").notNull(),
    observations: text("observations").notNull().default(""),
    action: text("action").notNull().default(""),
    outcome: text("outcome").notNull().default(""),
    lesson: text("lesson").notNull().default(""),
    applicability: text("applicability", { mode: "json" }).$type<unknown>().notNull(),
    antiApplicability: text("anti_applicability", { mode: "json" }).$type<unknown>().notNull(),
    domains: text("domains", { mode: "json" }).$type<unknown[]>().notNull(),
    technologies: text("technologies", { mode: "json" }).$type<unknown[]>().notNull(),
    changeTypes: text("change_types", { mode: "json" }).$type<unknown[]>().notNull(),
    tools: text("tools", { mode: "json" }).$type<unknown[]>().notNull(),
    classificationStatus: text("classification_status").notNull().default("unresolved"),
    scope: text("scope").notNull().default("repo"),
    projectRef: text("project_ref"),
    repoPath: text("repo_path"),
    repoKey: text("repo_key"),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    outcomeKind: text("outcome_kind").notNull().default("unknown"),
    importance: integer("importance").notNull().default(50),
    confidence: integer("confidence").notNull().default(50),
    compileUseCount: integer("compile_use_count").notNull().default(0),
    decisionUseCount: integer("decision_use_count").notNull().default(0),
    status: text("status").notNull().default("active"),
    staleAt: text("stale_at"),
    embedding: text("embedding"),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("episode_cards_source_unique_idx").on(table.sourceKind, table.sourceKey),
    index("episode_cards_status_idx").on(table.status),
    index("episode_cards_classification_status_idx").on(table.classificationStatus),
    index("episode_cards_scope_project_ref_idx").on(table.scope, table.projectRef),
    index("episode_cards_repo_key_idx").on(table.repoKey),
    index("episode_cards_repo_path_idx").on(table.repoPath),
    index("episode_cards_outcome_kind_idx").on(table.outcomeKind),
    index("episode_cards_created_at_idx").on(table.createdAt),
  ],
);

export const sqliteEpisodeRefs = sqliteTable(
  "episode_refs",
  {
    id: text("id").primaryKey(),
    episodeCardId: text("episode_card_id")
      .notNull()
      .references(() => sqliteEpisodeCards.id, { onDelete: "cascade" }),
    refKind: text("ref_kind").notNull(),
    refValue: text("ref_value").notNull(),
    locator: text("locator"),
    queryHint: text("query_hint"),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("episode_refs_episode_card_id_idx").on(table.episodeCardId),
    index("episode_refs_kind_value_idx").on(table.refKind, table.refValue),
  ],
);

export const sqliteEpisodeRetrievalFeedback = sqliteTable(
  "episode_retrieval_feedback",
  {
    id: text("id").primaryKey(),
    episodeCardId: text("episode_card_id")
      .notNull()
      .references(() => sqliteEpisodeCards.id, { onDelete: "cascade" }),
    runKind: text("run_kind").notNull(),
    runId: text("run_id").notNull(),
    usedFor: text("used_for").notNull(),
    verdict: text("verdict").notNull(),
    reason: text("reason"),
    metadata: text("metadata", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("episode_retrieval_feedback_episode_run_idx").on(
      table.episodeCardId,
      table.runKind,
      table.runId,
    ),
    index("episode_retrieval_feedback_verdict_created_at_idx").on(table.verdict, table.createdAt),
  ],
);
