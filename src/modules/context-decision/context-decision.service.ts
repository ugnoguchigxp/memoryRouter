import {
  type ContextDecisionConfidenceTrace,
  type ContextDecisionCoverageQueryRole,
  type ContextDecisionEpisodePrecedent,
  type ContextDecisionInput,
  type ContextDecisionKnowledgeAssessment,
  type ContextDecisionKnowledgePrior,
  type ContextDecisionMlSignal,
  type ContextDecisionResult,
  type ContextDecisionValue,
  type ContextDecisionEvidenceRole,
  type ContextDecisionReliabilityGate,
  contextDecisionInputSchema,
  contextDecisionValueSchema,
} from "../../shared/schemas/context-decision.schema.js";
import { recordEpisodeUsage, searchEpisodes } from "../episodic-memory/episode-card.service.js";
import type { KnowledgeSearchResult } from "../knowledge/knowledge.repository.js";
import { searchKnowledge } from "../knowledge/knowledge.repository.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting,
} from "../settings/settings.service.js";
import {
  englishPromptBinding,
  renderPrompt,
  promptMessage,
} from "../system-context/system-context.service.js";
import { buildDecisionCoverageQueries } from "./context-decision.coverage.js";
import {
  type ContextDecisionCandidateTrace,
  assessContextDecisionKnowledge,
  buildContextDecisionCandidateTraces,
} from "./context-decision.knowledge-assessment.js";
import { buildContextDecisionKnowledgePrior } from "./context-decision.knowledge-prior.js";
import { buildContextDecisionMlFeatures } from "./context-decision.ml-features.js";
import { buildContextDecisionMlSignal } from "./context-decision.ml-signal.js";
import {
  getContextDecisionDetail,
  getRelatedDecisionBadSignalSummary,
  insertContextDecisionCoverageRows,
  insertContextDecisionEvidenceRows,
  insertContextDecisionRun,
  listContextDecisionMlTrainingRows,
  listContextDecisionRuns,
  markContextDecisionRunFailed,
} from "./context-decision.repository.js";
import { applyContextDecisionReliabilityGate } from "./context-decision.reliability-gate.js";
import {
  type DecisionKnowledgeAnalysis,
  analyzeDecisionKnowledge,
  extractDecisionPrimaryEvidence,
  toDecisionEpisodePrecedent,
} from "./context-decision.relevance.js";
import {
  type DecisionEvidenceCandidate,
  evidenceWeightAtDecision,
  resolveContextDecisionOutcome,
  scoreContextDecision,
} from "./context-decision.scoring.js";
import {
  buildDecisionSignalAssessmentSummary,
  signalTracePayload,
  summarizeDecisionSignals,
} from "./context-decision.signals.js";
import { loadDecisionSignalBundles } from "./context-decision.signals.repository.js";

type ContextDecisionLlmJudgment = {
  decision: ContextDecisionValue;
  confidence: number;
  mandate: string;
  selectedAction: string | null;
  rejectedActions: string[];
  reasoningSummary: string;
};

type SelectionRole = "support" | "counter_evidence" | "user_preference" | "risk" | "alternative";

type UniqueRoleSelection = {
  selectedByRole: Record<SelectionRole, KnowledgeSearchResult[]>;
  suppressedByRole: Record<SelectionRole, string[]>;
};

const EVIDENCE_ROLE_PRECEDENCE: Record<ContextDecisionEvidenceRole, number> = {
  counter_evidence: 6,
  risk_warning: 5,
  user_preference: 4,
  rejected_alternative: 3,
  selected_support: 2,
  missing_counter_evidence: 1,
};

