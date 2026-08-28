import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { contextCompileRuns, knowledgeUsageEvents } from "./schema-context.js";
import {
  distillationTargetStates,
  evidenceCoverageResults,
  findCandidateResults,
  findingCandidateQueue,
  foundCandidates,
} from "./schema-distillation.js";
import { knowledgeItems } from "./schema-knowledge.js";
import {
  distillationQueueStatusValues,
  landscapeCurationDecisionValues,
  landscapeCurationDispositionValues,
  landscapeCurationFindingTypeValues,
  landscapeCurationLinkRoleValues,
  landscapeCurationPhaseValues,
  landscapeCurationRollbackStatusValues,
  landscapeReviewItemCandidateLinkStatusValues,
  landscapeReviewItemConfidenceValues,
  landscapeReviewItemProposedActionValues,
  landscapeReviewItemReasonValues,
  landscapeReviewItemSourceValues,
  landscapeReviewItemStatusValues,
  landscapeSnapshotCacheStatusValues,
  landscapeSnapshotCacheTypeValues,
} from "./schema.constants.js";
import { toSqlList } from "./schema.utils.js";

export const landscapeReviewItems = pgTable(
  "landscape_review_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    proposedAction: text("proposed_action").notNull().default("review_only"),
    priority: integer("priority").notNull().default(50),
    confidence: text("confidence").notNull().default("low"),
    idempotencyKey: text("idempotency_key").notNull(),
    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "cascade",
    }),
    runId: uuid("run_id").references(() => contextCompileRuns.id, {
      onDelete: "set null",
    }),
    triggerEventId: uuid("trigger_event_id").references(() => knowledgeUsageEvents.id, {
      onDelete: "set null",
    }),
    communityKey: text("community_key"),
    communityLabel: text("community_label"),
    suggestedAppliesTo: jsonb("suggested_applies_to").default({}).notNull(),
    evidence: jsonb("evidence").default([]).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("landscape_review_items_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    statusPriorityCreatedAtIdx: index("landscape_review_items_status_priority_created_at_idx").on(
      table.status,
      table.priority.desc(),
      table.createdAt,
    ),
    knowledgeStatusIdx: index("landscape_review_items_knowledge_status_idx").on(
      table.knowledgeId,
      table.status,
    ),
    communityStatusIdx: index("landscape_review_items_community_status_idx").on(
      table.communityKey,
      table.status,
    ),
    runStatusIdx: index("landscape_review_items_run_status_idx").on(table.runId, table.status),
    reasonStatusIdx: index("landscape_review_items_reason_status_idx").on(
      table.reason,
      table.status,
    ),
    sourceCheck: check(
      "landscape_review_items_source_check",
      sql`${table.source} IN (${sql.raw(toSqlList(landscapeReviewItemSourceValues))})`,
    ),
    reasonCheck: check(
      "landscape_review_items_reason_check",
      sql`${table.reason} IN (${sql.raw(toSqlList(landscapeReviewItemReasonValues))})`,
    ),
    statusCheck: check(
      "landscape_review_items_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeReviewItemStatusValues))})`,
    ),
    proposedActionCheck: check(
      "landscape_review_items_proposed_action_check",
      sql`${table.proposedAction} IN (${sql.raw(
        toSqlList(landscapeReviewItemProposedActionValues),
      )})`,
    ),
    confidenceCheck: check(
      "landscape_review_items_confidence_check",
      sql`${table.confidence} IN (${sql.raw(toSqlList(landscapeReviewItemConfidenceValues))})`,
    ),
    priorityCheck: check(
      "landscape_review_items_priority_check",
      sql`${table.priority} >= 0 AND ${table.priority} <= 100`,
    ),
    evidenceArrayCheck: check(
      "landscape_review_items_evidence_array_check",
      sql`jsonb_typeof(${table.evidence}) = 'array'`,
    ),
    suggestedAppliesToObjectCheck: check(
      "landscape_review_items_suggested_applies_to_object_check",
      sql`jsonb_typeof(${table.suggestedAppliesTo}) = 'object'`,
    ),
    payloadObjectCheck: check(
      "landscape_review_items_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  }),
);

