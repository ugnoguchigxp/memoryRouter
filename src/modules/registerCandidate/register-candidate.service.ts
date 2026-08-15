import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { resolveDatabaseBackendConfig } from "../../db/backend.js";
import { db } from "../../db/index.js";
import {
  coveringEvidenceQueue,
  distillationTargetStates,
  findCandidateResults,
  findingCandidateQueue,
  foundCandidates,
} from "../../db/schema.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { registerCandidateInputSchema } from "../../shared/schemas/knowledge.schema.js";
import { registerCandidatesBulkInputSchema } from "../../shared/schemas/knowledge.schema.js";
import {
  type ResolvedProjectScopedWriteIdentity,
  recordProjectScopedWritePersisted,
  resolveAuditedProjectScopedWriteIdentity,
} from "../context-compiler/project-scoped-write.js";
import { hasSkillLikeProcedureBody } from "../distillation/procedure-quality.js";
import { resolveKnowledgeCandidatePriorityGroup } from "../distillationTarget/priority-group.js";
import { DEFAULT_DISTILLATION_TARGET_VERSION } from "../distillationTarget/repository.js";
import { parseStorageCandidatesFromLlmOutput } from "../findCandidate/parser.js";
import type {
  CandidateKnowledgePolarity,
  CandidateKnowledgeType,
} from "../findCandidate/repository.js";
import { type KnowledgeApplicability, normalizeApplicability } from "../knowledge/applicability.js";
import { appendQueueEvent } from "../queue/core/events.js";

export type RegisterCandidateInput = z.input<typeof registerCandidateInputSchema>;

export type RegisterCandidateWarning =
  | "text_parsed_to_candidate_json"
  | "text_contained_multiple_candidates_registered_first"
  | "procedure_candidate_missing_skill_like_sections";

export type RegisterCandidateResult = {
  targetStateId: string;
  findCandidateResultId: string;
  findingJobId?: string;
  sourceUri: string;
  status: "candidate_registered";
  title: string;
  type: CandidateKnowledgeType;
  warnings: RegisterCandidateWarning[];
  next: "distillation_pipeline";
};

export type RegisterCandidatesBulkItemResult = {
  index: number;
  status: "candidate_registered" | "candidate_failed";
  title?: string;
  type?: CandidateKnowledgeType;
  targetStateId?: string;
  findCandidateResultId?: string;
  findingJobId?: string;
  sourceUri?: string;
  warnings?: RegisterCandidateWarning[];
  error?: string;
};

export type RegisterCandidatesBulkResult = {
  status: "bulk_candidates_registered" | "bulk_candidates_partial" | "bulk_candidates_failed";
  registeredCount: number;
  failedCount: number;
  items: RegisterCandidatesBulkItemResult[];
  next: "distillation_pipeline";
};

type RegisterCandidateOptions = {
  strictProcedureSections?: boolean;
};

const PROCEDURE_SECTION_WARNING: RegisterCandidateWarning =
  "procedure_candidate_missing_skill_like_sections";
const PROCEDURE_SECTION_VALIDATION_ERROR = "PROCEDURE_CANDIDATE_MISSING_SKILL_LIKE_SECTIONS";

