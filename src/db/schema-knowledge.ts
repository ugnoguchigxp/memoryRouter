import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { groupedConfig } from "../config.js";
import {
  knowledgeOriginLinkKindValues,
  knowledgePolarityValues,
  knowledgeQualityAdjustmentKindValues,
  knowledgeStatusValues,
  knowledgeTagKindValues,
  knowledgeTagStatusValues,
  knowledgeTypeValues,
  projectClassificationStatusValues,
  scopeValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    status: text("status").notNull(),
    scope: text("scope").notNull().default("repo"),
    classificationStatus: text("classification_status").notNull().default("unresolved"),
    projectRef: text("project_ref"),
    repoKey: text("repo_key"),
    repoPath: text("repo_path"),
    polarity: text("polarity").notNull().default("positive"),
    intentTags: jsonb("intent_tags").notNull().default("[]"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    appliesTo: jsonb("applies_to").default({}).notNull(),
    confidence: real("confidence").default(70).notNull(),
    importance: real("importance").default(70).notNull(),
    compileSelectCount: integer("compile_select_count").default(0).notNull(),
    lastCompiledAt: timestamp("last_compiled_at"),
    agenticAcceptCount: integer("agentic_accept_count").default(0).notNull(),
    explicitUpvoteCount: integer("explicit_upvote_count").default(0).notNull(),
    explicitDownvoteCount: integer("explicit_downvote_count").default(0).notNull(),
    dynamicScore: real("dynamic_score").default(0).notNull(),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
  },
  (table) => ({
    typeIdx: index("knowledge_items_type_idx").on(table.type),
    statusIdx: index("knowledge_items_status_idx").on(table.status),
    scopeIdx: index("knowledge_items_scope_idx").on(table.scope),
    classificationStatusIdx: index("knowledge_items_classification_status_idx").on(
      table.classificationStatus,
    ),
    projectRefScopeIdx: index("knowledge_items_status_scope_project_ref_idx").on(
      table.status,
      table.scope,
      table.projectRef,
    ),
    repoKeyScopeIdx: index("knowledge_items_status_scope_repo_key_idx").on(
      table.status,
      table.scope,
      table.repoKey,
    ),
    repoPathScopeIdx: index("knowledge_items_status_scope_repo_path_idx").on(
      table.status,
      table.scope,
      table.repoPath,
    ),
    polarityIdx: index("knowledge_items_polarity_idx").on(table.polarity),
    intentTagsGinIdx: index("knowledge_items_intent_tags_gin_idx").using("gin", table.intentTags),
    statusPolarityIdx: index("knowledge_items_status_polarity_idx").on(
      table.status,
      table.polarity,
    ),
    typeStatusIdx: index("knowledge_items_type_status_idx").on(table.type, table.status),
    appliesToRepoKeyIdx: index("knowledge_items_applies_to_repo_key_idx").on(
      sql`${table.appliesTo} ->> 'repoKey'`,
    ),
    appliesToRepoPathIdx: index("knowledge_items_applies_to_repo_path_idx").on(
      sql`${table.appliesTo} ->> 'repoPath'`,
    ),
    appliesToGinIdx: index("knowledge_items_applies_to_gin_idx").using("gin", table.appliesTo),
    coverEvidenceResultIdIdx: index("knowledge_items_cover_evidence_result_id_idx").on(
      sql`${table.metadata} ->> 'coverEvidenceResultId'`,
    ),
    metadataSourceUriIdx: index("knowledge_items_metadata_source_uri_idx").on(
      sql`${table.metadata} ->> 'sourceUri'`,
    ),
    lastCompiledAtIdx: index("knowledge_items_last_compiled_at_idx").on(table.lastCompiledAt),
    dynamicScoreIdx: index("knowledge_items_dynamic_score_idx").on(table.dynamicScore),
    titleBodyFtsIdx: index("knowledge_items_title_body_fts_idx").using(
      "gin",
      sql`to_tsvector('simple', coalesce(${table.title}, '') || ' ' || coalesce(${table.body}, ''))`,
    ),
    embeddingHnswIdx: index("knowledge_items_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops"),
    ),
    typeCheck: check(
      "knowledge_items_type_check",
      sql`${table.type} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
    statusCheck: check(
      "knowledge_items_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(knowledgeStatusValues))})`,
    ),
    scopeCheck: check(
      "knowledge_items_scope_check",
      sql`${table.scope} IN (${sql.raw(toSqlList(scopeValues))})`,
    ),
    classificationStatusCheck: check(
      "knowledge_items_classification_status_check",
      sql`${table.classificationStatus} IN (${sql.raw(
        toSqlList(projectClassificationStatusValues),
      )})`,
    ),
    polarityCheck: check(
      "knowledge_items_polarity_check",
      sql`${table.polarity} IN (${sql.raw(toSqlList(knowledgePolarityValues))})`,
    ),
  }),
);