export const landscapeReviewItemCandidateLinks = pgTable(
  "landscape_review_item_candidate_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewItemId: uuid("review_item_id")
      .references(() => landscapeReviewItems.id, { onDelete: "cascade" })
      .notNull(),
    targetStateId: uuid("target_state_id").references(() => distillationTargetStates.id, {
      onDelete: "cascade",
    }),
    findCandidateResultId: uuid("find_candidate_result_id").references(
      () => findCandidateResults.id,
      {
        onDelete: "cascade",
      },
    ),
    findingJobId: uuid("finding_job_id").references(() => findingCandidateQueue.id, {
      onDelete: "cascade",
    }),
    foundCandidateId: uuid("found_candidate_id").references(() => foundCandidates.id, {
      onDelete: "cascade",
    }),
    evidenceResultId: uuid("evidence_result_id").references(() => evidenceCoverageResults.id, {
      onDelete: "set null",
    }),
    legacyTargetStateId: uuid("legacy_target_state_id"),
    legacyFindCandidateResultId: uuid("legacy_find_candidate_result_id"),
    candidateKey: text("candidate_key").notNull(),
    status: text("status").notNull().default("draft_created"),
    approvalNote: text("approval_note"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    reviewCandidateUnique: uniqueIndex(
      "landscape_review_item_candidate_links_review_candidate_unique",
    ).on(table.reviewItemId, table.candidateKey),
    targetCandidateUnique: uniqueIndex(
      "landscape_review_item_candidate_links_target_candidate_unique",
    ).on(table.targetStateId, table.findCandidateResultId),
    queueCandidateUnique: uniqueIndex(
      "landscape_review_item_candidate_links_queue_candidate_unique",
    ).on(table.findingJobId, table.foundCandidateId),
    reviewStatusCreatedAtIdx: index(
      "landscape_review_item_candidate_links_review_status_created_at_idx",
    ).on(table.reviewItemId, table.status, table.createdAt),
    targetStateIdx: index("landscape_review_item_candidate_links_target_state_idx").on(
      table.targetStateId,
    ),
    findCandidateIdx: index("landscape_review_item_candidate_links_find_candidate_idx").on(
      table.findCandidateResultId,
    ),
    findingJobIdx: index("landscape_review_item_candidate_links_finding_job_idx").on(
      table.findingJobId,
    ),
    foundCandidateIdx: index("landscape_review_item_candidate_links_found_candidate_idx").on(
      table.foundCandidateId,
    ),
    evidenceResultIdx: index("landscape_review_item_candidate_links_evidence_result_idx").on(
      table.evidenceResultId,
    ),
    statusCheck: check(
      "landscape_review_item_candidate_links_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeReviewItemCandidateLinkStatusValues))})`,
    ),
  }),
);

