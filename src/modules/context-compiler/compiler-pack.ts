import { mcpResourceUri } from "../../project-identity.js";
import type { RetrievalMode } from "../../shared/schemas/compile.schema.js";
import type { ContextPack, ContextPackItem } from "../../shared/schemas/context-pack.schema.js";
import type { KnowledgeItem, KnowledgeStatus } from "../../shared/schemas/knowledge.schema.js";
import { asRecord } from "../../shared/utils/normalize.js";

export function scoreSourceOverlap(text: string, candidateText: string): number {
  const baseTokens = text
    .toLowerCase()
    .split(/[^a-z0-9_\u3040-\u30ff\u4e00-\u9fff\uff61-\uff9f]+/g)
    .filter((token) => token.length >= 3)
    .slice(0, 32);
  if (baseTokens.length === 0) return 0;
  const candidate = candidateText.toLowerCase();
  let overlap = 0;
  for (const token of baseTokens) {
    if (candidate.includes(token)) overlap += 1;
  }
  return overlap;
}

export function formatSourceRef(sourceUri: string, locator: string): string {
  return `${sourceUri}#${locator}`;
}

export function buildFallbackSourceRef(params: {
  runId: string;
  retrievalMode: RetrievalMode;
  degradedReasons: string[];
}): string {
  const reason =
    params.degradedReasons.find((item) => item.startsWith("NO_")) ??
    params.degradedReasons[0] ??
    "NO_SOURCE_MATCH";
  return `${mcpResourceUri(`packs/run/${params.runId}`)}#${params.retrievalMode}:${reason}`;
}

export function selectSourceRefsForKnowledge(
  item: { title: string; content: string },
  sourceItems: Array<{ sourceUri: string; locator: string; content: string; score: number }>,
  knownSourceRefs: string[],
): string[] {
  if (knownSourceRefs.length > 0) {
    return [...new Set(knownSourceRefs)].slice(0, 4);
  }
  if (sourceItems.length === 0) return [];
  const scored = sourceItems
    .map((sourceItem) => {
      const overlap = scoreSourceOverlap(
        `${item.title}\n${item.content}`,
        `${sourceItem.sourceUri}\n${sourceItem.content}`,
      );
      return {
        ref: formatSourceRef(sourceItem.sourceUri, sourceItem.locator),
        score: sourceItem.score + overlap * 0.05,
        overlap,
      };
    })
    .sort((a, b) => b.score - a.score);

  const overlapRefs = scored
    .filter((entry) => entry.overlap > 0)
    .slice(0, 2)
    .map((entry) => entry.ref);
  if (overlapRefs.length > 0) return [...new Set(overlapRefs)];
  return [];
}

export function buildMinimalTasks(retrievalMode: RetrievalMode): string[] {
  switch (retrievalMode) {
    case "review_context":
      return [
        "有効なルールと手順を確認する",
        "変更内容が既知の制約に反しないか検証する",
        "指摘は根拠を明確にして優先順位順にまとめる",
      ];
    case "debug_context":
      return [
        "関連する既知手順を先に確認する",
        "原因候補を狭めてから最小変更で修正する",
        "修正箇所に絞った再現・検証を行う",
      ];
    case "architecture_context":
      return [
        "既存ルールと制約を先に確認する",
        "設計候補のトレードオフを比較する",
        "実装境界と検証方法を明確化する",
      ];
    case "procedure_context":
      return [
        "手順候補を上から順に確認する",
        "必要最小限のコマンドのみ実行する",
        "結果と次の検証ステップを記録する",
      ];
    default:
      return ["関連する知識を確認する", "安全な最小変更で実装する", "変更箇所を重点検証する"];
  }
}

export function normalizeKnowledgeType(value: string): KnowledgeItem["type"] {
  return value === "procedure" ? "procedure" : "rule";
}

export function normalizeKnowledgeStatus(value: string): KnowledgeStatus {
  if (value === "deprecated") return "deprecated";
  if (value === "draft") return "draft";
  return "active";
}

export function toKnowledgePackItem(item: {
  id: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  title: string;
  content: string;
  score: number;
  sourceRefs: string[];
  polarity?: string;
  scopeSnapshot: Record<string, unknown>;
}): ContextPackItem {
  const section =
    item.polarity === "negative"
      ? "guardrails"
      : item.type === "procedure"
        ? "procedures"
        : "rules";
  return {
    id: `knowledge:${item.id}`,
    itemKind: item.type,
    itemId: item.id,
    section,
    title: item.title,
    content: item.content,
    score: item.score,
    rankingReason: `ranked by weighted score (${item.status})`,
    sourceRefs: item.sourceRefs,
    scopeSnapshot: item.scopeSnapshot,
  };
}

export function attachOutputMarkdownToPack(pack: ContextPack, markdown: string): ContextPack {
  const retrievalStats = asRecord(pack.diagnostics.retrievalStats);
  const responseComposer = asRecord(retrievalStats.responseComposer);
  return {
    ...pack,
    diagnostics: {
      ...pack.diagnostics,
      retrievalStats: {
        ...retrievalStats,
        responseComposer: {
          ...responseComposer,
          outputMarkdown: markdown,
        },
      },
    },
  };
}

export function legacyIntentFromRetrievalMode(retrievalMode: RetrievalMode): string {
  if (retrievalMode === "debug_context") return "debug";
  if (retrievalMode === "review_context") return "review";
  if (retrievalMode === "architecture_context") return "plan";
  if (retrievalMode === "procedure_context") return "edit";
  if (retrievalMode === "learning_context") return "finish";
  return "edit";
}
