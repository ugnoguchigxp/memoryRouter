import type { ResolvedCompileProjectIdentity } from "./compile-project-identity.js";
import {
  type RepositoryClassification,
  type RepositoryEntityKind,
  type RepositoryFacets,
  type RepositoryScopeCandidate,
  type RepositoryScopeDecisionReason,
  classifyRepositoryCandidate,
  evaluateRepositoryScope,
  repositoryCandidateIdentityBasis,
  repositoryClassificationValues,
  repositoryEntityKindValues,
} from "./repository-scope.js";

export const REPOSITORY_ISOLATION_REPORT_VERSION = 2 as const;
export const REPOSITORY_ISOLATION_PREVIEW_LIMIT_MAX = 20;
export const REPOSITORY_ISOLATION_BASELINE_MIN_SAMPLE = 500;

export type RepositoryIsolationRunObservation = {
  id: string;
  createdAt: Date;
  durationMs: number;
  status: string;
  degradedReasons: string[];
  matchBasis: "project_ref" | "repo_key" | "repo_path" | "none";
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  identityContractVersion: number;
  outputMarkdownKind: "narrative" | "no-content" | null;
  selectedIdsByEntity: Record<RepositoryEntityKind, string[]>;
};

export type RepositoryIdentityProducerEvent = {
  eventType:
    | "PROJECT_IDENTITY_PRODUCER_VALIDATED"
    | "PROJECT_IDENTITY_PRODUCER_PERSISTED"
    | "PROJECT_IDENTITY_PRODUCER_REJECTED";
  createdAt: Date;
  payload: Record<string, unknown>;
};

type ClassificationCounts = Record<RepositoryClassification, number>;
type IdentityBasisCounts = Record<"project_ref" | "repo_key" | "repo_path" | "none", number>;

export type RepositoryIsolationEntityInventory = {
  total: number;
  classifications: ClassificationCounts;
  identityBasis: IdentityBasisCounts;
  unresolvedByProducer: Record<string, number>;
  previewIdsByClassification: Record<RepositoryClassification, string[]>;
};

export type RepositoryIsolationSchemaCapabilities = {
  entities: Record<
    RepositoryEntityKind,
    {
      classificationStatus: boolean;
      scope: boolean;
      projectRef: boolean;
      repoKey: boolean;
      repoPath: boolean;
    }
  >;
  runIdentity: boolean;
  identityAliases: boolean;
};

export type RepositoryIsolationReport = {
  reportVersion: typeof REPOSITORY_ISOLATION_REPORT_VERSION;
  generatedAt: string;
  backend: "sqlite" | "postgres" | "fixture";
  readOnly: true;
  privacy: {
    contentFieldsIncluded: false;
    absolutePathsIncluded: false;
    previewLimit: number;
  };
  schemaCapabilities: RepositoryIsolationSchemaCapabilities;
  inventory: Record<RepositoryEntityKind, RepositoryIsolationEntityInventory>;
  requestComparison: null | {
    matchBasis: ResolvedCompileProjectIdentity["matchBasis"];
    identityContractVersion: number;
    identityFingerprint: string | null;
    wouldSelectCount: number;
    wouldExcludeCount: number;
    wouldSelectIds: string[];
    wouldExcludeIds: string[];
    excludedByReason: Partial<Record<RepositoryScopeDecisionReason, number>>;
  };
  recentRunReevaluation: Array<{
    runId: string;
    identityKnown: boolean;
    selectedCount: number;
    mismatchCount: number;
    selectedIds: string[];
    mismatchIds: string[];
  }>;
  producerObservation: {
    requestedWindowDays: 7;
    minimumIdentityBearingEvents: 200;
    observationStartedAt: string | null;
    oldestIdentityBearingEventAt: string | null;
    observedDays: number;
    validatedCount: number;
    persistedCount: number;
    identityBearingPersistedCount: number;
    globalPersistedCount: number;
    malformedPersistedCount: number;
    rejectedCount: number;
    persistedByProducer: Record<string, number>;
    enabledProducers: string[];
    observedEnabledProducers: string[];
    missingEnabledProducers: string[];
    enabledProducerCoverageRate: number;
    rejectedByProducer: Record<string, number>;
    rejectedByCode: Record<string, number>;
    newUnresolvedByEntity: Record<RepositoryEntityKind, number>;
    newUnresolvedCount: number;
    hasFullWindow: boolean;
    hasMinimumIdentityBearingEvents: boolean;
    hasCompleteEnabledProducerCoverage: boolean;
    completionCriteriaMet: boolean;
  };
  baseline: {
    requestedWindowDays: 14;
    actualWindowDays: 14 | 30;
    minimumIdentityPresentSamples: number;
    totalCompileRuns: number;
    identityPresentRuns: number;
    identityPresenceRate: number;
    insufficientIdentityPresentSamples: boolean;
    noContentRate: number;
    selectedCountDistribution: Record<
      RepositoryEntityKind,
      { p50: number | null; p95: number | null }
    >;
    durationMs: { p50: number | null; p95: number | null };
    agenticComposerFailureRate: number;
  };
};

