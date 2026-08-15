import { groupedConfig } from "../../config.js";
import { parseLlmJsonLike } from "../../lib/llm-output-parser.js";
import type {
  EpisodeCard,
  EpisodeCardCreateInput,
} from "../../shared/schemas/episode-card.schema.js";
import { resolveAuditedStoredProjectScopedWriteIdentity } from "../context-compiler/project-scoped-write.js";
import {
  type DistillationMessage,
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../distillation/distillation-runtime.service.js";
import {
  type BoundedSourceWindow,
  type SemanticChunk,
  buildBoundedSourceWindows,
  deterministicSemanticChunksFromWindows,
  validateSemanticChunks,
} from "../distillation/source-window.js";
import {
  createEpisodeCard,
  getEpisodeCardBySource,
  searchEpisodeCards,
} from "../episodic-memory/episode-card.repository.js";
import { appendQueueEvent } from "../queue/core/events.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveEpisodeDistillerRoute,
} from "../settings/settings.service.js";
import { promptMessage, renderPrompt } from "../system-context/system-context.service.js";
import {
  type EpisodeDistillerJob,
  getEpisodeDistillerJobById,
  markEpisodeDistillerCompleted,
  markEpisodeDistillerFailed,
} from "./repository.js";
import {
  type EpisodeDistillerCanonical,
  calibrateEpisodeCanonical,
  canonicalEpisodeToCardInput,
  episodeDistillerCanonicalArraySchema,
} from "./schema.js";
import {
  EPISODE_DISTILLATION_VERSION,
  type EpisodeGenerationKind,
  episodeSourceFragmentKey,
} from "./source-key.js";
import { type EpisodeSourceDocument, readEpisodeSourceDocument } from "./source-reader.js";

type Segment = {
  text: string;
  startOffset: number;
  endOffset: number;
  eventStart: string | null;
  eventEnd: string | null;
  eventIds: string[];
};

type EpisodeDistillerProcessResult = {
  generated: number;
  deduped: number;
  skipped: number;
  valueSkipped: number;
  duplicateGenerationKindSkipped: number;
  nearDuplicateSkipped: number;
  failedSegments: number;
  episodeIds: string[];
};

type ChunkedSegmentPlan = {
  segments: Segment[];
  sourceWindows: BoundedSourceWindow[];
  semanticChunks: SemanticChunk[];
  pipelineVersion: "deterministic-segment-v1" | "internal-chunked-v1";
};

type EpisodeValueReview = {
  publish: boolean;
  score: number;
  reasons: string[];
};

type PendingEpisode = {
  input: EpisodeCardCreateInput;
  segmentIndex: number;
};

type NearDuplicateCandidate = {
  id: string;
  title: string;
  situation: string;
  action: string;
  outcome: string;
  lesson: string;
};

type NearDuplicateReview = {
  publish: boolean;
  duplicateOfEpisodeId: string | null;
  confidence: number;
  reason: string;
};

const MIN_EPISODE_VALUE_SCORE = 60;
const MIN_EPISODE_IMPORTANCE = 55;
const MIN_EPISODE_CONFIDENCE = 55;
const MIN_EPISODE_REUSABLE_SIGNAL = 50;
const MIN_EPISODE_EVIDENCE_QUALITY = 50;
const MIN_EPISODE_COMPRESSION_QUALITY = 45;

