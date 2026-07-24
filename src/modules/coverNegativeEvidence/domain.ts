import { resolveCoverEvidenceRouteByPolicy } from "../coverEvidence/provider-policy.js";
import { saveCoverEvidenceResult } from "../coverEvidence/repository.js";
import type { CoverEvidenceResult } from "../coverEvidence/types.js";
import { knowledgeIntentTagSlugs } from "../../knowledge/intentTagDefinitions.js";
import {
  type DistillationChatClient,
  createDefaultChatClient,
  resolveRouteModelForProvider,
} from "../distillation/distillation-runtime.service.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes,
} from "../settings/settings.service.js";
import {
  renderSystemContext,
  systemContextMessage,
} from "../system-context/system-context.service.js";
import {
  applicabilityToCoverCandidateFields,
  hasRequiredApplicabilityFacets,
  mergeApplicability,
  normalizeApplicability,
} from "../knowledge/applicability.js";
import { parseNegativeEvidenceResult } from "./parser.js";
import { buildNegativeEvidenceUserPrompt } from "./prompts.js";

function buildNegativeKnowledgeBody(distilled: {
  failure: string;
  impact?: string;
  trigger?: string;
  fix?: string;
  verification?: string;
  decisionSignal?: string;
}): string {
  return [
    `避けること: ${distilled.failure}`,
    distilled.impact ? `影響: ${distilled.impact}` : null,
    distilled.trigger ? `発生条件: ${distilled.trigger}` : null,
    distilled.fix ? `推奨対応: ${distilled.fix}` : null,
    distilled.verification ? `確認方法: ${distilled.verification}` : null,
    distilled.decisionSignal ? `判断シグナル: ${distilled.decisionSignal}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function hasNonEmptyString(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function distinctEvidenceCount(evidence: string[]): number {
  return new Set(evidence.map((item) => item.trim()).filter(Boolean)).size;
}

function scoreNegativeCandidate(params: {
  evidenceCount: number;
  general: boolean;
  hasTrigger: boolean;
  hasFix: boolean;
  hasVerification: boolean;
  hasDecisionSignal: boolean;
  hasHighRiskTag: boolean;
}): { confidence: number; importance: number } {
  let confidence = 62;
  let importance = 58;

  confidence += Math.min(params.evidenceCount, 3) * 6;
  if (params.hasTrigger) confidence += 6;
  if (params.hasFix) confidence += 6;
  if (params.hasVerification) confidence += 4;
  if (params.hasDecisionSignal) confidence += 2;
  if (params.general) confidence -= 8;

  importance += params.hasHighRiskTag ? 14 : 0;
  importance += params.hasTrigger && params.hasFix ? 8 : 0;
  importance += params.evidenceCount >= 2 ? 6 : 0;
  if (params.general && !params.hasHighRiskTag) importance -= 6;

  return {
    confidence: Math.max(45, Math.min(90, confidence)),
    importance: Math.max(45, Math.min(90, importance)),
  };
}

function assessNegativeQuality(params: {
  status: string;
  polarity: "negative" | "neutral";
  distilled: {
    failure: string;
    impact?: string;
    trigger?: string;
    fix?: string;
    verification?: string;
    decisionSignal?: string;
  };
  evidence: string[];
  intentTags: string[];
  general: boolean;
}): {
  ready: boolean;
  reason: string | null;
  confidence: number;
  importance: number;
  evidenceCount: number;
} {
  const evidenceCount = distinctEvidenceCount(params.evidence);
  const hasTrigger = hasNonEmptyString(params.distilled.trigger);
  const hasFix = hasNonEmptyString(params.distilled.fix);
  const hasVerification = hasNonEmptyString(params.distilled.verification);
  const hasDecisionSignal = hasNonEmptyString(params.distilled.decisionSignal);
  const hasHighRiskTag = params.intentTags.some((tag) =>
    ["regression", "security_risk", "data_integrity"].includes(tag),
  );
  const score = scoreNegativeCandidate({
    evidenceCount,
    general: params.general,
    hasTrigger,
    hasFix,
    hasVerification,
    hasDecisionSignal,
    hasHighRiskTag,
  });

  if (params.status !== "ready") {
    return { ready: false, reason: params.status, evidenceCount, ...score };
  }
  if (params.polarity !== "negative") {
    return { ready: false, reason: "negative_polarity_required", evidenceCount, ...score };
  }
  if (!hasNonEmptyString(params.distilled.failure)) {
    return { ready: false, reason: "negative_failure_required", evidenceCount, ...score };
  }
  if (!hasTrigger) {
    return { ready: false, reason: "negative_trigger_required", evidenceCount, ...score };
  }
  if (!hasFix) {
    return { ready: false, reason: "negative_fix_required", evidenceCount, ...score };
  }
  if (evidenceCount < 2 && !hasHighRiskTag) {
    return { ready: false, reason: "negative_evidence_too_thin", evidenceCount, ...score };
  }
  if (params.general && !hasHighRiskTag && evidenceCount < 3) {
    return {
      ready: false,
      reason: "negative_general_scope_requires_stronger_evidence",
      evidenceCount,
      ...score,
    };
  }

  return { ready: true, reason: null, evidenceCount, ...score };
}

export async function runCoverNegativeEvidence(params: {
  id: string;
  candidate?: any;
  providerPolicy?: string;
  write?: boolean;
  chatClient?: DistillationChatClient;
  signal?: AbortSignal;
}) {
  const id = params.id;
  const row = params.candidate ?? (await getFindCandidateResultById(id));
  if (!row) {
    throw new Error(`find candidate result not found: ${id}`);
  }

  await ensureRuntimeSettingsLoaded();
  const routes = resolveCoverEvidenceRoutes();
  const providerPolicy = params.providerPolicy ?? "default";

  const mcpEvidenceRuntimeRoute = resolveCoverEvidenceRouteByPolicy({
    route: routes.mcpEvidence,
    policy: providerPolicy as any,
    routeName: "mcpEvidence",
  });
  const provider = mcpEvidenceRuntimeRoute.provider;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: mcpEvidenceRuntimeRoute.model,
    localLlmModel: mcpEvidenceRuntimeRoute.localLlmModel,
  });

  const prompt = buildNegativeEvidenceUserPrompt({
    title: row.title,
    content: row.content,
  });
  const systemContext = renderSystemContext("coverEvidence.negative", {
    allowedIntentTags: knowledgeIntentTagSlugs.join(", "),
  });

  const chat =
    params.chatClient ??
    createDefaultChatClient(
      provider,
      "cover-negative-evidence",
      mcpEvidenceRuntimeRoute.fallback,
      mcpEvidenceRuntimeRoute.azureDeploymentSlots,
      mcpEvidenceRuntimeRoute.localLlmModel,
    );
  const response = await chat({
    messages: [systemContextMessage(systemContext), { role: "user", content: prompt }],
    model,
    maxTokens: 2048,
    systemContexts: [systemContext.manifest],
    signal: params.signal,
  });

  const parsed = parseNegativeEvidenceResult(response.content ?? "");
  const appliesTo = mergeApplicability(
    normalizeApplicability(row),
    normalizeApplicability(row.metadata),
    normalizeApplicability(row.origin),
    parsed.appliesTo,
  );
  const quality = assessNegativeQuality({
    status: parsed.status,
    polarity: parsed.polarity,
    distilled: parsed.distilled,
    evidence: parsed.evidence,
    intentTags: parsed.intentTags,
    general: appliesTo?.general === true,
  });

  // Map to CoverEvidenceResult format to keep compatibility with existing pipeline.
  const missingRequiredApplicability = quality.ready && !hasRequiredApplicabilityFacets(appliesTo);
  const mappedStatus =
    quality.ready && !missingRequiredApplicability ? "knowledge_ready" : "insufficient";

  const result: CoverEvidenceResult = {
    schemaVersion: 1,
    status: mappedStatus as any,
    stage: "final",
    candidate:
      quality.ready && !missingRequiredApplicability
        ? {
            type: "rule",
            title: row.title,
            body: buildNegativeKnowledgeBody(parsed.distilled),
            confidence: quality.confidence,
            importance: quality.importance,
            ...applicabilityToCoverCandidateFields(appliesTo),
          }
        : null,
    references: parsed.evidence.map((e) => ({
      kind: "source",
      uri: row.sourceUri || `agent://candidate/${row.id}`,
      note: e,
      evidenceRole: "supports_candidate",
    })),
    duplicateRefs: [],
    toolEvents: [
      {
        name: "negative_coverage",
        ok: true,
        metadata: {
          polarity: parsed.polarity,
          intentTags: parsed.intentTags,
          ...(appliesTo ? { appliesTo } : {}),
          originRefs: parsed.originRefs,
          distilled: parsed.distilled,
          quality: {
            ready: quality.ready,
            reason: quality.reason,
            evidenceCount: quality.evidenceCount,
            confidence: quality.confidence,
            importance: quality.importance,
          },
        },
      },
    ],
    reason: missingRequiredApplicability
      ? "applies_to_categories_required"
      : !quality.ready
        ? quality.reason
        : null,
  };

  if (params.write) {
    await saveCoverEvidenceResult({
      id,
      result,
    });
  }

  return { id, result };
}
export type CoverEvidenceRunResult = {
  id: string;
  result: CoverEvidenceResult;
};
