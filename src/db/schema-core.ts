import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { groupedConfig } from "../config.js";
import {
  auditLogActorValues,
  episodeCardStatusValues,
  episodeOutcomeKindValues,
  episodeRefKindValues,
  episodeRetrievalRunKindValues,
  episodeRetrievalUsedForValues,
  episodeRetrievalVerdictValues,
  episodeSourceKindValues,
  projectClassificationStatusValues,
  scopeValues,
  settingValueKindValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const vibeMigrationRuns = pgTable("vibe_migration_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  fromTable: text("from_table").notNull(),
  deletedCount: integer("deleted_count").notNull(),
  preservedTables: jsonb("preserved_tables").default([]).notNull(),
  executedAt: timestamp("executed_at").defaultNow().notNull(),
  appVersion: text("app_version").notNull(),
});

export const vibeGoals = pgTable("vibe_goals", {
  id: text("id").primaryKey(), // SHA-256 ハッシュ値。JOIN 用
  goalUri: text("goal_uri").notNull().unique(),
  goalAnchorRef: text("goal_anchor_ref").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const vibeMemories = pgTable(
  "vibe_memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id").notNull(),
    content: text("content").notNull(),
    memoryType: text("memory_type").notNull().default("chat"),
    dedupeKey: text("dedupe_key"),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // Legacy capsule columns retained for historical Vibe Memory rows.
    goalId: text("goal_id").references(() => vibeGoals.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id").references((): any => vibeMemories.id, { onDelete: "cascade" }),
    subject: text("subject"),
    intent: text("intent"),
    wants: jsonb("wants").default([]).notNull(),
    refs: jsonb("refs").default([]).notNull(),
    confidence: text("confidence"),
    evidenceStatus: text("evidence_status"),
    actorId: text("actor_id"),
    ttlAt: timestamp("ttl_at"),
  },
  (table) => ({
    sessionIdIdx: index("vibe_memories_session_id_idx").on(table.sessionId),
    memoryTypeIdx: index("vibe_memories_memory_type_idx").on(table.memoryType),
    sessionDedupeKeyIdx: uniqueIndex("vibe_memories_session_dedupe_key_idx").on(
      table.sessionId,
      table.dedupeKey,
    ),
    contentFtsIdx: index("vibe_memories_content_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', ${table.content})`,
    ),
    embeddingHnswIdx: index("vibe_memories_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    // Legacy capsule indexes retained until a separate physical cleanup migration.
    goalIdIdx: index("vibe_memories_goal_id_idx").on(table.goalId),
    parentIdIdx: index("vibe_memories_parent_id_idx").on(table.parentId),
    intentIdx: index("vibe_memories_intent_idx").on(table.intent),
  }),
);

export const vibeMemoryMarks = pgTable(
  "vibe_memory_marks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goalId: text("goal_id")
      .references(() => vibeGoals.id, { onDelete: "cascade" })
      .notNull(),
    targetMemoryId: uuid("target_memory_id")
      .references(() => vibeMemories.id, { onDelete: "cascade" })
      .notNull(),
    mark: text("mark").notNull(),
    note: text("note"),
    actorId: text("actor_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    goalIdIdx: index("vibe_memory_marks_goal_id_idx").on(table.goalId),
    targetMemoryIdIdx: index("vibe_memory_marks_target_memory_id_idx").on(table.targetMemoryId),
    markIdx: index("vibe_memory_marks_mark_idx").on(table.mark),
  }),
);

export const syncStates = pgTable("sync_states", {
  id: text("id").primaryKey(),
  lastSyncedAt: timestamp("last_synced_at").defaultNow().notNull(),
  cursor: jsonb("cursor").default({}).notNull(),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const settings = pgTable(
  "settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull().default({}),
    valueKind: text("value_kind").notNull().default("json"),
    secretRef: text("secret_ref"),
    isSecret: boolean("is_secret").notNull().default(false),
    description: text("description"),
    schemaVersion: integer("schema_version").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    updatedBy: text("updated_by"),
  },
  (table) => ({
    namespaceKeyUniqueIdx: uniqueIndex("settings_namespace_key_unique_idx").on(
      table.namespace,
      table.key,
    ),
    namespaceIdx: index("settings_namespace_idx").on(table.namespace),
    keyIdx: index("settings_key_idx").on(table.key),
    valueKindCheck: check(
      "settings_value_kind_check",
      sql`${table.valueKind} IN (${sql.raw(toSqlList(settingValueKindValues))})`,
    ),
  }),
);

export const agentDiffEntries = pgTable(
  "agent_diff_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vibeMemoryId: uuid("vibe_memory_id")
      .references(() => vibeMemories.id, {
        onDelete: "cascade",
      })
      .notNull(),
    filePath: text("file_path").notNull(),
    diffHunk: text("diff_hunk").notNull(),
    changeType: text("change_type"),
    language: text("language"),
    symbolName: text("symbol_name"),
    symbolKind: text("symbol_kind"),
    signature: text("signature"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    vibeMemoryIdIdx: index("agent_diff_entries_vibe_memory_id_idx").on(table.vibeMemoryId),
    filePathIdx: index("agent_diff_entries_file_path_idx").on(table.filePath),
    symbolIdx: index("agent_diff_entries_symbol_idx").on(table.symbolName, table.symbolKind),
    lineRangeIdx: index("agent_diff_entries_line_range_idx").on(table.startLine, table.endLine),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    eventTypeIdx: index("audit_logs_event_type_idx").on(table.eventType),
    actorIdx: index("audit_logs_actor_idx").on(table.actor),
    createdAtIdx: index("audit_logs_created_at_idx").on(table.createdAt),
    actorCheck: check(
      "audit_logs_actor_check",
      sql`${table.actor} IN (${sql.raw(toSqlList(auditLogActorValues))})`,
    ),
  }),
);

export const episodeCards = pgTable(
  "episode_cards",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    situation: text("situation").notNull(),
    observations: text("observations").notNull().default(""),
    action: text("action").notNull().default(""),
    outcome: text("outcome").notNull().default(""),
    lesson: text("lesson").notNull().default(""),
    applicability: jsonb("applicability").default({}).notNull(),
    antiApplicability: jsonb("anti_applicability").default({}).notNull(),
    domains: jsonb("domains").default([]).notNull(),
    technologies: jsonb("technologies").default([]).notNull(),
    changeTypes: jsonb("change_types").default([]).notNull(),
    tools: jsonb("tools").default([]).notNull(),
    classificationStatus: text("classification_status").notNull().default("unresolved"),
    scope: text("scope").notNull().default("repo"),
    projectRef: text("project_ref"),
    repoPath: text("repo_path"),
    repoKey: text("repo_key"),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    outcomeKind: text("outcome_kind").notNull().default("unknown"),
    importance: integer("importance").default(50).notNull(),
    confidence: integer("confidence").default(50).notNull(),
    compileUseCount: integer("compile_use_count").default(0).notNull(),
    decisionUseCount: integer("decision_use_count").default(0).notNull(),
    status: text("status").notNull().default("active"),
    staleAt: timestamp("stale_at"),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("episode_cards_status_idx").on(table.status),
    classificationStatusIdx: index("episode_cards_classification_status_idx").on(
      table.classificationStatus,
    ),
    projectRefScopeIdx: index("episode_cards_scope_project_ref_idx").on(
      table.scope,
      table.projectRef,
    ),
    sourceUniqueIdx: uniqueIndex("episode_cards_source_unique_idx").on(
      table.sourceKind,
      table.sourceKey,
    ),
    repoKeyIdx: index("episode_cards_repo_key_idx").on(table.repoKey),
    repoPathIdx: index("episode_cards_repo_path_idx").on(table.repoPath),
    outcomeKindIdx: index("episode_cards_outcome_kind_idx").on(table.outcomeKind),
    createdAtIdx: index("episode_cards_created_at_idx").on(table.createdAt),
    textFtsIdx: index("episode_cards_text_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.title}, '') || ' ' || coalesce(${table.situation}, '') || ' ' || coalesce(${table.observations}, '') || ' ' || coalesce(${table.action}, '') || ' ' || coalesce(${table.outcome}, '') || ' ' || coalesce(${table.lesson}, ''))`,
    ),
    embeddingHnswIdx: index("episode_cards_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    statusCheck: check(
      "episode_cards_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(episodeCardStatusValues))})`,
    ),
    classificationStatusCheck: check(
      "episode_cards_classification_status_check",
      sql`${table.classificationStatus} IN (${sql.raw(
        toSqlList(projectClassificationStatusValues),
      )})`,
    ),
    scopeCheck: check(
      "episode_cards_scope_check",
      sql`${table.scope} IN (${sql.raw(toSqlList(scopeValues))})`,
    ),
    outcomeKindCheck: check(
      "episode_cards_outcome_kind_check",
      sql`${table.outcomeKind} IN (${sql.raw(toSqlList(episodeOutcomeKindValues))})`,
    ),
    sourceKindCheck: check(
      "episode_cards_source_kind_check",
      sql`${table.sourceKind} IN (${sql.raw(toSqlList(episodeSourceKindValues))})`,
    ),
    confidenceRangeCheck: check(
      "episode_cards_confidence_range_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 100`,
    ),
    importanceRangeCheck: check(
      "episode_cards_importance_range_check",
      sql`${table.importance} >= 0 and ${table.importance} <= 100`,
    ),
    compileUseCountRangeCheck: check(
      "episode_cards_compile_use_count_range_check",
      sql`${table.compileUseCount} >= 0`,
    ),
    decisionUseCountRangeCheck: check(
      "episode_cards_decision_use_count_range_check",
      sql`${table.decisionUseCount} >= 0`,
    ),
    applicabilityObjectCheck: check(
      "episode_cards_applicability_object_check",
      sql`jsonb_typeof(${table.applicability}) = 'object'`,
    ),
    antiApplicabilityObjectCheck: check(
      "episode_cards_anti_applicability_object_check",
      sql`jsonb_typeof(${table.antiApplicability}) = 'object'`,
    ),
    domainsArrayCheck: check(
      "episode_cards_domains_array_check",
      sql`jsonb_typeof(${table.domains}) = 'array'`,
    ),
    technologiesArrayCheck: check(
      "episode_cards_technologies_array_check",
      sql`jsonb_typeof(${table.technologies}) = 'array'`,
    ),
    changeTypesArrayCheck: check(
      "episode_cards_change_types_array_check",
      sql`jsonb_typeof(${table.changeTypes}) = 'array'`,
    ),
    toolsArrayCheck: check(
      "episode_cards_tools_array_check",
      sql`jsonb_typeof(${table.tools}) = 'array'`,
    ),
  }),
);

