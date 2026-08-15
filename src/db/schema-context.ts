import { sql } from "drizzle-orm";
import {
  boolean,
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
import { knowledgeItems } from "./schema-knowledge.js";
import {
  auditLogActorValues,
  compileEvalOutcomeValues,
  compileProjectBindingStatusValues,
  compileProjectIdentityTrustValues,
  compileProjectMatchBasisValues,
  compileProjectScopeModeValues,
  compileRunSourceValues,
  contextCompileCandidateTraceAgenticDecisionValues,
  contextCompileTaskTraceEmbeddingStatusValues,
  contextDecisionAutonomyLevelValues,
  contextDecisionCoverageQueryRoleValues,
  contextDecisionEffectValues,
  contextDecisionEvidenceRoleValues,
  contextDecisionFeedbackEffectStatusValues,
  contextDecisionFeedbackOutcomeValues,
  contextDecisionFeedbackSourceValues,
  contextDecisionHumanFeedbackValues,
  contextDecisionKnowledgePolicyValues,
  contextDecisionRiskBudgetValues,
  contextDecisionStatusValues,
  contextDecisionValues,
  knowledgeReviewProposedActionValues,
  knowledgeReviewQueueStatusValues,
  knowledgeTypeValues,
  knowledgeUsageVerdictValues,
  packSectionValues,
  projectIdentityAliasKindValues,
  projectIdentityAliasStatusValues,
  runStatusValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const contextCompileRuns = pgTable(
  "context_compile_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    goal: text("goal").notNull(),
    intent: text("intent").notNull(),
    sessionId: text("session_id"),
    projectRef: text("project_ref"),
    repoKey: text("repo_key"),
    repoPath: text("repo_path"),
    matchBasis: text("match_basis").notNull().default("none"),
    identityContractVersion: integer("identity_contract_version").notNull().default(1),
    scopeMode: text("scope_mode").notNull().default("global_only"),
    input: jsonb("input").notNull().default({}),
    retrievalMode: text("retrieval_mode").notNull(),
    status: text("status").notNull(),
    degradedReasons: jsonb("degraded_reasons").notNull().default([]),
    tokenBudget: integer("token_budget").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    source: text("source").notNull().default("unknown"),
    packSnapshot: jsonb("pack_snapshot"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    statusIdx: index("context_compile_runs_status_idx").on(table.status),
    createdAtIdx: index("context_compile_runs_created_at_idx").on(table.createdAt),
    sessionCreatedAtIdx: index("context_compile_runs_session_created_at_idx")
      .on(table.sessionId, table.createdAt)
      .where(sql`${table.sessionId} is not null`),
    sourceIdx: index("context_compile_runs_source_idx").on(table.source),
    projectRefIdx: index("context_compile_runs_project_ref_idx").on(table.projectRef),
    repoKeyIdx: index("context_compile_runs_repo_key_idx").on(table.repoKey),
    repoPathIdx: index("context_compile_runs_repo_path_idx").on(table.repoPath),
    statusCheck: check(
      "context_compile_runs_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(runStatusValues))})`,
    ),
    sourceCheck: check(
      "context_compile_runs_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(compileRunSourceValues))})`,
    ),
    matchBasisCheck: check(
      "context_compile_runs_match_basis_check",
      sql`${table.matchBasis} IN (${sql.raw(toSqlList(compileProjectMatchBasisValues))})`,
    ),
    scopeModeCheck: check(
      "context_compile_runs_scope_mode_check",
      sql`${table.scopeMode} IN (${sql.raw(toSqlList(compileProjectScopeModeValues))})`,
    ),
  }),
);

export const projectIdentityAliases = pgTable(
  "project_identity_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectRef: text("project_ref").notNull(),
    aliasKind: text("alias_kind").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    status: text("status").notNull().default("active"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    projectAliasUnique: uniqueIndex("project_identity_aliases_project_alias_unique").on(
      table.projectRef,
      table.aliasKind,
      table.normalizedValue,
    ),
    activeAliasUnique: uniqueIndex("project_identity_aliases_active_alias_unique")
      .on(table.aliasKind, table.normalizedValue)
      .where(sql`${table.status} = 'active'`),
    projectStatusIdx: index("project_identity_aliases_project_status_idx").on(
      table.projectRef,
      table.status,
    ),
    aliasKindCheck: check(
      "project_identity_aliases_alias_kind_check",
      sql`${table.aliasKind} IN (${sql.raw(toSqlList(projectIdentityAliasKindValues))})`,
    ),
    statusCheck: check(
      "project_identity_aliases_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(projectIdentityAliasStatusValues))})`,
    ),
  }),
);

