import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  type DistillationChatClient,
  type DistillationProviderSetting,
  type DistillationToolExecutor,
  resolveRouteModelForProvider,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationProviderName } from "../distillation/llm-resolver.js";
import { getFindCandidateResultById } from "../findCandidate/repository.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveCoverEvidenceRoutes,
} from "../settings/settings.service.js";
import {
  type RuntimeSettingsRoute,
  requireStaticRuntimeSettingsRoute,
} from "../settings/settings.types.js";
import { dedupeCoverEvidenceCandidate } from "./dedupe.service.js";
import {
  baseCandidate,
  candidateOriginHintsFromOrigin,
  isRetryableCoverEvidenceStatus,
  makeResult,
  mergeReferences,
  normalizeProcedureBodyQuality,
  referencesFromDuplicateRefs,
  requiresExternalEvidence,
  sourceContextForPrompts,
} from "./helpers.js";
import {
  appendOptionalMcpEvidence,
  runExternalEvidence,
  runValueAssessment,
} from "./llm-runner.js";
import { parseCoverEvidenceResult } from "./parser.js";
import { resolveCoverEvidenceRouteByPolicy } from "./provider-policy.js";
import {
  coverEvidenceResultFromRow,
  saveCoverEvidenceResult,
  selectCoverEvidenceResultById,
} from "./repository.js";
import {
  type SourceSupportResult,
  evaluateSourceSupport,
  readSourceEvidenceForCandidate,
} from "./source-support.service.js";
import type { CoverEvidenceInput, CoverEvidenceResult, CoverEvidenceToolEvent } from "./types.js";

export type CoverEvidenceRunInput = CoverEvidenceInput & {
  chatClient?: DistillationChatClient;
  toolExecutor?: DistillationToolExecutor;
};

export type CoverEvidenceRunResult = {
  id: string;
  result: CoverEvidenceResult;
};

type CoverEvidenceResolvedProviderRoute = {
  provider: DistillationProviderSetting;
  fallbackOrder: DistillationProviderName[];
  model: string;
  azureDeploymentSlots?: number[];
  localLlmModel?: string;
};

function isCoverEvidenceFailureStatus(status: string): boolean {
  return status === "parse_failed" || status === "tool_failed" || status === "provider_failed";
}

function summarizeCoverEvidenceFailure(result: CoverEvidenceResult): Record<string, unknown> {
  const parseFailureEvent = result.toolEvents.find(
    (event) => event.name === "parse_cover_evidence_result" && event.ok === false,
  );
  const metadata =
    parseFailureEvent?.metadata && typeof parseFailureEvent.metadata === "object"
      ? (parseFailureEvent.metadata as Record<string, unknown>)
      : null;
  return {
    reason: result.reason ?? null,
    candidatePresent: Boolean(result.candidate),
    toolEventCount: result.toolEvents.length,
    failedToolEventNames: result.toolEvents
      .filter((event) => event.ok === false)
      .map((event) => event.name),
    parseFailure: metadata
      ? {
          parserEventName: parseFailureEvent?.name ?? null,
          parserError: parseFailureEvent?.error ?? null,
          parserReason: metadata.reason ?? null,
          contentChars: metadata.contentChars ?? null,
          contentPreview: metadata.contentPreview ?? null,
          toolEventCount: metadata.toolEventCount ?? null,
        }
      : null,
  };
}

