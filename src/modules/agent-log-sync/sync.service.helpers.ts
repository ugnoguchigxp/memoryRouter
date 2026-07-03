import { groupedConfig } from "../../config.js";
import { redactSecretRecord, redactSecrets } from "../../shared/utils/secret-redaction.js";
import {
  extractAgentDiffContentFromText,
  stripAgentDiffContentFromText,
} from "../vibe-memory/agent-diff-ingestion.service.js";
import { isCodexFindingEscalationMetadata } from "../findCandidate/self-ingestion-guard.js";
import type { ChatMessage } from "./ingest.service.js";

export type AgentLogSourceDescriptor = {
  id: string;
  label: string;
};

const AGENT_TASK_LOG_BASENAME_RE = /^task-\d+\.log$/i;
const BACKGROUND_TASK_STARTED_RE =
  /Tool is running as a background task with task id: [^\s]+\/task-\d+/i;
const BACKGROUND_TASK_STATUS_RE = /(^|\n)Task:\s*[^\s]+\/task-\d+/i;
const BACKGROUND_TASK_LOG_PATH_RE = /(^|\n)Log:\s*.*task-\d+\.log/i;
const CODEX_INTERNAL_PROVIDER_PROMPT_RE =
  /^\[System Instructions\]\n[\s\S]*\n\n\[Instructions\]\nBased on the instructions and history above, generate the final response\./;
const NIGHTWORKERS_RUNTIME_CONTRACT_MARKER = "[NightWorkers Runtime Contract]";
const diffExtractionToolNames = new Set([
  "replace_file_content",
  "write_to_file",
  "multi_replace_file_content",
  "patch_file",
  "apply_patch",
]);

function agentLogThreadKey(message: ChatMessage): string | undefined {
  const sessionId = message.metadata.sessionId;
  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return sessionId.trim();
  }

  const sessionFile = message.metadata.sessionFile;
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    return sessionFile.trim();
  }

  return undefined;
}

export function isCodexInternalProviderPromptMessage(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    message.metadata.sourceId === "codex_logs" &&
    CODEX_INTERNAL_PROVIDER_PROMPT_RE.test(message.content.trim())
  );
}

export function isNonDistillableAgentTaskLogMessage(message: ChatMessage): boolean {
  if (isCodexInternalProviderPromptMessage(message)) return true;

  const projectName = message.metadata.projectName;
  if (typeof projectName === "string" && AGENT_TASK_LOG_BASENAME_RE.test(projectName.trim())) {
    return true;
  }

  const content = message.content.trim();
  if (!content.startsWith("Created At:")) return false;
  return (
    BACKGROUND_TASK_STARTED_RE.test(content) ||
    (BACKGROUND_TASK_STATUS_RE.test(content) && BACKGROUND_TASK_LOG_PATH_RE.test(content))
  );
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim()).filter((value) => value.length > 0));
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function extractRuntimeContractField(contract: string, field: string): string | undefined {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contract.match(new RegExp(`^\\s*${escapedField}\\s*:\\s*(.+?)\\s*$`, "m"));
  return match?.[1]?.trim() || undefined;
}

function nightWorkersRuntimeContractInfo(content: string): {
  before: string;
  executionMode: string;
  taskId?: string;
  runId?: string;
} | null {
  const markerIndex = content.indexOf(NIGHTWORKERS_RUNTIME_CONTRACT_MARKER);
  if (markerIndex < 0) return null;

  const before = content.slice(0, markerIndex).trim();
  const contract = content.slice(markerIndex);
  const executionMode = extractRuntimeContractField(contract, "executionMode");
  if (executionMode !== "implementation") return null;

  return {
    before,
    executionMode,
    taskId: extractRuntimeContractField(contract, "taskId"),
    runId: extractRuntimeContractField(contract, "runId"),
  };
}

export function hasTargetedNightWorkersRuntimeContract(content: string): boolean {
  return Boolean(nightWorkersRuntimeContractInfo(content));
}