function uniqueById(items: KnowledgeSearchResult[]): KnowledgeSearchResult[] {
  const seen = new Set<string>();
  const unique: KnowledgeSearchResult[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function summarizeKnowledge(item: KnowledgeSearchResult): string {
  const body = item.body.replace(/\s+/g, " ").trim();
  const excerpt = body.length > 280 ? `${body.slice(0, 277)}...` : body;
  return `${item.title}: ${excerpt}`;
}

function isUserPreferenceKnowledge(item: KnowledgeSearchResult): boolean {
  const text = `${item.title}\n${item.body}`.toLowerCase();
  if (/^\s*(never|do not|don't|禁止|してはいけない)\b/.test(text)) return false;
  return /\b(prefer|preference|user preference|requested style|prior decision)\b/.test(text);
}

function isRelevantDecisionKnowledge(item: KnowledgeSearchResult): boolean {
  return (Number(item.score) || 0) >= 0.2 || item.applicabilityScore >= 20;
}

function isNegativeKnowledge(item: KnowledgeSearchResult): boolean {
  return item.polarity === "negative";
}

function maxSimilarity(items: KnowledgeSearchResult[]): number | null {
  if (items.length === 0) return null;
  return Math.round(Math.max(...items.map((item) => Number(item.score) || 0)) * 100);
}

function knowledgeScorePercent(item: KnowledgeSearchResult): number {
  return Math.max(0, Math.min(100, Math.round((Number(item.score) || 0) * 100)));
}

function buildGuardrails(input: ContextDecisionInput, riskEvidence: KnowledgeSearchResult[]) {
  return {
    retrievalHints: input.retrievalHints,
    riskEvidenceCount: riskEvidence.length,
  };
}

function inputForDecisionRunPersistence(input: ContextDecisionInput): ContextDecisionInput {
  const { primaryEvidence: _primaryEvidence, ...metadata } = input.metadata;
  return {
    ...input,
    metadata,
  };
}

function primaryEvidenceStrength(
  primaryEvidence: NonNullable<ContextDecisionConfidenceTrace["primaryEvidence"]>,
): NonNullable<ContextDecisionConfidenceTrace["primaryEvidence"]>[number]["strength"] | "none" {
  const order: Array<
    NonNullable<ContextDecisionConfidenceTrace["primaryEvidence"]>[number]["strength"]
  > = ["verified", "observed", "claimed", "inferred"];
  for (const strength of order) {
    if (primaryEvidence.some((item) => item.strength === strength)) return strength;
  }
  return "none";
}

function compactLines(values: string[]): string {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned.join(", ") : "none";
}

function compactKnowledgeBody(body: string, maxLength = 420): string {
  const compact = body.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 3)}...` : compact;
}

function dedupeEvidenceByKnowledgeId(
  items: DecisionEvidenceCandidate[],
): DecisionEvidenceCandidate[] {
  const seen = new Set<string>();
  const unique: DecisionEvidenceCandidate[] = [];
  for (const item of items) {
    if (seen.has(item.knowledge.id)) continue;
    seen.add(item.knowledge.id);
    unique.push(item);
  }
  return unique;
}

function normalizeEvidenceCandidateRoles(
  items: DecisionEvidenceCandidate[],
): DecisionEvidenceCandidate[] {
  const byKnowledgeId = new Map<string, DecisionEvidenceCandidate>();
  for (const item of items) {
    const current = byKnowledgeId.get(item.knowledge.id);
    if (!current || EVIDENCE_ROLE_PRECEDENCE[item.role] > EVIDENCE_ROLE_PRECEDENCE[current.role]) {
      byKnowledgeId.set(item.knowledge.id, item);
    }
  }
  return Array.from(byKnowledgeId.values());
}

function buildKnowledgeBriefs(items: DecisionEvidenceCandidate[], limit: number): string[] {
  return dedupeEvidenceByKnowledgeId(items)
    .slice(0, limit)
    .map(({ knowledge, role, analysis, signals }, index) => {
      const kind =
        knowledge.type === "procedure"
          ? "procedure guidance"
          : knowledge.type === "rule"
            ? "best-practice rule"
            : "knowledge";
      const lines = [
        `${index + 1}. role=${role}; ${kind}; title=${knowledge.title}`,
        `confidence=${knowledge.confidence}; importance=${knowledge.importance}; status=${knowledge.status}`,
        `body=${compactKnowledgeBody(knowledge.body)}`,
      ];
      if (analysis) {
        lines.push(
          `situationMatch=${analysis.topicalRelevanceCategory}; topicalRelevance=${analysis.topicalRelevanceScore}; reason=${analysis.topicalRelevanceReason}`,
          `roleFit=${analysis.roleFit.classification}; roleFitConfidence=${analysis.roleFit.confidence}; roleFitReason=${analysis.roleFit.reason}`,
        );
      }
      if (signals?.compile || signals?.landscape || signals?.community) {
        lines.push(
          `usageSignals=${JSON.stringify({
            compile: signals.compile,
            landscape: signals.landscape,
            community: signals.community,
          })}`,
        );
      }
      return lines.join("\n");
    });
}

function buildEpisodePrecedentBriefs(
  items: ContextDecisionConfidenceTrace["episodePrecedents"],
  limit: number,
): string[] {
  return (items ?? [])
    .slice(0, limit)
    .map((episode, index) =>
      [
        `${index + 1}. title=${episode.title}`,
        `outcomeKind=${episode.outcomeKind}; usedFor=${episode.usedFor}; topicalRelevance=${episode.topicalRelevanceScore}; confidence=${episode.confidence}; importance=${episode.importance}`,
        `situation=${compactKnowledgeBody(episode.situation, 260)}`,
        `action=${compactKnowledgeBody(episode.action, 220)}`,
        `outcome=${compactKnowledgeBody(episode.outcome, 220)}`,
        `lesson=${compactKnowledgeBody(episode.lesson, 260)}`,
      ].join("\n"),
    );
}

function buildCoverageHitBriefs(params: {
  queryRole: ContextDecisionCoverageQueryRole;
  hits: KnowledgeSearchResult[];
  evidence: DecisionEvidenceCandidate[];
  candidateTraces: ContextDecisionCandidateTrace[];
  analysisByRoleAndKnowledge: Map<string, DecisionKnowledgeAnalysis>;
  limit: number;
}): string[] {
  return uniqueById(params.hits)
    .slice(0, params.limit)
    .map((knowledge, index) => {
      const trace = params.candidateTraces.find(
        (item) => item.role === params.queryRole && item.knowledgeId === knowledge.id,
      );
      const evidence = params.evidence.find((item) => item.knowledge.id === knowledge.id);
      const analysis =
        params.analysisByRoleAndKnowledge.get(candidateTraceKey(params.queryRole, knowledge.id)) ??
        evidence?.analysis;
      const adoption = trace?.selected ? "adopted" : "not_adopted";
      const role = evidence?.role ?? evidenceRolesForQueryRole(params.queryRole)[0] ?? "unknown";
      const lines = [
        `${index + 1}. queryRole=${params.queryRole}; decisionRole=${role}; adoption=${adoption}; title=${knowledge.title}`,
        `selectionStage=${trace?.selectionStage ?? "retrieved"}; selectionReason=${trace?.selectionReason ?? "none"}; rejectionReason=${trace?.rejectionReason ?? "none"}`,
        `confidence=${knowledge.confidence}; importance=${knowledge.importance}; status=${knowledge.status}`,
        `body=${compactKnowledgeBody(knowledge.body)}`,
      ];
      if (analysis) {
        lines.push(
          `situationMatch=${analysis.topicalRelevanceCategory}; topicalRelevance=${analysis.topicalRelevanceScore}; reason=${analysis.topicalRelevanceReason}`,
          `roleFit=${analysis.roleFit.classification}; roleFitConfidence=${analysis.roleFit.confidence}; roleFitReason=${analysis.roleFit.reason}`,
        );
      }
      return lines.join("\n");
    });
}

function selectUniqueKnowledgeByRole(params: {
  support: KnowledgeSearchResult[];
  counterEvidence: KnowledgeSearchResult[];
  userPreference: KnowledgeSearchResult[];
  risk: KnowledgeSearchResult[];
  alternative: KnowledgeSearchResult[];
}): UniqueRoleSelection {
  const selectedByRole: UniqueRoleSelection["selectedByRole"] = {
    support: uniqueById(params.support),
    counter_evidence: uniqueById(params.counterEvidence),
    user_preference: uniqueById(params.userPreference),
    risk: uniqueById(params.risk),
    alternative: uniqueById(params.alternative),
  };
  const suppressedByRole: UniqueRoleSelection["suppressedByRole"] = {
    support: [],
    counter_evidence: [],
    user_preference: [],
    risk: [],
    alternative: [],
  };

  return { selectedByRole, suppressedByRole };
}

function bestCandidateTrace(
  traces: ContextDecisionCandidateTrace[],
  knowledgeId: string,
): ContextDecisionCandidateTrace | null {
  const matches = traces
    .filter((trace) => trace.knowledgeId === knowledgeId)
    .sort((a, b) => {
      if (a.selected !== b.selected) return a.selected ? -1 : 1;
      return b.finalCandidateScore - a.finalCandidateScore;
    });
  return matches[0] ?? null;
}

function candidateTraceKey(role: string, knowledgeId: string): string {
  return `${role}:${knowledgeId}`;
}

function roleFitSupportsEvidenceRole(
  role: ContextDecisionEvidenceRole,
  analysis: DecisionKnowledgeAnalysis,
): boolean {
  if (role === "selected_support" || role === "user_preference") {
    return (
      analysis.topicalRelevanceScore >= 70 && analysis.roleFit.classification === "direct_support"
    );
  }
  if (role === "counter_evidence" || role === "rejected_alternative") {
    return (
      analysis.topicalRelevanceScore >= 70 &&
      (analysis.roleFit.classification === "counter_evidence" ||
        analysis.roleFit.classification === "direct_risk")
    );
  }
  if (role === "risk_warning") {
    return analysis.topicalRelevanceScore >= 40 && analysis.roleFit.classification !== "off_topic";
  }
  return false;
}

function roleFitSupportsQueryRole(
  queryRole: ContextDecisionCoverageQueryRole,
  analysis: DecisionKnowledgeAnalysis,
): boolean {
  return evidenceRolesForQueryRole(queryRole).some((role) =>
    roleFitSupportsEvidenceRole(role, analysis),
  );
}

function traceSelectionStage(params: {
  selected: boolean;
  duplicateSuppressed: boolean;
  queryRole: ContextDecisionCoverageQueryRole;
  analysis: DecisionKnowledgeAnalysis | undefined;
}): NonNullable<ContextDecisionCandidateTrace["selectionStage"]> {
  if (params.selected) return "selected";
  if (params.duplicateSuppressed) return "suppressed";
  if (!params.analysis) return "retrieved";
  if (params.analysis.topicalRelevanceScore < 40) return "relevance_filtered";
  if (!roleFitSupportsQueryRole(params.queryRole, params.analysis)) return "role_fit_classified";
  return "retrieved";
}

function capCandidateTraces(
  traces: ContextDecisionCandidateTrace[],
): ContextDecisionCandidateTrace[] {
  const selected = traces.filter((trace) => trace.selected);
  const selectedKeys = new Set(selected.map((trace) => `${trace.role}:${trace.knowledgeId}`));
  const rejected = traces
    .filter((trace) => !selectedKeys.has(`${trace.role}:${trace.knowledgeId}`))
    .sort((a, b) => b.finalCandidateScore - a.finalCandidateScore)
    .slice(0, 40);
  return [...selected, ...rejected].slice(0, 80);
}

async function retrieveDecisionEpisodePrecedents(
  input: ContextDecisionInput,
): Promise<ContextDecisionEpisodePrecedent[]> {
  try {
    const episodes = await searchEpisodes({
      query: input.decisionPoint,
      statuses: ["active"],
      technologies: input.retrievalHints.technologies,
      changeTypes: input.retrievalHints.changeTypes,
      domains: input.retrievalHints.domains,
      limit: 4,
    });
    return episodes
      .map((episode) => toDecisionEpisodePrecedent(input, episode))
      .sort((left, right) => right.topicalRelevanceScore - left.topicalRelevanceScore)
      .slice(0, 4);
  } catch {
    return [];
  }
}

function fallbackAgentMessage(params: {
  decision: string;
  confidence: number;
  supportHits: number;
  counterHits: number;
  riskHits: number;
  status: string;
  evidence: DecisionEvidenceCandidate[];
  reliabilityGate?: ContextDecisionReliabilityGate;
  episodePrecedents?: ContextDecisionConfidenceTrace["episodePrecedents"];
}): string {
  const basisEvidence = dedupeEvidenceByKnowledgeId(
    params.evidence.filter(
      (item) => item.role === "selected_support" || item.role === "user_preference",
    ),
  );
  const basisKnowledgeIds = new Set(basisEvidence.map((item) => item.knowledge.id));
  const basisItems = basisEvidence.slice(0, 3).map(({ knowledge }) => {
    const kind =
      knowledge.type === "procedure"
        ? "手続き"
        : knowledge.type === "rule"
          ? "ベストプラクティス"
          : "過去Knowledge";
    return `「${knowledge.title}」は${kind}として「${compactKnowledgeBody(knowledge.body, 150)}」と定義しています`;
  });
  const riskItems = dedupeEvidenceByKnowledgeId(
    params.evidence.filter(
      (item) =>
        (item.role === "risk_warning" || item.role === "counter_evidence") &&
        !basisKnowledgeIds.has(item.knowledge.id),
    ),
  )
    .slice(0, 2)
    .map(({ knowledge, analysis }) => {
      const similarity = analysis
        ? `類似度=${analysis.topicalRelevanceScore}、role=${analysis.roleFit.classification}`
        : "類似性は選定済み";
      return `「${knowledge.title}」(${similarity})`;
    });
  const episodeItems = (params.episodePrecedents ?? [])
    .slice(0, 2)
    .map(
      (episode) =>
        `「${episode.title}」は過去ケースとして usedFor=${episode.usedFor}、類似度=${episode.topicalRelevanceScore}`,
    );
  const basis =
    basisItems.length > 0
      ? `根拠は、${basisItems.join("。また、")}。`
      : "選定Knowledge本文から十分な具体根拠は得られていません。";
  const risk =
    riskItems.length > 0
      ? `一方で、${riskItems.join("、")} はリスク見積り用に採用し、停止ではなく継続条件を決める材料として扱います。`
      : "";
  const episodes =
    episodeItems.length > 0
      ? `EpisodeCard は ${episodeItems.join("、")} と評価し、類似する場合だけ判断に反映します。`
      : "";
  const impact = params.reliabilityGate?.operationalImpact;
  const impactLine = impact
    ? `影響見積りは operation=${impact.operationType}、level=${impact.level}、activeLeaseCount=${impact.activeLeaseCount ?? "unknown"}、impactedUserEstimate=${impact.impactedUserEstimate ?? "unknown"} です。${impact.reason}`
    : "";
  const reliabilityGate =
    params.reliabilityGate?.status === "constrained"
      ? `Reliability Gate は ${params.reliabilityGate.appliedRules
          .map((item) => item.key)
          .join(
            "、",
          )} により、最終判断を ${params.reliabilityGate.finalDecision} に抑制しています。`
      : "";
  const weakEvidenceNotice =
    params.confidence < 50 || params.status === "degraded"
      ? "この判断は根拠が限定的なため、断定ではなく条件付きの判断として扱います。"
      : "";
  if (params.decision === "escalate") {
    return `判断は escalate です。自律実行に必要な根拠または影響見積りが不足しているため、この判断では GO を出しません。${weakEvidenceNotice}${impactLine}${basis}${risk}${episodes}${reliabilityGate} confidenceは${params.confidence}%で、support hitsは${params.supportHits}、counter evidence hitsは${params.counterHits}、risk hitsは${params.riskHits}です。`;
  }
  if (
    params.decision === "reject" ||
    params.decision === "discard" ||
    params.decision === "rollback"
  ) {
    return `判断は ${params.decision} です。NO-GOです。対象アクションは明確な危険または直接禁止に該当するため、このまま実行しません。${weakEvidenceNotice}${impactLine}${basis}${risk}${episodes}${reliabilityGate} Knowledge検索ではsupport hitsが${params.supportHits}件、counter evidence hitsが${params.counterHits}件、risk hitsが${params.riskHits}件で、confidenceは${params.confidence}%です。statusは${params.status}です。`;
  }
  if (params.decision === "revise_and_execute") {
    return `判断は revise_and_execute です。GO with safeguards です。明らかな危険がない限り、ユーザー確認に倒さず、影響範囲を絞り、検証条件を満たしたうえで自律的に進めます。${weakEvidenceNotice}${impactLine}${basis}${risk}${episodes}${reliabilityGate} Knowledge検索ではsupport hitsが${params.supportHits}件、counter evidence hitsが${params.counterHits}件、risk hitsが${params.riskHits}件で、confidenceは${params.confidence}%です。statusは${params.status}です。`;
  }
  if (params.confidence < 50 || params.status === "degraded") {
    return `判断は ${params.decision} です。GOです。ただし根拠は限定的なので、リスクを見積もったうえで検証可能な範囲に絞って自律実行します。${impactLine}${basis}${risk}${episodes}${reliabilityGate} Knowledge検索ではsupport hitsが${params.supportHits}件、counter evidence hitsが${params.counterHits}件、risk hitsが${params.riskHits}件で、confidenceは${params.confidence}%です。statusは${params.status}です。`;
  }
  return `判断は ${params.decision} です。GOです。明らかな危険は見当たらないため、リスク見積りと検証条件を保持して自律的に進めます。${impactLine}${basis}${risk}${episodes}${reliabilityGate} Knowledge検索ではsupport hitsが${params.supportHits}件、counter evidence hitsが${params.counterHits}件、risk hitsが${params.riskHits}件で、confidenceは${params.confidence}%です。statusは${params.status}で、この範囲では自律的に次へ進めます。`;
}

function normalizeAgentMessage(content: string, fallback: string): string {
  const maxAnswerChars = 2_000;
  const normalized = content
    .replace(/```[\s\S]*?```/g, (match) => match.replace(/```/g, ""))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return fallback;
  return normalized.length > maxAnswerChars
    ? `${normalized.slice(0, maxAnswerChars - 3)}...`
    : normalized;
}