function emptyClassificationCounts(): ClassificationCounts {
  return { global: 0, repo: 0, unresolved: 0, malformed: 0, conflict: 0 };
}

function emptyIdentityBasisCounts(): IdentityBasisCounts {
  return { project_ref: 0, repo_key: 0, repo_path: 0, none: 0 };
}

function createEntityInventory(): RepositoryIsolationEntityInventory {
  return {
    total: 0,
    classifications: emptyClassificationCounts(),
    identityBasis: emptyIdentityBasisCounts(),
    unresolvedByProducer: {},
    previewIdsByClassification: {
      global: [],
      repo: [],
      unresolved: [],
      malformed: [],
      conflict: [],
    },
  };
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, quantile));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower] ?? null;
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function runHasIdentity(run: RepositoryIsolationRunObservation): boolean {
  return (
    run.matchBasis !== "none" &&
    (run.projectRef !== null || run.repoKey !== null || run.repoPath !== null)
  );
}

function runIdentity(run: RepositoryIsolationRunObservation): ResolvedCompileProjectIdentity {
  const matchValue =
    run.matchBasis === "project_ref"
      ? run.projectRef
      : run.matchBasis === "repo_key"
        ? run.repoKey
        : run.matchBasis === "repo_path"
          ? run.repoPath
          : null;
  return {
    contractVersion: 1,
    scopeMode: matchValue === null ? "global_only" : "project",
    matchBasis: matchValue === null ? "none" : run.matchBasis,
    matchValue,
    projectRef: run.projectRef,
    repoKey: run.repoKey,
    repoPath: run.repoPath,
    identityFingerprint: null,
    trust: "request_hint",
    bindingStatus: "not_applicable",
  };
}

function selectedIds(run: RepositoryIsolationRunObservation): string[] {
  return repositoryEntityKindValues.flatMap((kind) => run.selectedIdsByEntity[kind]);
}

function buildInventory(
  candidates: RepositoryScopeCandidate[],
  previewLimit: number,
): Record<RepositoryEntityKind, RepositoryIsolationEntityInventory> {
  const inventory = {
    knowledge: createEntityInventory(),
    source: createEntityInventory(),
    episode: createEntityInventory(),
  };
  for (const candidate of candidates) {
    const entity = inventory[candidate.entityKind];
    const classification = classifyRepositoryCandidate(candidate);
    const basis = repositoryCandidateIdentityBasis(candidate);
    entity.total += 1;
    entity.classifications[classification] += 1;
    entity.identityBasis[basis] += 1;
    if (classification !== "global" && classification !== "repo") {
      entity.unresolvedByProducer[candidate.producer] =
        (entity.unresolvedByProducer[candidate.producer] ?? 0) + 1;
    }
    if (entity.previewIdsByClassification[classification].length < previewLimit) {
      entity.previewIdsByClassification[classification].push(candidate.id);
    }
  }
  for (const kind of repositoryEntityKindValues) {
    const entity = inventory[kind];
    entity.unresolvedByProducer = Object.fromEntries(
      Object.entries(entity.unresolvedByProducer).sort(
        ([leftKey, leftCount], [rightKey, rightCount]) =>
          rightCount - leftCount || leftKey.localeCompare(rightKey),
      ),
    );
    for (const classification of repositoryClassificationValues) {
      entity.previewIdsByClassification[classification].sort();
    }
  }
  return inventory;
}