type EpisodeDistillerTestHooks = {
  semanticChunks?: (params: {
    windows: BoundedSourceWindow[];
    document: EpisodeSourceDocument;
    job: EpisodeDistillerJob;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  distillSegment?: (params: {
    segment: Segment;
    document: EpisodeSourceDocument;
    job: EpisodeDistillerJob;
    signal?: AbortSignal;
  }) => Promise<unknown>;
  reviewNearDuplicate?: (params: {
    input: EpisodeCardCreateInput;
    candidates: NearDuplicateCandidate[];
    document: EpisodeSourceDocument;
    job: EpisodeDistillerJob;
    signal?: AbortSignal;
  }) => Promise<unknown>;
};

let testHooks: EpisodeDistillerTestHooks = {};

export function setEpisodeDistillerTestHooksForTests(hooks: EpisodeDistillerTestHooks): void {
  testHooks = hooks;
}

function textForByteRange(content: string, startOffset: number, endOffset: number): string {
  return Buffer.from(content, "utf8").subarray(startOffset, endOffset).toString("utf8");
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberFromUnknown(value: unknown): number | null {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) ? numeric : null;
}

function stringArrayFromUnknown(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim())
    : [];
}

function overlapCount(left: string[] | undefined, right: string[] | undefined): number {
  const rightSet = new Set((right ?? []).map((item) => item.toLowerCase()));
  return (left ?? []).filter((item) => rightSet.has(item.toLowerCase())).length;
}

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function reviewEpisodeValue(canonical: EpisodeDistillerCanonical): EpisodeValueReview {
  const scores = canonical.scores;
  const reusableSignal = Math.max(
    scores.reusability,
    scores.decision_density,
    scores.failure_value,
  );
  const score = Math.round(
    scores.importance * 0.22 +
      scores.confidence * 0.18 +
      scores.reusability * 0.14 +
      scores.decision_density * 0.1 +
      scores.failure_value * 0.1 +
      scores.causal_clarity * 0.1 +
      scores.project_specificity * 0.06 +
      scores.evidence_quality * 0.05 +
      scores.compression_quality * 0.05,
  );
  const reasons: string[] = [];
  if (score < MIN_EPISODE_VALUE_SCORE) reasons.push("value_score_below_60");
  if (scores.importance < MIN_EPISODE_IMPORTANCE) reasons.push("importance_below_55");
  if (scores.confidence < MIN_EPISODE_CONFIDENCE) reasons.push("confidence_below_55");
  if (reusableSignal < MIN_EPISODE_REUSABLE_SIGNAL) {
    reasons.push("reusable_signal_below_50");
  }
  if (scores.evidence_quality < MIN_EPISODE_EVIDENCE_QUALITY) {
    reasons.push("evidence_quality_below_50");
  }
  if (scores.compression_quality < MIN_EPISODE_COMPRESSION_QUALITY) {
    reasons.push("compression_quality_below_45");
  }
  return {
    publish: reasons.length === 0,
    score,
    reasons,
  };
}

function parseNearDuplicateReview(value: unknown): NearDuplicateReview {
  const record = recordFromUnknown(value);
  if (typeof record.publish !== "boolean") {
    throw new Error("near duplicate review output did not include publish boolean");
  }
  return {
    publish: record.publish === true,
    duplicateOfEpisodeId:
      typeof record.duplicateOfEpisodeId === "string" && record.duplicateOfEpisodeId.trim()
        ? record.duplicateOfEpisodeId.trim()
        : null,
    confidence: Math.max(0, Math.min(100, Math.round(numberFromUnknown(record.confidence) ?? 0))),
    reason:
      typeof record.reason === "string" && record.reason.trim()
        ? record.reason.trim()
        : "near duplicate review did not provide a reason",
  };
}

function reviewAllowsPublish(
  review: NearDuplicateReview,
  candidates: NearDuplicateCandidate[],
): boolean {
  if (review.publish) return true;
  if (review.confidence < 70) return true;
  return !candidates.some((candidate) => candidate.id === review.duplicateOfEpisodeId);
}

function eventFilePathsForRange(
  document: EpisodeSourceDocument,
  start: number,
  end: number,
): string[] {
  return [
    ...new Set(
      document.events
        .filter((event) => event.endOffset > start && event.startOffset < end)
        .map((event) => event.filePath?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

async function findNearDuplicateCandidates(params: {
  input: EpisodeCardCreateInput;
  document: EpisodeSourceDocument;
}): Promise<NearDuplicateCandidate[]> {
  const inputMetadata = recordFromUnknown(params.input.metadata);
  const episodeDistillation = recordFromUnknown(inputMetadata.episodeDistillation);
  const generationKind = recordFromUnknown(params.input.applicability).generationKind;
  const sourceStartOffset = numberFromUnknown(episodeDistillation.sourceStartOffset);
  const sourceEndOffset = numberFromUnknown(episodeDistillation.sourceEndOffset);
  if (sourceStartOffset === null || sourceEndOffset === null) return [];
  const currentFiles = eventFilePathsForRange(params.document, sourceStartOffset, sourceEndOffset);
  const parentVibeMemoryId = episodeDistillation.parentVibeMemoryId;
  if (typeof parentVibeMemoryId !== "string" || !parentVibeMemoryId.trim()) return [];

  const episodes = await searchEpisodeCards({
    repoPath: params.input.repoPath ?? undefined,
    repoKey: params.input.repoKey ?? undefined,
    outcomeKinds: [params.input.outcomeKind ?? "unknown"],
    limit: 100,
  });
  return episodes
    .filter((episode) => episode.sourceKey !== params.input.sourceKey)
    .filter((episode) => {
      const metadata = recordFromUnknown(episode.metadata);
      const distillation = recordFromUnknown(metadata.episodeDistillation);
      if (distillation.parentVibeMemoryId !== parentVibeMemoryId) return false;
      const applicability = recordFromUnknown(episode.applicability);
      if (applicability.generationKind !== generationKind) return false;
      const candidateStart = numberFromUnknown(distillation.sourceStartOffset);
      const candidateEnd = numberFromUnknown(distillation.sourceEndOffset);
      if (candidateStart === null || candidateEnd === null) return false;
      const candidateFiles = eventFilePathsForRange(params.document, candidateStart, candidateEnd);
      const sameFile = overlapCount(currentFiles, candidateFiles) > 0;
      const facetOverlap =
        overlapCount(params.input.domains, episode.domains) +
        overlapCount(params.input.technologies, episode.technologies) +
        overlapCount(params.input.changeTypes, episode.changeTypes);
      return sameFile && facetOverlap >= 2;
    })
    .slice(0, 3)
    .map((episode) => ({
      id: episode.id,
      title: episode.title,
      situation: episode.situation,
      action: episode.action,
      outcome: episode.outcome,
      lesson: episode.lesson,
    }));
}

function buildNearDuplicateReviewMessages(params: {
  input: EpisodeCardCreateInput;
  candidates: NearDuplicateCandidate[];
}): DistillationMessage[] {
  return [
    {
      role: "user",
      content: [
        "次の shape の JSON object を返してください:",
        '{"publish":true,"duplicateOfEpisodeId":null,"confidence":0,"reason":"..."}',
        "",
        "New Episode candidate:",
        JSON.stringify({
          title: params.input.title,
          situation: params.input.situation,
          observations: params.input.observations,
          action: params.input.action,
          outcome: params.input.outcome,
          lesson: params.input.lesson,
          domains: params.input.domains,
          technologies: params.input.technologies,
          changeTypes: params.input.changeTypes,
          outcomeKind: params.input.outcomeKind,
        }),
        "",
        "Existing candidate episodes:",
        JSON.stringify(params.candidates),
      ].join("\n"),
    },
  ];
}

async function reviewNearDuplicate(params: {
  input: EpisodeCardCreateInput;
  candidates: NearDuplicateCandidate[];
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}): Promise<NearDuplicateReview> {
  if (params.candidates.length === 0) {
    return {
      publish: true,
      duplicateOfEpisodeId: null,
      confidence: 100,
      reason: "no near duplicate candidates",
    };
  }
  if (testHooks.reviewNearDuplicate) {
    return parseNearDuplicateReview(await testHooks.reviewNearDuplicate(params));
  }
  await ensureRuntimeSettingsLoaded();
  const route = resolveEpisodeDistillerRoute();
  const provider = route.provider;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: route.model,
    localLlmModel: route.localLlmModel,
  });
  const systemContext = renderPrompt("episodeDistiller.nearDuplicateReview", {});
  const completion = await runDistillationCompletion(
    {
      model,
      messages: [promptMessage(systemContext), ...buildNearDuplicateReviewMessages(params)],
      maxTokens: 800,
      systemContexts: [systemContext.manifest],
    },
    {
      providerSetting: provider,
      fallbackOrder: route.fallback,
      azureDeploymentSlots: route.azureDeploymentSlots,
      localLlmModel: route.localLlmModel,
      enableTools: false,
      maxToolRounds: 0,
      usageSource: "episode-distiller:near-duplicate-review",
      signal: params.signal,
      blankResponseReminder: [
        "空の応答です。publish, duplicateOfEpisodeId, confidence, reason を持つ JSON object だけを返してください。",
      ],
    },
  );
  return parseNearDuplicateReview(parseLlmJsonLike(completion.content)?.value);
}

function splitLargeSegment(segment: Segment, maxBytes: number): Segment[] {
  if (segment.endOffset - segment.startOffset <= maxBytes) return [segment];
  const chunks: Segment[] = [];
  let start = segment.startOffset;
  const buffer = Buffer.from(segment.text, "utf8");
  while (start < segment.endOffset) {
    const relativeStart = start - segment.startOffset;
    const relativeEnd = Math.min(buffer.byteLength, relativeStart + maxBytes);
    const text = buffer.subarray(relativeStart, relativeEnd).toString("utf8");
    const end = segment.startOffset + relativeEnd;
    chunks.push({
      text,
      startOffset: start,
      endOffset: end,
      eventStart: segment.eventStart,
      eventEnd: segment.eventEnd,
      eventIds: segment.eventIds,
    });
    start = end;
  }
  return chunks;
}

function buildDeterministicSegments(document: EpisodeSourceDocument): Segment[] {
  const maxTokens = 4000;
  const maxBytes = maxTokens * 4;
  const events = document.events;
  if (events.length === 0) {
    return [
      {
        text: document.content,
        startOffset: 0,
        endOffset: Buffer.byteLength(document.content, "utf8"),
        eventStart: null,
        eventEnd: null,
        eventIds: [],
      },
    ];
  }

  const segments: Segment[] = [];
  let current = [events[0]];
  for (const event of events.slice(1)) {
    const previous = current.at(-1);
    const previousAt = previous ? Date.parse(previous.createdAt) : Number.NaN;
    const currentAt = Date.parse(event.createdAt);
    const gapMs =
      Number.isFinite(previousAt) && Number.isFinite(currentAt) ? currentAt - previousAt : 0;
    const currentFiles = new Set(current.map((item) => item.filePath).filter(Boolean));
    const fileBoundary =
      currentFiles.size > 0 && event.filePath ? !currentFiles.has(event.filePath) : false;
    const startOffset = current[0]?.startOffset ?? 0;
    const projectedBytes = event.endOffset - startOffset;
    if (gapMs >= 30 * 60_000 || fileBoundary || projectedBytes > maxBytes) {
      const first = current[0];
      const last = current.at(-1);
      if (first && last) {
        segments.push({
          text: textForByteRange(document.content, first.startOffset, last.endOffset),
          startOffset: first.startOffset,
          endOffset: last.endOffset,
          eventStart: first.id,
          eventEnd: last.id,
          eventIds: current.map((item) => item.id),
        });
      }
      current = [event];
    } else {
      current.push(event);
    }
  }

  const first = current[0];
  const last = current.at(-1);
  if (first && last) {
    segments.push({
      text: textForByteRange(document.content, first.startOffset, last.endOffset),
      startOffset: first.startOffset,
      endOffset: last.endOffset,
      eventStart: first.id,
      eventEnd: last.id,
      eventIds: current.map((item) => item.id),
    });
  }

  return segments.flatMap((segment) => splitLargeSegment(segment, maxBytes));
}

function buildMessages(segment: Segment, document: EpisodeSourceDocument): DistillationMessage[] {
  return [
    {
      role: "user",
      content: [
        `Vibe memory id: ${document.vibeMemoryId}`,
        `Session id: ${document.sessionId}`,
        `Source byte range: ${segment.startOffset}-${segment.endOffset}`,
        `Source events: ${segment.eventIds.join(", ") || "-"}`,
        "",
        "次の shape の JSON array を返してください。値の自然文は日本語で書いてください:",
        "{",
        '  "title": "...",',
        '  "context": "...",',
        '  "intent": "...",',
        '  "keyDecisions": ["..."],',
        '  "actionTaken": "...",',
        '  "outcome": "...",',
        '  "failedApproach": "",',
        '  "reusableLesson": "...",',
        '  "usefulFutureTriggers": ["..."],',
        '  "openLoops": ["..."],',
        '  "generationKind": "task_episode|failure_episode|decision_episode",',
        '  "outcomeKind": "success|failure|mixed|unknown",',
        '  "domains": ["..."],',
        '  "technologies": ["..."],',
        '  "changeTypes": ["..."],',
        '  "tools": ["..."],',
        '  "scores": { "importance": 0, "confidence": 0, "reusability": 0, "decision_density": 0, "failure_value": 0, "causal_clarity": 0, "project_specificity": 0, "evidence_quality": 0, "compression_quality": 0, "staleness_risk": 0 }',
        "}",
        "",
        "Source segment:",
        segment.text,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n"),
    },
  ];
}

function projectIdentityFromSourceMetadata(metadata: Record<string, unknown>) {
  return resolveAuditedStoredProjectScopedWriteIdentity(metadata.projectIdentity, {
    producer: "episode-distiller.typescript",
    entityKind: "episode",
  });
}

function buildSemanticChunkMessages(
  windows: BoundedSourceWindow[],
  document: EpisodeSourceDocument,
): DistillationMessage[] {
  return [
    {
      role: "user",
      content: [
        `Vibe memory id: ${document.vibeMemoryId}`,
        `Session id: ${document.sessionId}`,
        "",
        "次の shape の JSON array を返してください:",
        "{",
        '  "chunkIndex": 0,',
        '  "sourceStartOffset": 0,',
        '  "sourceEndOffset": 100,',
        '  "eventIds": ["..."],',
        '  "taskBoundaryKind": "request_to_result|investigation|implementation|verification|failure_resolution|decision_turn|misc",',
        '  "title": "...",',
        '  "boundaryReason": "...",',
        '  "expectedOutputs": ["episode"],',
        '  "openBoundary": false',
        "}",
        "",
        "Source windows:",
        JSON.stringify(
          windows.map((window) => ({
            windowIndex: window.windowIndex,
            sourceStartOffset: window.sourceStartOffset,
            sourceEndOffset: window.sourceEndOffset,
            eventIds: window.eventIds,
            text: window.text,
          })),
        ),
      ].join("\n"),
    },
  ];
}

function segmentFromSemanticChunk(document: EpisodeSourceDocument, chunk: SemanticChunk): Segment {
  return {
    text: textForByteRange(document.content, chunk.sourceStartOffset, chunk.sourceEndOffset),
    startOffset: chunk.sourceStartOffset,
    endOffset: chunk.sourceEndOffset,
    eventStart: chunk.eventIds[0] ?? null,
    eventEnd: chunk.eventIds.at(-1) ?? null,
    eventIds: chunk.eventIds,
  };
}

async function createSemanticChunks(params: {
  windows: BoundedSourceWindow[];
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}): Promise<SemanticChunk[]> {
  if (params.windows.length === 0) return [];
  if (testHooks.semanticChunks) {
    const chunkOutput = await testHooks.semanticChunks(params);
    const validated = validateSemanticChunks({
      windows: params.windows,
      chunks: chunkOutput,
    });
    if (validated.length > 0) return validated;
    return deterministicSemanticChunksFromWindows(params.windows);
  }
  await ensureRuntimeSettingsLoaded();
  const route = resolveEpisodeDistillerRoute();
  const provider = route.provider;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: route.model,
    localLlmModel: route.localLlmModel,
  });
  try {
    const systemContext = renderPrompt("episodeDistiller.semanticChunk", {});
    const completion = await runDistillationCompletion(
      {
        model,
        messages: [
          promptMessage(systemContext),
          ...buildSemanticChunkMessages(params.windows, params.document),
        ],
        maxTokens: 2000,
        systemContexts: [systemContext.manifest],
      },
      {
        providerSetting: provider,
        fallbackOrder: route.fallback,
        azureDeploymentSlots: route.azureDeploymentSlots,
        localLlmModel: route.localLlmModel,
        enableTools: false,
        maxToolRounds: 0,
        usageSource: "episode-distiller:semantic-chunk",
        signal: params.signal,
        blankResponseReminder: [
          "空の応答です。semantic chunk の JSON array だけを返してください。",
        ],
      },
    );
    const parsed = parseLlmJsonLike(completion.content)?.value;
    const validated = validateSemanticChunks({
      windows: params.windows,
      chunks: parsed,
    });
    return validated.length > 0
      ? validated
      : deterministicSemanticChunksFromWindows(params.windows);
  } catch (error) {
    if (params.signal?.aborted) throw error;
    return deterministicSemanticChunksFromWindows(params.windows);
  }
}

async function buildSegmentPlan(params: {
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}): Promise<ChunkedSegmentPlan> {
  if (!groupedConfig.distillation.internalChunkedDistillationEnabled) {
    return {
      segments: buildDeterministicSegments(params.document),
      sourceWindows: [],
      semanticChunks: [],
      pipelineVersion: "deterministic-segment-v1",
    };
  }
  const sourceWindows = buildBoundedSourceWindows({
    content: params.document.content,
    events: params.document.events,
  });
  const semanticChunks = await createSemanticChunks({
    windows: sourceWindows,
    document: params.document,
    job: params.job,
    signal: params.signal,
  });
  const episodeChunks = semanticChunks.filter((chunk) =>
    chunk.expectedOutputs.some((output) => output === "episode" || output === "both"),
  );
  const segments = episodeChunks.map((chunk) => segmentFromSemanticChunk(params.document, chunk));
  return {
    segments,
    sourceWindows,
    semanticChunks,
    pipelineVersion: "internal-chunked-v1",
  };
}

async function distillSegment(params: {
  segment: Segment;
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}): Promise<unknown> {
  if (testHooks.distillSegment) {
    return testHooks.distillSegment(params);
  }
  await ensureRuntimeSettingsLoaded();
  const route = resolveEpisodeDistillerRoute();
  const provider = route.provider;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: route.model,
    localLlmModel: route.localLlmModel,
  });
  const systemContext = renderPrompt("episodeDistiller.generate", {});
  const completion = await runDistillationCompletion(
    {
      model,
      messages: [promptMessage(systemContext), ...buildMessages(params.segment, params.document)],
      maxTokens: 4000,
      systemContexts: [systemContext.manifest],
    },
    {
      providerSetting: provider,
      fallbackOrder: route.fallback,
      azureDeploymentSlots: route.azureDeploymentSlots,
      localLlmModel: route.localLlmModel,
      enableTools: false,
      maxToolRounds: 0,
      usageSource: "episode-distiller",
      signal: params.signal,
      blankResponseReminder: [
        "空の応答です。actionTaken と outcome を含む Episode canonical form の JSON array だけを返してください。",
      ],
    },
  );
  return parseLlmJsonLike(completion.content)?.value;
}