function clampConfidence(value: unknown, fallback: number): number {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(100, Math.round(numberValue)));
}

function deterministicJudgment(params: {
  selectedAction: string | null;
  confidence: number;
}): ContextDecisionLlmJudgment {
  const decision = resolveContextDecisionOutcome(params);
  return {
    decision,
    confidence: params.confidence,
    mandate:
      decision === "escalate"
        ? "Escalate only because required Knowledge evidence was not sufficient for autonomous progress."
        : `Proceed with: ${params.selectedAction ?? "the best supported autonomous action"}.`,
    selectedAction: params.selectedAction,
    rejectedActions: [],
    reasoningSummary: "Deterministic fallback judgment from evidence-derived confidence.",
  };
}

function extractJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {}
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseLlmJudgment(
  content: string,
  deterministicConfidence: number,
): ContextDecisionLlmJudgment | null {
  const record = extractJsonObject(content);
  if (!record) return null;
  const decisionResult = contextDecisionValueSchema.safeParse(record.decision);
  if (!decisionResult.success) return null;
  return {
    decision: decisionResult.data,
    confidence: clampConfidence(record.confidence, deterministicConfidence),
    mandate:
      typeof record.mandate === "string" && record.mandate.trim()
        ? record.mandate.trim()
        : "Proceed according to the selected final decision.",
    selectedAction:
      typeof record.selectedAction === "string" && record.selectedAction.trim()
        ? record.selectedAction.trim()
        : null,
    rejectedActions: Array.isArray(record.rejectedActions)
      ? record.rejectedActions.filter((item): item is string => typeof item === "string")
      : [],
    reasoningSummary:
      typeof record.reasoningSummary === "string" && record.reasoningSummary.trim()
        ? record.reasoningSummary.trim()
        : "No reasoning summary returned.",
  };
}

function assessmentOverrideExplanationRequired(params: {
  assessmentDirection: ContextDecisionKnowledgeAssessment["recommendedDirection"];
  finalDecision: ContextDecisionValue;
  reasoningSummary: string;
}): boolean {
  if (params.assessmentDirection === "unknown") return false;
  if (params.assessmentDirection === params.finalDecision) return false;
  const summary = params.reasoningSummary.toLowerCase();
  return !(
    summary.includes("assessment") ||
    summary.includes("override") ||
    summary.includes("上書") ||
    summary.includes("不一致") ||
    summary.includes("異な")
  );
}

function assessmentAlignedFallbackJudgment(params: {
  deterministic: ContextDecisionLlmJudgment;
  assessment: ContextDecisionKnowledgeAssessment;
}): ContextDecisionLlmJudgment {
  if (
    params.assessment.recommendedDirection === "unknown" ||
    params.assessment.recommendedDirection === params.deterministic.decision
  ) {
    return params.deterministic;
  }
  const decision = params.assessment.recommendedDirection;
  return {
    decision,
    confidence: params.deterministic.confidence,
    mandate: `Follow Knowledge Assessment recommendation: ${decision}.`,
    selectedAction: null,
    rejectedActions:
      params.deterministic.decision === decision ? [] : [params.deterministic.decision],
    reasoningSummary:
      "Knowledge Assessment recommendation differs from the deterministic fallback, and no explicit override explanation was available.",
  };
}

