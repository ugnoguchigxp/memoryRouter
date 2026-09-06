import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import type { CompileInput, RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { getAgenticLlmProviders } from "../llm/agentic-llm.service.js";
import {
  isRateLimitError,
  recordProviderRateLimit,
  recordProviderUsage,
} from "../llm/provider-pressure.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveAgenticCompileRouting,
} from "../settings/settings.service.js";
import { renderPrompt, promptMessage } from "../system-context/system-context.service.js";

export type AgenticCandidate = {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
  polarity?: "positive" | "negative" | "neutral";
  section?: "rules" | "procedures" | "guardrails";
};

export type AgenticRefineResult = {
  items: AgenticCandidate[];
  agenticUsed: boolean;
  reasoning?: string;
  error?: string;
  selectionReason?: "selected" | "empty_selection" | "no_valid_selected_ids";
};

type AgenticLlmOutput = {
  selectedIds: string[];
  reasoning?: string;
};

function buildUserPrompt(goal: string, candidates: AgenticCandidate[]): string {
  const items = candidates.map((item) => ({
    id: item.id,
    type: item.type,
    status: item.status,
    title: item.title,
    content: item.content.slice(0, 500),
    score: Math.round(item.score * 1000) / 1000,
    polarity: item.polarity ?? "positive",
    section:
      item.section ??
      (item.polarity === "negative"
        ? "guardrails"
        : item.type === "procedure"
          ? "procedures"
          : "rules"),
  }));
  return JSON.stringify({ goal, candidates: items });
}

function parseAgenticOutput(raw: string): AgenticLlmOutput | null {
  const parsed = parseLlmJsonLike(raw);
  if (parsed) {
    return normalizeAgenticOutput(parsed.value);
  }

  return parseAgenticLabelOutput(raw);
}

function normalizeStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) {
    return value.every((id) => typeof id === "string") ? value : null;
  }
  if (typeof value === "string") {
    const ids = value
      .split(/[\s,]+/)
      .map((id) => id.trim())
      .filter(Boolean);
    return ids.length > 0 ? ids : null;
  }
  return null;
}

function normalizeAgenticOutput(value: unknown): AgenticLlmOutput | null {
  if (Array.isArray(value)) {
    const selectedIds = normalizeStringArray(value);
    return selectedIds ? { selectedIds, reasoning: "Converted from array format" } : null;
  }
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const decisions = Array.isArray(obj.decisions) ? obj.decisions : null;
  if (decisions) {
    const selected = new Set(
      decisions.flatMap((decision) => {
        if (typeof decision !== "object" || decision === null) return [];
        const entry = decision as Record<string, unknown>;
        return (entry.verdict === "include" || entry.verdict === "conditional") &&
          typeof entry.candidateId === "string"
          ? [entry.candidateId]
          : [];
      }),
    );
    const ordered = normalizeStringArray(obj.orderedOptionalIds) ?? [];
    const selectedIds = [
      ...ordered.filter((id) => selected.delete(id)),
      ...selected,
    ];
    return { selectedIds };
  }
  const selectedIds =
    normalizeStringArray(obj.selectedIds) ??
    normalizeStringArray(obj.ids) ??
    normalizeStringArray(obj.knowledgeIds) ??
    normalizeStringArray(obj.selected);
  if (!selectedIds) return null;
  return {
    selectedIds,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
  };
}

