import { z } from "zod";

export const landscapeCurationFindingTypeSchema = z.enum([
  "duplicate_candidate",
  "reachability_gap",
  "stale_knowledge",
  "applicability_issue",
  "contradiction_candidate",
]);

export const landscapeCurationDecisionSchema = z.enum([
  "merge_review",
  "deprecate_duplicate",
  "repair_scope",
  "keep_separate",
  "needs_evidence",
  "observe",
  "escalate",
]);

export const landscapeCurationPhaseSchema = z.enum([
  "evaluate",
  "preflight",
  "llm_review",
  "policy",
  "awaiting_downstream",
  "mutation",
  "postcheck",
  "rollback",
]);

export const landscapeCurationDispositionSchema = z.enum([
  "auto_execute",
  "enqueue_downstream",
  "record_only",
  "await_evidence",
  "blocked",
]);

export const landscapeCurationReleaseModeSchema = z.enum([
  "disabled",
  "shadow",
  "auto_non_destructive",
  "auto_bounded",
]);

export const landscapeCurationRollbackStatusSchema = z.enum([
  "not_requested",
  "pending",
  "completed",
  "failed",
]);

export const landscapeCurationPolicyReasonCodeSchema = z.enum([
  "MODE_DISABLED",
  "SHADOW_ONLY",
  "AUTONOMOUS_SAFE_DOWNSTREAM",
  "AUTONOMOUS_SAFE_MUTATION",
  "AUTONOMOUS_TERMINAL_DECISION",
  "LOW_CONFIDENCE",
  "LLM_BLOCKER_PRESENT",
  "EVIDENCE_INCOMPLETE",
  "STALE_INPUT",
  "REPOSITORY_IDENTITY_MISMATCH",
  "GLOBAL_REPO_MIX",
  "CROSS_REPOSITORY_CANDIDATE",
  "CANDIDATE_NOT_ACTIVE",
  "CANDIDATE_REFERENCE_INVALID",
  "TYPE_MISMATCH",
  "POLARITY_MISMATCH",
  "AUTONOMOUS_EXACT_DUPLICATE_REQUIRED",
  "SIMILARITY_BELOW_THRESHOLD",
  "SCOPE_OVERLAP_BELOW_THRESHOLD",
  "SCOPE_PATCH_NOT_NARROWING",
  "REPLAY_REGRESSION",
  "UNIQUE_USAGE_PRESENT",
  "LINEAGE_NOT_PRESERVED",
  "CONTRADICTION_AUTOMATION_BLOCKED",
  "DAILY_BUDGET_EXHAUSTED",
  "REPO_BUDGET_EXHAUSTED",
  "ACTION_NOT_IMPLEMENTED",
]);

export const landscapeCurationLinkRoleSchema = z.enum([
  "merge_review",
  "merge_finalize",
  "evidence_repair",
]);

export const landscapeCurationEvidenceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  knowledgeId: z.string().min(1).nullable(),
  value: z.unknown(),
  observedAt: z.string().datetime(),
  source: z.string().min(1),
});

export const landscapeCurationKnowledgeSnapshotSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  bodyHash: z.string().min(1),
  appliesToHash: z.string().min(1),
  status: z.string().min(1),
  type: z.string().min(1),
  polarity: z.string().min(1),
  scope: z.string().min(1),
  classificationStatus: z.string().min(1),
  projectRef: z.string().nullable(),
  repoKey: z.string().nullable(),
  repoPath: z.string().nullable(),
  appliesTo: z.record(z.unknown()),
  confidence: z.number(),
  importance: z.number(),
  updatedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  lastVerifiedAt: z.string().datetime().nullable(),
  similarity: z.number().min(0).max(1).nullable().optional(),
  scopeOverlap: z.number().min(0).max(1).nullable().optional(),
});

export const landscapeCurationInputSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime(),
  finding: z.object({
    type: landscapeCurationFindingTypeSchema,
    reviewItemId: z.string().min(1).nullable(),
    evidenceHash: z.string().min(1),
  }),
  subject: landscapeCurationKnowledgeSnapshotSchema,
  candidates: z.array(landscapeCurationKnowledgeSnapshotSchema).max(5),
  evidence: z.array(landscapeCurationEvidenceSchema).max(100),
  usage: z.record(z.unknown()),
  lineage: z.record(z.unknown()),
  reviewItem: z.record(z.unknown()).nullable(),
  capabilities: z.record(z.unknown()),
  versions: z.object({
    detector: z.string().min(1),
    policy: z.string().min(1),
    prompt: z.string().min(1),
  }),
});