function knowledgeAssessmentForPrompt(assessment: ContextDecisionKnowledgeAssessment) {
  return {
    status: assessment.status,
    recommendedDirection: assessment.recommendedDirection,
    meaningfulMetrics: assessment.meaningfulMetrics ?? [
      { key: "knowledgeCoverage", label: "Coverage", value: assessment.knowledgeCoverage },
      { key: "supportStrength", label: "Support", value: assessment.supportStrength },
    ],
    retrievalMethods: assessment.retrievalMethods,
  };
}

async function contextDecisionLlmProviders(source: string) {
  await ensureRuntimeSettingsLoaded();
  const routing = resolveAgenticCompileRouting();
  if (!routing.enabled) return [];
  return getAgenticLlmProviders(
    routing.provider,
    routing.timeoutMs,
    source,
    routing.fallback,
    routing.azureDeploymentSlots,
  );
}

async function structuredLlmJudgment(params: {
  input: ContextDecisionInput;
  deterministic: ContextDecisionLlmJudgment;
  trace: ContextDecisionConfidenceTrace;
  knowledgeAssessment: ContextDecisionKnowledgeAssessment;
  knowledgePrior: ContextDecisionKnowledgePrior;
  outcomePredictor: ContextDecisionMlSignal;
  evidence: DecisionEvidenceCandidate[];
  supportHits: number;
  preferenceHits: number;
  counterHits: number;
  riskHits: number;
}): Promise<{
  judgment: ContextDecisionLlmJudgment;
  status: NonNullable<ContextDecisionConfidenceTrace["llmJudgmentStatus"]>;
}> {
  const providers = await contextDecisionLlmProviders("context-decision-judgment");
  const supportBriefs = buildKnowledgeBriefs(
    params.evidence.filter(
      (item) => item.role === "selected_support" || item.role === "user_preference",
    ),
    5,
  );
  const riskBriefs = buildKnowledgeBriefs(
    params.evidence.filter((item) => item.role === "risk_warning"),
    2,
  );
  const counterBriefs = buildKnowledgeBriefs(
    params.evidence.filter((item) => item.role === "counter_evidence"),
    3,
  );
  const episodeBriefs = buildEpisodePrecedentBriefs(params.trace.episodePrecedents, 4);
  const judgeSystemContext = renderPrompt("contextDecision.judge", {}, englishPromptBinding);
  const repairSystemContext = renderPrompt("contextDecision.repair", {}, englishPromptBinding);
  const userPrompt = [
    `Decision point: ${params.input.decisionPoint}`,
    `Technologies: ${compactLines(params.input.retrievalHints.technologies)}`,
    `Change types: ${compactLines(params.input.retrievalHints.changeTypes)}`,
    `Domains: ${compactLines(params.input.retrievalHints.domains)}`,
    "",
    "Deterministic evidence-derived decision:",
    JSON.stringify(params.deterministic),
    "Deterministic confidence trace:",
    JSON.stringify({
      supportScore: params.trace.supportScore,
      counterScore: params.trace.counterScore,
      preferenceScore: params.trace.preferenceScore,
      riskSignalScore: params.trace.riskSignalScore,
      coverageScore: params.trace.coverageScore,
      verificationScore: params.trace.verificationScore,
      historicalFeedbackScore: params.trace.historicalFeedbackScore,
      finalConfidence: params.trace.finalConfidence,
      forcedRules: params.trace.forcedRules,
    }),
    "",
    "Knowledge Assessment:",
    JSON.stringify(knowledgeAssessmentForPrompt(params.knowledgeAssessment)),
    `Knowledge Assessment recommendedDirection: ${params.knowledgeAssessment.recommendedDirection}`,
    "",
    "Retrieval-scoped Knowledge Prior reference note:",
    JSON.stringify(params.knowledgePrior),
    "",
    "Primary Evidence:",
    JSON.stringify(params.trace.primaryEvidence ?? []),
    "",
    "Similar EpisodeCard precedents:",
    episodeBriefs.length > 0 ? episodeBriefs.join("\n\n") : "none",
    "",
    "Use the Knowledge Prior only as reference material. Evidence trace and deterministic scoring take priority when they conflict.",
    "",
    "Outcome Predictor advisory signal:",
    `- status: ${params.outcomePredictor.status}`,
    `- predictedDecision: ${params.outcomePredictor.predictedDecision ?? "none"}`,
    `- confidence: ${params.outcomePredictor.confidence ?? "none"}`,
    `- trainingSampleCount: ${params.outcomePredictor.trainingSampleCount}`,
    `- classDistribution: ${JSON.stringify(params.outcomePredictor.classDistribution)}`,
    `- reason: ${params.outcomePredictor.reason}`,
    "Use this only as a secondary outcome-history signal. Do not follow it blindly. If Knowledge evidence, coverage, guardrails, or user safety contradict it, override it and explain why. Return one final decision.",
    "",
    "Knowledge interpretation task:",
    "- First classify the selected excerpts by meaning, regardless of their current list label.",
    "- For each selected support/preference Knowledge item, decide adoption=adopted or not_adopted by comparing the item body with this decision point and Primary Evidence.",
    "- For each selected counter/risk Knowledge item, decide adoption=adopted or not_adopted by comparing the item body with this decision point and the specific failure/risk condition.",
    "- For each EpisodeCard precedent, decide adoption=adopted or not_adopted by comparing situation/action/outcome/lesson with the current situation.",
    "- Do not let retrieval role or hit count substitute for this adoption step.",
    "- Make an explicit GO/NO-GO judgment from the available metadata instead of defaulting to user confirmation.",
    "- Estimate risk severity, reversibility, blast radius, and available safeguards before deciding whether to stop.",
    "- If safeguards can bound the risk, prefer revise_and_execute and name the safeguard.",
    "- For runtime restarts, estimate active user/client impact and active in-flight work; bounded impact should usually be GO with safeguards.",
    "- Treat excerpts that forbid, block, require confirmation, require backup, require dry run, require environment confirmation, or require rollback planning as prohibition_or_constraint or risk_warning.",
    "- Count only excerpts that positively permit or recommend the proposed action under the current conditions as execution_support.",
    "- If a prohibition_or_constraint applies to the proposed action and required conditions are absent, it weighs against execute.",
    "- Prefer revise_and_execute when the agent can continue safely after narrowing scope, adding verification, or avoiding the risky sub-action.",
    "- Return reject only when execution itself is clearly unsafe or directly forbidden, not merely because evidence is weak or mixed.",
    "- If you choose a final decision different from Knowledge Assessment recommendedDirection, reasoningSummary must include: Knowledge Assessment override: <reason>.",
    "- Include evidenceInterpretation with a compact classification summary for the selected Knowledge excerpts.",
    "",
    `Coverage: support=${params.supportHits}, preference=${params.preferenceHits}, counter=${params.counterHits}, risk=${params.riskHits}`,
    "",
    "Support/preference Knowledge:",
    supportBriefs.length > 0 ? supportBriefs.join("\n\n") : "none",
    "",
    "Counter Evidence Knowledge:",
    counterBriefs.length > 0 ? counterBriefs.join("\n\n") : "none",
    "",
    "Risk Knowledge:",
    riskBriefs.length > 0 ? riskBriefs.join("\n\n") : "none",
    "",
    "Required JSON shape:",
    JSON.stringify({
      decision: "execute | reject | revise_and_execute | rollback | discard | escalate",
      confidence: "0-100 integer",
      mandate: "short imperative decision mandate",
      selectedAction: "string or null",
      rejectedActions: ["string"],
      reasoningSummary:
        "short explanation, including risk estimate, adopted/non-adopted evidence basis, Knowledge Assessment override and Outcome Predictor override when applicable",
      evidenceInterpretation: [
        {
          title: "knowledge title",
          classification:
            "execution_support | prohibition_or_constraint | risk_warning | verification_requirement | unrelated",
          adoption: "adopted | not_adopted",
          similarityToDecision: "short comparison of candidate content vs current situation",
          appliesToProposedAction: true,
          effectOnDecision:
            "supports execute | weighs against execute | requires revision | ignored",
        },
      ],
      episodeInterpretation: [
        {
          title: "episode title",
          adoption: "adopted | not_adopted",
          similarityToDecision: "short comparison of past case vs current situation",
          effectOnDecision: "supports execute | weighs against execute | background only | ignored",
        },
      ],
    }),
  ].join("\n");

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    try {
      const response = await provider.chat({
        messages: [promptMessage(judgeSystemContext), { role: "user", content: userPrompt }],
        maxTokens: 700,
        temperature: 0,
        responseFormat: "json",
        systemContexts: [judgeSystemContext.manifest],
      });
      const parsed = parseLlmJudgment(response.content, params.trace.finalConfidence);
      if (parsed) {
        if (
          assessmentOverrideExplanationRequired({
            assessmentDirection: params.knowledgeAssessment.recommendedDirection,
            finalDecision: parsed.decision,
            reasoningSummary: parsed.reasoningSummary,
          })
        ) {
          return {
            judgment: assessmentAlignedFallbackJudgment({
              deterministic: params.deterministic,
              assessment: params.knowledgeAssessment,
            }),
            status: "fallback",
          };
        }
        return {
          judgment: { ...parsed, confidence: params.trace.finalConfidence },
          status: "completed",
        };
      }

      const repairResponse = await provider.chat({
        messages: [
          promptMessage(repairSystemContext),
          {
            role: "user",
            content: [
              "Invalid response:",
              response.content,
              "Required keys: decision, confidence, mandate, selectedAction, rejectedActions, reasoningSummary.",
              `Valid decisions: ${contextDecisionValueSchema.options.join(", ")}`,
            ].join("\n"),
          },
        ],
        maxTokens: 500,
        temperature: 0,
        responseFormat: "json",
        systemContexts: [repairSystemContext.manifest],
      });
      const repaired = parseLlmJudgment(repairResponse.content, params.trace.finalConfidence);
      if (repaired) {
        if (
          assessmentOverrideExplanationRequired({
            assessmentDirection: params.knowledgeAssessment.recommendedDirection,
            finalDecision: repaired.decision,
            reasoningSummary: repaired.reasoningSummary,
          })
        ) {
          return {
            judgment: assessmentAlignedFallbackJudgment({
              deterministic: params.deterministic,
              assessment: params.knowledgeAssessment,
            }),
            status: "fallback",
          };
        }
        return {
          judgment: { ...repaired, confidence: params.trace.finalConfidence },
          status: "repaired",
        };
      }
    } catch {}
  }
  return {
    judgment: assessmentAlignedFallbackJudgment({
      deterministic: params.deterministic,
      assessment: params.knowledgeAssessment,
    }),
    status: "fallback",
  };
}