export function sanitizeNightWorkersRuntimeContractMessage(
  message: ChatMessage,
): ChatMessage | null {
  if (message.metadata.sourceId !== "codex_logs") return message;

  const contractInfo = nightWorkersRuntimeContractInfo(message.content);
  if (!contractInfo) return message;
  if (!contractInfo.before) return null;

  return {
    ...message,
    content: contractInfo.before,
    metadata: {
      ...message.metadata,
      nightWorkersRuntimeContractStripped: true,
      nightWorkersRuntimeContractExecutionMode: contractInfo.executionMode,
      ...(contractInfo.taskId ? { nightWorkersTaskId: contractInfo.taskId } : {}),
      ...(contractInfo.runId ? { nightWorkersRunId: contractInfo.runId } : {}),
    },
  };
}

export function sanitizeNightWorkersRuntimeContractChunk(chunk: ChatMessage[]): ChatMessage[] {
  return chunk
    .map(sanitizeNightWorkersRuntimeContractMessage)
    .filter((message): message is ChatMessage => Boolean(message));
}

export function isExcludedAgentLogMetadata(metadata: Record<string, unknown>): boolean {
  if (isCodexFindingEscalationMetadata(metadata)) return true;

  const projectNames = normalizedSet(groupedConfig.agentLogSync.excludedProjectNames);
  const sessionIds = normalizedSet(groupedConfig.agentLogSync.excludedSessionIds);
  const titleContains = groupedConfig.agentLogSync.excludedSessionTitleContains
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const projectName = metadataString(metadata, "projectName");
  if (projectName && projectNames.has(projectName)) return true;

  const sessionId = metadataString(metadata, "sessionId");
  if (sessionId && sessionIds.has(sessionId)) return true;

  const sessionTitle = metadataString(metadata, "sessionTitle");
  return Boolean(sessionTitle && titleContains.some((pattern) => sessionTitle.includes(pattern)));
}

export function isExcludedAgentLogMessage(message: ChatMessage): boolean {
  return isExcludedAgentLogMetadata(message.metadata);
}

export function filterDistillableAgentLogMessages(messages: ChatMessage[]): ChatMessage[] {
  const skipNextCodexAssistantByThread = new Set<string>();
  const result: ChatMessage[] = [];

  for (const message of messages) {
    if (!message.content.trim()) continue;
    if (isExcludedAgentLogMessage(message)) continue;

    const threadKey = agentLogThreadKey(message);
    if (
      message.role === "assistant" &&
      threadKey &&
      skipNextCodexAssistantByThread.has(threadKey)
    ) {
      skipNextCodexAssistantByThread.delete(threadKey);
      continue;
    }

    if (isCodexInternalProviderPromptMessage(message)) {
      if (threadKey) skipNextCodexAssistantByThread.add(threadKey);
      continue;
    }

    if (isNonDistillableAgentTaskLogMessage(message)) continue;
    result.push(message);
  }

  return result;
}