export const deadZoneMergeReviewQueue = pgTable(
  "dead_zone_merge_review_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewItemId: uuid("review_item_id").references(() => landscapeReviewItems.id, {
      onDelete: "set null",
    }),
    deadZoneKnowledgeId: uuid("dead_zone_knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    canonicalKnowledgeId: uuid("canonical_knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    nextRunAt: timestamp("next_run_at"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    provider: text("provider").notNull().default("local-llm"),
    model: text("model"),
    inputSnapshot: jsonb("input_snapshot").default({}).notNull(),
    result: jsonb("result").default({}).notNull(),
    payload: jsonb("payload").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("dead_zone_merge_review_queue_idempotency_unique").on(
      table.idempotencyKey,
    ),
    statusPriorityCreatedAtIdx: index(
      "dead_zone_merge_review_queue_status_priority_created_at_idx",
    ).on(table.status, table.priority, table.createdAt),
    deadZoneStatusIdx: index("dead_zone_merge_review_queue_dead_zone_status_idx").on(
      table.deadZoneKnowledgeId,
      table.status,
    ),
    canonicalStatusIdx: index("dead_zone_merge_review_queue_canonical_status_idx").on(
      table.canonicalKnowledgeId,
      table.status,
    ),
    reviewItemStatusIdx: index("dead_zone_merge_review_queue_review_item_status_idx").on(
      table.reviewItemId,
      table.status,
    ),
    statusCheck: check(
      "dead_zone_merge_review_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    distinctKnowledgeCheck: check(
      "dead_zone_merge_review_queue_distinct_knowledge_check",
      sql`${table.canonicalKnowledgeId} IS NULL OR ${table.deadZoneKnowledgeId} <> ${table.canonicalKnowledgeId}`,
    ),
    inputSnapshotObjectCheck: check(
      "dead_zone_merge_review_queue_input_snapshot_object_check",
      sql`jsonb_typeof(${table.inputSnapshot}) = 'object'`,
    ),
    resultObjectCheck: check(
      "dead_zone_merge_review_queue_result_object_check",
      sql`jsonb_typeof(${table.result}) = 'object'`,
    ),
    payloadObjectCheck: check(
      "dead_zone_merge_review_queue_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "dead_zone_merge_review_queue_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const mergeActivationFinalizeQueue = pgTable(
  "merge_activation_finalize_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    mergeReviewJobId: uuid("merge_review_job_id")
      .references(() => deadZoneMergeReviewQueue.id, { onDelete: "cascade" })
      .notNull(),
    deadZoneKnowledgeId: uuid("dead_zone_knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    canonicalKnowledgeId: uuid("canonical_knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    reviewItemId: uuid("review_item_id").references(() => landscapeReviewItems.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(2),
    nextRunAt: timestamp("next_run_at"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    provider: text("provider").notNull().default("local-llm"),
    model: text("model"),
    inputSnapshot: jsonb("input_snapshot").default({}).notNull(),
    activationResult: jsonb("activation_result").default({}).notNull(),
    knowledgeId: uuid("knowledge_id").references(() => knowledgeItems.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").default({}).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("merge_activation_finalize_queue_idempotency_unique").on(
      table.idempotencyKey,
    ),
    statusPriorityCreatedAtIdx: index(
      "merge_activation_finalize_queue_status_priority_created_at_idx",
    ).on(table.status, table.priority, table.createdAt),
    mergeReviewJobIdx: index("merge_activation_finalize_queue_merge_review_job_idx").on(
      table.mergeReviewJobId,
    ),
    deadZoneStatusIdx: index("merge_activation_finalize_queue_dead_zone_status_idx").on(
      table.deadZoneKnowledgeId,
      table.status,
    ),
    canonicalStatusIdx: index("merge_activation_finalize_queue_canonical_status_idx").on(
      table.canonicalKnowledgeId,
      table.status,
    ),
    reviewItemStatusIdx: index("merge_activation_finalize_queue_review_item_status_idx").on(
      table.reviewItemId,
      table.status,
    ),
    statusCheck: check(
      "merge_activation_finalize_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    distinctKnowledgeCheck: check(
      "merge_activation_finalize_queue_distinct_knowledge_check",
      sql`${table.deadZoneKnowledgeId} <> ${table.canonicalKnowledgeId}`,
    ),
    payloadObjectCheck: check(
      "merge_activation_finalize_queue_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    metadataObjectCheck: check(
      "merge_activation_finalize_queue_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
    inputSnapshotObjectCheck: check(
      "merge_activation_finalize_queue_input_snapshot_object_check",
      sql`jsonb_typeof(${table.inputSnapshot}) = 'object'`,
    ),
    activationResultObjectCheck: check(
      "merge_activation_finalize_queue_activation_result_object_check",
      sql`jsonb_typeof(${table.activationResult}) = 'object'`,
    ),
  }),
);

export const landscapeCurationQueue = pgTable(
  "landscape_curation_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewItemId: uuid("review_item_id").references(() => landscapeReviewItems.id, {
      onDelete: "set null",
    }),
    findingType: text("finding_type").notNull(),
    subjectKnowledgeId: uuid("subject_knowledge_id")
      .references(() => knowledgeItems.id, { onDelete: "cascade" })
      .notNull(),
    candidateKnowledgeIds: jsonb("candidate_knowledge_ids").default([]).notNull(),
    repositoryIdentity: jsonb("repository_identity").default({}).notNull(),
    fingerprint: text("fingerprint").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    status: text("status").notNull().default("pending"),
    phase: text("phase").notNull().default("evaluate"),
    decision: text("decision"),
    disposition: text("disposition"),
    priority: integer("priority").notNull().default(50),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    nextRunAt: timestamp("next_run_at"),
    lockedBy: text("locked_by"),
    lockedAt: timestamp("locked_at"),
    heartbeatAt: timestamp("heartbeat_at"),
    lastError: text("last_error"),
    lastOutcomeKind: text("last_outcome_kind"),
    provider: text("provider").notNull().default("local-llm"),
    model: text("model"),
    inputSnapshot: jsonb("input_snapshot").default({}).notNull(),
    result: jsonb("result").default({}).notNull(),
    policyResult: jsonb("policy_result").default({}).notNull(),
    mutationPlan: jsonb("mutation_plan").default({}).notNull(),
    postcheckResult: jsonb("postcheck_result").default({}).notNull(),
    rollbackSnapshot: jsonb("rollback_snapshot").default({}).notNull(),
    rollbackStatus: text("rollback_status").notNull().default("not_requested"),
    schemaVersion: integer("schema_version").notNull().default(1),
    detectorVersion: text("detector_version").notNull().default("curation-detector-v1"),
    policyVersion: text("policy_version").notNull().default("curation-policy-v1"),
    promptVersion: text("prompt_version").notNull().default("landscape-curation-v1"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
    rollbackAt: timestamp("rollback_at"),
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("landscape_curation_queue_idempotency_unique").on(
      table.idempotencyKey,
    ),
    claimIdx: index("landscape_curation_queue_claim_idx").on(
      table.status,
      table.nextRunAt,
      table.priority,
      table.createdAt,
    ),
    subjectUpdatedIdx: index("landscape_curation_queue_subject_updated_idx").on(
      table.subjectKnowledgeId,
      table.updatedAt,
    ),
    fingerprintCreatedIdx: index("landscape_curation_queue_fingerprint_created_idx").on(
      table.fingerprint,
      table.createdAt,
    ),
    activeFingerprintUnique: uniqueIndex("landscape_curation_queue_active_fingerprint_unique")
      .on(table.fingerprint)
      .where(
        sql`${table.status} IN ('pending', 'running', 'paused') OR ${table.phase} = 'awaiting_downstream'`,
      ),
    statusCheck: check(
      "landscape_curation_queue_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(distillationQueueStatusValues))})`,
    ),
    findingTypeCheck: check(
      "landscape_curation_queue_finding_type_check",
      sql`${table.findingType} IN (${sql.raw(toSqlList(landscapeCurationFindingTypeValues))})`,
    ),
    phaseCheck: check(
      "landscape_curation_queue_phase_check",
      sql`${table.phase} IN (${sql.raw(toSqlList(landscapeCurationPhaseValues))})`,
    ),
    decisionCheck: check(
      "landscape_curation_queue_decision_check",
      sql`${table.decision} IS NULL OR ${table.decision} IN (${sql.raw(
        toSqlList(landscapeCurationDecisionValues),
      )})`,
    ),
    dispositionCheck: check(
      "landscape_curation_queue_disposition_check",
      sql`${table.disposition} IS NULL OR ${table.disposition} IN (${sql.raw(
        toSqlList(landscapeCurationDispositionValues),
      )})`,
    ),
    rollbackStatusCheck: check(
      "landscape_curation_queue_rollback_status_check",
      sql`${table.rollbackStatus} IN (${sql.raw(toSqlList(landscapeCurationRollbackStatusValues))})`,
    ),
    priorityCheck: check(
      "landscape_curation_queue_priority_check",
      sql`${table.priority} >= 0 AND ${table.priority} <= 100`,
    ),
    candidateIdsArrayCheck: check(
      "landscape_curation_queue_candidate_ids_array_check",
      sql`jsonb_typeof(${table.candidateKnowledgeIds}) = 'array'`,
    ),
    repositoryIdentityObjectCheck: check(
      "landscape_curation_queue_repository_identity_object_check",
      sql`jsonb_typeof(${table.repositoryIdentity}) = 'object'`,
    ),
    inputSnapshotObjectCheck: check(
      "landscape_curation_queue_input_snapshot_object_check",
      sql`jsonb_typeof(${table.inputSnapshot}) = 'object'`,
    ),
    resultObjectCheck: check(
      "landscape_curation_queue_result_object_check",
      sql`jsonb_typeof(${table.result}) = 'object'`,
    ),
    policyResultObjectCheck: check(
      "landscape_curation_queue_policy_result_object_check",
      sql`jsonb_typeof(${table.policyResult}) = 'object'`,
    ),
    mutationPlanObjectCheck: check(
      "landscape_curation_queue_mutation_plan_object_check",
      sql`jsonb_typeof(${table.mutationPlan}) = 'object'`,
    ),
    postcheckResultObjectCheck: check(
      "landscape_curation_queue_postcheck_result_object_check",
      sql`jsonb_typeof(${table.postcheckResult}) = 'object'`,
    ),
    rollbackSnapshotObjectCheck: check(
      "landscape_curation_queue_rollback_snapshot_object_check",
      sql`jsonb_typeof(${table.rollbackSnapshot}) = 'object'`,
    ),
  }),
);

export const landscapeCurationJobLinks = pgTable(
  "landscape_curation_job_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    curationJobId: uuid("curation_job_id")
      .references(() => landscapeCurationQueue.id, { onDelete: "cascade" })
      .notNull(),
    role: text("role").notNull(),
    queueName: text("queue_name").notNull(),
    queueJobId: uuid("queue_job_id").notNull(),
    status: text("status").notNull(),
    outcomeKind: text("outcome_kind"),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    curationRoleUnique: uniqueIndex("landscape_curation_job_links_curation_role_unique").on(
      table.curationJobId,
      table.role,
    ),
    queueJobIdx: index("landscape_curation_job_links_queue_job_idx").on(
      table.queueName,
      table.queueJobId,
    ),
    roleCheck: check(
      "landscape_curation_job_links_role_check",
      sql`${table.role} IN (${sql.raw(toSqlList(landscapeCurationLinkRoleValues))})`,
    ),
    metadataObjectCheck: check(
      "landscape_curation_job_links_metadata_object_check",
      sql`jsonb_typeof(${table.metadata}) = 'object'`,
    ),
  }),
);

