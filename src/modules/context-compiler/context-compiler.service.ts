import { groupedConfig } from "../../config.js";
import type { CompileRunSource } from "../../shared/schemas/compile-run.schema.js";
import {
  compileInputSchema,
  deriveRetrievalModeFromChangeTypes,
} from "../../shared/schemas/compile.schema.js";
import { type ContextPack, contextPackSchema } from "../../shared/schemas/context-pack.schema.js";
import { asRecord, asStringArray } from "../../shared/utils/normalize.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import { recordEpisodeUsage } from "../episodic-memory/episode-card.service.js";
import { normalizeKnowledgeApplicability } from "../knowledge/applicability.service.js";
import { recordKnowledgeCompileSelectionSafe } from "../knowledge/knowledge-value.service.js";
import { retrieveKnowledge } from "../knowledge/knowledge.service.js";
import {
  applyLandscapeCompileIntervention,
  isLandscapeCompileInterventionEnabled,
} from "../landscape/landscape-compile-intervention.service.js";
import {
  type SecurityIntelligenceShadowResult,
  collectSecurityIntelligenceShadowRetrieval,
} from "../security-intelligence/shadow-retrieval.service.js";
import { retrieveSources } from "../sources/source-retrieval.service.js";
import { agenticRefine } from "./agentic-refine.service.js";
import { resolveCompileProjectIdentity } from "./compile-project-identity.js";
import { CONTEXT_COMPILE_LIMITS, CONTEXT_COMPILE_SECTION_RATIOS } from "./compiler-contracts.js";
import type { KnowledgeRankable } from "./compiler-diagnostics.js";
import {
  buildEmbeddingTraceDiagnostics,
  buildInputFacets,
  classifyCompileReasons,
  filterBenignNegativeKnowledgeReasons,
  filterByCandidateEvidence,
  firstAvailableKnowledgeEmbedding,
  goalContainsDesignDocumentReference,
  pushUnique,
  resolveKnowledgeTaskTraceEmbeddingStatus,
} from "./compiler-diagnostics.js";
import { episodeToPackItem, retrieveEpisodePrecedents } from "./compiler-episodes.js";
import {
  attachOutputMarkdownToPack,
  buildFallbackSourceRef,
  buildMinimalTasks,
  formatSourceRef,
  legacyIntentFromRetrievalMode,
  normalizeKnowledgeStatus,
  normalizeKnowledgeType,
  selectSourceRefsForKnowledge,
  toKnowledgePackItem,
} from "./compiler-pack.js";
import {
  persistCompileTaskTraceSafe,
  recordCompileRunKnowledgeUsageSignalsSafe,
  updateCompileRunFailureSafe,
  updateCompileRunSnapshotSafe,
} from "./compiler-persistence.js";
import {
  buildCandidateTraceRows,
  mergeCompileRetrievalTraceEntries,
  mergeUtilityTraceCandidates,
  persistCandidateTraceRows,
} from "./compiler-traces.js";
import { insertCompileRun, insertContextPackItems } from "./context-compiler.repository.js";
import { composeContextResponse } from "./context-response-composer.service.js";
import { suppressNearDuplicateKnowledge } from "./duplicate-suppression.service.js";
import { renderContextPackMarkdown } from "./pack-renderer.js";
import { rankAndDedupe } from "./ranking.service.js";
import { buildRepositorySelectionScopeSnapshot } from "./repository-scope.js";
import { applySectionTokenBudget } from "./token-budget.js";
import { collectUtilityTraceCandidates } from "./utility-retrieval.service.js";