async function composeAgentMessage(params: {
  input: ContextDecisionInput;
  decision: string;
  mandate: string;
  confidence: number;
  status: string;
  supportHits: number;
  preferenceHits: number;
  counterHits: number;
  riskHits: number;
  selectedSupportCount: number;
  evidence: DecisionEvidenceCandidate[];
  supportHitBriefs: string[];
  counterRiskHitBriefs: string[];
  primaryEvidence: ContextDecisionConfidenceTrace["primaryEvidence"];
  episodePrecedents: ContextDecisionConfidenceTrace["episodePrecedents"];
  reliabilityGate: ContextDecisionReliabilityGate;
}): Promise<string> {
  const basisEvidence = params.evidence.filter(
    (item) => item.role === "selected_support" || item.role === "user_preference",
  );
  const basisKnowledgeIds = new Set(basisEvidence.map((item) => item.knowledge.id));
  const riskEvidence = params.evidence.filter(
    (item) =>
      (item.role === "risk_warning" || item.role === "counter_evidence") &&
      !basisKnowledgeIds.has(item.knowledge.id),
  );
  const basisKnowledgeBriefs = buildKnowledgeBriefs(basisEvidence, 5);
  const riskKnowledgeBriefs = buildKnowledgeBriefs(riskEvidence, 2);
  const episodeBriefs = buildEpisodePrecedentBriefs(params.episodePrecedents, 4);
  const fallback = fallbackAgentMessage({
    decision: params.decision,
    confidence: params.confidence,
    supportHits: params.supportHits,
    counterHits: params.counterHits,
    riskHits: params.riskHits,
    status: params.status,
    evidence: params.evidence,
    reliabilityGate: params.reliabilityGate,
    episodePrecedents: params.episodePrecedents,
  });
  const reliabilityGateLines =
    params.reliabilityGate.status === "constrained"
      ? [
          `status=${params.reliabilityGate.status}`,
          `originalDecision=${params.reliabilityGate.originalDecision}`,
          `finalDecision=${params.reliabilityGate.finalDecision}`,
          `confidenceCap=${params.reliabilityGate.confidenceCap ?? "none"}`,
          `rules=${params.reliabilityGate.appliedRules
            .map((item) => `${item.key}:${item.severity}:${item.message}`)
            .join(" | ")}`,
        ]
      : [`status=${params.reliabilityGate.status}`];
  const providers = await contextDecisionLlmProviders("context-decision-answer");
  const answerSystemContext = renderPrompt("contextDecision.answer", {}, englishPromptBinding);
  const userPrompt = [
    `Decision point: ${params.input.decisionPoint}`,
    `Decision: ${params.decision}`,
    `Mandate: ${params.mandate}`,
    `Confidence: ${params.confidence}%`,
    `Status: ${params.status}`,
    `Technologies: ${compactLines(params.input.retrievalHints.technologies)}`,
    `Change types: ${compactLines(params.input.retrievalHints.changeTypes)}`,
    `Domains: ${compactLines(params.input.retrievalHints.domains)}`,
    `Coverage: support=${params.supportHits}, preference=${params.preferenceHits}, counter=${params.counterHits}, risk=${params.riskHits}, selectedSupport=${params.selectedSupportCount}`,
    "",
    "Reliability Gate trace:",
    reliabilityGateLines.join("\n"),
    "",
    "Primary Evidence:",
    JSON.stringify(params.primaryEvidence ?? []),
    "",
    "Similar EpisodeCard precedents:",
    episodeBriefs.length > 0 ? episodeBriefs.join("\n\n") : "none",
    "",
    "Support/preference Knowledge hits to evaluate for adoption:",
    params.supportHitBriefs.length > 0
      ? params.supportHitBriefs.join("\n\n")
      : basisKnowledgeBriefs.length > 0
        ? basisKnowledgeBriefs.join("\n\n")
        : "none",
    "",
    "Counter/risk Knowledge hits to evaluate for adoption:",
    params.counterRiskHitBriefs.length > 0
      ? params.counterRiskHitBriefs.join("\n\n")
      : riskKnowledgeBriefs.length > 0
        ? riskKnowledgeBriefs.join("\n\n")
        : "none",
    "",
    "Answer requirements:",
    "- Start with the decision.",
    "- Frame the result as GO/NO-GO from the evidence, not as a default request to ask the user.",
    "- Explicitly state why this was GO, GO with safeguards, or NO-GO.",
    "- Include a risk estimate when counter/risk Knowledge or failure EpisodeCards are present: severity, reversibility, blast radius, and usable safeguards.",
    "- If the risk can be bounded, choose continuation language and state the safeguard rather than telling the agent to stop.",
    "- Before writing the final rationale, decide which support Knowledge, counter/risk Knowledge, and EpisodeCard candidates are adopted or not adopted.",
    "- In the answer, name the adopted candidate types naturally: support Knowledge, counter/risk Knowledge, or past similar case.",
    "- Explain why an adopted candidate is materially similar to the current decision point; do not cite it just because it was retrieved.",
    "- If a prominent counter/risk or failure EpisodeCard was not adopted, briefly say why it did not match the current situation.",
    "- If operational impact evidence is present in the Reliability Gate trace, include the impact level, active work/client estimate, and why that impact is acceptable or blocking.",
    "- For GO with safeguards, state the concrete safeguard or stop condition that lets the agent continue autonomously.",
    "- Give concrete reasoning only from Knowledge titles and bodies that actually support the final decision after semantic classification.",
    "- Mention when the basis is a procedure, best-practice rule, or repeated prior tendency.",
    "- Treat risk, prohibition, and constraint Knowledge as cautions, guardrail context, or reasons to reject/revise, not as the main reason to execute.",
    "- Prefer revise_and_execute over reject when the remaining safe path is to narrow scope, verify first, or avoid only the risky sub-action.",
    "- Use reject only when the target action itself must stop because the risk is obvious and blocking.",
    "- If Reliability Gate status is constrained, explicitly mention the constraint reason before describing what to do next.",
    "- If the decision is reject, discard, rollback, or escalate, do not say the agent can proceed.",
    "- If the decision is revise_and_execute, state what must be revised before execution.",
    "- Do not include raw IDs, source refs, or long quotations.",
    "Write the answer as the text shown at the top of the Decision screen and returned by the MCP tool.",
  ].join("\n");

  for (const provider of providers) {
    if (!provider.isConfigured()) continue;
    try {
      const response = await provider.chat({
        messages: [promptMessage(answerSystemContext), { role: "user", content: userPrompt }],
        maxTokens: 512,
        temperature: 0,
        responseFormat: "text",
        systemContexts: [answerSystemContext.manifest],
      });
      return normalizeAgentMessage(response.content, fallback);
    } catch {}
  }
  return fallback;
}