export const repositoryIdentityMigrationAudits = pgTable(
  "repository_identity_migration_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    migrationVersion: text("migration_version").notNull(),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    beforeFingerprint: text("before_fingerprint").notNull(),
    afterFingerprint: text("after_fingerprint").notNull(),
    reasonCode: text("reason_code").notNull(),
    provenanceSource: text("provenance_source").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    replayUnique: uniqueIndex("repository_identity_migration_audits_replay_unique_idx").on(
      table.migrationVersion,
      table.entityKind,
      table.entityId,
      table.afterFingerprint,
    ),
    versionOutcomeIdx: index("repository_identity_migration_audits_version_outcome_idx").on(
      table.migrationVersion,
      table.outcome,
    ),
    entityIdx: index("repository_identity_migration_audits_entity_idx").on(
      table.entityKind,
      table.entityId,
    ),
    entityKindCheck: check(
      "repository_identity_migration_audits_entity_kind_check",
      sql`${table.entityKind} IN ('knowledge','source','episode')`,
    ),
    outcomeCheck: check(
      "repository_identity_migration_audits_outcome_check",
      sql`${table.outcome} IN ('backfilled','unresolved','conflict','malformed','global_promoted')`,
    ),
  }),
);

export const contextCompileEvals = pgTable(
  "context_compile_evals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    sessionId: text("session_id"),
    avg: integer("score").notNull(),
    outcome: text("outcome").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    source: text("source").notNull().default("mcp"),
    metadata: jsonb("metadata").notNull().default({}),
    relevance: integer("relevance"),
    actionability: integer("actionability"),
    coverage: integer("coverage"),
    clarity: integer("clarity"),
    specificity: integer("specificity"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runCreatedAtIdx: index("context_compile_evals_run_created_at_idx").on(
      table.runId,
      table.createdAt,
    ),
    sessionCreatedAtIdx: index("context_compile_evals_session_created_at_idx")
      .on(table.sessionId, table.createdAt)
      .where(sql`${table.sessionId} is not null`),
    outcomeCreatedAtIdx: index("context_compile_evals_outcome_created_at_idx").on(
      table.outcome,
      table.createdAt,
    ),
    scoreRangeCheck: check(
      "context_compile_evals_score_range_check",
      sql`${table.avg} >= 0 and ${table.avg} <= 100`,
    ),
    outcomeCheck: check(
      "context_compile_evals_outcome_check",
      sql`${table.outcome} IN (${sql.raw(toSqlList(compileEvalOutcomeValues))})`,
    ),
    sourceCheck: check(
      "context_compile_evals_source_check",
      sql`${table.source} IN ('mcp', 'ui', 'system', 'import')`,
    ),
    bodyLengthCheck: check(
      "context_compile_evals_body_length_check",
      sql`char_length(${table.body}) <= 10000`,
    ),
    titleLengthCheck: check(
      "context_compile_evals_title_length_check",
      sql`${table.title} is null or char_length(${table.title}) <= 160`,
    ),
    relevanceRangeCheck: check(
      "context_compile_evals_relevance_range_check",
      sql`${table.relevance} is null or (${table.relevance} >= 0 and ${table.relevance} <= 100)`,
    ),
    actionabilityRangeCheck: check(
      "context_compile_evals_actionability_range_check",
      sql`${table.actionability} is null or (${table.actionability} >= 0 and ${table.actionability} <= 100)`,
    ),
    coverageRangeCheck: check(
      "context_compile_evals_coverage_range_check",
      sql`${table.coverage} is null or (${table.coverage} >= 0 and ${table.coverage} <= 100)`,
    ),
    clarityRangeCheck: check(
      "context_compile_evals_clarity_range_check",
      sql`${table.clarity} is null or (${table.clarity} >= 0 and ${table.clarity} <= 100)`,
    ),
    specificityRangeCheck: check(
      "context_compile_evals_specificity_range_check",
      sql`${table.specificity} is null or (${table.specificity} >= 0 and ${table.specificity} <= 100)`,
    ),
  }),
);