export const landscapeCurationResultSchema = z.object({
  schemaVersion: z.literal(1),
  decision: landscapeCurationDecisionSchema,
  confidence: z.enum(["low", "medium", "high"]),
  canonicalKnowledgeId: z.string().min(1).nullable(),
  rationale: z.array(z.string().min(1).max(300)).min(1).max(8),
  supportingEvidenceIds: z.array(z.string().min(1)).max(20),
  counterEvidence: z.array(z.string().min(1).max(300)).max(8),
  blockers: z.array(z.string().min(1).max(300)).max(8),
  proposedAppliesTo: z.record(z.unknown()).nullable(),
  proposedSummary: z.string().max(500).nullable(),
  rawOutputExcerpt: z.string().max(1200).optional(),
  parseStatus: z.enum(["parsed", "recovered", "failed"]).optional(),
});

export const landscapeCurationPolicyResultSchema = z.object({
  schemaVersion: z.literal(1),
  policyVersion: z.literal("curation-policy-v1"),
  releaseMode: landscapeCurationReleaseModeSchema,
  requestedDecision: landscapeCurationDecisionSchema,
  disposition: landscapeCurationDispositionSchema,
  effectiveAction: z.enum([
    "record",
    "repair_scope",
    "enqueue_merge_review",
    "merge_review",
    "deprecate_duplicate",
    "none",
  ]),
  reasonCodes: z.array(landscapeCurationPolicyReasonCodeSchema).min(1),
  evaluatedAt: z.string().datetime(),
  limits: z.object({ dailyRemaining: z.number().int(), repoRemaining: z.number().int() }),
});

export const landscapeCurationJobStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "skipped",
  "failed",
  "paused",
]);

export const landscapeCurationJobLinkSchema = z.object({
  id: z.string().min(1),
  curationJobId: z.string().min(1),
  role: landscapeCurationLinkRoleSchema,
  queueName: z.string().min(1),
  queueJobId: z.string().min(1),
  status: z.string().min(1),
  outcomeKind: z.string().nullable(),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export const landscapeCurationJobSchema = z.object({
  id: z.string().min(1),
  reviewItemId: z.string().min(1).nullable(),
  findingType: landscapeCurationFindingTypeSchema,
  subjectKnowledgeId: z.string().min(1),
  candidateKnowledgeIds: z.array(z.string().min(1)).max(5),
  status: landscapeCurationJobStatusSchema,
  phase: landscapeCurationPhaseSchema,
  decision: landscapeCurationDecisionSchema.nullable(),
  disposition: landscapeCurationDispositionSchema.nullable(),
  priority: z.number().int().min(0).max(100),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  lastError: z.string().nullable(),
  lastOutcomeKind: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime().nullable(),
});

export type LandscapeCurationFindingType = z.infer<typeof landscapeCurationFindingTypeSchema>;
export type LandscapeCurationDecision = z.infer<typeof landscapeCurationDecisionSchema>;
export type LandscapeCurationPhase = z.infer<typeof landscapeCurationPhaseSchema>;
export type LandscapeCurationDisposition = z.infer<typeof landscapeCurationDispositionSchema>;
export type LandscapeCurationReleaseMode = z.infer<typeof landscapeCurationReleaseModeSchema>;
export type LandscapeCurationRollbackStatus = z.infer<typeof landscapeCurationRollbackStatusSchema>;
export type LandscapeCurationPolicyReasonCode = z.infer<
  typeof landscapeCurationPolicyReasonCodeSchema
>;
export type LandscapeCurationLinkRole = z.infer<typeof landscapeCurationLinkRoleSchema>;
export type LandscapeCurationInputSnapshotV1 = z.infer<typeof landscapeCurationInputSnapshotSchema>;
export type LandscapeCurationResultV1 = z.infer<typeof landscapeCurationResultSchema>;
export type LandscapeCurationPolicyResultV1 = z.infer<typeof landscapeCurationPolicyResultSchema>;
export type LandscapeCurationJob = z.infer<typeof landscapeCurationJobSchema>;
export type LandscapeCurationJobLink = z.infer<typeof landscapeCurationJobLinkSchema>;