function parseAgenticLabelOutput(raw: string): AgenticLlmOutput | null {
  const selectedMatch = raw.match(/(?:selectedIds|selected|ids|knowledgeIds)\s*[:：]\s*([^\n]+)/i);
  if (!selectedMatch?.[1]) return null;
  const selectedIds = selectedMatch[1]
    .replace(/[[\]"'`]/g, "")
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (selectedIds.length === 0) return null;
  const reasoning = raw.match(/reasoning\s*[:：]\s*([^\n]+)/i)?.[1]?.trim();
  return { selectedIds, reasoning };
}

function selectCandidates(
  candidates: AgenticCandidate[],
  selectedIds: string[],
): AgenticCandidate[] {
  const candidateMap = new Map(candidates.map((item) => [item.id, item]));
  const selected: AgenticCandidate[] = [];

  for (const id of selectedIds) {
    const item = candidateMap.get(id);
    if (item) {
      selected.push(item);
      candidateMap.delete(id);
    }
  }

  return selected;
}

function formatAutoFallbackError(messages: string[]): string {
  const detail = messages.join(" | ");
  return `AGENTIC_REFINE_FAILED: ${detail}`;
}

function modelForProvider(provider: string, routeModel?: string): string {
  switch (provider) {
    case "openai":
      return groupedConfig.openAi.model;
    case "azure-openai":
      return groupedConfig.azureOpenAi.model;
    case "bedrock":
      return groupedConfig.bedrock.model;
    case "local-llm":
      return routeModel?.trim() || groupedConfig.localLlm.model;
    default:
      return groupedConfig.openAi.model;
  }
}

function routeModelForProvider(
  provider: string,
  routing: ReturnType<typeof resolveAgenticCompileRouting>,
): string {
  return modelForProvider(
    provider,
    provider === "local-llm" ? (routing.localLlmModel ?? routing.model) : routing.model,
  );
}

/**
 * LLM を使って knowledge 候補を goal に対して選別・並べ替えする。
 *
 * - agenticCompile が無効、または provider が未設定の場合は入力をそのまま返す
 * - provider エラー時は graceful fallback（入力をそのまま返す）
 */
export async function agenticRefine(
  candidates: AgenticCandidate[],
  input: CompileInput,
  retrievalMode: RetrievalMode,
): Promise<AgenticRefineResult> {
  await ensureRuntimeSettingsLoaded();
  const routing = resolveAgenticCompileRouting();

  if (!routing.enabled) {
    return { items: candidates, agenticUsed: false };
  }

  if (candidates.length === 0) {
    return { items: candidates, agenticUsed: false };
  }

  const providers = getAgenticLlmProviders(
    routing.provider,
    routing.timeoutMs,
    "context-compiler",
    routing.fallback,
    routing.azureDeploymentSlots,
  );
  const allowFallback = providers.length > 1;
  const fallbackErrors: string[] = [];
  let attempted = 0;

  const systemContext = renderPrompt("contextCompiler.selectEvidence", {});
  const userPrompt = buildUserPrompt(input.goal, candidates);

  for (const provider of providers) {
    if (!provider.isConfigured()) {
      continue;
    }

    attempted += 1;
    const providerModel = routeModelForProvider(provider.name, routing);
    void recordProviderUsage({
      provider: provider.name,
      model: providerModel,
      source: "context-compiler",
      kind: "interactive",
    }).catch(() => undefined);

    try {
      const response = await provider.chat({
        model: provider.name === "local-llm" ? providerModel : undefined,
        messages: [promptMessage(systemContext), { role: "user", content: userPrompt }],
        maxTokens: routing.maxTokens,
        temperature: 0,
        systemContexts: [systemContext.manifest],
      });

      const parsed = parseAgenticOutput(response.content);
      if (!parsed) {
        if (allowFallback) {
          fallbackErrors.push(`${provider.name}:AGENTIC_OUTPUT_PARSE_FAILED`);
          continue;
        }
        return {
          items: candidates,
          agenticUsed: false,
          error: "AGENTIC_OUTPUT_PARSE_FAILED",
        };
      }

      const selected = selectCandidates(candidates, parsed.selectedIds);
      if (selected.length === 0) {
        const selectionReason =
          parsed.selectedIds.length === 0 ? "empty_selection" : "no_valid_selected_ids";
        return {
          items: [],
          agenticUsed: true,
          reasoning: parsed.reasoning,
          selectionReason,
        };
      }

      return {
        items: selected,
        agenticUsed: true,
        reasoning: parsed.reasoning,
        selectionReason: "selected",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isRateLimitError(error)) {
        void recordProviderRateLimit({
          provider: provider.name,
          model: providerModel,
          source: "context-compiler",
          error,
        }).catch(() => undefined);
      }
      if (allowFallback) {
        fallbackErrors.push(`${provider.name}:${message}`);
        continue;
      }
      return {
        items: candidates,
        agenticUsed: false,
        error: `AGENTIC_REFINE_FAILED: ${message}`,
      };
    }
  }

  if (attempted === 0) {
    return { items: candidates, agenticUsed: false };
  }

  if (fallbackErrors.length > 0) {
    console.error("[agenticRefine] All providers failed:", fallbackErrors);
    return {
      items: candidates,
      agenticUsed: false,
      error: formatAutoFallbackError(fallbackErrors),
    };
  }

  return { items: candidates, agenticUsed: false };
}