export const contextCompileTaskTraces = pgTable(
  "context_compile_task_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    retrievalMode: text("retrieval_mode").notNull(),
    projectRef: text("project_ref"),
    repoPath: text("repo_path"),
    repoKey: text("repo_key"),
    matchBasis: text("match_basis").notNull().default("none"),
    identityContractVersion: integer("identity_contract_version").notNull().default(1),
    scopeMode: text("scope_mode").notNull().default("global_only"),
    identityFingerprint: text("identity_fingerprint"),
    identityTrust: text("identity_trust").notNull().default("request_hint"),
    bindingStatus: text("binding_status").notNull().default("not_applicable"),
    technologies: jsonb("technologies").notNull().default([]),
    changeTypes: jsonb("change_types").notNull().default([]),
    domains: jsonb("domains").notNull().default([]),
    embeddingStatus: text("embedding_status").notNull().default("facets_only"),
    embeddingProvider: text("embedding_provider"),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    embedding: vector("embedding", { dimensions: groupedConfig.embedding.dimension }),
    goalHash: text("goal_hash").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdUnique: uniqueIndex("context_compile_task_traces_run_id_unique").on(table.runId),
    createdAtIdx: index("context_compile_task_traces_created_at_idx").on(table.createdAt),
    repoPathIdx: index("context_compile_task_traces_repo_path_idx").on(table.repoPath),
    repoKeyIdx: index("context_compile_task_traces_repo_key_idx").on(table.repoKey),
    projectRefIdx: index("context_compile_task_traces_project_ref_idx").on(table.projectRef),
    embeddingStatusIdx: index("context_compile_task_traces_embedding_status_idx").on(
      table.embeddingStatus,
    ),
    goalHashIdx: index("context_compile_task_traces_goal_hash_idx").on(table.goalHash),
    technologiesArrayCheck: check(
      "context_compile_task_traces_technologies_array_check",
      sql`jsonb_typeof(${table.technologies}) = 'array'`,
    ),
    changeTypesArrayCheck: check(
      "context_compile_task_traces_change_types_array_check",
      sql`jsonb_typeof(${table.changeTypes}) = 'array'`,
    ),
    domainsArrayCheck: check(
      "context_compile_task_traces_domains_array_check",
      sql`jsonb_typeof(${table.domains}) = 'array'`,
    ),
    embeddingStatusCheck: check(
      "context_compile_task_traces_embedding_status_check",
      sql`${table.embeddingStatus} IN (${sql.raw(
        toSqlList(contextCompileTaskTraceEmbeddingStatusValues),
      )})`,
    ),
    matchBasisCheck: check(
      "context_compile_task_traces_match_basis_check",
      sql`${table.matchBasis} IN (${sql.raw(toSqlList(compileProjectMatchBasisValues))})`,
    ),
    scopeModeCheck: check(
      "context_compile_task_traces_scope_mode_check",
      sql`${table.scopeMode} IN (${sql.raw(toSqlList(compileProjectScopeModeValues))})`,
    ),
    identityTrustCheck: check(
      "context_compile_task_traces_identity_trust_check",
      sql`${table.identityTrust} IN (${sql.raw(toSqlList(compileProjectIdentityTrustValues))})`,
    ),
    bindingStatusCheck: check(
      "context_compile_task_traces_binding_status_check",
      sql`${table.bindingStatus} IN (${sql.raw(toSqlList(compileProjectBindingStatusValues))})`,
    ),
  }),
);