export const landscapeSnapshots = pgTable(
  "landscape_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotType: text("snapshot_type").notNull(),
    status: text("status").notNull().default("ready"),
    paramsHash: text("params_hash").notNull(),
    params: jsonb("params").notNull().default({}),
    payload: jsonb("payload").notNull().default({}),
    generatedAt: timestamp("generated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    typeParamsHashUnique: uniqueIndex("landscape_snapshots_type_params_hash_unique").on(
      table.snapshotType,
      table.paramsHash,
    ),
    typeGeneratedAtIdx: index("landscape_snapshots_type_generated_at_idx").on(
      table.snapshotType,
      table.generatedAt,
    ),
    expiresAtIdx: index("landscape_snapshots_expires_at_idx").on(table.expiresAt),
    statusCheck: check(
      "landscape_snapshots_status_check",
      sql`${table.status} IN (${sql.raw(toSqlList(landscapeSnapshotCacheStatusValues))})`,
    ),
    typeCheck: check(
      "landscape_snapshots_type_check",
      sql`${table.snapshotType} IN (${sql.raw(toSqlList(landscapeSnapshotCacheTypeValues))})`,
    ),
    paramsObjectCheck: check(
      "landscape_snapshots_params_object_check",
      sql`jsonb_typeof(${table.params}) = 'object'`,
    ),
    payloadObjectCheck: check(
      "landscape_snapshots_payload_object_check",
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
  }),
);