export const knowledgeCommunityLabels = pgTable(
  "knowledge_community_labels",
  {
    communityKey: text("community_key").primaryKey(),
    label: text("label").notNull(),
    note: text("note"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    updatedAtIdx: index("knowledge_community_labels_updated_at_idx").on(table.updatedAt),
  }),
);

export const knowledgeTagDefinitions = pgTable(
  "knowledge_tag_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    aliases: jsonb("aliases").default([]).notNull(),
    status: text("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(1000),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    kindStatusIdx: index("knowledge_tag_definitions_kind_status_idx").on(table.kind, table.status),
    aliasesGinIdx: index("knowledge_tag_definitions_aliases_gin_idx").using("gin", table.aliases),
    kindSlugUniqueIdx: uniqueIndex("knowledge_tag_definitions_kind_slug_unique").on(
      table.kind,
      table.slug,
    ),
    kindCheck: check(
      "knowledge_tag_definitions_kind_check",
      sql`${table.kind} IN (${sql.raw(toSqlList(knowledgeTagKindValues))})`,
    ),
    statusCheck: check(
      "knowledge_tag_definitions_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(knowledgeTagStatusValues))})`,
    ),
  }),
);

export const knowledgeQualityAdjustments = pgTable(
  "knowledge_quality_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    adjustmentKind: text("adjustment_kind").notNull(),
    windowStartAt: timestamp("window_start_at").notNull(),
    windowEndAt: timestamp("window_end_at").notNull(),
    negativeRunCount: integer("negative_run_count").notNull(),
    offTopicRate: real("off_topic_rate").notNull(),
    importanceDelta: real("importance_delta").notNull(),
    confidenceDelta: real("confidence_delta").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    knowledgeKindCreatedAtIdx: index(
      "knowledge_quality_adjustments_knowledge_kind_created_at_idx",
    ).on(table.knowledgeId, table.adjustmentKind, table.createdAt),
    createdAtIdx: index("knowledge_quality_adjustments_created_at_idx").on(table.createdAt),
    adjustmentKindCheck: check(
      "knowledge_quality_adjustments_adjustment_kind_check",
      sql`${table.adjustmentKind} IN (${sql.raw(toSqlList(knowledgeQualityAdjustmentKindValues))})`,
    ),
  }),
);

export const knowledgeOriginLinks = pgTable(
  "knowledge_origin_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    originKind: text("origin_kind").notNull(),
    originUri: text("origin_uri").notNull(),
    originKey: text("origin_key").notNull(),
    confidence: real("confidence").default(1.0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    knowledgeIdIdx: index("knowledge_origin_links_knowledge_id_idx").on(table.knowledgeId),
    originKindIdx: index("knowledge_origin_links_origin_kind_idx").on(table.originKind),
    originKindUriUniqueIdx: uniqueIndex("knowledge_origin_links_knowledge_kind_uri_unique").on(
      table.knowledgeId,
      table.originKind,
      table.originUri,
    ),
    originKindCheck: check(
      "knowledge_origin_links_origin_kind_check",
      sql`${table.originKind} IN (${sql.raw(toSqlList(knowledgeOriginLinkKindValues))})`,
    ),
  }),
);