function dedupeProviderFallbackOrder(
  values: DistillationProviderName[],
  primary: DistillationProviderSetting,
): DistillationProviderName[] {
  const seen = new Set<DistillationProviderName>();
  const deduped: DistillationProviderName[] = [];
  for (const value of values) {
    if (value === primary || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function resolveCoverEvidenceProviderRoute(params: {
  route: RuntimeSettingsRoute;
  providerOverride?: DistillationProviderSetting;
  providerFallbackMode?: "fallback" | "single";
}): CoverEvidenceResolvedProviderRoute {
  const route = requireStaticRuntimeSettingsRoute(params.route);
  const provider = params.providerOverride ?? (route.provider as DistillationProviderSetting);
  const fallbackMode = params.providerFallbackMode === "single" ? "single" : "fallback";
  const routeFallback = [...route.fallback] as DistillationProviderName[];
  const fallbackOrder =
    fallbackMode === "single" ? [] : dedupeProviderFallbackOrder(routeFallback, provider);
  const routeModelBelongsToProvider = route.provider === provider;

  return {
    provider,
    fallbackOrder,
    model: resolveRouteModelForProvider({
      provider,
      routeModel: routeModelBelongsToProvider ? route.model : undefined,
      localLlmModel: routeModelBelongsToProvider ? route.localLlmModel : undefined,
    }),
    azureDeploymentSlots: route.azureDeploymentSlots ? [...route.azureDeploymentSlots] : undefined,
    localLlmModel: route.localLlmModel,
  };
}

async function recordProcedureDemotionAudit(params: {
  id: string;
  result: CoverEvidenceResult;
  saved: boolean;
  cached?: boolean;
}): Promise<void> {
  const events = params.result.toolEvents.filter(
    (event) => event.name === "procedure_demoted_to_rule" && event.ok,
  );
  for (const event of events) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceProcedureDemotedToRule,
      actor: "system",
      payload: {
        id: params.id,
        stage: params.result.stage,
        saved: params.saved,
        cached: Boolean(params.cached),
        metadata: event.metadata ?? {},
      },
    });
  }
}

function shouldVerifySourceSupportWithLlm(
  support: SourceSupportResult,
  sourceContent: string,
): boolean {
  if (support.ok || support.reason === "not_actionable") return false;
  return sourceContent.trim().length > 0;
}

function sourceSupportDiagnosticEvent(support: SourceSupportResult): CoverEvidenceToolEvent | null {
  if (support.ok) return null;
  return {
    name: "source_support",
    ok: false,
    metadata: {
      reason: support.reason,
      confidence: support.confidence,
      overlapRatio: support.overlapRatio,
      matchedTokenCount: support.matchedTokenCount,
      checkedTokenCount: support.checkedTokenCount,
      mode: "llm_verification",
    },
  };
}

function prependToolEvents(
  result: CoverEvidenceResult,
  toolEvents: CoverEvidenceToolEvent[],
): CoverEvidenceResult {
  return toolEvents.length > 0
    ? {
        ...result,
        toolEvents: [...toolEvents, ...result.toolEvents],
      }
    : result;
}