export async function compileContextPack(
  rawInput: unknown,
  options?: { source?: CompileRunSource; sessionId?: string },
): Promise<{
  pack: ContextPack;
  markdown: string;
  securityIntelligenceShadow?: SecurityIntelligenceShadowResult;
}> {
  const compileStartedAt = Date.now();
  const input = compileInputSchema.parse(rawInput);
  const projectIdentity = resolveCompileProjectIdentity(input);
  const retrievalMode =
    input.retrievalMode ?? deriveRetrievalModeFromChangeTypes(input.changeTypes);
  const tokenBudget = input.tokenBudget ?? groupedConfig.compile.defaultTokenBudget;
  const candidateTraceLimit = groupedConfig.compile.candidateTraceLimit;
  const persistedInput = {
    goal: input.goal,
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.retrievalMode ? { retrievalMode: input.retrievalMode } : {}),
    ...(input.changeTypes ? { changeTypes: input.changeTypes } : {}),
    ...(input.technologies ? { technologies: input.technologies } : {}),
    ...(input.domains ? { domains: input.domains } : {}),
    ...(input.files ? { files: input.files } : {}),
    ...(projectIdentity.projectRef ? { projectRef: projectIdentity.projectRef } : {}),
    ...(projectIdentity.repoPath ? { repoPath: projectIdentity.repoPath } : {}),
    ...(projectIdentity.repoKey ? { repoKey: projectIdentity.repoKey } : {}),
    ...(input.includeDraft !== undefined ? { includeDraft: input.includeDraft } : {}),
    ...(input.tokenBudget ? { tokenBudget: input.tokenBudget } : {}),
    ...(input.securityIntelligenceShadow
      ? { securityIntelligenceShadow: input.securityIntelligenceShadow }
      : {}),
    projectIdentity,
  };

  const normalizedApplicability = await normalizeKnowledgeApplicability({
    technologies: input.technologies,
    changeTypes: input.changeTypes,
    domains: input.domains,
  });

  const matchedTechnologies = asStringArray(normalizedApplicability.appliesTo.technologies);
  const matchedChangeTypes = asStringArray(normalizedApplicability.appliesTo.changeTypes);
  const matchedDomains = asStringArray(normalizedApplicability.appliesTo.domains);
  const unknownFacetsByKind = normalizedApplicability.unknownTagCandidates.reduce<
    Record<string, string[]>
  >((acc, candidate) => {
    const current = acc[candidate.kind] ?? [];
    if (!current.includes(candidate.value)) current.push(candidate.value);
    acc[candidate.kind] = current;
    return acc;
  }, {});

  const inputFacets = buildInputFacets({
    input,
    matchedChangeTypes,
    matchedTechnologies,
    matchedDomains,
    unknownFacetsByKind,
  });

  if (goalContainsDesignDocumentReference(input.goal)) {
    const degradedReasons = ["GOAL_CONTAINS_DESIGN_DOCUMENT_REFERENCE"];
    const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
    const reasonBuckets = classifyCompileReasons({
      reasons: degradedReasons,
      selectedKnowledgeCount: 0,
    });
    const runId = await insertCompileRun({
      goal: input.goal,
      intent: legacyIntentFromRetrievalMode(retrievalMode),
      sessionId: options?.sessionId,
      projectRef: projectIdentity.projectRef,
      repoKey: projectIdentity.repoKey,
      repoPath: projectIdentity.repoPath ?? undefined,
      matchBasis: projectIdentity.matchBasis,
      identityContractVersion: projectIdentity.contractVersion,
      scopeMode: projectIdentity.scopeMode,
      input: persistedInput,
      retrievalMode,
      status: "degraded",
      degradedReasons,
      tokenBudget,
      durationMs: compileDurationMs,
      source: options?.source ?? "unknown",
    });
    await persistCompileTaskTraceSafe({
      runId,
      retrievalMode,
      projectRef: projectIdentity.projectRef,
      repoPath: projectIdentity.repoPath,
      repoKey: projectIdentity.repoKey,
      matchBasis: projectIdentity.matchBasis,
      identityContractVersion: projectIdentity.contractVersion,
      scopeMode: projectIdentity.scopeMode,
      identityFingerprint: projectIdentity.identityFingerprint,
      identityTrust: projectIdentity.trust,
      bindingStatus: projectIdentity.bindingStatus,
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
      goal: input.goal,
      embeddingStatus: "facets_only",
      embeddingProvider: null,
      embeddingModel: null,
      embeddingDimensions: null,
      embedding: null,
    });

    const pack = contextPackSchema.parse({
      runId,
      goal: input.goal,
      retrievalMode,
      status: "degraded",
      minimalTasks: buildMinimalTasks(retrievalMode),
      rules: [],
      procedures: [],
      warnings: [],
      sourceRefs: [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })],
      diagnostics: {
        degradedReasons,
        retrievalStats: {
          knowledge: { skipped: true, reason: "goal_design_document_reference" },
          sources: { skipped: true, reason: "goal_design_document_reference" },
          episodes: { skipped: true, reason: "goal_design_document_reference" },
          tokenBudget,
          compileDurationMs,
          candidateTraceSavedCount: 0,
          candidateTraceTruncated: false,
          candidateTraceLimit,
          candidateTraceSkippedReason: "goal_design_document_reference",
          agenticUsed: false,
          reasonBuckets: {
            blocking: reasonBuckets.blockingReasons,
            maintenanceWarnings: reasonBuckets.maintenanceWarnings,
            hardFailures: reasonBuckets.hardFailureReasons,
          },
          suggestedNextCalls: [],
        },
        inputFacets,
      },
    });

    const markdown = renderContextPackMarkdown(pack);
    const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);
    await updateCompileRunSnapshotSafe(runId, packWithMarkdown);
    await recordKnowledgeCompileSelectionSafe({
      runId,
      selectedKnowledgeIds: [],
      agenticAcceptedKnowledgeIds: [],
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.contextCompileRun,
      actor: "agent",
      payload: {
        runId,
        goal: input.goal,
        retrievalMode,
        status: "degraded",
        degradedReasons,
        tokenBudget,
        compileDurationMs,
        source: options?.source ?? "unknown",
        selectedCounts: { rules: 0, procedures: 0, guardrails: 0 },
      },
    });

    const securityIntelligenceShadow = await collectSecurityIntelligenceShadowRetrieval({
      compileRunRef: runId,
      compileInput: input,
      retrievalMode,
      facets: {
        technologies: matchedTechnologies,
        changeTypes: matchedChangeTypes,
        domains: matchedDomains,
      },
    });
    return {
      pack: packWithMarkdown,
      markdown,
      ...(securityIntelligenceShadow ? { securityIntelligenceShadow } : {}),
    };
  }

  const [positiveKnowledge, negativeKnowledge, sourceContext, episodePrecedents] =
    await Promise.all([
      retrieveKnowledge(input, {
        retrievalMode,
        polarities: ["positive"],
        facetFilters: {
          technologies: matchedTechnologies,
          changeTypes: matchedChangeTypes,
          domains: matchedDomains,
        },
      }),
      retrieveKnowledge(input, {
        retrievalMode,
        polarities: ["negative"],
        facetFilters: {
          technologies: matchedTechnologies,
          changeTypes: matchedChangeTypes,
          domains: matchedDomains,
        },
      }),
      retrieveSources(input, { retrievalMode }),
      retrieveEpisodePrecedents({
        input,
        technologies: matchedTechnologies,
        changeTypes: matchedChangeTypes,
        domains: matchedDomains,
      }),
    ]);

  const degradedReasons = [
    ...positiveKnowledge.degradedReasons,
    ...filterBenignNegativeKnowledgeReasons(negativeKnowledge.degradedReasons),
    ...sourceContext.degradedReasons,
  ];

  const combinedItems = [...positiveKnowledge.items, ...negativeKnowledge.items];

  const rankedKnowledgeBeforeIntervention = rankAndDedupe<KnowledgeRankable>(
    combinedItems.map((item) => {
      const applicability = asRecord(item.appliesTo);
      const metadata = asRecord(item.metadata);
      const technologies = asStringArray(applicability.technologies);
      const changeTypes = asStringArray(applicability.changeTypes);
      const domains = asStringArray(applicability.domains);
      return {
        id: item.id,
        title: item.title,
        content: item.body,
        score: item.score,
        confidence: item.confidence,
        importance: item.importance,
        dynamicScore: item.dynamicScore,
        decayFactor: item.decayFactor,
        type: normalizeKnowledgeType(item.type),
        status: normalizeKnowledgeStatus(item.status),
        sourceRefs: item.sourceRefs,
        sourceRefCount: item.sourceRefs.length,
        hasSourceLinks: item.hasSourceLinks,
        stale: item.status === "deprecated",
        applicabilityScore: item.applicabilityScore,
        candidateEvidence: item.candidateEvidence,
        polarity: item.polarity ?? "positive",
        scopeSnapshot: buildRepositorySelectionScopeSnapshot(
          {
            id: item.id,
            entityKind: "knowledge",
            status: item.status,
            classificationStatus: item.classificationStatus ?? "unresolved",
            scope: item.scope,
            projectRef: item.projectRef ?? null,
            repoKey: item.repoKey ?? null,
            repoPath: item.repoPath ?? null,
            general:
              applicability.general === true ||
              (technologies.length === 0 && changeTypes.length === 0 && domains.length === 0),
            facets: { technologies, changeTypes, domains },
            producer: typeof metadata.producer === "string" ? metadata.producer : "knowledge",
          },
          projectIdentity,
          {
            technologies: matchedTechnologies,
            changeTypes: matchedChangeTypes,
            domains: matchedDomains,
          },
        ),
      };
    }),
    isLandscapeCompileInterventionEnabled() ? 24 : CONTEXT_COMPILE_LIMITS.normalRankingLimit,
  );
  const landscapeIntervention = applyLandscapeCompileIntervention(
    rankedKnowledgeBeforeIntervention,
    { limit: CONTEXT_COMPILE_LIMITS.normalRankingLimit },
  );
  const rankedKnowledge = landscapeIntervention.items;

  const knowledgeFilterResult = filterByCandidateEvidence(rankedKnowledge);
  const filteredKnowledge = knowledgeFilterResult.items;
  const duplicateSuppression = suppressNearDuplicateKnowledge(filteredKnowledge);
  const compressedKnowledge = duplicateSuppression.items;
  if (knowledgeFilterResult.suppressedCount > 0) {
    pushUnique(degradedReasons, "LOW_CONFIDENCE_VECTOR_ONLY_SUPPRESSED");
  }
  if (
    rankedKnowledge.length > 0 &&
    compressedKnowledge.length === 0 &&
    episodePrecedents.items.length === 0
  ) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const agenticResult = await agenticRefine(
    compressedKnowledge.map((item) => ({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs: item.sourceRefs,
      polarity:
        item.polarity === "negative" || item.polarity === "neutral" ? item.polarity : "positive",
      section:
        item.polarity === "negative"
          ? "guardrails"
          : item.type === "procedure"
            ? "procedures"
            : "rules",
    })),
    input,
    retrievalMode,
  );

  if (agenticResult.error) {
    console.warn(
      "[compileContextPack] agenticRefine failed, but falling back gracefully to original candidates. Error:",
      agenticResult.error,
    );
    if (agenticResult.error === "AGENTIC_REFINE_SKIPPED_RATE_LIMIT") {
      pushUnique(degradedReasons, "OPENAI_RATE_LIMIT_COOLDOWN_ACTIVE");
      pushUnique(degradedReasons, "AGENTIC_REFINE_SKIPPED_RATE_LIMIT");
    } else {
      pushUnique(degradedReasons, "AGENTIC_REFINE_FAILED");
    }
  }

  const refinedKnowledgeMap = new Map(compressedKnowledge.map((k) => [k.id, k]));
  const finalKnowledge = agenticResult.items
    .map((item) => refinedKnowledgeMap.get(item.id))
    .filter((k): k is KnowledgeRankable => k !== undefined);
  if (finalKnowledge.length === 0 && episodePrecedents.items.length === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }

  const knowledgePackItems = finalKnowledge.map((item) => {
    const sourceRefs = selectSourceRefsForKnowledge(
      { title: item.title, content: item.content },
      sourceContext.items,
      item.sourceRefs,
    );
    return toKnowledgePackItem({
      id: item.id,
      type: item.type,
      status: item.status,
      title: item.title,
      content: item.content,
      score: item.score,
      sourceRefs,
      polarity: item.polarity,
      scopeSnapshot: item.scopeSnapshot,
    });
  });
  const episodePackItems = episodePrecedents.items.map((episode, index) =>
    episodeToPackItem(episode, index, projectIdentity, {
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
    }),
  );
  if (episodePrecedents.items.length > 0) {
    await recordEpisodeUsage({
      usageKind: "compile",
      episodeIds: episodePrecedents.items.map((episode) => episode.id),
    });
  }
  const packItems = [...knowledgePackItems, ...episodePackItems];

  const budgetedRules = applySectionTokenBudget(
    packItems.filter((item) => item.section === "rules"),
    Math.floor(tokenBudget * CONTEXT_COMPILE_SECTION_RATIOS.rules),
  );
  const budgetedProcedures = applySectionTokenBudget(
    packItems.filter((item) => item.section === "procedures"),
    Math.floor(tokenBudget * CONTEXT_COMPILE_SECTION_RATIOS.procedures),
  );
  const budgetedGuardrails = applySectionTokenBudget(
    packItems.filter((item) => item.section === "guardrails"),
    Math.floor(tokenBudget * CONTEXT_COMPILE_SECTION_RATIOS.guardrails),
  );

  if (budgetedRules.dropped || budgetedProcedures.dropped || budgetedGuardrails.dropped) {
    pushUnique(degradedReasons, "TOKEN_BUDGET_SECTION_LIMIT_REACHED");
  }

  const selectedPackItems = [
    ...budgetedRules.items,
    ...budgetedProcedures.items,
    ...budgetedGuardrails.items,
  ];
  const selectedKnowledgeIds = [
    ...new Set(
      selectedPackItems
        .filter((item) => item.itemKind === "rule" || item.itemKind === "procedure")
        .map((item) => item.itemId),
    ),
  ];
  const selectedPackItemCount = selectedPackItems.length;
  if (selectedPackItemCount === 0) {
    pushUnique(degradedReasons, "NO_RELEVANT_CONTEXT");
  }
  const directCandidateTraceRows = buildCandidateTraceRows({
    knowledgeItems: combinedItems.map((item) => ({
      id: item.id,
      type: normalizeKnowledgeType(item.type),
      status: normalizeKnowledgeStatus(item.status),
      score: item.score,
      metadata: item.metadata,
      candidateEvidence: item.candidateEvidence,
      scopeSnapshot: rankedKnowledgeBeforeIntervention.find((ranked) => ranked.id === item.id)
        ?.scopeSnapshot,
    })),
    rankedKnowledgeBeforeIntervention,
    filteredKnowledge: compressedKnowledge,
    finalKnowledge,
    duplicateSuppressedById: duplicateSuppression.suppressedById,
    selectedPackItems,
    retrievalTrace: {
      text: mergeCompileRetrievalTraceEntries([
        ...(positiveKnowledge.trace?.text ?? []),
        ...(negativeKnowledge.trace?.text ?? []),
      ]),
      vector: mergeCompileRetrievalTraceEntries([
        ...(positiveKnowledge.trace?.vector ?? []),
        ...(negativeKnowledge.trace?.vector ?? []),
      ]),
      merged: mergeCompileRetrievalTraceEntries([
        ...(positiveKnowledge.trace?.merged ?? []),
        ...(negativeKnowledge.trace?.merged ?? []),
      ]),
    },
    agenticUsed: agenticResult.agenticUsed,
  });
  const utilityTraceCandidates = await collectUtilityTraceCandidates({
    input,
    retrievalMode,
    selectedKnowledgeIds,
    existingCandidateIds: directCandidateTraceRows.map((row) => row.itemId),
    facets: {
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
    },
  });
  const candidateTraceRows = mergeUtilityTraceCandidates(
    directCandidateTraceRows,
    utilityTraceCandidates,
  );
  const composedResponse = await composeContextResponse({
    input,
    retrievalMode,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    guardrails: budgetedGuardrails.items,
  });
  if (composedResponse.error) {
    pushUnique(degradedReasons, "CONTEXT_RESPONSE_COMPOSE_FAILED");
    if (composedResponse.error === "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT") {
      pushUnique(degradedReasons, "OPENAI_RATE_LIMIT_COOLDOWN_ACTIVE");
      pushUnique(degradedReasons, "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT");
    }
  }
  if (composedResponse.markdown === "No Content" && selectedPackItemCount > 0) {
    pushUnique(degradedReasons, "COMPOSED_CONTEXT_NO_ALIGNMENT");
  }
  const forceNoContentDueToRateLimit =
    agenticResult.error === "AGENTIC_REFINE_SKIPPED_RATE_LIMIT" ||
    composedResponse.error === "CONTEXT_RESPONSE_COMPOSER_SKIPPED_RATE_LIMIT";
  if (forceNoContentDueToRateLimit) {
    pushUnique(degradedReasons, "CONTEXT_COMPILE_LLM_UNAVAILABLE_NO_CONTENT");
  }
  const sourceRefsCandidate = [
    ...new Set([
      ...selectedPackItems.flatMap((item) => item.sourceRefs),
      ...sourceContext.items.map((item) => formatSourceRef(item.sourceUri, item.locator)),
    ]),
  ];
  const embeddingTrace = buildEmbeddingTraceDiagnostics({
    positiveKnowledge: positiveKnowledge.stats,
    negativeKnowledge: negativeKnowledge.stats,
    sources: sourceContext.stats,
  });
  const reasonBuckets = classifyCompileReasons({
    reasons: degradedReasons,
    selectedKnowledgeCount: selectedPackItemCount,
  });
  const status =
    reasonBuckets.hardFailureReasons.length >= 2
      ? "failed"
      : reasonBuckets.blockingReasons.length > 0
        ? "degraded"
        : "ok";
  const minimalTasks = buildMinimalTasks(retrievalMode);
  const compileDurationMs = Math.max(0, Date.now() - compileStartedAt);
  const suggestedNextCalls: string[] = [];
  if (degradedReasons.includes("NO_ACTIVE_KNOWLEDGE_MATCH")) {
    suggestedNextCalls.push("search_knowledge");
  }
  if (degradedReasons.includes("NO_SOURCE_MATCH")) {
    suggestedNextCalls.push("search_memory");
  }
  if (
    degradedReasons.some(
      (reason) =>
        reason.endsWith("_FAILED") ||
        reason === "AGENTIC_REFINE_FAILED" ||
        reason === "QUERY_EMBEDDING_UNAVAILABLE" ||
        reason === "SOURCE_QUERY_EMBEDDING_UNAVAILABLE",
    )
  ) {
    suggestedNextCalls.push("doctor");
  }

  const runId = await insertCompileRun({
    goal: input.goal,
    intent: legacyIntentFromRetrievalMode(retrievalMode),
    sessionId: options?.sessionId,
    projectRef: projectIdentity.projectRef,
    repoKey: projectIdentity.repoKey,
    repoPath: projectIdentity.repoPath ?? undefined,
    matchBasis: projectIdentity.matchBasis,
    identityContractVersion: projectIdentity.contractVersion,
    scopeMode: projectIdentity.scopeMode,
    input: persistedInput,
    retrievalMode,
    status,
    degradedReasons,
    tokenBudget,
    durationMs: compileDurationMs,
    source: options?.source ?? "unknown",
  });
  const taskTraceEmbeddingStats = firstAvailableKnowledgeEmbedding(
    positiveKnowledge.stats,
    negativeKnowledge.stats,
  );
  const taskTraceEmbeddingStatus = resolveKnowledgeTaskTraceEmbeddingStatus({
    selected: taskTraceEmbeddingStats,
    positiveKnowledge: positiveKnowledge.stats,
    negativeKnowledge: negativeKnowledge.stats,
  });
  await persistCompileTaskTraceSafe({
    runId,
    retrievalMode,
    projectRef: projectIdentity.projectRef,
    repoPath: projectIdentity.repoPath,
    repoKey: projectIdentity.repoKey,
    matchBasis: projectIdentity.matchBasis,
    identityContractVersion: projectIdentity.contractVersion,
    scopeMode: projectIdentity.scopeMode,
    identityFingerprint: projectIdentity.identityFingerprint,
    identityTrust: projectIdentity.trust,
    bindingStatus: projectIdentity.bindingStatus,
    technologies: matchedTechnologies,
    changeTypes: matchedChangeTypes,
    domains: matchedDomains,
    goal: input.goal,
    embeddingStatus: taskTraceEmbeddingStatus,
    embeddingProvider: taskTraceEmbeddingStats.embeddingProvider ?? null,
    embeddingModel: taskTraceEmbeddingStats.embeddingModel ?? null,
    embeddingDimensions: taskTraceEmbeddingStats.embeddingDimensions ?? null,
    embedding: taskTraceEmbeddingStats.queryEmbedding ?? null,
  });
  const selectedRankMap = new Map<string, number>();
  for (const [index, item] of selectedPackItems.entries()) {
    if (item.itemKind !== "rule" && item.itemKind !== "procedure") continue;
    if (selectedRankMap.has(item.itemId)) continue;
    selectedRankMap.set(item.itemId, index + 1);
  }
  const agenticAcceptedKnowledgeIds = agenticResult.agenticUsed
    ? [...new Set(finalKnowledge.map((item) => item.id))]
    : [];

  let candidateTracePersistResult: Awaited<ReturnType<typeof persistCandidateTraceRows>> = {
    savedCount: 0,
    truncated: false,
    skippedReason: "not_attempted",
  };
  try {
    const [candidateTraceSettled, packItemsSettled] = await Promise.allSettled([
      persistCandidateTraceRows({
        runId,
        rows: candidateTraceRows,
        traceLimit: candidateTraceLimit,
      }),
      insertContextPackItems(
        runId,
        selectedPackItems.map((item) => ({
          itemKind: item.itemKind,
          itemId: item.itemId,
          section: item.section,
          score: item.score,
          rankingReason: item.rankingReason,
          sourceRefs: item.sourceRefs,
          scopeSnapshot: item.scopeSnapshot,
        })),
      ),
    ]);
    if (candidateTraceSettled.status === "fulfilled") {
      candidateTracePersistResult = candidateTraceSettled.value;
    } else {
      candidateTracePersistResult = {
        savedCount: 0,
        truncated: false,
        skippedReason: "save_failed",
      };
      await recordAuditLogSafe({
        eventType: "CONTEXT_COMPILE_CANDIDATE_TRACE_SAVE_FAILED",
        actor: "system",
        payload: {
          runId,
          traceLimit: candidateTraceLimit,
          candidateCount: candidateTraceRows.length,
          error:
            candidateTraceSettled.reason instanceof Error
              ? candidateTraceSettled.reason.message
              : String(candidateTraceSettled.reason),
        },
      });
    }
    if (packItemsSettled.status === "rejected") {
      throw packItemsSettled.reason;
    }
  } catch (error) {
    const failureReasons = [...new Set([...degradedReasons, "CONTEXT_PACK_PERSIST_FAILED"])];
    const failedDurationMs = Math.max(0, Date.now() - compileStartedAt);
    const failedPack = contextPackSchema.parse({
      runId,
      goal: input.goal,
      retrievalMode,
      status: "failed",
      minimalTasks,
      rules: budgetedRules.items,
      procedures: budgetedProcedures.items,
      guardrails: budgetedGuardrails.items,
      warnings: [],
      sourceRefs:
        sourceRefsCandidate.length > 0
          ? sourceRefsCandidate
          : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons: failureReasons })],
      diagnostics: {
        degradedReasons: failureReasons,
        retrievalStats: {
          knowledge: {
            ...positiveKnowledge.stats,
            textHitCount:
              positiveKnowledge.stats.textHitCount + negativeKnowledge.stats.textHitCount,
            vectorHitCount:
              positiveKnowledge.stats.vectorHitCount + negativeKnowledge.stats.vectorHitCount,
            mergedCount: positiveKnowledge.stats.mergedCount + negativeKnowledge.stats.mergedCount,
          },
          sources: sourceContext.stats,
          episodes: episodePrecedents.stats,
          embeddingTrace,
          tokenBudget,
          compileDurationMs: failedDurationMs,
          candidateTraceSavedCount: candidateTracePersistResult.savedCount,
          candidateTraceTruncated: candidateTracePersistResult.truncated,
          candidateTraceLimit,
          candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
          persistenceState: {
            contextPackItemsSaved: false,
            candidateTraceSavedCount: candidateTracePersistResult.savedCount,
            candidateTraceTruncated: candidateTracePersistResult.truncated,
            candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
          },
          duplicateSuppressedCount: duplicateSuppression.suppressedById.size,
          duplicateSuppressedGroupCount: duplicateSuppression.groups.length,
          landscapeIntervention: landscapeIntervention.diagnostics,
          agenticUsed: agenticResult.agenticUsed,
          agenticReasoning: agenticResult.reasoning,
          agenticSelectionReason: agenticResult.selectionReason ?? null,
          reasonBuckets: {
            blocking: [
              ...new Set([...reasonBuckets.blockingReasons, "CONTEXT_PACK_PERSIST_FAILED"]),
            ],
            maintenanceWarnings: reasonBuckets.maintenanceWarnings,
            hardFailures: [
              ...new Set([...reasonBuckets.hardFailureReasons, "CONTEXT_PACK_PERSIST_FAILED"]),
            ],
          },
          responseComposer: {
            used: composedResponse.agenticUsed,
            markdownKind: composedResponse.markdown === "No Content" ? "no-content" : "narrative",
            ...(composedResponse.noContentReason
              ? { noContentReason: composedResponse.noContentReason }
              : {}),
            ...(composedResponse.error ? { error: composedResponse.error } : {}),
          },
          persistError: error instanceof Error ? error.message : String(error),
          suggestedNextCalls: [...new Set([...suggestedNextCalls, "doctor"])],
        },
        inputFacets,
      },
    });
    const failedPackWithMarkdown = attachOutputMarkdownToPack(failedPack, "No Content");
    await updateCompileRunFailureSafe({
      runId,
      degradedReasons: failureReasons,
      durationMs: failedDurationMs,
      pack: failedPackWithMarkdown,
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.contextCompileRun,
      actor: "agent",
      payload: {
        runId,
        goal: input.goal,
        retrievalMode,
        status: "failed",
        degradedReasons: failureReasons,
        tokenBudget,
        compileDurationMs: failedDurationMs,
        source: options?.source ?? "unknown",
        selectedCounts: {
          rules: budgetedRules.items.length,
          procedures: budgetedProcedures.items.length,
          guardrails: budgetedGuardrails.items.length,
        },
        persistError: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
  await recordKnowledgeCompileSelectionSafe({
    runId,
    selectedKnowledgeIds,
    agenticAcceptedKnowledgeIds,
  });

  await recordCompileRunKnowledgeUsageSignalsSafe({
    runId,
    selectedKnowledgeIds,
    selectedRankMap,
    agenticAcceptedKnowledgeIds,
    usedKnowledge: composedResponse.usedKnowledge,
    actor: composedResponse.agenticUsed ? "agent" : "system",
    scopeSnapshotByKnowledgeId: new Map(
      selectedPackItems
        .filter((item) => item.itemKind === "rule" || item.itemKind === "procedure")
        .map((item) => [item.itemId, item.scopeSnapshot ?? {}]),
    ),
  });

  const sourceRefs =
    sourceRefsCandidate.length > 0
      ? sourceRefsCandidate
      : [buildFallbackSourceRef({ runId, retrievalMode, degradedReasons })];

  const pack = contextPackSchema.parse({
    runId,
    goal: input.goal,
    retrievalMode,
    status,
    minimalTasks,
    rules: budgetedRules.items,
    procedures: budgetedProcedures.items,
    guardrails: budgetedGuardrails.items,
    warnings: [],
    sourceRefs,
    diagnostics: {
      degradedReasons,
      retrievalStats: {
        knowledge: {
          ...positiveKnowledge.stats,
          textHitCount: positiveKnowledge.stats.textHitCount + negativeKnowledge.stats.textHitCount,
          vectorHitCount:
            positiveKnowledge.stats.vectorHitCount + negativeKnowledge.stats.vectorHitCount,
          mergedCount: positiveKnowledge.stats.mergedCount + negativeKnowledge.stats.mergedCount,
        },
        sources: sourceContext.stats,
        episodes: episodePrecedents.stats,
        embeddingTrace,
        tokenBudget,
        compileDurationMs,
        candidateTraceSavedCount: candidateTracePersistResult.savedCount,
        candidateTraceTruncated: candidateTracePersistResult.truncated,
        candidateTraceLimit,
        candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
        persistenceState: {
          contextPackItemsSaved: true,
          candidateTraceSavedCount: candidateTracePersistResult.savedCount,
          candidateTraceTruncated: candidateTracePersistResult.truncated,
          candidateTraceSkippedReason: candidateTracePersistResult.skippedReason,
        },
        duplicateSuppressedCount: duplicateSuppression.suppressedById.size,
        duplicateSuppressedGroupCount: duplicateSuppression.groups.length,
        landscapeIntervention: landscapeIntervention.diagnostics,
        agenticUsed: agenticResult.agenticUsed,
        agenticReasoning: agenticResult.reasoning,
        agenticSelectionReason: agenticResult.selectionReason ?? null,
        reasonBuckets: {
          blocking: reasonBuckets.blockingReasons,
          maintenanceWarnings: reasonBuckets.maintenanceWarnings,
          hardFailures: reasonBuckets.hardFailureReasons,
        },
        responseComposer: {
          used: composedResponse.agenticUsed,
          markdownKind: composedResponse.markdown === "No Content" ? "no-content" : "narrative",
          ...(composedResponse.noContentReason
            ? { noContentReason: composedResponse.noContentReason }
            : {}),
          ...(composedResponse.error ? { error: composedResponse.error } : {}),
        },
        suggestedNextCalls: [...new Set(suggestedNextCalls)],
      },
      inputFacets,
    },
  });

  const markdown = forceNoContentDueToRateLimit
    ? "No Content"
    : composedResponse.markdown || renderContextPackMarkdown(pack);
  const packWithMarkdown = attachOutputMarkdownToPack(pack, markdown);
  await updateCompileRunSnapshotSafe(runId, packWithMarkdown);

  await recordAuditLogSafe({
    eventType: auditEventTypes.contextCompileRun,
    actor: "agent",
    payload: {
      runId,
      goal: input.goal,
      retrievalMode,
      status,
      degradedReasons,
      tokenBudget,
      compileDurationMs,
      source: options?.source ?? "unknown",
      selectedCounts: {
        rules: budgetedRules.items.length,
        procedures: budgetedProcedures.items.length,
        guardrails: budgetedGuardrails.items.length,
      },
    },
  });

  const securityIntelligenceShadow = await collectSecurityIntelligenceShadowRetrieval({
    compileRunRef: runId,
    compileInput: input,
    retrievalMode,
    facets: {
      technologies: matchedTechnologies,
      changeTypes: matchedChangeTypes,
      domains: matchedDomains,
    },
  });
  return {
    pack: packWithMarkdown,
    markdown,
    ...(securityIntelligenceShadow ? { securityIntelligenceShadow } : {}),
  };
}
