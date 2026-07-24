import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import type { DistillationDomainSmokeResult } from "../distillation-domain.types.js";
import {
  type DistillationMessage,
  type DistillationProviderSetting,
  type DistillationRuntimeToolDefinition,
  type DistillationToolExecutor,
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import type { DistillationToolCall } from "../distillation/distillation-tools.service.js";
import { getDistillationTargetStateById } from "../distillationTarget/repository.js";
import { readFileDomain } from "../readFile/domain.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveFindCandidateRoute,
} from "../settings/settings.service.js";
import {
  renderSystemContext,
  systemContextMessage,
} from "../system-context/system-context.service.js";
import {
  type StorageCandidateParseDiagnostics,
  parseStorageCandidatesWithDiagnostics,
} from "./parser.js";
import {
  type CandidateOrigin,
  type CandidateRecord,
  insertFindCandidateResult,
} from "./repository.js";
import {
  type FilteredVibeMemoryStats,
  readFilteredVibeMemoryForCandidateWindow,
} from "./vibe-memory-filter.js";

export type FindCandidateCallerMode = "cli_text" | "storage";

export type FindCandidateSourceInput = {
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest";
  targetKey: string;
  sourceUri: string;
  metadata?: Record<string, unknown>;
};

export type FindCandidateInput = {
  targetStateId?: string;
  sourceInput?: FindCandidateSourceInput;
  provider?: DistillationProviderSetting;
  callerMode?: FindCandidateCallerMode;
  fromToken?: number;
  readTokens?: number;
  wikiMinify?: boolean;
  memoryReaderMode?: "compressed" | "original";
  maxReads?: number;
  writeEpisode?: boolean;
  signal?: AbortSignal;
};

export type FindCandidateResult = {
  targetStateId: string | null;
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest";
  targetKey: string;
  callerMode: FindCandidateCallerMode;
  candidates: CandidateRecord[];
  insertedIds?: string[];
  readRanges: Array<{ from: number; toExclusive: number }>;
  parseDiagnostics?: StorageCandidateParseDiagnostics;
};

type FindCandidateTargetKind = FindCandidateResult["targetKind"];
type FindCandidateTarget = {
  id: string | null;
  targetKind: FindCandidateTargetKind;
  targetKey: string;
  sourceUri: string;
  metadata: Record<string, unknown>;
};

type ReaderWindowMetadata = {
  totalTokens: number;
  from: number;
  toExclusive: number;
  returnedTokens: number;
  filterStats?: FilteredVibeMemoryStats;
};

function parseToolArgs(raw: string): Record<string, unknown> {
  const parsed = parseLlmJsonLike(raw)?.value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function asInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  return fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return fallback;
}

function maxReads(input: FindCandidateInput): number {
  return Math.max(
    1,
    Math.min(
      64,
      Math.floor(input.maxReads ?? groupedConfig.distillationTools.findCandidateMaxToolCalls),
    ),
  );
}

function readTokens(input: FindCandidateInput): number {
  return Math.max(1, Math.floor(input.readTokens ?? groupedConfig.readFile.defaultTokens));
}

function candidateOutputMaxTokens(): number {
  return Math.max(4096, groupedConfig.vibeDistillation.maxOutputTokens);
}

function readerWindowMetadata(value: unknown): ReaderWindowMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  const totalTokens = asInt(metadata.totalTokens, -1);
  const from = asInt(metadata.from, -1);
  const toExclusive = asInt(metadata.toExclusive, -1);
  const returnedTokens = asInt(metadata.returnedTokens, -1);
  if (totalTokens < 0 || from < 0 || toExclusive < from || returnedTokens < 0) return null;
  const filterStats = asRecord(metadata.filterStats);
  return {
    totalTokens,
    from,
    toExclusive,
    returnedTokens,
    filterStats:
      Object.keys(filterStats).length > 0 ? (filterStats as FilteredVibeMemoryStats) : undefined,
  };
}

function isToolLoopMaxRoundsError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("distillation tool loop exceeded max rounds")
  );
}

function normalizeFindCandidateFailure(params: {
  error: unknown;
  readCount: number;
  readLimit: number;
}): Error {
  if (isToolLoopMaxRoundsError(params.error) && params.readCount > 0) {
    return new Error(
      `findCandidate evidence_not_found: exhausted ${params.readCount}/${params.readLimit} reader tool calls without producing a final candidate response`,
      { cause: params.error },
    );
  }
  return params.error instanceof Error ? params.error : new Error(String(params.error));
}