export async function runCoverEvidence(
  input: CoverEvidenceRunInput,
): Promise<CoverEvidenceRunResult> {
  const id = input.id.trim();
  if (!id) {
    throw new Error("id is required");
  }
  await ensureRuntimeSettingsLoaded();
  const routes = resolveCoverEvidenceRoutes();
  const providerPolicy = input.providerPolicy ?? "default";
  const resolvedProviderFallbackMode =
    providerPolicy === "cloud_api" ? "fallback" : input.providerFallbackMode;
  const providerOverride = providerPolicy === "cloud_api" ? undefined : input.provider;

  const sourceSupportRuntimeRoute = resolveCoverEvidenceRouteByPolicy({
    route: routes.sourceSupport,
    policy: providerPolicy,
    routeName: "sourceSupport",
  });
  const externalEvidenceRuntimeRoute = resolveCoverEvidenceRouteByPolicy({
    route: routes.externalEvidence,
    policy: providerPolicy,
    routeName: "externalEvidence",
  });
  const mcpEvidenceRuntimeRoute = resolveCoverEvidenceRouteByPolicy({
    route: routes.mcpEvidence,
    policy: providerPolicy,
    routeName: "mcpEvidence",
  });

  const sourceSupportRoute = resolveCoverEvidenceProviderRoute({
    route: sourceSupportRuntimeRoute,
    providerOverride,
    providerFallbackMode: resolvedProviderFallbackMode,
  });
  const sourceSupportProvider = sourceSupportRoute.provider;
  const sourceSupportFallbackOrder = sourceSupportRoute.fallbackOrder;
  const sourceSupportModel = sourceSupportRoute.model;
  const sourceSupportAzureDeploymentSlots = sourceSupportRoute.azureDeploymentSlots;
  const sourceSupportLocalLlmModel = sourceSupportRoute.localLlmModel;

  const externalEvidenceRoute = resolveCoverEvidenceProviderRoute({
    route: externalEvidenceRuntimeRoute,
    providerOverride,
    providerFallbackMode: resolvedProviderFallbackMode,
  });
  const externalEvidenceProvider = externalEvidenceRoute.provider;
  const externalEvidenceFallbackOrder = externalEvidenceRoute.fallbackOrder;
  const externalEvidenceModel = externalEvidenceRoute.model;
  const externalEvidenceAzureDeploymentSlots = externalEvidenceRoute.azureDeploymentSlots;
  const externalEvidenceLocalLlmModel = externalEvidenceRoute.localLlmModel;

  const mcpEvidenceRoute = resolveCoverEvidenceProviderRoute({
    route: mcpEvidenceRuntimeRoute,
    providerOverride,
    providerFallbackMode: resolvedProviderFallbackMode,
  });
  const mcpEvidenceProvider = mcpEvidenceRoute.provider;
  const mcpEvidenceFallbackOrder = mcpEvidenceRoute.fallbackOrder;
  const mcpEvidenceModel = mcpEvidenceRoute.model;
  const mcpEvidenceAzureDeploymentSlots = mcpEvidenceRoute.azureDeploymentSlots;
  const mcpEvidenceLocalLlmModel = mcpEvidenceRoute.localLlmModel;

  if (input.write) {
    const existing = await selectCoverEvidenceResultById(id);
    if (existing) {
      const existingResult = coverEvidenceResultFromRow(existing);
      const normalizedExistingResult = normalizeProcedureBodyQuality(existingResult);
      if (input.forceRefreshEvidence || isRetryableCoverEvidenceStatus(existingResult.status)) {
        // Retryable rows are checkpoints, not terminal cache hits.
      } else {
        if (normalizedExistingResult !== existingResult) {
          await saveCoverEvidenceResult({
            id: existing.id,
            result: normalizedExistingResult,
          });
          await recordProcedureDemotionAudit({
            id: existing.id,
            result: normalizedExistingResult,
            saved: true,
            cached: true,
          });
        }
        return {
          id: existing.id,
          result: normalizedExistingResult,
        };
      }
    }
  }

  const row = input.candidate ?? (await getFindCandidateResultById(id));
  if (!row) {
    throw new Error(`find candidate result not found: ${id}`);
  }

  const originObj = row.origin && typeof row.origin === "object" ? (row.origin as any) : {};
  const isNegative = originObj.polarity === "negative";
  if (isNegative) {
    const { runCoverNegativeEvidence } = await import("../coverNegativeEvidence/domain.js");
    return runCoverNegativeEvidence({
      id,
      candidate: row,
      providerPolicy,
      write: input.write,
      chatClient: input.chatClient,
      signal: input.signal,
    });
  }

  await recordAuditLogSafe({
    eventType: auditEventTypes.coverEvidenceStarted,
    actor: "system",
    payload: {
      id,
      targetKind: row.targetKind,
      targetKey: row.targetKey,
      provider: sourceSupportProvider,
      providerOverride: providerOverride ?? null,
      providerPolicy,
      providerFallbackMode: resolvedProviderFallbackMode ?? "fallback",
      providerRoutes: {
        sourceSupport: {
          provider: sourceSupportProvider,
          fallbackOrder: sourceSupportFallbackOrder,
          azureDeploymentSlots: sourceSupportAzureDeploymentSlots,
          localLlmModel: sourceSupportLocalLlmModel,
        },
        externalEvidence: {
          provider: externalEvidenceProvider,
          fallbackOrder: externalEvidenceFallbackOrder,
          azureDeploymentSlots: externalEvidenceAzureDeploymentSlots,
          localLlmModel: externalEvidenceLocalLlmModel,
        },
        mcpEvidence: {
          provider: mcpEvidenceProvider,
          fallbackOrder: mcpEvidenceFallbackOrder,
          azureDeploymentSlots: mcpEvidenceAzureDeploymentSlots,
          localLlmModel: mcpEvidenceLocalLlmModel,
        },
      },
    },
  });

  let result: CoverEvidenceResult | undefined;

  try {
    if (row.status !== "selected") {
      result = makeResult({
        status: "parse_failed",
        stage: "load",
        candidate: null,
        reason: "find_candidate_not_selected",
      });
    } else {
      let sourceRead: Awaited<ReturnType<typeof readSourceEvidenceForCandidate>>;
      try {
        sourceRead = await readSourceEvidenceForCandidate(row);
      } catch (error) {
        result = makeResult({
          status: "tool_failed",
          stage: "source_support",
          candidate: null,
          reason: "source_read_failed",
        });
        sourceRead = {
          primaryContent: null,
          assessmentContent: "",
          assessmentSource: "primary",
          content: "",
          valueAssessmentContent: "",
          references: [],
          readRanges: [],
        };
      }

      if (result === undefined) {
        const hasPrimaryEvidence = sourceRead.primaryContent !== null;
        const support = hasPrimaryEvidence
          ? evaluateSourceSupport({
              title: row.title,
              body: row.content,
              sourceContent: sourceRead.primaryContent ?? "",
            })
          : ({
              ok: false,
              reason: "unsupported_by_source",
              confidence: 0,
              overlapRatio: 0,
              matchedTokenCount: 0,
              checkedTokenCount: 0,
            } satisfies SourceSupportResult);
        const sourceSupportDiagnostics: CoverEvidenceToolEvent[] = [];
        if (
          !support.ok &&
          !shouldVerifySourceSupportWithLlm(support, sourceRead.primaryContent ?? "")
        ) {
          result = makeResult({
            status: "insufficient",
            stage: "source_support",
            candidate: null,
            references: sourceRead.references,
            reason: support.reason,
          });
        } else {
          const diagnosticEvent = sourceSupportDiagnosticEvent(support);
          if (diagnosticEvent) {
            sourceSupportDiagnostics.push(diagnosticEvent);
          }
          const sourceContext = sourceContextForPrompts({
            row,
            readRanges: sourceRead.readRanges,
            assessmentSource: sourceRead.assessmentSource,
            hasPrimaryEvidence,
          });
          const originHints = candidateOriginHintsFromOrigin(row.origin);
          const candidate = baseCandidate({
            title: row.title,
            body: row.content,
            confidence: support.confidence,
            hints: originHints,
          });
          const dedupe = await dedupeCoverEvidenceCandidate(candidate);
          if (dedupe.status !== "unique") {
            result = makeResult({
              status: dedupe.status,
              stage: "dedupe",
              candidate: null,
              references: mergeReferences(
                sourceRead.references,
                referencesFromDuplicateRefs(dedupe.duplicateRefs),
              ),
              duplicateRefs: dedupe.duplicateRefs,
              reason: dedupe.status,
            });
          } else {
            const needsExternalEvidence = requiresExternalEvidence(candidate);
            sourceSupportDiagnostics.push({
              name: "source_first_route",
              ok: true,
              metadata: {
                route: needsExternalEvidence ? "needs_external" : "source_only",
                reason: needsExternalEvidence
                  ? "requires_external_evidence"
                  : "no_external_evidence_signal",
              },
            });
            if (!needsExternalEvidence) {
              result = await runValueAssessment({
                id,
                candidate,
                sourceReferences: sourceRead.references,
                sourceContentExcerpt:
                  sourceRead.valueAssessmentContent || sourceRead.assessmentContent,
                sourceContext,
                candidateTypeHint: originHints.type,
                provider: sourceSupportProvider,
                model: sourceSupportModel,
                fallbackOrder: sourceSupportFallbackOrder,
                azureDeploymentSlots: sourceSupportAzureDeploymentSlots,
                localLlmModel: sourceSupportLocalLlmModel,
                chatClient: input.chatClient,
                signal: input.signal,
              });
            } else {
              result = await runExternalEvidence({
                id,
                candidate,
                sourceReferences: sourceRead.references,
                sourceContentExcerpt: sourceRead.assessmentContent,
                sourceContext,
                candidateTypeHint: originHints.type,
                provider: externalEvidenceProvider,
                model: externalEvidenceModel,
                fallbackOrder: externalEvidenceFallbackOrder,
                azureDeploymentSlots: externalEvidenceAzureDeploymentSlots,
                localLlmModel: externalEvidenceLocalLlmModel,
                forceRefreshEvidence: input.forceRefreshEvidence,
                chatClient: input.chatClient,
                toolExecutor: input.toolExecutor,
                signal: input.signal,
              });
              result = await appendOptionalMcpEvidence({
                id,
                result,
                provider: mcpEvidenceProvider,
                model: mcpEvidenceModel,
                fallbackOrder: mcpEvidenceFallbackOrder,
                azureDeploymentSlots: mcpEvidenceAzureDeploymentSlots,
                localLlmModel: mcpEvidenceLocalLlmModel,
                chatClient: input.chatClient,
                toolExecutor: input.toolExecutor,
                signal: input.signal,
              });
            }
          }
          if (result) {
            result = prependToolEvents(result, sourceSupportDiagnostics);
          }
        }
      }
    }

    if (!result) {
      throw new Error("coverEvidence did not produce a result");
    }

    if (input.write) {
      await saveCoverEvidenceResult({
        id,
        result,
      });
      await recordProcedureDemotionAudit({
        id,
        result,
        saved: true,
      });
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceCompleted,
      actor: "system",
      payload: {
        id,
        status: result.status,
        stage: result.stage,
        saved: Boolean(input.write),
        ...summarizeCoverEvidenceFailure(result),
      },
    });

    if (isCoverEvidenceFailureStatus(result.status)) {
      await recordAuditLogSafe({
        eventType: auditEventTypes.coverEvidenceFailed,
        actor: "system",
        payload: {
          id,
          status: result.status,
          stage: result.stage,
          saved: Boolean(input.write),
          ...summarizeCoverEvidenceFailure(result),
        },
      });
    }

    return { id, result };
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.coverEvidenceFailed,
      actor: "system",
      payload: {
        id,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function runCoverEvidenceSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  const parsed = parseCoverEvidenceResult(
    JSON.stringify({
      schemaVersion: 1,
      status: "knowledge_ready",
      stage: "final",
      candidate: {
        type: "rule",
        title: "coverEvidence smoke keeps evidence refs",
        body: "coverEvidence must preserve source references before finalizeDistille creates drafts.",
        importance: 70,
        confidence: 80,
      },
      references: [
        {
          kind: "source",
          uri: "smoke://cover-evidence",
          note: "smoke source reference",
          evidenceRole: "supports_candidate",
        },
      ],
      duplicateRefs: [],
      toolEvents: [],
      reason: null,
    }),
  );
  return {
    domain: "coverEvidence",
    implemented: true,
    status: "ok",
    checkedAt: new Date().toISOString(),
    message: "coverEvidence parser and runtime are available.",
    receivedInput: input,
    nextContracts: [
      "coverEvidence preserves source references",
      "coverEvidence write=true stores cover_evidence_results",
      "finalizeDistille consumes knowledge_ready cover evidence results",
    ],
  };
}