export const episodeRefs = pgTable(
  "episode_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeCardId: uuid("episode_card_id")
      .references(() => episodeCards.id, { onDelete: "cascade" })
      .notNull(),
    refKind: text("ref_kind").notNull(),
    refValue: text("ref_value").notNull(),
    locator: text("locator"),
    queryHint: text("query_hint"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    episodeCardIdIdx: index("episode_refs_episode_card_id_idx").on(table.episodeCardId),
    refKindValueIdx: index("episode_refs_kind_value_idx").on(table.refKind, table.refValue),
    refKindCheck: check(
      "episode_refs_ref_kind_check",
      sql`${table.refKind} IN (${sql.raw(toSqlList(episodeRefKindValues))})`,
    ),
  }),
);

export const episodeRetrievalFeedback = pgTable(
  "episode_retrieval_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    episodeCardId: uuid("episode_card_id")
      .references(() => episodeCards.id, { onDelete: "cascade" })
      .notNull(),
    runKind: text("run_kind").notNull(),
    runId: text("run_id").notNull(),
    usedFor: text("used_for").notNull(),
    verdict: text("verdict").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    episodeRunIdx: index("episode_retrieval_feedback_episode_run_idx").on(
      table.episodeCardId,
      table.runKind,
      table.runId,
    ),
    verdictCreatedAtIdx: index("episode_retrieval_feedback_verdict_created_at_idx").on(
      table.verdict,
      table.createdAt,
    ),
    runKindCheck: check(
      "episode_retrieval_feedback_run_kind_check",
      sql`${table.runKind} IN (${sql.raw(toSqlList(episodeRetrievalRunKindValues))})`,
    ),
    usedForCheck: check(
      "episode_retrieval_feedback_used_for_check",
      sql`${table.usedFor} IN (${sql.raw(toSqlList(episodeRetrievalUsedForValues))})`,
    ),
    verdictCheck: check(
      "episode_retrieval_feedback_verdict_check",
      sql`${table.verdict} IN (${sql.raw(toSqlList(episodeRetrievalVerdictValues))})`,
    ),
  }),
);