function inferTitleFromText(value: string): string {
  const lines = value
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const titleLine =
    heading?.replace(/^#{1,6}\s+/, "") ??
    lines.find((line) => /^title\s*:/i.test(line))?.replace(/^title\s*:\s*/i, "") ??
    lines[0] ??
    "Registered candidate";
  return titleLine
    .replace(/^[-*]\s+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
}

function hasProcedureAvoidSection(body: string): boolean {
  return /^Avoid:\s*$/im.test(body) || /^Avoid:\s+\S/im.test(body);
}

function parseRegistrationTextCandidates(input: RegisterCandidateInput) {
  if (!input.text) return [];
  const strictCandidates = parseStorageCandidatesFromLlmOutput(input.text);
  if (strictCandidates.length > 0) return strictCandidates;

  const parsed = parseLlmJsonLike(input.text)?.value;
  if (!parsed || typeof parsed !== "object") return strictCandidates;
  const withDefaults = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return {
      ...record,
      type: record.type ?? record.candidateType ?? input.type ?? "rule",
      polarity: record.polarity ?? input.polarity ?? "positive",
    };
  };
  const defaulted = Array.isArray(parsed)
    ? parsed.map(withDefaults)
    : "candidates" in parsed && Array.isArray(parsed.candidates)
      ? { ...parsed, candidates: parsed.candidates.map(withDefaults) }
      : "candidate" in parsed
        ? { ...parsed, candidate: withDefaults(parsed.candidate) }
        : withDefaults(parsed);
  return parseStorageCandidatesFromLlmOutput(JSON.stringify(defaulted));
}

function bodyWithProcedureAvoidSection(params: {
  body: string;
  type: CandidateKnowledgeType;
  polarity: CandidateKnowledgePolarity;
  avoid?: string;
}): string {
  if (params.polarity === "negative" || params.type !== "procedure" || !params.avoid) {
    return params.body;
  }
  if (hasProcedureAvoidSection(params.body)) return params.body;
  return `${params.body.trimEnd()}\n\nAvoid:\n- ${params.avoid}`;
}

function normalizeInput(input: RegisterCandidateInput): {
  title: string;
  body: string;
  type: CandidateKnowledgeType;
  originalType?: CandidateKnowledgeType;
  polarity: CandidateKnowledgePolarity;
  intentTags: string[];
  applicability: KnowledgeApplicability;
  warnings: RegisterCandidateWarning[];
} {
  const warnings: RegisterCandidateWarning[] = [];
  const textCandidates = parseRegistrationTextCandidates(input);
  const parsedCandidate = textCandidates[0];
  if (parsedCandidate) {
    warnings.push("text_parsed_to_candidate_json");
  }
  if (textCandidates.length > 1) {
    warnings.push("text_contained_multiple_candidates_registered_first");
  }

  const originalType = input.type ?? parsedCandidate?.type ?? "rule";
  const rawPolarity = input.polarity ?? parsedCandidate?.polarity ?? "positive";
  const polarity: CandidateKnowledgePolarity = rawPolarity === "negative" ? "negative" : "positive";
  const rawBody =
    input.body ??
    parsedCandidate?.content ??
    input.text ??
    (polarity === "negative" && input.avoid && input.prefer
      ? `避けること: ${input.avoid}\n推奨: ${input.prefer}`
      : "");
  const type = polarity === "negative" && originalType === "procedure" ? "rule" : originalType;
  const body = bodyWithProcedureAvoidSection({
    body: rawBody,
    type,
    polarity,
    avoid: input.avoid,
  });
  const title = input.title ?? parsedCandidate?.title ?? inferTitleFromText(body);
  const intentTags = input.intentTags ?? [];
  const applicability = normalizeApplicability(input) ?? {};
  if (type === "procedure" && !hasSkillLikeProcedureBody(body)) {
    warnings.push("procedure_candidate_missing_skill_like_sections");
  }

  return {
    title,
    body,
    type,
    ...(originalType !== type ? { originalType } : {}),
    polarity,
    intentTags,
    applicability,
    warnings,
  };
}

function compactOrigin(
  input: RegisterCandidateInput,
  normalized: {
    type: CandidateKnowledgeType;
    originalType?: CandidateKnowledgeType;
    polarity: CandidateKnowledgePolarity;
    intentTags: string[];
    applicability: KnowledgeApplicability;
  },
  identity: ResolvedProjectScopedWriteIdentity,
) {
  const applicability = normalized.applicability;
  return {
    source: "mcp_register_candidate",
    registeredAt: new Date().toISOString(),
    candidateType: normalized.type,
    projectIdentity: identity,
    ...(normalized.originalType ? { originalCandidateType: normalized.originalType } : {}),
    polarity: normalized.polarity,
    ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(input.importance !== undefined ? { importance: input.importance } : {}),
    ...(Object.keys(applicability).length > 0 ? { appliesTo: applicability } : {}),
    ...(applicability.general !== undefined ? { general: applicability.general } : {}),
    ...(applicability.technologies ? { technologies: applicability.technologies } : {}),
    ...(applicability.changeTypes ? { changeTypes: applicability.changeTypes } : {}),
    ...(applicability.domains ? { domains: applicability.domains } : {}),
    ...(applicability.repoPath ? { repoPath: applicability.repoPath } : {}),
    ...(applicability.repoKey ? { repoKey: applicability.repoKey } : {}),
    ...(Object.keys(input.metadata ?? {}).length > 0 ? { metadata: input.metadata } : {}),
  };
}

export async function registerCandidate(
  input: RegisterCandidateInput,
  options: RegisterCandidateOptions = {},
): Promise<RegisterCandidateResult> {
  const parsed = registerCandidateInputSchema.parse(input);
  const normalized = normalizeInput(parsed);
  if (options.strictProcedureSections && normalized.warnings.includes(PROCEDURE_SECTION_WARNING)) {
    throw new Error(PROCEDURE_SECTION_VALIDATION_ERROR);
  }
  const identity = await resolveAuditedProjectScopedWriteIdentity(
    {
      scope: parsed.scope,
      projectRef: parsed.projectRef,
      repoKey: normalized.applicability.repoKey,
      repoPath: normalized.applicability.repoPath,
    },
    {
      producer: "register-candidate.typescript",
      entityKind: "candidate",
      actor: "agent",
    },
  );
  const candidateId = randomUUID();
  const sourceUri = `agent://candidate/${candidateId}`;
  const now = new Date();
  const hasApplicability = Object.keys(normalized.applicability).length > 0;
  if (resolveDatabaseBackendConfig().kind === "sqlite") {
    const { getRuntimeSqliteCoreDatabase } = await import("../../db/sqlite/runtime.js");
    const sqlite = await getRuntimeSqliteCoreDatabase();
    const targetStateId = randomUUID();
    const findCandidateResultId = randomUUID();
    const findingJobId = randomUUID();
    const foundCandidateId = randomUUID();
    const coveringJobId = randomUUID();
    const origin = compactOrigin(parsed, normalized, identity);
    const targetMetadata = {
      ...(parsed.metadata ?? {}),
      source: "mcp_register_candidate",
      registeredAt: now.toISOString(),
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    } satisfies Record<string, unknown>;
    const priorityGroup = resolveKnowledgeCandidatePriorityGroup({
      sourceUri,
      metadata: targetMetadata,
    });
    const payload = {
      title: normalized.title,
      body: normalized.body,
      type: normalized.type,
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
      origin,
      legacyTargetStateId: targetStateId,
      legacyFindCandidateResultId: findCandidateResultId,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    };
    const findingMetadata = {
      source: "mcp_register_candidate",
      registeredAt: now.toISOString(),
      legacyTargetStateId: targetStateId,
      legacyFindCandidateResultId: findCandidateResultId,
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    };
    const candidateMetadata = {
      sourceKind: "knowledge_candidate",
      sourceKey: candidateId,
      sourceUri,
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    };
    sqlite.db.exec("BEGIN IMMEDIATE");
    try {
      sqlite.db
        .query(
          `insert into distillation_target_states (
             id, target_kind, target_key, source_uri, distillation_version,
             status, phase, priority_group, sort_key, metadata, created_at, updated_at
           ) values (?, 'knowledge_candidate', ?, ?, ?, 'pending', 'selected', ?, ?, ?, ?, ?)`,
        )
        .run(
          targetStateId,
          candidateId,
          sourceUri,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          priorityGroup,
          now.toISOString(),
          JSON.stringify(targetMetadata),
          now.toISOString(),
          now.toISOString(),
        );
      sqlite.db
        .query(
          `insert into find_candidate_results (
             id, target_state_id, candidate_index, title, content, origin, status, created_at, updated_at
           ) values (?, ?, 0, ?, ?, ?, 'selected', ?, ?)`,
        )
        .run(
          findCandidateResultId,
          targetStateId,
          normalized.title,
          normalized.body,
          JSON.stringify(origin),
          now.toISOString(),
          now.toISOString(),
        );
      sqlite.db
        .query(
          `insert into finding_candidate_queue (
             id, input_kind, source_kind, source_key, source_uri, distillation_version,
             status, priority, payload, metadata, completed_at, last_outcome_kind, created_at, updated_at
           ) values (?, 'provided_candidate', 'knowledge_candidate', ?, ?, ?,
             'completed', 90, ?, ?, ?, 'provided_candidate_registered', ?, ?)`,
        )
        .run(
          findingJobId,
          candidateId,
          sourceUri,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          JSON.stringify(payload),
          JSON.stringify(findingMetadata),
          now.toISOString(),
          now.toISOString(),
          now.toISOString(),
        );
      sqlite.db
        .query(
          `insert into found_candidates (
             id, finding_job_id, candidate_index, type, title, content, origin, metadata, created_at, updated_at
           ) values (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          foundCandidateId,
          findingJobId,
          normalized.type,
          normalized.title,
          normalized.body,
          JSON.stringify(origin),
          JSON.stringify(candidateMetadata),
          now.toISOString(),
          now.toISOString(),
        );
      sqlite.db
        .query(
          `insert into covering_evidence_queue (
             id, found_candidate_id, distillation_version, status, priority,
             provider_policy, payload, metadata, created_at, updated_at
           ) values (?, ?, ?, 'pending', 90, 'default', '{}', ?, ?, ?)`,
        )
        .run(
          coveringJobId,
          foundCandidateId,
          DEFAULT_DISTILLATION_TARGET_VERSION,
          JSON.stringify({ projectIdentity: identity }),
          now.toISOString(),
          now.toISOString(),
        );
      sqlite.db.exec("COMMIT");
    } catch (error) {
      sqlite.db.exec("ROLLBACK");
      throw error;
    }
    await recordProjectScopedWritePersisted(identity, {
      producer: "register-candidate.typescript",
      entityKind: "candidate",
      entityId: foundCandidateId,
      actor: "agent",
    });
    await appendQueueEvent({
      queueName: "findingCandidate",
      queueJobId: findingJobId,
      eventType: "completed",
      message: "provided candidate persisted to candidate pipeline",
      metadata: { sourceKind: "knowledge_candidate", sourceKey: candidateId, foundCandidateId },
    });
    await appendQueueEvent({
      queueName: "coveringEvidence",
      queueJobId: coveringJobId,
      eventType: "enqueued",
      message: "covering job enqueued from register-candidate",
      metadata: { foundCandidateId, findingJobId },
    });
    return {
      targetStateId,
      findCandidateResultId,
      findingJobId,
      sourceUri,
      status: "candidate_registered",
      title: normalized.title,
      type: normalized.type,
      warnings: normalized.warnings,
      next: "distillation_pipeline",
    };
  }

  const targetMetadata = {
    ...(parsed.metadata ?? {}),
    source: "mcp_register_candidate",
    registeredAt: now.toISOString(),
    polarity: normalized.polarity,
    projectIdentity: identity,
    ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
  } satisfies Record<string, unknown>;
  const priorityGroup = resolveKnowledgeCandidatePriorityGroup({
    sourceUri,
    metadata: targetMetadata,
  });

  const result = await db.transaction(async (tx) => {
    const [target] = await tx
      .insert(distillationTargetStates)
      .values({
        targetKind: "knowledge_candidate",
        targetKey: candidateId,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        phase: "selected",
        priorityGroup,
        sortKey: now.toISOString(),
        metadata: targetMetadata,
        updatedAt: now,
      })
      .returning();

    if (!target) throw new Error("failed to create candidate target state");

    const [candidate] = await tx
      .insert(findCandidateResults)
      .values({
        targetStateId: target.id,
        candidateIndex: 0,
        title: normalized.title,
        content: normalized.body,
        origin: compactOrigin(parsed, normalized, identity),
        status: "selected",
        updatedAt: now,
      })
      .returning();

    if (!candidate) throw new Error("failed to create candidate result");

    const payload = {
      title: normalized.title,
      body: normalized.body,
      type: normalized.type,
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
      origin: compactOrigin(parsed, normalized, identity),
      legacyTargetStateId: target.id,
      legacyFindCandidateResultId: candidate.id,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
    };

    const metadata = {
      source: "mcp_register_candidate",
      registeredAt: now.toISOString(),
      legacyTargetStateId: target.id,
      legacyFindCandidateResultId: candidate.id,
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    };

    const [findingJob] = await tx
      .insert(findingCandidateQueue)
      .values({
        inputKind: "provided_candidate",
        sourceKind: "knowledge_candidate",
        sourceKey: candidateId,
        sourceUri,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        payload,
        metadata,
        priority: 90,
        status: "completed",
        completedAt: now,
        lastOutcomeKind: "provided_candidate_registered",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          findingCandidateQueue.inputKind,
          findingCandidateQueue.sourceKind,
          findingCandidateQueue.sourceKey,
          findingCandidateQueue.distillationVersion,
        ],
        set: {
          sourceUri,
          payload,
          metadata,
          priority: 90,
          status: "completed",
          completedAt: now,
          lastOutcomeKind: "provided_candidate_registered",
          updatedAt: now,
        },
      })
      .returning();

    if (!findingJob) throw new Error("failed to create V2 finding job");

    const origin = compactOrigin(parsed, normalized, identity);
    const candidateMetadata = {
      sourceKind: "knowledge_candidate",
      sourceKey: candidateId,
      sourceUri,
      polarity: normalized.polarity,
      projectIdentity: identity,
      ...(normalized.intentTags.length > 0 ? { intentTags: normalized.intentTags } : {}),
      ...(hasApplicability ? { appliesTo: normalized.applicability } : {}),
    };

    const [foundCandidate] = await tx
      .insert(foundCandidates)
      .values({
        findingJobId: findingJob.id,
        candidateIndex: 0,
        type: normalized.type,
        title: normalized.title,
        content: normalized.body,
        origin,
        metadata: candidateMetadata,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [foundCandidates.findingJobId, foundCandidates.candidateIndex],
        set: {
          type: normalized.type,
          title: normalized.title,
          content: normalized.body,
          origin,
          metadata: candidateMetadata,
          updatedAt: now,
        },
      })
      .returning();

    if (!foundCandidate) throw new Error("failed to create V2 found candidate");

    const [coveringJob] = await tx
      .insert(coveringEvidenceQueue)
      .values({
        foundCandidateId: foundCandidate.id,
        distillationVersion: DEFAULT_DISTILLATION_TARGET_VERSION,
        status: "pending",
        priority: 90,
        providerPolicy: "default",
        payload: {},
        metadata: { projectIdentity: identity },
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: coveringEvidenceQueue.foundCandidateId,
        set: {
          status: "pending",
          priority: 90,
          completedAt: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          lastError: null,
          lastOutcomeKind: null,
          metadata: { projectIdentity: identity },
          updatedAt: now,
        },
      })
      .returning();

    if (!coveringJob) throw new Error("failed to create V2 covering job");

    return { target, candidate, findingJob, foundCandidate, coveringJob };
  });

  await recordProjectScopedWritePersisted(identity, {
    producer: "register-candidate.typescript",
    entityKind: "candidate",
    entityId: result.foundCandidate.id,
    actor: "agent",
  });

  await appendQueueEvent({
    queueName: "findingCandidate",
    queueJobId: result.findingJob.id,
    eventType: "completed",
    message: "provided candidate registered synchronously (finding skipped)",
    metadata: {
      sourceKind: "knowledge_candidate",
      sourceKey: candidateId,
      inputKind: "provided_candidate",
      foundCandidateId: result.foundCandidate.id,
    },
  });

  await appendQueueEvent({
    queueName: "coveringEvidence",
    queueJobId: result.coveringJob.id,
    eventType: "enqueued",
    message: "covering job enqueued from synchronous register-candidate",
    metadata: {
      foundCandidateId: result.foundCandidate.id,
      findingJobId: result.findingJob.id,
    },
  });

  return {
    targetStateId: result.target.id,
    findCandidateResultId: result.candidate.id,
    findingJobId: result.findingJob.id,
    sourceUri,
    status: "candidate_registered",
    title: normalized.title,
    type: normalized.type,
    warnings: normalized.warnings,
    next: "distillation_pipeline",
  };
}

export async function registerCandidatesBulk(
  input: RegisterCandidateInput[],
  options: RegisterCandidateOptions = {},
): Promise<RegisterCandidatesBulkResult> {
  const parsed = registerCandidatesBulkInputSchema.parse(input);
  const bulkBatchId = randomUUID();
  const bulkCount = parsed.length;
  const items: RegisterCandidatesBulkItemResult[] = [];
  let registeredCount = 0;

  for (let index = 0; index < parsed.length; index += 1) {
    const item = parsed[index];
    const metadata = {
      ...(item.metadata ?? {}),
      bulkBatchId,
      bulkIndex: index,
      bulkCount,
      bulkSource: "mcp_register_candidates",
      inputTypeProvided: item.type !== undefined,
    };
    const normalized: RegisterCandidateInput = {
      ...item,
      ...(item.type ? {} : { type: "rule" }),
      metadata,
    };

    try {
      const result = await registerCandidate(normalized, options);
      registeredCount += 1;
      items.push({
        index,
        status: "candidate_registered",
        title: result.title,
        type: result.type,
        targetStateId: result.targetStateId,
        findCandidateResultId: result.findCandidateResultId,
        findingJobId: result.findingJobId,
        sourceUri: result.sourceUri,
        warnings: result.warnings,
      });
    } catch (error) {
      items.push({
        index,
        status: "candidate_failed",
        title: normalized.title,
        type: normalized.type as CandidateKnowledgeType | undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failedCount = bulkCount - registeredCount;
  const status =
    registeredCount === bulkCount
      ? "bulk_candidates_registered"
      : registeredCount > 0
        ? "bulk_candidates_partial"
        : "bulk_candidates_failed";

  return {
    status,
    registeredCount,
    failedCount,
    items,
    next: "distillation_pipeline",
  };
}