export const contextPackItems = pgTable(
  "context_pack_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: text("item_id").notNull(),
    section: text("section").notNull(),
    score: real("score").default(0).notNull(),
    rankingReason: text("ranking_reason").notNull(),
    sourceRefs: jsonb("source_refs").notNull().default([]),
    scopeSnapshot: jsonb("scope_snapshot").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdIdx: index("context_pack_items_run_id_idx").on(table.runId),
    sectionIdx: index("context_pack_items_section_idx").on(table.section),
    sectionCheck: check(
      "context_pack_items_section_check",
      sql`${table.section} IN (${sql.raw(toSqlList(packSectionValues))})`,
    ),
  }),
);

export const contextCompileCandidateTraces = pgTable(
  "context_compile_candidate_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    itemKind: text("item_kind").notNull(),
    itemId: uuid("item_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    textRank: integer("text_rank"),
    textScore: real("text_score"),
    vectorRank: integer("vector_rank"),
    vectorScore: real("vector_score"),
    mergedRank: integer("merged_rank"),
    mergedScore: real("merged_score"),
    finalRank: integer("final_rank"),
    finalScore: real("final_score"),
    selected: boolean("selected").notNull().default(false),
    suppressed: boolean("suppressed").notNull().default(false),
    suppressionReason: text("suppression_reason"),
    agenticDecision: text("agentic_decision").notNull().default("not_evaluated"),
    rankingReason: text("ranking_reason"),
    communityKey: text("community_key"),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    runItemUnique: uniqueIndex("context_compile_candidate_traces_run_item_unique").on(
      table.runId,
      table.itemKind,
      table.itemId,
    ),
    runFinalRankIdx: index("context_compile_candidate_traces_run_final_rank_idx").on(
      table.runId,
      table.finalRank,
    ),
    itemCreatedAtIdx: index("context_compile_candidate_traces_item_created_at_idx").on(
      table.itemId,
      table.createdAt,
    ),
    runSelectedIdx: index("context_compile_candidate_traces_run_selected_idx").on(
      table.runId,
      table.selected,
    ),
    suppressionReasonIdx: index("context_compile_candidate_traces_suppression_reason_idx").on(
      table.suppressionReason,
    ),
    communityKeyCreatedAtIdx: index(
      "context_compile_candidate_traces_community_key_created_at_idx",
    ).on(table.communityKey, table.createdAt),
    itemKindCheck: check(
      "context_compile_candidate_traces_item_kind_check",
      sql`${table.itemKind} IN (${sql.raw(toSqlList(knowledgeTypeValues))})`,
    ),
    agenticDecisionCheck: check(
      "context_compile_candidate_traces_agentic_decision_check",
      sql`${table.agenticDecision} IN (${sql.raw(
        toSqlList(contextCompileCandidateTraceAgenticDecisionValues),
      )})`,
    ),
    evidenceObjectCheck: check(
      "context_compile_candidate_traces_evidence_object_check",
      sql`jsonb_typeof(${table.evidence}) = 'object'`,
    ),
  }),
);

export const knowledgeUsageEvents = pgTable(
  "knowledge_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .references(() => contextCompileRuns.id, { onDelete: "cascade" })
      .notNull(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    verdict: text("verdict").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    runIdIdx: index("knowledge_usage_events_run_id_idx").on(table.runId),
    knowledgeIdIdx: index("knowledge_usage_events_knowledge_id_idx").on(table.knowledgeId),
    verdictCreatedAtIdx: index("knowledge_usage_events_verdict_created_at_idx").on(
      table.verdict,
      table.createdAt,
    ),
    knowledgeVerdictCreatedAtIdx: index(
      "knowledge_usage_events_knowledge_verdict_created_at_idx",
    ).on(table.knowledgeId, table.verdict, table.createdAt),
    runKnowledgeUnique: uniqueIndex("knowledge_usage_events_run_knowledge_unique").on(
      table.runId,
      table.knowledgeId,
    ),
    verdictCheck: check(
      "knowledge_usage_events_verdict_check",
      sql`${table.verdict} IN (${sql.raw(toSqlList(knowledgeUsageVerdictValues))})`,
    ),
    actorCheck: check(
      "knowledge_usage_events_actor_check",
      sql`${table.actor} IN (${sql.raw(toSqlList(auditLogActorValues))})`,
    ),
    reasonLengthCheck: check(
      "knowledge_usage_events_reason_length_check",
      sql`${table.reason} IS NULL OR char_length(${table.reason}) <= 160`,
    ),
  }),
);

