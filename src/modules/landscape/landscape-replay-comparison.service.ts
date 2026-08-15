import { retrieveKnowledge } from "../knowledge/knowledge.service.js";
import { extractLandscapeTaskFacets } from "./landscape-facets.js";
import {
  type PackItemForComparison,
  type UsageEventForComparison,
  averageRunRate,
  buildVerdictMix,
  classifyReplayComparison,
  compileInputFromRun,
  emptyComparisonCounts,
  emptyVerdictMix,
  groupByRunId,
  normalizeRetrievalMode,
  orderPackItems,
  rate,
  uniqueOrdered,
} from "./landscape-replay-comparison.helpers.js";
import { loadLandscapeReplayCorpus } from "./landscape-replay.repository.js";
import type {
  BuildLandscapeReplayComparisonInput,
  LandscapeAppliesToRefineCandidate,
  LandscapeCompileInterventionPlan,
  LandscapePromotionGateSummary,
  LandscapeRankingExperimentSummary,
  LandscapeReplayComparisonKind,
  LandscapeReplayComparisonResponse,
  LandscapeReplayComparisonRun,
  LandscapeReplayRecompilePlan,
  LandscapeRunStatus,
  LandscapeScoreTuningSummary,
} from "./landscape-replay.types.js";
import { runWithLandscapeSnapshotCache } from "./landscape-snapshot-cache.service.js";

const HIGH_CHURN_REPLACEMENT_RATE = 0.5;
const LOW_OVERLAP_RATE = 0.6;
const MAX_REFINE_CANDIDATES = 300;

function buildRecompilePlan(params: {
  replayRunCount: number;
  comparedRunCount: number;
}): LandscapeReplayRecompilePlan {
  const excludedCount = Math.max(0, params.replayRunCount - params.comparedRunCount);
  return {
    mode: "current_retrieval_dry_run",
    writesCompileRuns: false,
    replayRunCount: params.replayRunCount,
    comparedRunCount: params.comparedRunCount,
    blockers:
      excludedCount > 0
        ? [`${excludedCount} legacy run(s) excluded: identity snapshot is unknown.`]
        : [],
  };
}

function buildScoreTuningSummary(
  runs: LandscapeReplayComparisonRun[],
): LandscapeScoreTuningSummary {
  const highChurnRuns = runs.filter(
    (run) =>
      run.replacementRate >= HIGH_CHURN_REPLACEMENT_RATE &&
      run.newlyRetrievedKnowledgeIds.length > 0,
  );
  const negativeFeedbackRuns = runs.filter(
    (run) => run.baselineVerdicts.offTopic + run.baselineVerdicts.wrong > 0,
  );
  const lostUsedBaselineRuns = runs.filter((run) => run.usedBaselineLostKnowledgeIds.length > 0);
  const recommendations: string[] = [];

  if (lostUsedBaselineRuns.length > 0) {
    recommendations.push(
      "Add a retention signal for previously used baseline items before promotion.",
    );
  }
  if (highChurnRuns.length > 0) {
    recommendations.push(
      "Penalize high replacement churn in ranking experiments before runtime rollout.",
    );
  }
  if (negativeFeedbackRuns.length > 0) {
    recommendations.push("Use off-topic and wrong replay verdicts as a repulsion sandbox signal.");
  }
  if (runs.some((run) => run.comparison === "no_current_match")) {
    recommendations.push("Audit facet filters for runs with no current retrieval match.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Keep score tuning in observe-only mode until more replay drift appears.");
  }

  return {
    productionEnabled: false,
    stableRunCount: runs.filter((run) => run.comparison === "stable").length,
    driftedRunCount: runs.filter((run) => run.comparison === "drifted").length,
    lostBaselineRunCount: runs.filter((run) => run.comparison === "lost_baseline").length,
    negativeFeedbackRunCount: negativeFeedbackRuns.length,
    highChurnRunCount: highChurnRuns.length,
    lostUsedBaselineRunCount: lostUsedBaselineRuns.length,
    noCurrentMatchRunCount: runs.filter((run) => run.comparison === "no_current_match").length,
    averageReplacementRate: averageRunRate(runs, (run) => run.replacementRate),
    recommendations,
  };
}