async function defaultFindCandidateRoute(targetKind: FindCandidateTargetKind): Promise<{
  provider: DistillationProviderSetting;
  model: string;
  fallback: Array<Exclude<DistillationProviderSetting, "auto">>;
  azureDeploymentSlots?: number[];
  localLlmModel?: string;
}> {
  await ensureRuntimeSettingsLoaded();
  const route = resolveFindCandidateRoute(targetKind);
  return {
    provider: route.provider as DistillationProviderSetting,
    model: route.model ?? "",
    fallback: [...route.fallback] as Array<Exclude<DistillationProviderSetting, "auto">>,
    azureDeploymentSlots: route.azureDeploymentSlots ? [...route.azureDeploymentSlots] : undefined,
    localLlmModel: route.localLlmModel,
  };
}

function buildToolDefinitionForTarget(
  targetKind: "wiki_file" | "vibe_memory" | "web_ingest",
): DistillationRuntimeToolDefinition {
  if (targetKind === "wiki_file" || targetKind === "web_ingest") {
    return {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read more content from the current document by token window. Use only when additional content is required.",
        parameters: {
          type: "object",
          properties: {
            fromToken: {
              type: "number",
              description: "Start token offset (0-based).",
            },
            readTokens: {
              type: "number",
              description: "Token length to read.",
            },
            minify: {
              type: "boolean",
              description: "Whether to use compressed text.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    };
  }

  return {
    type: "function",
    function: {
      name: "memory_reader",
      description:
        "Read more filtered content from the current vibe memory by token window. Use only when additional content is required.",
      parameters: {
        type: "object",
        properties: {
          fromToken: {
            type: "number",
            description: "Start token offset (0-based).",
          },
          readTokens: { type: "number", description: "Token length to read." },
          mode: {
            type: "string",
            description:
              "Ignored for findCandidate vibe memory reads; content is always deterministically filtered.",
            enum: ["compressed", "original"],
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}

function wikiUserPrompt(): string {
  return [
    "まず tool で本文を読んでください。",
    "必要なら複数回読み、最終的に JSON だけを返してください。",
    "候補は必ず知識単位で分割してください（1候補=1ルール or 1手続き）。",
    "手順・運用フロー・レビュー手順・コマンド列は procedure として返してください。",
  ].join("\n");
}

function vibeMemoryInitialUserPrompt(): string {
  return [
    "これから memory_reader tool で最初の filtered vibe memory window を読みます。",
    "tool result に含まれる filtered memory content と diff だけを source として扱ってください。",
    "この user prompt や system prompt の文言を候補化しないでください。",
  ].join("\n");
}

function vibeMemoryAfterInitialReadPrompt(): string {
  return [
    "上の memory_reader tool result を評価してください。",
    "原因・修正・検証・ユーザーの継続的 preference・repo 固有の運用手順が含まれる場合は、進捗会話をそのまま捨てずに再利用可能な candidate にしてください。",
    "追加の window が必要なら memory_reader を呼び出してください。",
    "十分なら、候補 JSON だけを返してください。",
    "明確な再利用可能 signal がない場合だけ [] を返してください。",
  ].join("\n");
}

function readerAfterInitialReadPrompt(toolName: string): string {
  return [
    `上の ${toolName} tool result を source content として評価してください。`,
    "原因・修正・検証・ユーザーの継続的 preference・repo 固有の運用手順が含まれる場合は、再利用可能な candidate にしてください。",
    "追加の window が必要なら reader tool を呼び出してください。",
    "十分なら、候補 JSON だけを返してください。",
    "明確な再利用可能 signal がない場合だけ [] を返してください。",
  ].join("\n");
}

function routeMayUseCodex(params: {
  provider: DistillationProviderSetting;
  fallbackOrder: Array<Exclude<DistillationProviderSetting, "auto">>;
}): boolean {
  return params.provider === "codex" || params.fallbackOrder.includes("codex");
}

function modelForFindCandidateRoute(params: {
  routeProvider: DistillationProviderSetting;
  routeModel: string;
  routeLocalLlmModel?: string;
  provider: DistillationProviderSetting;
}): string {
  return resolveRouteModelForProvider({
    provider: params.provider,
    routeModel: params.routeProvider === params.provider ? params.routeModel : undefined,
    localLlmModel: params.routeProvider === params.provider ? params.routeLocalLlmModel : undefined,
  });
}

function buildInitialUserMessages(targetKind: FindCandidateTargetKind): DistillationMessage[] {
  return [
    {
      role: "user",
      content: targetKind === "vibe_memory" ? vibeMemoryInitialUserPrompt() : wikiUserPrompt(),
    },
  ];
}

function normalizeCandidateForPipeline(candidate: CandidateRecord): CandidateRecord {
  return {
    ...candidate,
  };
}

function llmOutputPreview(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 1000);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function buildInitialVibeMemoryToolCall(input: FindCandidateInput): DistillationToolCall {
  const mode = input.memoryReaderMode ?? "compressed";
  return {
    id: "initial-memory-reader",
    type: "function",
    function: {
      name: "memory_reader",
      arguments: JSON.stringify({
        fromToken: Math.max(0, Math.floor(input.fromToken ?? 0)),
        readTokens: readTokens(input),
        mode,
      }),
    },
  };
}

function buildInitialReadFileToolCall(input: FindCandidateInput): DistillationToolCall {
  return {
    id: "initial-read-file",
    type: "function",
    function: {
      name: "read_file",
      arguments: JSON.stringify({
        fromToken: Math.max(0, Math.floor(input.fromToken ?? 0)),
        readTokens: readTokens(input),
        minify: input.wikiMinify ?? true,
      }),
    },
  };
}

export function formatCliTextCandidates(candidates: CandidateRecord[]): string {
  if (candidates.length === 0) return "NO_CANDIDATE";
  return candidates
    .map((candidate) =>
      [
        `TYPE: ${candidate.type}`,
        `POLARITY: ${candidate.polarity}`,
        `TITLE: ${candidate.title}`,
        `CONTENT:\n${candidate.content}`,
      ].join("\n"),
    )
    .join("\n---\n");
}

export async function runFindCandidate(input: FindCandidateInput): Promise<FindCandidateResult> {
  const targetStateId = input.targetStateId?.trim() ?? "";
  const rawTarget =
    targetStateId.length > 0
      ? await getDistillationTargetStateById(targetStateId)
      : input.sourceInput
        ? {
            id: null,
            targetKind: input.sourceInput.targetKind,
            targetKey: input.sourceInput.targetKey.trim(),
            sourceUri: input.sourceInput.sourceUri.trim(),
            metadata: input.sourceInput.metadata ?? {},
          }
        : null;
  if (!rawTarget) {
    throw new Error("targetStateId or sourceInput is required");
  }

  const target: FindCandidateTarget = {
    id: rawTarget.id,
    targetKind: rawTarget.targetKind as FindCandidateTargetKind,
    targetKey: rawTarget.targetKey,
    sourceUri: rawTarget.sourceUri ?? rawTarget.targetKey,
    metadata: asRecord("metadata" in rawTarget ? rawTarget.metadata : undefined),
  };

  if (
    target.targetKind !== "wiki_file" &&
    target.targetKind !== "vibe_memory" &&
    target.targetKind !== "web_ingest"
  ) {
    throw new Error(`unsupported target kind for findCandidate: ${target.targetKind}`);
  }
  if (!target.targetKey.trim()) {
    throw new Error("targetKey is required");
  }

  const callerMode = input.callerMode ?? "cli_text";
  const defaultRoute = await defaultFindCandidateRoute(target.targetKind);
  const provider = input.provider ?? defaultRoute.provider;
  const fallbackOrder = input.provider ? [] : defaultRoute.fallback;
  const azureDeploymentSlots = input.provider ? undefined : defaultRoute.azureDeploymentSlots;
  const localLlmModel = input.provider ? undefined : defaultRoute.localLlmModel;
  const model = modelForFindCandidateRoute({
    routeProvider: defaultRoute.provider,
    routeModel: defaultRoute.model,
    routeLocalLlmModel: defaultRoute.localLlmModel,
    provider,
  });
  const toolDefinition = buildToolDefinitionForTarget(target.targetKind);
  const readLog: Array<{ from: number; toExclusive: number }> = [];
  const readLimit = maxReads(input);
  let reads = 0;
  const targetReadPath =
    target.targetKind === "web_ingest" ? target.sourceUri.trim() : target.targetKey;
  if (
    (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") &&
    !targetReadPath
  ) {
    throw new Error(`missing readable source path for target: ${target.id ?? target.targetKey}`);
  }

  const toolExecutor: DistillationToolExecutor = async (toolCall) => {
    const args = parseToolArgs(toolCall.function.arguments);
    if (reads >= readLimit) {
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: false,
        content: "",
        error: `read limit exceeded (${readLimit})`,
      };
    }

    if (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") {
      if (toolCall.function.name !== "read_file") {
        return {
          callId: toolCall.id,
          name: toolCall.function.name,
          ok: false,
          content: "",
          error: "unknown tool",
        };
      }

      const result = await readFileDomain({
        path: targetReadPath,
        fromToken: Math.max(0, asInt(args.fromToken, asInt(input.fromToken, 0))),
        readTokens: Math.max(1, asInt(args.readTokens, readTokens(input))),
        minify: asBool(args.minify, input.wikiMinify ?? true),
      });
      reads += 1;
      readLog.push({ from: result.from, toExclusive: result.toExclusive });
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: true,
        content: result.content,
        metadata: {
          totalTokens: result.totalTokens,
          from: result.from,
          toExclusive: result.toExclusive,
          returnedTokens: result.returnedTokens,
        },
      };
    }

    if (toolCall.function.name !== "memory_reader") {
      return {
        callId: toolCall.id,
        name: toolCall.function.name,
        ok: false,
        content: "",
        error: "unknown tool",
      };
    }

    const result = await readFilteredVibeMemoryForCandidateWindow({
      vibeMemoryId: target.targetKey,
      fromToken: Math.max(0, asInt(args.fromToken, asInt(input.fromToken, 0))),
      readTokens: Math.max(1, asInt(args.readTokens, readTokens(input))),
    });
    reads += 1;
    readLog.push({ from: result.from, toExclusive: result.toExclusive });
    return {
      callId: toolCall.id,
      name: toolCall.function.name,
      ok: true,
      content: result.content,
      metadata: {
        totalTokens: result.totalTokens,
        from: result.from,
        toExclusive: result.toExclusive,
        returnedTokens: result.returnedTokens,
        filterStats: result.stats,
      },
    };
  };

  await recordAuditLogSafe({
    eventType: auditEventTypes.findCandidateStarted,
    actor: "system",
    payload: {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      provider,
      callerMode,
    },
  });

  try {
    let llmOutput = "";
    let candidates: CandidateRecord[] = [];
    let parseDiagnostics: StorageCandidateParseDiagnostics | undefined;
    let readerUsedRecorded = false;
    let latestFilterStats: FilteredVibeMemoryStats | undefined;

    const recordReaderUsed = async (metadata: Record<string, unknown> = {}) => {
      if (readerUsedRecorded || readLog.length === 0) return;
      readerUsedRecorded = true;
      await recordAuditLogSafe({
        eventType: auditEventTypes.findCandidateReaderUsed,
        actor: "system",
        payload: {
          targetStateId: target.id,
          readCount: readLog.length,
          readRanges: readLog,
          ...metadata,
        },
      });
    };

    const sourceSystemContext = renderSystemContext(
      target.targetKind === "vibe_memory" ? "findCandidate.vibeMemory" : "findCandidate.wiki",
      {},
    );
    const extractSystemContext = renderSystemContext("findCandidate.extract", {});
    const messages: DistillationMessage[] = [
      systemContextMessage(sourceSystemContext),
      systemContextMessage(extractSystemContext),
      ...buildInitialUserMessages(target.targetKind),
    ];
    let deterministicInitialRead = false;

    if (
      (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") &&
      routeMayUseCodex({ provider, fallbackOrder })
    ) {
      const initialToolCall = buildInitialReadFileToolCall(input);
      const initialToolResult = await toolExecutor(initialToolCall);
      if (!initialToolResult.ok) {
        throw new Error(initialToolResult.error ?? "initial read_file failed");
      }
      deterministicInitialRead = true;
      messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [initialToolCall],
        },
        {
          role: "tool",
          tool_call_id: initialToolCall.id,
          name: initialToolResult.name,
          content: initialToolResult.content,
        },
        {
          role: "user",
          content: readerAfterInitialReadPrompt(initialToolResult.name),
        },
      );
      await recordReaderUsed({
        initialRead: true,
        reader: initialToolResult.name,
      });
    }

    if (target.targetKind === "vibe_memory") {
      const initialToolCall = buildInitialVibeMemoryToolCall(input);
      const initialToolResult = await toolExecutor(initialToolCall);
      if (!initialToolResult.ok) {
        throw new Error(initialToolResult.error ?? "initial memory_reader failed");
      }
      latestFilterStats = readerWindowMetadata(initialToolResult.metadata)?.filterStats;
      messages.push(
        {
          role: "assistant",
          content: null,
          tool_calls: [initialToolCall],
        },
        {
          role: "tool",
          tool_call_id: initialToolCall.id,
          name: initialToolResult.name,
          content: initialToolResult.content,
        },
        {
          role: "user",
          content: vibeMemoryAfterInitialReadPrompt(),
        },
      );
      await recordReaderUsed({
        initialRead: true,
        reader: "memory_reader",
        ...(latestFilterStats ? { filterStats: latestFilterStats } : {}),
      });
    }

    const completion = await runDistillationCompletion(
      {
        model,
        maxTokens: candidateOutputMaxTokens(),
        messages,
        systemContexts: [sourceSystemContext.manifest, extractSystemContext.manifest],
      },
      {
        providerSetting: provider,
        fallbackOrder,
        azureDeploymentSlots,
        localLlmModel,
        toolDefinitions: [toolDefinition],
        toolExecutor,
        usageSource: "find-candidate",
        enableTools: reads < readLimit,
        maxToolRounds: Math.max(0, readLimit - reads),
        timeoutMs: groupedConfig.distillation.findCandidateTimeoutMs,
        requireToolCall:
          (target.targetKind === "wiki_file" || target.targetKind === "web_ingest") &&
          !deterministicInitialRead,
        requireToolCallReminder: [
          "まだ本文を読んでいません。",
          "まず提供された reader tool を呼び出して本文 content を読んでください。",
          "その後に候補のみを返してください。",
        ],
        blankResponseReminder: [
          '空の応答です。[] または {"type":"rule|procedure","polarity":"positive|negative","title":"...","content":"..."} を返してください。',
        ],
        signal: input.signal,
      },
    );

    llmOutput = completion.content.trim();
    const parsed = parseStorageCandidatesWithDiagnostics(llmOutput);
    parseDiagnostics = parsed.diagnostics;
    candidates = parsed.candidates.map(normalizeCandidateForPipeline);

    if (readLog.length === 0) {
      throw new Error("findCandidate reader tool was not used");
    }

    await recordReaderUsed();
    const noCandidateDiagnostics =
      candidates.length === 0
        ? {
            parseDiagnostics,
            llmOutputPreview: llmOutputPreview(llmOutput),
            ...(latestFilterStats ? { filterStats: latestFilterStats } : {}),
          }
        : undefined;

    if (callerMode === "cli_text") {
      await recordAuditLogSafe({
        eventType: auditEventTypes.findCandidateCompleted,
        actor: "system",
        payload: {
          targetStateId: target.id,
          candidateCount: candidates.length,
          readCount: readLog.length,
          ...(latestFilterStats ? { filterStats: latestFilterStats } : {}),
          ...(noCandidateDiagnostics ? { noCandidateDiagnostics } : {}),
        },
      });

      return {
        targetStateId: target.id,
        targetKind: target.targetKind,
        targetKey: target.targetKey,
        callerMode,
        candidates,
        readRanges: readLog,
        parseDiagnostics,
      };
    }

    const origin: CandidateOrigin = {
      readRanges: readLog,
    };

    const insertedIds: string[] = [];

    if (target.id) {
      for (const [index, candidate] of candidates.entries()) {
        const saved = await insertFindCandidateResult({
          targetStateId: target.id,
          candidateIndex: index,
          candidate,
          origin,
        });
        insertedIds.push(saved.id);
      }
    }

    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateCompleted,
      actor: "system",
      payload: {
        targetStateId: target.id,
        candidateCount: candidates.length,
        insertedCount: insertedIds.length,
        ...(latestFilterStats ? { filterStats: latestFilterStats } : {}),
        ...(noCandidateDiagnostics ? { noCandidateDiagnostics } : {}),
      },
    });

    return {
      targetStateId: target.id,
      targetKind: target.targetKind,
      targetKey: target.targetKey,
      callerMode,
      candidates,
      insertedIds: target.id ? insertedIds : undefined,
      readRanges: readLog,
      parseDiagnostics,
    };
  } catch (error) {
    const normalizedError = normalizeFindCandidateFailure({
      error,
      readCount: readLog.length,
      readLimit,
    });
    await recordAuditLogSafe({
      eventType: auditEventTypes.findCandidateFailed,
      actor: "system",
      payload: {
        targetStateId: target.id,
        error: normalizedError.message,
      },
    });
    throw normalizedError;
  }
}

export async function runFindCandidateSmoke(
  input: Record<string, unknown>,
): Promise<DistillationDomainSmokeResult> {
  return {
    domain: "findCandidate",
    implemented: false,
    status: "prepared",
    checkedAt: new Date().toISOString(),
    message:
      "findCandidate domain smoke remains scaffold-only. Use find-candidate CLI for runtime.",
    receivedInput: input,
    nextContracts: [
      "findCandidate runtime is implemented via runFindCandidate",
      "coverEvidence and finalizeDistille runtimes are available as downstream stages",
      "distill-domain smoke will be replaced after all domains migrate",
    ],
  };
}