async function distillSegmentWithRetry(params: {
  segment: Segment;
  document: EpisodeSourceDocument;
  job: EpisodeDistillerJob;
  signal?: AbortSignal;
}) {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const output = await distillSegment(params);
      return episodeDistillerCanonicalArraySchema.parse(output);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(lastError || "episode distiller parse failed");
}

async function createEpisodeIdempotently(input: Parameters<typeof createEpisodeCard>[0]): Promise<{
  episode: EpisodeCard;
  deduped: boolean;
}> {
  const existing = await getEpisodeCardBySource({
    sourceKind: input.sourceKind,
    sourceKey: input.sourceKey,
  });
  if (existing) return { episode: existing, deduped: true };
  try {
    return {
      episode: await createEpisodeCard(input, {
        identityProducer: "episode-distiller.typescript",
      }),
      deduped: false,
    };
  } catch (error) {
    const concurrentExisting = await getEpisodeCardBySource({
      sourceKind: input.sourceKind,
      sourceKey: input.sourceKey,
    });
    if (concurrentExisting) return { episode: concurrentExisting, deduped: true };
    throw error;
  }
}

export async function processEpisodeDistillerJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<EpisodeDistillerProcessResult> {
  const job = await getEpisodeDistillerJobById(jobId);
  if (!job) throw new Error(`episode distiller queue job not found: ${jobId}`);
  if (job.sourceKind !== "vibe_memory") {
    throw new Error(`unsupported episode source kind: ${job.sourceKind}`);
  }
  await appendQueueEvent({
    queueName: "episodeDistiller",
    queueJobId: job.id,
    eventType: "claimed",
    message: "episode distiller claimed",
  });

  const document = await readEpisodeSourceDocument(job.sourceKey);
  const segmentPlan = await buildSegmentPlan({ document, job, signal });
  const segments = segmentPlan.segments;
  const metadata = document.metadata;
  const projectIdentity = await projectIdentityFromSourceMetadata(metadata);
  let generated = 0;
  let deduped = 0;
  let skipped = 0;
  let valueSkipped = 0;
  let duplicateGenerationKindSkipped = 0;
  let nearDuplicateSkipped = 0;
  let failedSegments = 0;
  const episodeIds: string[] = [];
  const pendingEpisodes: PendingEpisode[] = [];
  const segmentErrors: Array<{ segment: number; error: string }> = [];
  const skippedDuplicateGenerationKinds: Array<{
    segment: number;
    generationKind: EpisodeGenerationKind;
  }> = [];
  const skippedValueReviews: Array<{
    segment: number;
    generationKind: EpisodeGenerationKind;
    title: string;
    valueReview: EpisodeValueReview;
  }> = [];
  const nearDuplicateReviews: Array<{
    segment: number;
    title: string;
    sourceKey: string;
    candidateCount: number;
    publish: boolean;
    duplicateOfEpisodeId: string | null;
    confidence: number;
    reason: string;
  }> = [];

  for (const [segmentIndex, segment] of segments.entries()) {
    if (signal?.aborted) throw new Error("episode distiller aborted");
    if (estimateTokenCount(segment.text) <= 10) {
      skipped += 1;
      continue;
    }
    let canonicalEpisodes: EpisodeDistillerCanonical[];
    try {
      canonicalEpisodes = await distillSegmentWithRetry({
        segment,
        document,
        job,
        signal,
      });
    } catch (error) {
      failedSegments += 1;
      segmentErrors.push({
        segment: segmentIndex,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (canonicalEpisodes.length === 0) {
      skipped += 1;
      continue;
    }
    const seenGenerationKinds = new Set<EpisodeGenerationKind>();
    for (const rawCanonical of canonicalEpisodes) {
      const canonical = calibrateEpisodeCanonical(rawCanonical);
      const generationKind = canonical.generationKind as EpisodeGenerationKind;
      if (seenGenerationKinds.has(generationKind)) {
        skipped += 1;
        duplicateGenerationKindSkipped += 1;
        skippedDuplicateGenerationKinds.push({
          segment: segmentIndex,
          generationKind,
        });
        continue;
      }
      seenGenerationKinds.add(generationKind);
      const valueReview = reviewEpisodeValue(canonical);
      if (!valueReview.publish) {
        skipped += 1;
        valueSkipped += 1;
        skippedValueReviews.push({
          segment: segmentIndex,
          generationKind,
          title: canonical.title,
          valueReview,
        });
        continue;
      }
      const sourceFragmentKey = episodeSourceFragmentKey({
        parentSourceKind: "vibe_memory",
        parentSourceKey: job.sourceKey,
        sourceSpan: {
          startOffset: segment.startOffset,
          endOffset: segment.endOffset,
        },
        generationKind,
        distillationVersion: EPISODE_DISTILLATION_VERSION,
      });
      const input = canonicalEpisodeToCardInput({
        canonical,
        sourceKey: sourceFragmentKey,
        parentVibeMemoryId: job.sourceKey,
        sourceFragmentKey,
        sourceStartOffset: segment.startOffset,
        sourceEndOffset: segment.endOffset,
        eventStart: segment.eventStart,
        eventEnd: segment.eventEnd,
        readRanges: [{ from: segment.startOffset, toExclusive: segment.endOffset }],
        sessionId: document.sessionId,
        projectIdentity,
        distillationVersion: EPISODE_DISTILLATION_VERSION,
      });
      const inputMetadata = recordFromUnknown(input.metadata);
      input.metadata = {
        ...inputMetadata,
        episodeDistillation: {
          ...recordFromUnknown(inputMetadata.episodeDistillation),
          valueReview,
        },
      };
      pendingEpisodes.push({ input, segmentIndex });
    }
  }

  if (
    generated === 0 &&
    deduped === 0 &&
    failedSegments > 0 &&
    failedSegments === segments.length
  ) {
    const sampleErrors = segmentErrors
      .slice(0, 3)
      .map((item) => `segment ${item.segment}: ${item.error}`)
      .join(" | ");
    throw new Error(
      `episode distiller failed all segments (${failedSegments}/${segments.length})${
        sampleErrors ? `: ${sampleErrors}` : ""
      }`,
    );
  }

  for (const pending of pendingEpisodes) {
    const candidates = await findNearDuplicateCandidates({
      input: pending.input,
      document,
    });
    const review = await reviewNearDuplicate({
      input: pending.input,
      candidates,
      document,
      job,
      signal,
    });
    const publish = reviewAllowsPublish(review, candidates);
    nearDuplicateReviews.push({
      segment: pending.segmentIndex,
      title: pending.input.title,
      sourceKey: pending.input.sourceKey,
      candidateCount: candidates.length,
      publish,
      duplicateOfEpisodeId: review.duplicateOfEpisodeId,
      confidence: review.confidence,
      reason: review.reason,
    });
    if (!publish) {
      skipped += 1;
      nearDuplicateSkipped += 1;
      continue;
    }
    const saved = await createEpisodeIdempotently(pending.input);
    episodeIds.push(saved.episode.id);
    if (saved.deduped) deduped += 1;
    else generated += 1;
  }

  const outcome =
    generated > 0 || deduped > 0
      ? "episodes_distilled"
      : valueSkipped > 0
        ? "low_value_skipped"
        : "no_episode";
  await markEpisodeDistillerCompleted({
    jobId: job.id,
    status: outcome === "episodes_distilled" ? "completed" : "skipped",
    outcome,
    metadata: {
      episodeDistiller: {
        pipelineVersion: segmentPlan.pipelineVersion,
        generated,
        deduped,
        skipped,
        valueSkipped,
        duplicateGenerationKindSkipped,
        nearDuplicateSkipped,
        failedSegments,
        segmentCount: segments.length,
        sourceWindowCount: segmentPlan.sourceWindows.length,
        semanticChunkCount: segmentPlan.semanticChunks.length,
        episodeIds,
        acceptedCandidateCount: pendingEpisodes.length,
        segmentErrors,
        skippedDuplicateGenerationKinds,
        skippedValueReviews,
        nearDuplicateReviews,
        completedAt: new Date().toISOString(),
      },
    },
  });
  await appendQueueEvent({
    queueName: "episodeDistiller",
    queueJobId: job.id,
    eventType: "completed",
    message: "episode distiller completed",
    metadata: {
      generated,
      deduped,
      skipped,
      valueSkipped,
      duplicateGenerationKindSkipped,
      nearDuplicateSkipped,
      failedSegments,
      episodeIds,
      acceptedCandidateCount: pendingEpisodes.length,
    },
  });
  return {
    generated,
    deduped,
    skipped,
    valueSkipped,
    duplicateGenerationKindSkipped,
    nearDuplicateSkipped,
    failedSegments,
    episodeIds,
  };
}

export async function failEpisodeDistillerJob(jobId: string, error: string): Promise<void> {
  await markEpisodeDistillerFailed({
    jobId,
    error,
    outcome: "failed",
    metadata: {
      episodeDistiller: {
        failedAt: new Date().toISOString(),
        error,
      },
    },
  });
}