function buildRankingExperiments(params: {
  runs: LandscapeReplayComparisonRun[];
  retainedItemCount: number;
  missingFromCurrentItemCount: number;
  usedBaselineLostItemCount: number;
  averageOverlapRate: number;
}): LandscapeRankingExperimentSummary[] {
  const { runs } = params;
  const usedRetentionOverlap = averageRunRate(runs, (run) =>
    rate(
      run.retainedKnowledgeIds.length + run.usedBaselineLostKnowledgeIds.length,
      run.baselineSelectedKnowledgeIds.length,
    ),
  );
  const negativeRepulsionRunCount = new Set([
    ...runs
      .filter((run) => run.replacementRate >= HIGH_CHURN_REPLACEMENT_RATE)
      .map((run) => run.runId),
    ...runs
      .filter((run) => run.baselineVerdicts.offTopic + run.baselineVerdicts.wrong > 0)
      .map((run) => run.runId),
  ]).size;
  const lowRecallRunCount = runs.filter(
    (run) =>
      run.comparison === "lost_baseline" ||
      run.comparison === "no_current_match" ||
      run.overlapRate < LOW_OVERLAP_RATE,
  ).length;

  return [
    {
      experiment: "current_retrieval",
      productionEnabled: false,
      targetRunCount: runs.length,
      estimatedRetainedItemCount: params.retainedItemCount,
      estimatedMissingFromCurrentItemCount: params.missingFromCurrentItemCount,
      estimatedUsedBaselineLostItemCount: params.usedBaselineLostItemCount,
      estimatedAverageOverlapRate: params.averageOverlapRate,
      riskReductionSignal: 0,
      recommendation: "Baseline dry-run only; do not use this as a ranking change.",
    },
    {
      experiment: "used_baseline_retention",
      productionEnabled: false,
      targetRunCount: runs.filter((run) => run.usedBaselineLostKnowledgeIds.length > 0).length,
      estimatedRetainedItemCount: params.retainedItemCount + params.usedBaselineLostItemCount,
      estimatedMissingFromCurrentItemCount: Math.max(
        0,
        params.missingFromCurrentItemCount - params.usedBaselineLostItemCount,
      ),
      estimatedUsedBaselineLostItemCount: 0,
      estimatedAverageOverlapRate: usedRetentionOverlap,
      riskReductionSignal: rate(
        params.usedBaselineLostItemCount,
        params.missingFromCurrentItemCount,
      ),
      recommendation:
        "Sandbox a retention boost for baseline items that previously received used feedback.",
    },
    {
      experiment: "negative_repulsion",
      productionEnabled: false,
      targetRunCount: negativeRepulsionRunCount,
      estimatedRetainedItemCount: params.retainedItemCount,
      estimatedMissingFromCurrentItemCount: params.missingFromCurrentItemCount,
      estimatedUsedBaselineLostItemCount: params.usedBaselineLostItemCount,
      estimatedAverageOverlapRate: params.averageOverlapRate,
      riskReductionSignal: rate(negativeRepulsionRunCount, runs.length),
      recommendation:
        "Use replay drift and negative verdicts to sandbox a penalty before changing production order.",
    },
    {
      experiment: "diversity_exploration",
      productionEnabled: false,
      targetRunCount: lowRecallRunCount,
      estimatedRetainedItemCount: params.retainedItemCount,
      estimatedMissingFromCurrentItemCount: params.missingFromCurrentItemCount,
      estimatedUsedBaselineLostItemCount: params.usedBaselineLostItemCount,
      estimatedAverageOverlapRate: params.averageOverlapRate,
      riskReductionSignal: rate(lowRecallRunCount, runs.length),
      recommendation:
        "Keep exploration as an explicit experiment for low-recall runs, not a default compile path.",
    },
  ];
}