function determineEvidenceRole(
  knowledge: KnowledgeSearchResult,
  defaultRole: ContextDecisionEvidenceRole,
): ContextDecisionEvidenceRole {
  if (defaultRole !== "selected_support") {
    return defaultRole;
  }
  const tags = knowledge.intentTags || [];
  if (tags.includes("preference") || tags.includes("user_preference")) {
    return "user_preference";
  }
  if (knowledge.polarity === "negative") {
    return "risk_warning";
  }
  return "selected_support";
}

function evidenceRolesForQueryRole(queryRole: string): ContextDecisionEvidenceRole[] {
  if (queryRole === "support") return ["selected_support"];
  if (queryRole === "counter_evidence") return ["counter_evidence"];
  if (queryRole === "user_preference") return ["user_preference"];
  if (queryRole === "risk") return ["risk_warning"];
  if (queryRole === "alternative") return ["rejected_alternative"];
  return [];
}

function containsProceedClaim(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("proceed") ||
    normalized.includes("execute") ||
    normalized.includes("continue autonomously") ||
    normalized.includes("can continue") ||
    message.includes("進めます") ||
    message.includes("実行します") ||
    message.includes("続行できます") ||
    message.includes("自律的に次へ進め")
  );
}

function validatedAgentMessage(params: {
  decision: ContextDecisionValue;
  message: string;
  fallback: string;
  confidence: number;
  status: string;
}): string {
  if (
    params.decision === "reject" ||
    params.decision === "rollback" ||
    params.decision === "discard" ||
    params.decision === "escalate"
  ) {
    return containsProceedClaim(params.message) ? params.fallback : params.message;
  }
  if (
    (params.confidence < 50 || params.status === "degraded") &&
    containsProceedClaim(params.message)
  ) {
    return params.fallback;
  }
  return params.message;
}

async function persistFailedDecision(params: {
  input: ContextDecisionInput;
  queryCount: number;
  error: unknown;
  primaryEvidence: ContextDecisionConfidenceTrace["primaryEvidence"];
  episodePrecedents: ContextDecisionConfidenceTrace["episodePrecedents"];
}): Promise<ContextDecisionResult> {
  const reason = failureReason(params.error);
  const confidenceTrace: ContextDecisionConfidenceTrace = {
    supportScore: 0,
    counterScore: 0,
    preferenceScore: 0,
    riskSignalScore: 0,
    coverageScore: 0,
    verificationScore: 0,
    historicalFeedbackScore: 0,
    finalConfidence: 0,
    forcedRules: ["retrieval_or_decision_failure_escalate"],
    primaryEvidence: params.primaryEvidence,
    episodePrecedents: params.episodePrecedents,
    directEvidenceRatio: 0,
    primaryEvidenceStrength: primaryEvidenceStrength(params.primaryEvidence ?? []),
    episodePrecedentRisk: params.episodePrecedents?.filter((item) => item.usedFor === "risk_cap")
      .length,
    topicalRelevanceAverage: 0,
    roleFitPassRate: 0,
    confidenceCaps: [
      {
        key: "retrieval_failure",
        cap: 0,
        reason: "Decision retrieval or processing failed before evidence scoring.",
      },
    ],
    signalStatus: {
      status: "failed",
      evidenceCount: 0,
      compileSignalCount: 0,
      communitySignalCount: 0,
      landscapeSignalCount: 0,
      reason,
    },
    llmJudgmentStatus: "fallback",
  };
  const agentMessage = `判断は escalate です。Decision 実行中に検索または signal 取得が失敗したため、自律実行せずユーザー確認に進むべき状態です。失敗理由: ${reason}`;
  const decisionId = await insertContextDecisionRun({
    input: inputForDecisionRunPersistence(params.input),
    decision: "escalate",
    selectedAction: null,
    rejectedActions: ["execute"],
    mandate: "Escalate because context_decision could not retrieve auditable evidence.",
    agentMessage,
    confidence: 0,
    confidenceTrace,
    guardrails: buildGuardrails(params.input, []),
    unsupportedAlternatives: [],
    status: "failed",
  });
  return {
    decisionId,
    decision: "escalate",
    mandate: "Escalate because context_decision could not retrieve auditable evidence.",
    confidence: 0,
    agentMessage,
    feedbackHandle: {
      decisionId,
      tool: "context_decision_feedback",
    },
    coverageSummary: {
      queryCount: params.queryCount,
      supportHits: 0,
      counterEvidenceHits: 0,
      degraded: true,
    },
  };
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : "context decision failed";
}

function postRunPersistenceFailureResult(params: {
  decisionId: string;
  reason: string;
  queryCount: number;
  supportHits: number;
  counterHits: number;
}): ContextDecisionResult {
  const agentMessage = `判断は escalate です。Decision run は作成されましたが、evidence または coverage の監査情報保存に失敗したため、自律実行せずユーザー確認に進むべき状態です。失敗理由: ${params.reason}`;
  return {
    decisionId: params.decisionId,
    decision: "escalate",
    mandate:
      "Escalate because context_decision could not persist complete audit evidence for the decision.",
    confidence: 0,
    agentMessage,
    feedbackHandle: {
      decisionId: params.decisionId,
      tool: "context_decision_feedback",
    },
    coverageSummary: {
      queryCount: params.queryCount,
      supportHits: params.supportHits,
      counterEvidenceHits: params.counterHits,
      degraded: true,
    },
  };
}