export const knowledgeReviewQueue = pgTable(
  "knowledge_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    knowledgeId: uuid("knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    triggerEventId: uuid("trigger_event_id")
      .references(() => knowledgeUsageEvents.id, { onDelete: "cascade" })
      .notNull(),
    triggerVerdict: text("trigger_verdict").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAction: text("proposed_action").notNull().default("review_only"),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    statusCreatedAtIdx: index("knowledge_review_queue_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
    knowledgeStatusIdx: index("knowledge_review_queue_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    triggerEventUnique: uniqueIndex("knowledge_review_queue_trigger_event_unique").on(
      table.triggerEventId,
    ),
    triggerVerdictCheck: check(
      "knowledge_review_queue_trigger_verdict_check",
      sql`${table.triggerVerdict} IN (${sql.raw(toSqlList(knowledgeUsageVerdictValues))})`,
    ),
    statusCheck: check(
      "knowledge_review_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(knowledgeReviewQueueStatusValues))})`,
    ),
    proposedActionCheck: check(
      "knowledge_review_queue_proposed_action_check",
      sql`${table.proposedAction} IN (${sql.raw(toSqlList(knowledgeReviewProposedActionValues))})`,
    ),
  }),
);

export const contextDecisionRuns = pgTable(
  "context_decision_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: text("session_id"),
    premise: text("premise"),
    decisionPoint: text("decision_point").notNull(),
    proposedAction: text("proposed_action"),
    options: jsonb("options").notNull().default([]),
    retrievalHints: jsonb("retrieval_hints").notNull().default({}),
    decision: text("decision").notNull(),
    selectedAction: text("selected_action"),
    rejectedActions: jsonb("rejected_actions").notNull().default([]),
    mandate: text("mandate").notNull(),
    agentMessage: text("agent_message").notNull(),
    confidence: integer("confidence").notNull(),
    confidenceTrace: jsonb("confidence_trace").notNull().default({}),
    autonomyLevel: text("autonomy_level").notNull().default("high"),
    riskBudget: text("risk_budget").notNull().default("medium"),
    knowledgePolicy: text("knowledge_policy").notNull().default("optional"),
    availableRollback: text("available_rollback"),
    verificationPlan: text("verification_plan"),
    guardrails: jsonb("guardrails").notNull().default({}),
    unsupportedAlternatives: jsonb("unsupported_alternatives").notNull().default([]),
    status: text("status").notNull().default("completed"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    createdAtIdx: index("context_decision_runs_created_at_idx").on(table.createdAt),
    decisionCreatedAtIdx: index("context_decision_runs_decision_created_at_idx").on(
      table.decision,
      table.createdAt,
    ),
    statusCreatedAtIdx: index("context_decision_runs_status_created_at_idx").on(
      table.status,
      table.createdAt,
    ),
    sessionCreatedAtIdx: index("context_decision_runs_session_created_at_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    decisionCheck: check(
      "context_decision_runs_decision_check",
      sql`${table.decision} IN (${sql.raw(toSqlList(contextDecisionValues))})`,
    ),
    confidenceRangeCheck: check(
      "context_decision_runs_confidence_range_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 100`,
    ),
    autonomyLevelCheck: check(
      "context_decision_runs_autonomy_level_check",
      sql`${table.autonomyLevel} IN (${sql.raw(toSqlList(contextDecisionAutonomyLevelValues))})`,
    ),
    riskBudgetCheck: check(
      "context_decision_runs_risk_budget_check",
      sql`${table.riskBudget} IN (${sql.raw(toSqlList(contextDecisionRiskBudgetValues))})`,
    ),
    knowledgePolicyCheck: check(
      "context_decision_runs_knowledge_policy_check",
      sql`${table.knowledgePolicy} IN (${sql.raw(
        toSqlList(contextDecisionKnowledgePolicyValues),
      )})`,
    ),
    statusCheck: check(
      "context_decision_runs_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(contextDecisionStatusValues))})`,
    ),
    optionsArrayCheck: check(
      "context_decision_runs_options_array_check",
      sql`jsonb_typeof(${table.options}) = 'array'`,
    ),
    retrievalHintsObjectCheck: check(
      "context_decision_runs_retrieval_hints_object_check",
      sql`jsonb_typeof(${table.retrievalHints}) = 'object'`,
    ),
    rejectedActionsArrayCheck: check(
      "context_decision_runs_rejected_actions_array_check",
      sql`jsonb_typeof(${table.rejectedActions}) = 'array'`,
    ),
    confidenceTraceObjectCheck: check(
      "context_decision_runs_confidence_trace_object_check",
      sql`jsonb_typeof(${table.confidenceTrace}) = 'object'`,
    ),
    guardrailsObjectCheck: check(
      "context_decision_runs_guardrails_object_check",
      sql`jsonb_typeof(${table.guardrails}) = 'object'`,
    ),
    unsupportedAlternativesArrayCheck: check(
      "context_decision_runs_unsupported_alternatives_array_check",
      sql`jsonb_typeof(${table.unsupportedAlternatives}) = 'array'`,
    ),
    metadataObjectCheck: check(
      "context_decision_runs_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const contextDecisionEvidence = pgTable(
  "context_decision_evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionRunId: uuid("decision_run_id")
      .references(() => contextDecisionRuns.id, { onDelete: "cascade" })
      .notNull(),
    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "set null",
    }),
    role: text("role").notNull(),
    weightAtDecision: integer("weight_at_decision").notNull(),
    dynamicScoreAtDecision: integer("dynamic_score_at_decision"),
    applicabilityScore: integer("applicability_score"),
    temporalRelevance: integer("temporal_relevance"),
    summary: text("summary").notNull(),
    sourceRefs: jsonb("source_refs").notNull().default([]),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    decisionRoleIdx: index("context_decision_evidence_decision_role_idx").on(
      table.decisionRunId,
      table.role,
    ),
    knowledgeRoleIdx: index("context_decision_evidence_knowledge_role_idx").on(
      table.knowledgeId,
      table.role,
    ),
    roleCheck: check(
      "context_decision_evidence_role_check",
      sql`${table.role} IN (${sql.raw(toSqlList(contextDecisionEvidenceRoleValues))})`,
    ),
    sourceRefsArrayCheck: check(
      "context_decision_evidence_source_refs_array_check",
      sql`jsonb_typeof(${table.sourceRefs}) = 'array'`,
    ),
    metadataObjectCheck: check(
      "context_decision_evidence_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const contextDecisionCoverageTraces = pgTable(
  "context_decision_coverage_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionRunId: uuid("decision_run_id")
      .references(() => contextDecisionRuns.id, { onDelete: "cascade" })
      .notNull(),
    query: text("query").notNull(),
    queryRole: text("query_role").notNull(),
    scope: jsonb("scope").notNull().default({}),
    hitCount: integer("hit_count").notNull().default(0),
    maxSimilarity: integer("max_similarity"),
    selectedKnowledgeIds: jsonb("selected_knowledge_ids").notNull().default([]),
    rejectedKnowledgeIds: jsonb("rejected_knowledge_ids").notNull().default([]),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    decisionRoleIdx: index("context_decision_coverage_decision_role_idx").on(
      table.decisionRunId,
      table.queryRole,
    ),
    queryRoleCheck: check(
      "context_decision_coverage_query_role_check",
      sql`${table.queryRole} IN (${sql.raw(toSqlList(contextDecisionCoverageQueryRoleValues))})`,
    ),
    scopeObjectCheck: check(
      "context_decision_coverage_scope_object_check",
      sql`jsonb_typeof(${table.scope}) = 'object'`,
    ),
    selectedKnowledgeIdsArrayCheck: check(
      "context_decision_coverage_selected_knowledge_ids_array_check",
      sql`jsonb_typeof(${table.selectedKnowledgeIds}) = 'array'`,
    ),
    rejectedKnowledgeIdsArrayCheck: check(
      "context_decision_coverage_rejected_knowledge_ids_array_check",
      sql`jsonb_typeof(${table.rejectedKnowledgeIds}) = 'array'`,
    ),
  }),
);