function buildSuggestedAppliesTo(run: LandscapeReplayComparisonRun) {
  return {
    ...(run.taskFacets.repoKey ? { repoKey: run.taskFacets.repoKey } : {}),
    ...(run.taskFacets.repoPath ? { repoPath: run.taskFacets.repoPath } : {}),
    retrievalMode: run.retrievalMode,
    technologies: run.taskFacets.technologies,
    changeTypes: run.taskFacets.changeTypes,
    domains: run.taskFacets.domains,
  };
}

function buildAppliesToRefineCandidates(
  runs: LandscapeReplayComparisonRun[],
): LandscapeAppliesToRefineCandidate[] {
  const candidates: LandscapeAppliesToRefineCandidate[] = [];
  const seen = new Set<string>();

  function addCandidate(
    run: LandscapeReplayComparisonRun,
    knowledgeId: string,
    params: Pick<LandscapeAppliesToRefineCandidate, "reason" | "confidence" | "evidence">,
  ) {
    const key = `${run.runId}:${knowledgeId}:${params.reason}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({
      runId: run.runId,
      knowledgeId,
      reason: params.reason,
      confidence: params.confidence,
      suggestedAppliesTo: buildSuggestedAppliesTo(run),
      evidence: params.evidence,
    });
  }

  for (const run of runs) {
    for (const knowledgeId of run.usedBaselineLostKnowledgeIds) {
      addCandidate(run, knowledgeId, {
        reason: "used_baseline_lost",
        confidence: "medium",
        evidence: [
          "Knowledge was selected in the baseline replay run.",
          "Knowledge received used feedback in the baseline run.",
          "Current retrieval no longer returns it within the comparison limit.",
        ],
      });
    }

    for (const knowledgeId of run.offTopicBaselineKnowledgeIds) {
      addCandidate(run, knowledgeId, {
        reason: "baseline_off_topic",
        confidence: "medium",
        evidence: [
          "Knowledge was selected in the baseline replay run.",
          "Knowledge received off-topic feedback in the baseline run.",
          "Run facets provide a narrower appliesTo candidate for review.",
        ],
      });
    }

    for (const knowledgeId of run.wrongBaselineKnowledgeIds) {
      addCandidate(run, knowledgeId, {
        reason: "baseline_wrong",
        confidence: "medium",
        evidence: [
          "Knowledge was selected in the baseline replay run.",
          "Knowledge received wrong feedback in the baseline run.",
          "Promotion should require review before this signal affects runtime ranking.",
        ],
      });
    }

    if (run.overlapRate >= LOW_OVERLAP_RATE) continue;
    for (const knowledgeId of run.missingFromCurrentKnowledgeIds.slice(0, 3)) {
      addCandidate(run, knowledgeId, {
        reason: "baseline_missing_after_recompile",
        confidence: "low",
        evidence: [
          "Knowledge was selected in the baseline replay run.",
          "Current retrieval no longer returns it within the comparison limit.",
          "Run-level overlap is below the replay stability threshold.",
        ],
      });
    }
  }

  return candidates.slice(0, MAX_REFINE_CANDIDATES);
}

function buildPromotionGateSummary(
  runs: LandscapeReplayComparisonRun[],
): LandscapePromotionGateSummary {
  const affectedRuns = runs.filter(
    (run) =>
      run.usedBaselineLostKnowledgeIds.length > 0 ||
      run.baselineVerdicts.offTopic + run.baselineVerdicts.wrong > 0 ||
      run.comparison === "lost_baseline" ||
      run.comparison === "no_current_match",
  );
  const riskyNewKnowledgeCount = new Set(
    affectedRuns.flatMap((run) => run.newlyRetrievedKnowledgeIds),
  ).size;
  const shouldTighten = affectedRuns.length > 0;

  return {
    productionEnabled: false,
    gateMode: shouldTighten ? "review_required" : "normal",
    shouldTighten,
    affectedRunCount: affectedRuns.length,
    riskyNewKnowledgeCount,
    reason: shouldTighten
      ? "Replay comparison found baseline loss or negative feedback; require review before promoting candidates in affected basins."
      : "Replay comparison did not find baseline loss or negative feedback that requires a stricter promotion gate.",
  };
}

function buildCompileInterventionPlan(
  scoreTuning: LandscapeScoreTuningSummary,
): LandscapeCompileInterventionPlan {
  if (scoreTuning.lostUsedBaselineRunCount > 0) {
    return {
      productionEnabled: false,
      strategy: "retain_used_baseline",
      candidateRunCount: scoreTuning.lostUsedBaselineRunCount,
      reason:
        "Used baseline items were lost in current retrieval; test retention before runtime ranking changes.",
    };
  }
  if (scoreTuning.negativeFeedbackRunCount > 0) {
    return {
      productionEnabled: false,
      strategy: "repel_negative_candidates",
      candidateRunCount: scoreTuning.negativeFeedbackRunCount,
      reason:
        "Replay verdicts include off-topic or wrong feedback; sandbox repulsion before runtime ranking changes.",
    };
  }
  if (scoreTuning.highChurnRunCount > 0) {
    return {
      productionEnabled: false,
      strategy: "repel_negative_candidates",
      candidateRunCount: scoreTuning.highChurnRunCount,
      reason:
        "Current retrieval churn is high; sandbox repulsion against risky replacements first.",
    };
  }
  if (scoreTuning.noCurrentMatchRunCount > 0) {
    return {
      productionEnabled: false,
      strategy: "diversity_exploration",
      candidateRunCount: scoreTuning.noCurrentMatchRunCount,
      reason:
        "Some replay runs have no current match; exploration should remain an explicit experiment.",
    };
  }
  return {
    productionEnabled: false,
    strategy: "observe_only",
    candidateRunCount: 0,
    reason: "No replay comparison signal is strong enough to justify runtime compile intervention.",
  };
}

export async function buildLandscapeReplayComparison(
  input: BuildLandscapeReplayComparisonInput,
): Promise<LandscapeReplayComparisonResponse> {
  return runWithLandscapeSnapshotCache({
    snapshotType: "landscape_replay_comparison",
    params: {
      ...input,
    },
    build: async () => {
      const analysisDate = new Date();
      const analysisAsOf = analysisDate.toISOString();
      const corpusStartAt = new Date(
        analysisDate.getTime() - input.windowDays * 24 * 60 * 60 * 1000,
      );
      const corpus = await loadLandscapeReplayCorpus({
        windowDays: input.windowDays,
        limit: input.limit,
        runStatus: input.runStatus,
      });

      const packItemsByRunId = groupByRunId(corpus.packItems);
      const usageEventsByRunId = groupByRunId<UsageEventForComparison>(corpus.usageEvents);
      const runs: LandscapeReplayComparisonRun[] = [];
      const comparisonCounts = emptyComparisonCounts();
      let baselineSelectedItemCount = 0;
      let currentRetrievedItemCount = 0;
      let retainedItemCount = 0;
      let missingFromCurrentItemCount = 0;
      let newlyRetrievedItemCount = 0;
      let usedBaselineLostItemCount = 0;
      let currentNoMatchRunCount = 0;

      for (const run of corpus.runs) {
        const taskFacets = extractLandscapeTaskFacets({
          runInput: run.input,
          repoPath: run.repoPath,
          retrievalMode: run.retrievalMode,
          source: run.source,
          runStatus: run.status,
          degradedReasons: run.degradedReasons,
        });
        const compileInput = compileInputFromRun({
          goal: run.goal,
          runInput: run.input,
          projectRef: run.projectRef,
          repoKey: run.repoKey,
          repoPath: run.repoPath,
          matchBasis: run.matchBasis,
          identityContractVersion: run.identityContractVersion,
          scopeMode: run.scopeMode,
          retrievalMode: run.retrievalMode,
          source: run.source,
          runStatus: run.status,
          degradedReasons: run.degradedReasons,
        });
        const retrievalMode = normalizeRetrievalMode(run.retrievalMode, taskFacets.changeTypes);
        const baselineSelectedKnowledgeIds = uniqueOrdered(
          orderPackItems(packItemsByRunId.get(run.id) ?? []).map((item) => item.itemId),
        );
        const baselineSet = new Set(baselineSelectedKnowledgeIds);
        const baselineUsageEvents = (usageEventsByRunId.get(run.id) ?? []).filter((event) =>
          baselineSet.has(event.knowledgeId),
        );
        const baselineVerdicts = buildVerdictMix(baselineUsageEvents);
        const usedBaselineKnowledgeIds = uniqueOrdered(
          baselineUsageEvents
            .filter((event) => event.verdict === "used")
            .map((event) => event.knowledgeId),
        );
        const offTopicBaselineKnowledgeIds = uniqueOrdered(
          baselineUsageEvents
            .filter((event) => event.verdict === "off_topic")
            .map((event) => event.knowledgeId),
        );
        const wrongBaselineKnowledgeIds = uniqueOrdered(
          baselineUsageEvents
            .filter((event) => event.verdict === "wrong")
            .map((event) => event.knowledgeId),
        );
        if (!compileInput) {
          comparisonCounts.not_comparable += 1;
          runs.push({
            runId: run.id,
            createdAt: run.createdAt.toISOString(),
            goal: run.goal,
            retrievalMode,
            status: run.status as LandscapeRunStatus,
            identityCompatibility: "legacy_identity_unknown",
            taskFacets,
            baselineSelectedKnowledgeIds,
            currentRetrievedKnowledgeIds: [],
            retainedKnowledgeIds: [],
            missingFromCurrentKnowledgeIds: [],
            newlyRetrievedKnowledgeIds: [],
            baselineVerdicts,
            usedBaselineRetainedKnowledgeIds: [],
            usedBaselineLostKnowledgeIds: [],
            offTopicBaselineKnowledgeIds,
            wrongBaselineKnowledgeIds,
            overlapRate: 0,
            replacementRate: 0,
            comparison: "not_comparable",
            currentDegradedReasons: ["LEGACY_IDENTITY_UNKNOWN"],
            currentRetrievalStats: {
              textHitCount: 0,
              vectorHitCount: 0,
              mergedCount: 0,
              textFailed: false,
              vectorFailed: false,
              embeddingStatus: "disabled",
              repoScopeFallbackUsed: false,
            },
          });
          continue;
        }
        const current = await retrieveKnowledge(compileInput, {
          retrievalMode,
          limit: input.currentLimit,
          facetFilters: {
            technologies: taskFacets.technologies,
            changeTypes: taskFacets.changeTypes,
            domains: taskFacets.domains,
          },
        });
        const currentRetrievedKnowledgeIds = uniqueOrdered(
          current.items.map((item) => item.id).slice(0, input.currentLimit),
        );
        const currentSet = new Set(currentRetrievedKnowledgeIds);
        const retainedKnowledgeIds = baselineSelectedKnowledgeIds.filter((id) =>
          currentSet.has(id),
        );
        const missingFromCurrentKnowledgeIds = baselineSelectedKnowledgeIds.filter(
          (id) => !currentSet.has(id),
        );
        const newlyRetrievedKnowledgeIds = currentRetrievedKnowledgeIds.filter(
          (id) => !baselineSet.has(id),
        );
        const usedBaselineRetainedKnowledgeIds = usedBaselineKnowledgeIds.filter((id) =>
          currentSet.has(id),
        );
        const usedBaselineLostKnowledgeIds = usedBaselineKnowledgeIds.filter(
          (id) => !currentSet.has(id),
        );
        const overlapRate = rate(retainedKnowledgeIds.length, baselineSelectedKnowledgeIds.length);
        const replacementRate = rate(
          newlyRetrievedKnowledgeIds.length,
          currentRetrievedKnowledgeIds.length,
        );
        const comparison = classifyReplayComparison({
          baselineCount: baselineSelectedKnowledgeIds.length,
          currentCount: currentRetrievedKnowledgeIds.length,
          retainedCount: retainedKnowledgeIds.length,
          overlapRate,
        });
        comparisonCounts[comparison] += 1;
        baselineSelectedItemCount += baselineSelectedKnowledgeIds.length;
        currentRetrievedItemCount += currentRetrievedKnowledgeIds.length;
        retainedItemCount += retainedKnowledgeIds.length;
        missingFromCurrentItemCount += missingFromCurrentKnowledgeIds.length;
        newlyRetrievedItemCount += newlyRetrievedKnowledgeIds.length;
        usedBaselineLostItemCount += usedBaselineLostKnowledgeIds.length;
        if (currentRetrievedKnowledgeIds.length === 0) currentNoMatchRunCount += 1;

        runs.push({
          runId: run.id,
          createdAt: run.createdAt.toISOString(),
          goal: run.goal,
          retrievalMode,
          status: run.status as LandscapeRunStatus,
          identityCompatibility: "comparable",
          taskFacets,
          baselineSelectedKnowledgeIds,
          currentRetrievedKnowledgeIds,
          retainedKnowledgeIds,
          missingFromCurrentKnowledgeIds,
          newlyRetrievedKnowledgeIds,
          baselineVerdicts,
          usedBaselineRetainedKnowledgeIds,
          usedBaselineLostKnowledgeIds,
          offTopicBaselineKnowledgeIds,
          wrongBaselineKnowledgeIds,
          overlapRate,
          replacementRate,
          comparison,
          currentDegradedReasons: current.degradedReasons,
          currentRetrievalStats: {
            textHitCount: current.stats.textHitCount,
            vectorHitCount: current.stats.vectorHitCount,
            mergedCount: current.stats.mergedCount,
            textFailed: current.stats.textFailed,
            vectorFailed: current.stats.vectorFailed,
            embeddingStatus: current.stats.embeddingStatus,
            repoScopeFallbackUsed: current.stats.repoScopeFallbackUsed,
          },
        });
      }

      const comparableRuns = runs.filter((run) => run.identityCompatibility === "comparable");
      const averageOverlapRate = rate(
        comparableRuns.reduce((sum, run) => sum + run.overlapRate, 0),
        comparableRuns.length,
      );
      const scoreTuning = buildScoreTuningSummary(comparableRuns);

      return {
        generatedAt: analysisAsOf,
        analysisAsOf,
        windowDays: input.windowDays,
        corpusWindow: {
          startAt: corpusStartAt.toISOString(),
          endAt: analysisAsOf,
        },
        basis: {
          unit: "replay-comparison",
          mode: "current_retrieval",
          runStatus: input.runStatus,
          currentLimit: input.currentLimit,
        },
        replayRunCount: corpus.runs.length,
        comparedRunCount: comparableRuns.length,
        baselineSelectedItemCount,
        currentRetrievedItemCount,
        retainedItemCount,
        missingFromCurrentItemCount,
        newlyRetrievedItemCount,
        usedBaselineLostItemCount,
        averageOverlapRate,
        currentNoMatchRunCount,
        comparisonCounts,
        recompilePlan: buildRecompilePlan({
          replayRunCount: corpus.runs.length,
          comparedRunCount: comparableRuns.length,
        }),
        rankingExperiments: buildRankingExperiments({
          runs: comparableRuns,
          retainedItemCount,
          missingFromCurrentItemCount,
          usedBaselineLostItemCount,
          averageOverlapRate,
        }),
        appliesToRefineCandidates: buildAppliesToRefineCandidates(comparableRuns),
        promotionGateSummary: buildPromotionGateSummary(comparableRuns),
        scoreTuning,
        compileInterventionPlan: buildCompileInterventionPlan(scoreTuning),
        runs: input.includeRuns ? runs : [],
      };
    },
  });
}
