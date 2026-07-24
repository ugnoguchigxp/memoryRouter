import { groupedConfig } from "../../config.js";
import {
  type DeadZoneMergeReviewResult,
  deadZoneMergeReviewResultSchema,
} from "../../shared/schemas/landscape-deadzone-review.schema.js";
import {
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationMessage } from "../distillation/types.js";
import { resolveDeadZoneMergeReviewRoute } from "../settings/settings.service.js";
import {
  renderSystemContext,
  systemContextMessage,
} from "../system-context/system-context.service.js";

export type DeadZoneMergeReviewKnowledgeSnapshot = {
  id: string;
  title: string;
  body: string;
  type: string;
  status: string;
  appliesTo: Record<string, unknown>;
};

export type DeadZoneMergeReviewInputSnapshot = {
  deadZone: DeadZoneMergeReviewKnowledgeSnapshot & { bodyHash: string };
  canonical: DeadZoneMergeReviewKnowledgeSnapshot & { bodyHash: string };
  heuristicRecommendation: {
    confidence: string;
    reasons: string[];
    blockers: string[];
  };
};

export class DeadZoneMergeReviewParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadZoneMergeReviewParseError";
  }
}

function excerpt(value: string, max = 1200): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function extractJsonObject(value: string): unknown {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? value;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new DeadZoneMergeReviewParseError("merge review response did not contain JSON");
  }
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new DeadZoneMergeReviewParseError(
      error instanceof Error ? error.message : "merge review response JSON parse failed",
    );
  }
}

export async function runDeadZoneMergeReviewLlm(params: {
  inputSnapshot: DeadZoneMergeReviewInputSnapshot;
  signal?: AbortSignal;
}): Promise<DeadZoneMergeReviewResult> {
  const route = resolveDeadZoneMergeReviewRoute();
  const providerSetting = route.provider === "auto" ? "local-llm" : route.provider;
  const model = resolveRouteModelForProvider({
    provider: providerSetting,
    routeModel: route.model,
    localLlmModel: route.localLlmModel,
  });
  const systemContext = renderSystemContext("landscape.deadZoneMergeReview", {});
  const messages: DistillationMessage[] = [
    systemContextMessage(systemContext),
    {
      role: "user",
      content: JSON.stringify({
        task: "dead_zone_merge_review",
        requiredJsonShape: {
          decision: "merge_recommended | merge_blocked | keep_separate | needs_evidence",
          confidence: "low | medium | high",
          rationale: ["short reason"],
          blockers: ["blocking issue"],
          proposedCanonicalBody: "full merged canonical body or null",
          proposedSummary: "short summary or null",
        },
        rule: "Recommend merge only when the canonical item remains coherent and the dead-zone item adds useful, non-conflicting content.",
        input: params.inputSnapshot,
      }),
    },
  ];

  const completion = await runDistillationCompletion(
    {
      model,
      messages,
      maxTokens: 4000,
      systemContexts: [systemContext.manifest],
    },
    {
      providerSetting,
      fallbackOrder: route.fallback,
      azureDeploymentSlots: route.azureDeploymentSlots,
      localLlmModel: route.localLlmModel,
      enableTools: false,
      maxToolRounds: 0,
      usageSource: "dead-zone-merge-review",
      timeoutMs: groupedConfig.distillation.coverEvidenceTimeoutMs,
      signal: params.signal,
    },
  );

  const parsed = deadZoneMergeReviewResultSchema
    .omit({ rawOutputExcerpt: true, parseStatus: true })
    .safeParse(extractJsonObject(completion.content));
  if (!parsed.success) {
    throw new DeadZoneMergeReviewParseError(parsed.error.message);
  }

  return deadZoneMergeReviewResultSchema.parse({
    ...parsed.data,
    rawOutputExcerpt: excerpt(completion.content),
    parseStatus: "parsed",
  });
}