function buildBaseline(
  runs: RepositoryIsolationRunObservation[],
  now: Date,
): RepositoryIsolationReport["baseline"] {
  const ageMs = (run: RepositoryIsolationRunObservation) => now.getTime() - run.createdAt.getTime();
  const withinDays = (run: RepositoryIsolationRunObservation, days: number) =>
    ageMs(run) >= 0 && ageMs(run) <= days * 24 * 60 * 60 * 1000;
  const fourteenDayRuns = runs.filter((run) => withinDays(run, 14));
  const fourteenDayIdentityRuns = fourteenDayRuns.filter(runHasIdentity);
  const actualWindowDays =
    fourteenDayIdentityRuns.length >= REPOSITORY_ISOLATION_BASELINE_MIN_SAMPLE ? 14 : 30;
  const cohortRuns = runs.filter((run) => withinDays(run, actualWindowDays));
  const identityRuns = cohortRuns.filter(runHasIdentity);
  const selectedCountDistribution = Object.fromEntries(
    repositoryEntityKindValues.map((kind) => {
      const counts = identityRuns.map((run) => run.selectedIdsByEntity[kind].length);
      return [kind, { p50: percentile(counts, 0.5), p95: percentile(counts, 0.95) }];
    }),
  ) as RepositoryIsolationReport["baseline"]["selectedCountDistribution"];
  const composerFailures = identityRuns.filter((run) =>
    run.degradedReasons.some(
      (reason) => reason.includes("COMPOSE_FAILED") || reason.includes("AGENTIC_REFINE_FAILED"),
    ),
  ).length;
  return {
    requestedWindowDays: 14,
    actualWindowDays,
    minimumIdentityPresentSamples: REPOSITORY_ISOLATION_BASELINE_MIN_SAMPLE,
    totalCompileRuns: cohortRuns.length,
    identityPresentRuns: identityRuns.length,
    identityPresenceRate: rate(identityRuns.length, cohortRuns.length),
    insufficientIdentityPresentSamples:
      identityRuns.length < REPOSITORY_ISOLATION_BASELINE_MIN_SAMPLE,
    noContentRate: rate(
      identityRuns.filter((run) => run.outputMarkdownKind === "no-content").length,
      identityRuns.length,
    ),
    selectedCountDistribution,
    durationMs: {
      p50: percentile(
        identityRuns.map((run) => run.durationMs).filter((value) => Number.isFinite(value)),
        0.5,
      ),
      p95: percentile(
        identityRuns.map((run) => run.durationMs).filter((value) => Number.isFinite(value)),
        0.95,
      ),
    },
    agenticComposerFailureRate: rate(composerFailures, identityRuns.length),
  };
}

function sortedCounts(entries: Array<string | null>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = entry?.slice(0, 120) || "unknown";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort(
      ([leftKey, leftCount], [rightKey, rightCount]) =>
        rightCount - leftCount || leftKey.localeCompare(rightKey),
    ),
  );
}