export function chunkMessages(
  messages: ChatMessage[],
  maxMessages = groupedConfig.agentLogSync.maxMessagesPerChunk,
  maxChars = groupedConfig.agentLogSync.maxCharsPerChunk,
): ChatMessage[][] {
  const chunks: ChatMessage[][] = [];
  let current: ChatMessage[] = [];
  let currentChars = 0;

  for (const message of messages) {
    const reachedMessageLimit = current.length >= maxMessages;
    const reachedCharLimit = current.length > 0 && currentChars + message.content.length > maxChars;

    if (reachedMessageLimit || reachedCharLimit) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(message);
    currentChars += message.content.length;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

export function buildTranscript(messages: ChatMessage[]): string {
  return messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

export function isToolCallMessage(message: ChatMessage): boolean {
  return message.metadata.messageKind === "tool_call";
}

function previewText(text: string, maxChars = 800): string {
  const compact = text.trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars).trimEnd()}...`;
}

function getStringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getBooleanMetadata(metadata: Record<string, unknown>, key: string): boolean | undefined {
  const value = metadata[key];
  return typeof value === "boolean" ? value : undefined;
}

function sanitizeMetadataText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = redactSecrets(value).trim();
  return redacted.length > 0 ? redacted : undefined;
}

function sanitizeToolCallSummary(toolCall: unknown): Record<string, unknown> | null {
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return null;
  const record = toolCall as Record<string, unknown>;
  const name = getStringMetadata(record, "name") ?? "tool";
  return {
    name,
    summary: sanitizeMetadataText(getStringMetadata(record, "summary")),
    commandLine: sanitizeMetadataText(getStringMetadata(record, "commandLine")),
    cwd: getStringMetadata(record, "cwd"),
    action: getStringMetadata(record, "action"),
    targetFile: getStringMetadata(record, "targetFile"),
    contentPreview: sanitizeMetadataText(getStringMetadata(record, "contentPreview")),
    sourceTruncated: getBooleanMetadata(record, "sourceTruncated"),
    reconstructedFromFile: getBooleanMetadata(record, "reconstructedFromFile"),
  };
}

function summarizeToolMessage(message: ChatMessage): Record<string, unknown>[] {
  const toolCalls = message.metadata.toolCalls;
  if (Array.isArray(toolCalls)) {
    return toolCalls
      .map(sanitizeToolCallSummary)
      .filter((toolCall): toolCall is Record<string, unknown> => Boolean(toolCall))
      .map((toolCall) => ({
        ...toolCall,
        timestamp: message.metadata.timestamp,
        stepIndex: message.metadata.stepIndex,
      }));
  }

  return [
    {
      name: getStringMetadata(message.metadata, "toolName") ?? "tool",
      contentPreview: previewText(redactSecrets(message.content)),
      timestamp: message.metadata.timestamp,
    },
  ];
}

function collectToolCallSummaries(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.filter(isToolCallMessage).flatMap(summarizeToolMessage);
}

function firstMetadataString(messages: ChatMessage[], key: string): string | undefined {
  for (const message of messages) {
    const value = message.metadata[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function getSessionStartedAt(messages: ChatMessage[]): string | undefined {
  const timestamps = messages
    .flatMap((message) => [message.metadata.sessionStartedAt, message.metadata.timestamp])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  return timestamps[0]?.toISOString();
}

function formatSessionTitleTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

function buildSessionTitle(source: AgentLogSourceDescriptor, messages: ChatMessage[]): string {
  const projectName = firstMetadataString(messages, "projectName") ?? "Unknown Project";
  const time = formatSessionTitleTime(getSessionStartedAt(messages));
  return [projectName, time, source.label].filter(Boolean).join(" / ");
}

export function buildReadableTranscript(messages: ChatMessage[]): string {
  return messages
    .filter((message) => !isToolCallMessage(message))
    .map((message) => {
      const content = redactSecrets(stripAgentDiffContentFromText(message.content));
      return content ? `${message.role.toUpperCase()}: ${content}` : "";
    })
    .filter((line) => !line.match(/^(USER|ASSISTANT):\s*$/))
    .join("\n\n");
}

export function buildMemorySessionId(sourceId: string, message: ChatMessage): string {
  const sessionId = message.metadata.sessionId;
  const projectKey =
    (message.metadata.projectName as string) ||
    (message.metadata.projectRoot as string) ||
    "default";

  if (typeof sessionId === "string" && sessionId.trim().length > 0) {
    return `${sourceId}:${projectKey}:${sessionId.trim()}`;
  }

  const sessionFile = message.metadata.sessionFile;
  if (typeof sessionFile === "string" && sessionFile.trim().length > 0) {
    return `${sourceId}:${projectKey}:file:${sessionFile.trim()}`;
  }

  return `${sourceId}:${projectKey}:fallback`;
}

export function buildDedupeKey(params: {
  sourceId: string;
  memorySessionId: string;
  chunkIndex: number;
}): string {
  return `${params.sourceId}:${params.memorySessionId}:${params.chunkIndex}`;
}

export function extractUnifiedDiffsFromText(text: string): string {
  return extractAgentDiffContentFromText(text);
}

export function extractAgentDiffsFromToolCalls(messages: ChatMessage[]): Array<{
  filePath: string;
  diffHunk: string;
  changeType: "add" | "modify";
  metadata: Record<string, unknown>;
}> {
  const diffs: Array<{
    filePath: string;
    diffHunk: string;
    changeType: "add" | "modify";
    metadata: Record<string, unknown>;
  }> = [];
  for (const message of messages) {
    const toolCalls = message.metadata.toolCalls as unknown;
    if (!Array.isArray(toolCalls)) continue;

    for (const rawToolCall of toolCalls) {
      if (!rawToolCall || typeof rawToolCall !== "object" || Array.isArray(rawToolCall)) continue;
      const toolCall = rawToolCall as Record<string, unknown>;
      const targetFile = getStringMetadata(toolCall, "targetFile");
      const contentPreview = getStringMetadata(toolCall, "contentPreview");
      const toolName = getStringMetadata(toolCall, "name") ?? "tool";
      if (!targetFile || !contentPreview) continue;

      const name = toolName.toLowerCase();
      if (!diffExtractionToolNames.has(name)) continue;

      diffs.push({
        filePath: targetFile,
        diffHunk: redactSecrets(contentPreview),
        changeType: name === "write_to_file" ? "add" : "modify",
        metadata: { extractedFrom: "agent_tool_call", toolName },
      });
    }
  }
  return diffs;
}

export function getCheckpointDate(maxObservedMtimeMs: number, since?: Date): Date {
  if (Number.isFinite(maxObservedMtimeMs) && maxObservedMtimeMs > 0) {
    return new Date(maxObservedMtimeMs);
  }
  return since ?? new Date();
}

export function mergeMessageMetadata(
  source: AgentLogSourceDescriptor,
  messages: ChatMessage[],
  options: { rawMessageCount?: number } = {},
): Record<string, unknown> {
  const firstMetadata = messages.find((message) => message.metadata)?.metadata ?? {};
  const toolCalls = collectToolCallSummaries(messages);
  const projectName = firstMetadataString(messages, "projectName");
  const projectRoot = firstMetadataString(messages, "projectRoot");
  const sessionStartedAt = getSessionStartedAt(messages);
  const sessionFiles = Array.from(
    new Set(
      messages
        .map((message) => message.metadata.sessionFile)
        .filter((file): file is string => typeof file === "string" && file.length > 0),
    ),
  );
  const strippedMessages = messages.filter(
    (message) => message.metadata.nightWorkersRuntimeContractStripped === true,
  );
  const runtimeContractTaskId = firstMetadataString(messages, "nightWorkersTaskId");
  const runtimeContractRunId = firstMetadataString(messages, "nightWorkersRunId");
  const runtimeContractExecutionMode = firstMetadataString(
    messages,
    "nightWorkersRuntimeContractExecutionMode",
  );

  return {
    ...redactSecretRecord(firstMetadata),
    source: source.label,
    sourceId: source.id,
    sources: [source.label],
    sessionFiles,
    projectName,
    projectRoot,
    sessionStartedAt,
    sessionTitle: buildSessionTitle(source, messages),
    ...(options.rawMessageCount !== undefined ? { rawMessageCount: options.rawMessageCount } : {}),
    messageCount: messages.length,
    ...(strippedMessages.length > 0
      ? {
          nightWorkersRuntimeContractStripped: true,
          nightWorkersRuntimeContractStrippedCount: strippedMessages.length,
          nightWorkersRuntimeContractExecutionMode: runtimeContractExecutionMode,
          ...(runtimeContractTaskId ? { nightWorkersTaskId: runtimeContractTaskId } : {}),
          ...(runtimeContractRunId ? { nightWorkersRunId: runtimeContractRunId } : {}),
        }
      : {}),
    toolCallCount: toolCalls.length,
    toolCalls: toolCalls.slice(0, 100),
    toolCallsTruncated: toolCalls.length > 100,
    roles: Array.from(new Set(messages.map((message) => message.role))),
    kind: "agent_log_chunk",
    memoryPipeline: "raw_for_distillation",
  };
}