export const contextDecisionHumanFeedback = pgTable(
  "context_decision_human_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionRunId: uuid("decision_run_id")
      .references(() => contextDecisionRuns.id, { onDelete: "cascade" })
      .notNull(),
    value: text("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    decisionRunUnique: uniqueIndex("context_decision_human_feedback_run_unique").on(
      table.decisionRunId,
    ),
    valueCheck: check(
      "context_decision_human_feedback_value_check",
      sql`${table.value} IN (${sql.raw(toSqlList(contextDecisionHumanFeedbackValues))})`,
    ),
  }),
);

export const contextDecisionFeedback = pgTable(
  "context_decision_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    decisionRunId: uuid("decision_run_id")
      .references(() => contextDecisionRuns.id, { onDelete: "cascade" })
      .notNull(),
    source: text("source").notNull(),
    outcome: text("outcome").notNull(),
    inferredReason: text("inferred_reason").notNull(),
    affectedKnowledgeIds: jsonb("affected_knowledge_ids").notNull().default([]),
    suggestedAdjustment: jsonb("suggested_adjustment").notNull().default({}),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    decisionRunIdx: index("context_decision_feedback_run_idx").on(table.decisionRunId),
    outcomeCreatedAtIdx: index("context_decision_feedback_outcome_created_at_idx").on(
      table.outcome,
      table.createdAt,
    ),
    sourceCheck: check(
      "context_decision_feedback_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(contextDecisionFeedbackSourceValues))})`,
    ),
    outcomeCheck: check(
      "context_decision_feedback_outcome_check",
      sql`${table.outcome} IN (${sql.raw(toSqlList(contextDecisionFeedbackOutcomeValues))})`,
    ),
    affectedKnowledgeIdsArrayCheck: check(
      "context_decision_feedback_affected_knowledge_ids_array_check",
      sql`jsonb_typeof(${table.affectedKnowledgeIds}) = 'array'`,
    ),
    suggestedAdjustmentObjectCheck: check(
      "context_decision_feedback_suggested_adjustment_object_check",
      sql`jsonb_typeof(${table.suggestedAdjustment}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "context_decision_feedback_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const contextDecisionFeedbackEffects = pgTable(
  "context_decision_feedback_effects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    feedbackId: uuid("feedback_id").references(() => contextDecisionFeedback.id, {
      onDelete: "cascade",
    }),
    humanFeedbackId: uuid("human_feedback_id").references(() => contextDecisionHumanFeedback.id, {
      onDelete: "cascade",
    }),
    decisionRunId: uuid("decision_run_id")
      .references(() => contextDecisionRuns.id, { onDelete: "cascade" })
      .notNull(),
    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "set null",
    }),
    effect: text("effect").notNull(),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    confidence: integer("confidence").notNull(),
    status: text("status").notNull().default("applied"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    decisionRunStatusIdx: index("context_decision_feedback_effects_run_status_idx").on(
      table.decisionRunId,
      table.status,
    ),
    knowledgeStatusIdx: index("context_decision_feedback_effects_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    effectCheck: check(
      "context_decision_feedback_effects_effect_check",
      sql`${table.effect} IN (${sql.raw(toSqlList(contextDecisionEffectValues))})`,
    ),
    confidenceRangeCheck: check(
      "context_decision_feedback_effects_confidence_range_check",
      sql`${table.confidence} >= 0 and ${table.confidence} <= 100`,
    ),
    statusCheck: check(
      "context_decision_feedback_effects_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(contextDecisionFeedbackEffectStatusValues))})`,
    ),
    feedbackSourceCheck: check(
      "context_decision_feedback_effects_source_check",
      sql`((${table.feedbackId} is not null and ${table.humanFeedbackId} is null) or (${table.feedbackId} is null and ${table.humanFeedbackId} is not null))`,
    ),
    metadataObjectCheck: check(
      "context_decision_feedback_effects_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);