function producerObservation(input: {
  events: RepositoryIdentityProducerEvent[];
  now: Date;
  newUnresolvedByEntity: Record<RepositoryEntityKind, number>;
  enabledProducers: string[];
  observationStartedAt?: Date;
}): RepositoryIsolationReport["producerObservation"] {
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const cutoff = input.now.getTime() - windowMs;
  const events = input.events.filter((event) => {
    const timestamp = event.createdAt.getTime();
    return Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= input.now.getTime();
  });
  const validated = events.filter(
    (event) => event.eventType === "PROJECT_IDENTITY_PRODUCER_VALIDATED",
  );
  const persisted = events.filter(
    (event) => event.eventType === "PROJECT_IDENTITY_PRODUCER_PERSISTED",
  );
  const rejected = events.filter(
    (event) => event.eventType === "PROJECT_IDENTITY_PRODUCER_REJECTED",
  );
  const hasProducerMetadata = (event: RepositoryIdentityProducerEvent): boolean => {
    const entityKind = event.payload.entityKind;
    return (
      typeof event.payload.producer === "string" &&
      event.payload.producer.trim().length > 0 &&
      (entityKind === "knowledge" ||
        entityKind === "source" ||
        entityKind === "episode" ||
        entityKind === "candidate" ||
        entityKind === "vibe_memory")
    );
  };
  const identityBearing = persisted.filter((event) => {
    const fingerprint = event.payload.identityFingerprint;
    return (
      hasProducerMetadata(event) &&
      event.payload.scope === "repo" &&
      (event.payload.matchBasis === "project_ref" ||
        event.payload.matchBasis === "repo_key" ||
        event.payload.matchBasis === "repo_path") &&
      (event.payload.bindingStatus === "verified" ||
        event.payload.bindingStatus === "unverified") &&
      typeof fingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(fingerprint)
    );
  });
  const globalPersisted = persisted.filter(
    (event) =>
      hasProducerMetadata(event) &&
      event.payload.scope === "global" &&
      event.payload.matchBasis === "none" &&
      event.payload.bindingStatus === "not_applicable" &&
      event.payload.identityFingerprint === null,
  );
  const malformedPersistedCount =
    persisted.length - identityBearing.length - globalPersisted.length;
  const oldestIdentityBearing = identityBearing.reduce<Date | null>(
    (oldest, event) => (!oldest || event.createdAt < oldest ? event.createdAt : oldest),
    null,
  );
  const observationStartedAt =
    input.observationStartedAt &&
    Number.isFinite(input.observationStartedAt.getTime()) &&
    input.observationStartedAt.getTime() <= input.now.getTime()
      ? input.observationStartedAt
      : null;
  const observedDays = observationStartedAt
    ? Math.min(7, Math.max(0, (input.now.getTime() - observationStartedAt.getTime()) / 86_400_000))
    : 0;
  const hasFullWindow = observationStartedAt !== null && observationStartedAt.getTime() <= cutoff;
  const hasMinimumIdentityBearingEvents = identityBearing.length >= 200;
  const enabledProducers = [...new Set(input.enabledProducers.map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  const identityBearingProducerSet = new Set(
    identityBearing.flatMap((event) =>
      typeof event.payload.producer === "string" && event.payload.producer.trim()
        ? [event.payload.producer.trim()]
        : [],
    ),
  );
  const observedEnabledProducers = enabledProducers.filter((producer) =>
    identityBearingProducerSet.has(producer),
  );
  const missingEnabledProducers = enabledProducers.filter(
    (producer) => !identityBearingProducerSet.has(producer),
  );
  const hasCompleteEnabledProducerCoverage =
    enabledProducers.length > 0 && missingEnabledProducers.length === 0;
  const newUnresolvedCount = repositoryEntityKindValues.reduce(
    (total, kind) => total + input.newUnresolvedByEntity[kind],
    0,
  );
  return {
    requestedWindowDays: 7,
    minimumIdentityBearingEvents: 200,
    observationStartedAt: observationStartedAt?.toISOString() ?? null,
    oldestIdentityBearingEventAt: oldestIdentityBearing?.toISOString() ?? null,
    observedDays,
    validatedCount: validated.length,
    persistedCount: persisted.length,
    identityBearingPersistedCount: identityBearing.length,
    globalPersistedCount: globalPersisted.length,
    malformedPersistedCount,
    rejectedCount: rejected.length,
    persistedByProducer: sortedCounts(
      persisted.map((event) =>
        typeof event.payload.producer === "string" ? event.payload.producer : null,
      ),
    ),
    enabledProducers,
    observedEnabledProducers,
    missingEnabledProducers,
    enabledProducerCoverageRate: rate(observedEnabledProducers.length, enabledProducers.length),
    rejectedByProducer: sortedCounts(
      rejected.map((event) =>
        typeof event.payload.producer === "string" ? event.payload.producer : null,
      ),
    ),
    rejectedByCode: sortedCounts(
      rejected.map((event) =>
        typeof event.payload.rejectionCode === "string" ? event.payload.rejectionCode : null,
      ),
    ),
    newUnresolvedByEntity: input.newUnresolvedByEntity,
    newUnresolvedCount,
    hasFullWindow,
    hasMinimumIdentityBearingEvents,
    hasCompleteEnabledProducerCoverage,
    completionCriteriaMet:
      hasFullWindow &&
      hasMinimumIdentityBearingEvents &&
      hasCompleteEnabledProducerCoverage &&
      malformedPersistedCount === 0 &&
      newUnresolvedCount === 0,
  };
}

export function buildRepositoryIsolationReport(input: {
  backend: RepositoryIsolationReport["backend"];
  candidates: RepositoryScopeCandidate[];
  runs?: RepositoryIsolationRunObservation[];
  requestIdentity?: ResolvedCompileProjectIdentity;
  requestFacets?: RepositoryFacets;
  previewLimit?: number;
  recentRunLimit?: number;
  now?: Date;
  schemaCapabilities?: RepositoryIsolationSchemaCapabilities;
  producerEvents?: RepositoryIdentityProducerEvent[];
  enabledProducers?: string[];
  producerObservationStartedAt?: Date;
  newUnresolvedByEntity?: Record<RepositoryEntityKind, number>;
}): RepositoryIsolationReport {
  const previewLimit = Math.min(
    REPOSITORY_ISOLATION_PREVIEW_LIMIT_MAX,
    Math.max(0, Math.floor(input.previewLimit ?? REPOSITORY_ISOLATION_PREVIEW_LIMIT_MAX)),
  );
  const runs = input.runs ?? [];
  const candidatesById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const requestIdentity = input.requestIdentity;
  const requestDecisions = requestIdentity
    ? input.candidates.map((candidate) => ({
        candidate,
        decision: evaluateRepositoryScope(candidate, requestIdentity, input.requestFacets ?? {}),
      }))
    : [];
  const excludedByReason: Partial<Record<RepositoryScopeDecisionReason, number>> = {};
  for (const { decision } of requestDecisions) {
    if (decision.allowed) continue;
    excludedByReason[decision.reason] = (excludedByReason[decision.reason] ?? 0) + 1;
  }

  const recentRuns = [...runs]
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
    .slice(0, Math.max(0, Math.floor(input.recentRunLimit ?? 20)))
    .map((run) => {
      const ids = selectedIds(run);
      const identity = runIdentity(run);
      const mismatches = ids.filter((id) => {
        const item = candidatesById.get(id);
        return !item || !evaluateRepositoryScope(item, identity).allowed;
      });
      return {
        runId: run.id,
        identityKnown: runHasIdentity(run),
        selectedCount: ids.length,
        mismatchCount: mismatches.length,
        selectedIds: ids.slice(0, previewLimit),
        mismatchIds: mismatches.slice(0, previewLimit),
      };
    });

  const allowed = requestDecisions.filter(({ decision }) => decision.allowed);
  const excluded = requestDecisions.filter(({ decision }) => !decision.allowed);
  return {
    reportVersion: REPOSITORY_ISOLATION_REPORT_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    backend: input.backend,
    readOnly: true,
    privacy: {
      contentFieldsIncluded: false,
      absolutePathsIncluded: false,
      previewLimit,
    },
    schemaCapabilities: input.schemaCapabilities ?? {
      entities: {
        knowledge: {
          classificationStatus: true,
          scope: true,
          projectRef: true,
          repoKey: true,
          repoPath: true,
        },
        source: {
          classificationStatus: true,
          scope: true,
          projectRef: true,
          repoKey: true,
          repoPath: true,
        },
        episode: {
          classificationStatus: true,
          scope: true,
          projectRef: true,
          repoKey: true,
          repoPath: true,
        },
      },
      runIdentity: true,
      identityAliases: true,
    },
    inventory: buildInventory(input.candidates, previewLimit),
    requestComparison: requestIdentity
      ? {
          matchBasis: requestIdentity.matchBasis,
          identityContractVersion: requestIdentity.contractVersion,
          identityFingerprint: requestIdentity.identityFingerprint,
          wouldSelectCount: allowed.length,
          wouldExcludeCount: excluded.length,
          wouldSelectIds: allowed.map(({ candidate }) => candidate.id).slice(0, previewLimit),
          wouldExcludeIds: excluded.map(({ candidate }) => candidate.id).slice(0, previewLimit),
          excludedByReason,
        }
      : null,
    recentRunReevaluation: recentRuns,
    producerObservation: producerObservation({
      events: input.producerEvents ?? [],
      now: input.now ?? new Date(),
      newUnresolvedByEntity: input.newUnresolvedByEntity ?? {
        knowledge: 0,
        source: 0,
        episode: 0,
      },
      enabledProducers: input.enabledProducers ?? [],
      observationStartedAt: input.producerObservationStartedAt,
    }),
    baseline: buildBaseline(runs, input.now ?? new Date()),
  };
}