export async function decideContext(input: unknown): Promise<ContextDecisionResult> {
  const parsed = contextDecisionInputSchema.parse(input);
  const primaryEvidence = extractDecisionPrimaryEvidence(parsed);
  const episodePrecedents = await retrieveDecisionEpisodePrecedents(parsed);
  if (episodePrecedents.length > 0) {
    await recordEpisodeUsage({
      usageKind: "decision",
      episodeIds: episodePrecedents.map((episode) => episode.episodeId),
    });
  }
  const coverageQueries = buildDecisionCoverageQueries(parsed);
  let coverageResults: Array<(typeof coverageQueries)[number] & { hits: KnowledgeSearchResult[] }>;
  try {
    coverageResults = await Promise.all(
      coverageQueries.map(async (query) => {
        const hits = await searchKnowledge(
          {
            query: query.query,
            status: "active",
            limit: 6,
            includeDraft: false,
            includeGeneral: true,
          },
          {
            includeGeneral: true,
            technologies: parsed.retrievalHints.technologies,
            changeTypes: parsed.retrievalHints.changeTypes,
            domains: parsed.retrievalHints.domains,
          },
        );
        return { ...query, hits: uniqueById(hits).filter(isRelevantDecisionKnowledge) };
      }),
    );
  } catch (error) {
    return persistFailedDecision({
      input: parsed,
      queryCount: coverageQueries.length,
      error,
      primaryEvidence,
      episodePrecedents,
    });
  }

  try {
    const supportHits = coverageResults.find((item) => item.queryRole === "support")?.hits ?? [];
    const preferenceHits =
      coverageResults.find((item) => item.queryRole === "user_preference")?.hits ?? [];
    const riskHits = coverageResults.find((item) => item.queryRole === "risk")?.hits ?? [];
    const counterHits =
      coverageResults.find((item) => item.queryRole === "counter_evidence")?.hits ?? [];
    const alternativeHits =
      coverageResults.find((item) => item.queryRole === "alternative")?.hits ?? [];
    const analysisByRoleAndKnowledge = new Map<string, DecisionKnowledgeAnalysis>();
    const analysisFor = (
      queryRole: ContextDecisionCoverageQueryRole,
      knowledge: KnowledgeSearchResult,
    ) => {
      const key = candidateTraceKey(queryRole, knowledge.id);
      const existing = analysisByRoleAndKnowledge.get(key);
      if (existing) return existing;
      const analysis = analyzeDecisionKnowledge({
        input: parsed,
        primaryEvidence,
        episodePrecedents,
        knowledge,
        queryRole,
      });
      analysisByRoleAndKnowledge.set(key, analysis);
      return analysis;
    };
    for (const result of coverageResults) {
      for (const hit of result.hits) {
        analysisFor(result.queryRole, hit);
      }
    }
    const negativeHits = coverageResults
      .flatMap((item) => item.hits)
      .filter(isNegativeKnowledge)
      .sort((left, right) => (Number(right.score) || 0) - (Number(left.score) || 0));

    const roleSelection = selectUniqueKnowledgeByRole({
      support: supportHits
        .filter((item) => !isNegativeKnowledge(item))
        .filter((item) => {
          const analysis = analysisFor("support", item);
          return (
            analysis.topicalRelevanceScore >= 70 &&
            analysis.roleFit.classification === "direct_support"
          );
        })
        .slice(0, 4),
      counterEvidence: counterHits
        .filter((item) => !isNegativeKnowledge(item))
        .filter((item) => {
          const analysis = analysisFor("counter_evidence", item);
          return (
            analysis.topicalRelevanceScore >= 40 &&
            (analysis.roleFit.classification === "counter_evidence" ||
              analysis.roleFit.classification === "direct_risk")
          );
        })
        .slice(0, 3),
      userPreference: preferenceHits
        .filter(isUserPreferenceKnowledge)
        .filter((item) => analysisFor("user_preference", item).topicalRelevanceScore >= 40)
        .slice(0, 2),
      risk: uniqueById([...riskHits, ...negativeHits])
        .filter((item) => {
          const analysis = analysisFor("risk", item);
          return (
            analysis.topicalRelevanceScore >= 40 &&
            analysis.topicalRelevanceCategory !== "off_topic"
          );
        })
        .slice(0, 4),
      alternative: alternativeHits
        .filter((item) => analysisFor("alternative", item).topicalRelevanceScore >= 30)
        .slice(0, 2),
    });
    const selectedSupport = roleSelection.selectedByRole.support;
    const selectedCounterEvidence = roleSelection.selectedByRole.counter_evidence;
    const selectedPreference = roleSelection.selectedByRole.user_preference;
    const selectedRisk = roleSelection.selectedByRole.risk;
    const selectedAlternatives = roleSelection.selectedByRole.alternative;
    const evidenceCandidates = normalizeEvidenceCandidateRoles([
      ...selectedSupport.map((knowledge) => ({
        knowledge,
        role: determineEvidenceRole(knowledge, "selected_support"),
        analysis: analysisFor("support", knowledge),
      })),
      ...selectedCounterEvidence.map((knowledge) => ({
        knowledge,
        role: "counter_evidence" as const,
        analysis: analysisFor("counter_evidence", knowledge),
      })),
      ...selectedPreference.map((knowledge) => ({
        knowledge,
        role: determineEvidenceRole(knowledge, "user_preference"),
        analysis: analysisFor("user_preference", knowledge),
      })),
      ...selectedRisk.map((knowledge) => ({
        knowledge,
        role: determineEvidenceRole(knowledge, "risk_warning"),
        analysis: analysisFor("risk", knowledge),
      })),
      ...selectedAlternatives.map((knowledge) => ({
        knowledge,
        role: determineEvidenceRole(knowledge, "rejected_alternative"),
        analysis: analysisFor("alternative", knowledge),
      })),
    ]);
    const effectiveSelectedSupport = evidenceCandidates
      .filter((item) => item.role === "selected_support")
      .map((item) => item.knowledge);
    const effectiveSelectedRisk = evidenceCandidates
      .filter((item) => item.role === "risk_warning")
      .map((item) => item.knowledge);
    const signalResult = await loadDecisionSignalBundles(
      evidenceCandidates.map((item) => item.knowledge.id),
    );
    const evidenceWithSignals: DecisionEvidenceCandidate[] = evidenceCandidates.map((item) => ({
      ...item,
      signals: signalResult.bundles.get(item.knowledge.id),
    }));

    const relatedBadSignalSummary = await getRelatedDecisionBadSignalSummary(
      effectiveSelectedSupport.map((item) => item.id),
    );
    const relatedBadSignalCount = relatedBadSignalSummary.count;
    const scored = scoreContextDecision({
      input: parsed,
      evidence: evidenceWithSignals,
      coverage: coverageResults.map((item) => ({
        queryRole: item.queryRole,
        hitCount: item.hits.length,
      })),
      relatedBadSignalCount,
      primaryEvidence,
      episodePrecedents,
    });
    const selectedIdsByRole = new Map(
      coverageResults.map((item) => {
        const evidenceRoles = new Set(evidenceRolesForQueryRole(item.queryRole));
        const selectedForRole = new Set(
          evidenceCandidates
            .filter((candidate) => evidenceRoles.has(candidate.role))
            .map((candidate) => candidate.knowledge.id),
        );
        return [
          item.queryRole,
          item.hits
            .map((knowledge) => knowledge.id)
            .filter((knowledgeId) => selectedForRole.has(knowledgeId)),
        ];
      }),
    );
    const assessmentCoverage = coverageResults.map((item) => ({
      queryRole: item.queryRole,
      hits: item.hits,
      selectedKnowledgeIds: selectedIdsByRole.get(item.queryRole) ?? [],
      duplicateSuppressedKnowledgeIds:
        item.queryRole === "support"
          ? roleSelection.suppressedByRole.support
          : item.queryRole === "counter_evidence"
            ? roleSelection.suppressedByRole.counter_evidence
            : item.queryRole === "user_preference"
              ? roleSelection.suppressedByRole.user_preference
              : item.queryRole === "risk"
                ? roleSelection.suppressedByRole.risk
                : item.queryRole === "alternative"
                  ? roleSelection.suppressedByRole.alternative
                  : [],
    }));
    const candidateTraces = buildContextDecisionCandidateTraces(assessmentCoverage).map((trace) => {
      const analysis = analysisByRoleAndKnowledge.get(
        candidateTraceKey(trace.role, trace.knowledgeId),
      );
      const duplicateSuppressed = trace.rejectionReason?.includes("duplicate suppressed") ?? false;
      return {
        ...trace,
        selectionStage: traceSelectionStage({
          selected: trace.selected,
          duplicateSuppressed,
          queryRole: trace.role,
          analysis,
        }),
        topicalRelevanceScore: analysis?.topicalRelevanceScore,
        topicalRelevanceReason: analysis?.topicalRelevanceReason,
        roleFit: analysis?.roleFit,
        selectionReason:
          trace.selected && analysis
            ? `${trace.selectionReason}; relevance ${analysis.topicalRelevanceScore}; role ${analysis.roleFit.classification}`
            : trace.selectionReason,
        rejectionReason:
          trace.selected || !analysis
            ? trace.rejectionReason
            : analysis.topicalRelevanceScore < 40
              ? "topical relevance below background threshold"
              : !roleFitSupportsQueryRole(trace.role, analysis)
                ? `role fit classified as ${analysis.roleFit.classification}`
                : trace.rejectionReason,
      };
    });
    const supportHitBriefs = buildCoverageHitBriefs({
      queryRole: "support",
      hits: supportHits,
      evidence: evidenceWithSignals,
      candidateTraces,
      analysisByRoleAndKnowledge,
      limit: 6,
    });
    const counterRiskHitBriefs = [
      ...buildCoverageHitBriefs({
        queryRole: "counter_evidence",
        hits: counterHits,
        evidence: evidenceWithSignals,
        candidateTraces,
        analysisByRoleAndKnowledge,
        limit: 4,
      }),
      ...buildCoverageHitBriefs({
        queryRole: "risk",
        hits: riskHits,
        evidence: evidenceWithSignals,
        candidateTraces,
        analysisByRoleAndKnowledge,
        limit: 4,
      }),
    ].slice(0, 8);
    const knowledgeAssessment = assessContextDecisionKnowledge({
      evidence: evidenceWithSignals,
      coverage: assessmentCoverage,
      candidateTraces,
      relatedBadSignalCount,
    });
    knowledgeAssessment.signalSummary = buildDecisionSignalAssessmentSummary(signalResult);
    const knowledgePrior = buildContextDecisionKnowledgePrior({
      evidence: evidenceWithSignals,
      candidateTraces,
    });

    const selectedAction = null;
    const deterministic = deterministicJudgment({
      selectedAction,
      confidence: scored.confidence,
    });
    const mlFeatures = buildContextDecisionMlFeatures({
      input: parsed,
      evidence: evidenceWithSignals,
      coverage: coverageResults.map((item) => ({
        queryRole: item.queryRole,
        hitCount: item.hits.length,
      })),
      trace: scored.trace,
      relatedBadSignalCount,
    });
    const trainingRows = await listContextDecisionMlTrainingRows({ limit: 500 });
    const outcomePredictor = await buildContextDecisionMlSignal({
      currentFeatures: mlFeatures,
      trainingRows,
    });
    const llmJudgment = await structuredLlmJudgment({
      input: parsed,
      deterministic,
      trace: scored.trace,
      knowledgeAssessment,
      knowledgePrior,
      outcomePredictor,
      evidence: evidenceWithSignals,
      supportHits: supportHits.length,
      preferenceHits: preferenceHits.length,
      counterHits: counterHits.length,
      riskHits: riskHits.length,
    });
    const reliabilityResult = applyContextDecisionReliabilityGate({
      judgment: llmJudgment.judgment,
      knowledgeAssessment,
      evidence: evidenceWithSignals,
      relatedBadSignalSummary,
      decisionPoint: parsed.decisionPoint,
      metadata: parsed.metadata,
      signalLoadStatus: signalResult.status,
      signalLoadReason: signalResult.reason,
    });
    const signalTrace = signalTracePayload(signalResult);
    const confidenceTrace: ContextDecisionConfidenceTrace = {
      ...scored.trace,
      finalConfidence: reliabilityResult.judgment.confidence,
      signalStatus: summarizeDecisionSignals(signalResult),
      compileSignals: signalTrace.compileSignals,
      communitySignals: signalTrace.communitySignals,
      landscapeSignals: signalTrace.landscapeSignals,
      knowledgeAssessment,
      knowledgePrior,
      outcomePredictor,
      mlSignal: outcomePredictor,
      candidateTraces: capCandidateTraces(candidateTraces),
      llmJudgmentStatus: llmJudgment.status,
      reliabilityGate: reliabilityResult.gate,
    };
    const decision = reliabilityResult.judgment.decision;
    const mandate = reliabilityResult.judgment.mandate;
    const finalSelectedAction = reliabilityResult.judgment.selectedAction;
    const rejectedActions = reliabilityResult.judgment.rejectedActions;
    const unsupportedAlternatives: Array<Record<string, unknown>> = [];
    const guardrails = buildGuardrails(parsed, effectiveSelectedRisk);
    const finalStatus =
      scored.status === "degraded" ||
      reliabilityResult.gate.status === "constrained" ||
      llmJudgment.status !== "completed" ||
      signalResult.status !== "complete"
        ? "degraded"
        : "completed";
    const rawAgentMessage = await composeAgentMessage({
      input: parsed,
      decision,
      mandate,
      confidence: reliabilityResult.judgment.confidence,
      status: finalStatus,
      supportHits: supportHits.length,
      preferenceHits: preferenceHits.length,
      counterHits: counterHits.length,
      riskHits: riskHits.length,
      selectedSupportCount: effectiveSelectedSupport.length,
      evidence: evidenceWithSignals,
      supportHitBriefs,
      counterRiskHitBriefs,
      primaryEvidence: confidenceTrace.primaryEvidence,
      episodePrecedents: confidenceTrace.episodePrecedents,
      reliabilityGate: reliabilityResult.gate,
    });
    const agentMessage = validatedAgentMessage({
      decision,
      message: rawAgentMessage,
      confidence: reliabilityResult.judgment.confidence,
      status: finalStatus,
      fallback: fallbackAgentMessage({
        decision,
        confidence: reliabilityResult.judgment.confidence,
        supportHits: supportHits.length,
        counterHits: counterHits.length,
        riskHits: riskHits.length,
        status: finalStatus,
        evidence: evidenceWithSignals,
        reliabilityGate: reliabilityResult.gate,
        episodePrecedents,
      }),
    });

    const decisionId = await insertContextDecisionRun({
      input: inputForDecisionRunPersistence(parsed),
      decision,
      selectedAction: finalSelectedAction,
      rejectedActions,
      mandate,
      agentMessage,
      confidence: reliabilityResult.judgment.confidence,
      confidenceTrace,
      guardrails,
      unsupportedAlternatives,
      status: finalStatus,
    });

    let persistenceStage = "context_decision_evidence";
    try {
      await insertContextDecisionEvidenceRows(
        decisionId,
        evidenceWithSignals.map(({ knowledge, role, signals }) => {
          const candidateTrace = bestCandidateTrace(candidateTraces, knowledge.id);
          const analysis = candidateTrace?.roleFit
            ? {
                topicalRelevanceScore: candidateTrace.topicalRelevanceScore,
                topicalRelevanceReason: candidateTrace.topicalRelevanceReason,
                roleFit: candidateTrace.roleFit,
                selectionStage: candidateTrace.selectionStage,
              }
            : {};
          return {
            knowledgeId: knowledge.id,
            role,
            weightAtDecision: evidenceWeightAtDecision(knowledge, role, signals),
            dynamicScoreAtDecision: Math.round(knowledge.dynamicScore),
            applicabilityScore: Math.round(knowledge.applicabilityScore),
            temporalRelevance: knowledge.lastVerifiedAt ? 85 : 55,
            summary: summarizeKnowledge(knowledge),
            sourceRefs: knowledge.sourceRefs,
            metadata: {
              title: knowledge.title,
              type: knowledge.type,
              status: knowledge.status,
              score: knowledge.score,
              retrievalMethod: candidateTrace?.retrievalMethod ?? "keyword",
              vectorStatus: candidateTrace?.vectorStatus ?? "unavailable",
              vectorSimilarity: candidateTrace?.vectorSimilarity ?? null,
              keywordScore: candidateTrace?.keywordScore ?? knowledgeScorePercent(knowledge),
              facetScore: candidateTrace?.facetScore ?? Math.round(knowledge.applicabilityScore),
              sourceQualityScore: candidateTrace?.sourceQualityScore ?? null,
              candidateScore: candidateTrace?.finalCandidateScore ?? null,
              selectionReason: candidateTrace?.selectionReason ?? "selected evidence candidate",
              ...analysis,
              confidence: knowledge.confidence,
              importance: knowledge.importance,
              signals: signals ?? {},
            },
          };
        }),
      );

      if (
        counterHits.length === 0 &&
        coverageResults.some((item) => item.queryRole === "counter_evidence")
      ) {
        persistenceStage = "missing_counter_evidence";
        await insertContextDecisionEvidenceRows(decisionId, [
          {
            knowledgeId: null,
            role: "missing_counter_evidence",
            weightAtDecision: 0,
            dynamicScoreAtDecision: null,
            applicabilityScore: null,
            temporalRelevance: null,
            summary:
              "No counter-evidence was found in the v1 multi-query coverage trace. This is recorded as weak context only, not positive proof.",
            sourceRefs: [],
            metadata: { neutral: true, retrievalMethod: "keyword", vectorStatus: "unavailable" },
          },
        ]);
      }

      persistenceStage = "context_decision_coverage";
      await insertContextDecisionCoverageRows(
        decisionId,
        coverageResults.map((item) => {
          const selectedKnowledgeIds = selectedIdsByRole.get(item.queryRole) ?? [];
          return {
            query: item.query,
            queryRole: item.queryRole,
            scope: {
              knowledgeStatus: "active",
              retrievalMethods: ["keyword", "facet", "hybrid"],
              vectorStatus: "unavailable",
              normalizedKeywords: item.normalizedKeywords,
              retrievalInput: item.retrievalInput,
              signalStatus: signalResult.status,
            },
            hitCount: item.hits.length,
            maxSimilarity: maxSimilarity(item.hits),
            selectedKnowledgeIds,
            rejectedKnowledgeIds: item.hits
              .map((knowledge) => knowledge.id)
              .filter((id) => !selectedKnowledgeIds.includes(id)),
            reason: item.reason,
          };
        }),
      );
    } catch (error) {
      const reason = failureReason(error);
      const failureResult = postRunPersistenceFailureResult({
        decisionId,
        reason,
        queryCount: coverageResults.length,
        supportHits: supportHits.length,
        counterHits: counterHits.length,
      });
      await markContextDecisionRunFailed(decisionId, {
        reason,
        stage: persistenceStage,
        mandate: failureResult.mandate,
        agentMessage: failureResult.agentMessage,
      }).catch(() => undefined);
      return failureResult;
    }

    return {
      decisionId,
      decision,
      mandate,
      confidence: reliabilityResult.judgment.confidence,
      agentMessage,
      feedbackHandle: {
        decisionId,
        tool: "context_decision_feedback",
      },
      coverageSummary: {
        queryCount: coverageResults.length,
        supportHits: supportHits.length,
        counterEvidenceHits: counterHits.length,
        degraded: finalStatus !== "completed",
      },
    };
  } catch (error) {
    return persistFailedDecision({
      input: parsed,
      queryCount: coverageQueries.length,
      error,
      primaryEvidence,
      episodePrecedents,
    });
  }
}

export { getContextDecisionDetail, listContextDecisionRuns };
