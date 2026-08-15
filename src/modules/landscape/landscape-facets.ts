import type {
  LandscapeRunStatus,
  LandscapeTaskFacetEntry,
  LandscapeTaskFacets,
} from "./landscape-replay.types.js";

const UNKNOWN = "unknown";

export type LandscapeReplayCompileRunInput = {
  goal: string;
  runInput: unknown;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  matchBasis: string;
  identityContractVersion: number;
  scopeMode: string;
  retrievalMode: string;
  source: string;
  runStatus: LandscapeRunStatus;
  degradedReasons: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeFacetValue(value: string): string {
  return value.trim().toLowerCase();
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => normalizeFacetValue(item))
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => normalizeFacetValue(item))
        .filter(Boolean),
    ),
  ];
}

function firstStringArray(input: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const values = asStringArray(input[key]);
    if (values.length > 0) return values;
  }
  return [];
}

function pickString(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = asNonEmptyString(input[key]);
    if (value) return value;
  }
  return undefined;
}

export function extractLandscapeTaskFacets(input: {
  runInput: unknown;
  repoPath: string | null;
  retrievalMode: string;
  source: string;
  runStatus: LandscapeRunStatus;
  degradedReasons: unknown;
}): LandscapeTaskFacets {
  const record = asRecord(input.runInput);
  const appliesTo = asRecord(record.appliesTo);
  const metadata = asRecord(record.metadata);

  const repoPath =
    pickString(record, ["repoPath", "workspacePath", "projectRoot"]) ??
    pickString(appliesTo, ["repoPath"]) ??
    pickString(metadata, ["repoPath", "sourceRepoPath", "workspacePath", "projectRoot"]) ??
    input.repoPath ??
    undefined;
  const repoKey =
    pickString(record, ["repoKey"]) ??
    pickString(appliesTo, ["repoKey"]) ??
    pickString(metadata, ["repoKey", "sourceProject"]);

  return {
    ...(repoKey ? { repoKey: normalizeFacetValue(repoKey) } : {}),
    ...(repoPath ? { repoPath } : {}),
    retrievalMode: normalizeFacetValue(input.retrievalMode || UNKNOWN),
    technologies: firstStringArray(record, ["technologies", "technology", "tech"]),
    changeTypes: firstStringArray(record, ["changeTypes", "changeType"]),
    domains: firstStringArray(record, ["domains", "domain"]),
    source: normalizeFacetValue(input.source || UNKNOWN),
    runStatus: input.runStatus,
    degradedReasonBuckets: asStringArray(input.degradedReasons),
  };
}

function entriesForArray(
  facetKind: LandscapeTaskFacetEntry["facetKind"],
  values: string[],
): LandscapeTaskFacetEntry[] {
  const normalized = values.length > 0 ? values : [UNKNOWN];
  return normalized.map((facetValue) => ({ facetKind, facetValue }));
}

export function enumerateLandscapeTaskFacetEntries(
  facets: LandscapeTaskFacets,
): LandscapeTaskFacetEntry[] {
  return [
    { facetKind: "retrievalMode", facetValue: facets.retrievalMode || UNKNOWN },
    { facetKind: "repoKey", facetValue: facets.repoKey || UNKNOWN },
    ...entriesForArray("technology", facets.technologies),
    ...entriesForArray("changeType", facets.changeTypes),
    ...entriesForArray("domain", facets.domains),
    { facetKind: "source", facetValue: facets.source || UNKNOWN },
    { facetKind: "runStatus", facetValue: facets.runStatus },
    ...entriesForArray("degradedReasonBucket", facets.degradedReasonBuckets),
  ];
}
