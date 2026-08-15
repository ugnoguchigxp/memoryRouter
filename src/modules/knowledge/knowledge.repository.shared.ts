import { type SQL, and, eq, isNull, or, sql } from "drizzle-orm";
import { knowledgeItems } from "../../db/schema.js";
import type {
  KnowledgeApplicabilityInput,
  KnowledgeItem,
  KnowledgeSearchInput,
  KnowledgeStatus,
} from "../../shared/schemas/knowledge.schema.js";
import {
  type ResolvedCompileProjectIdentity,
  normalizeCompileRepoPath,
  resolveCompileProjectIdentity,
} from "../context-compiler/compile-project-identity.js";
import { parseApplicabilityFromRecord } from "./applicability.service.js";

export type KnowledgeSearchResult = {
  id: string;
  type: string;
  status: string;
  scope: string;
  classificationStatus?: string;
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  polarity: string;
  intentTags: string[];
  title: string;
  body: string;
  confidence: number;
  importance: number;
  score: number;
  appliesTo: Record<string, unknown>;
  metadata: Record<string, unknown>;
  sourceRefs: string[];
  hasSourceLinks: boolean;
  dynamicScore: number;
  compileSelectCount: number;
  agenticAcceptCount: number;
  explicitUpvoteCount: number;
  explicitDownvoteCount: number;
  lastCompiledAt: Date | null;
  lastVerifiedAt: Date | null;
  updatedAt: Date;
  decayFactor: number;
  applicabilityScore: number;
  applicabilityMatches: {
    technologies: string[];
    changeTypes: string[];
    domains: string[];
    general: boolean;
  };
};

export type UpsertKnowledgeFromSourceParams = {
  sourceUri: string;
  type: KnowledgeItem["type"];
  status: KnowledgeStatus;
  scope: KnowledgeItem["scope"];
  polarity?: string;
  intentTags?: string[];
  title: string;
  body: string;
  confidence?: number;
  importance?: number;
  metadata?: Record<string, unknown>;
  embedding?: number[];
  appliesTo?: Record<string, unknown> | KnowledgeApplicabilityInput;
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  identityProducer?: string;
};

export type KnowledgeSearchOptions = {
  projectIdentity?: ResolvedCompileProjectIdentity;
  projectRef?: string;
  repoPath?: string;
  repoKey?: string;
  types?: KnowledgeItem["type"][];
  polarities?: Array<"positive" | "negative" | "neutral">;
  intentTags?: string[];
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  includeGeneral?: boolean;
};

export type KnowledgeSearchQueryInput = Omit<KnowledgeSearchInput, "includeGeneral"> & {
  includeGeneral?: boolean;
};

export function finiteOrZero(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function valueAsString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeFacetValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{L}\p{N}./+#-]/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueLowerSlugs(values: string[] | undefined): string[] {
  const deduped = new Set<string>();
  for (const raw of values ?? []) {
    const normalized = normalizeFacetValue(raw);
    if (!normalized) continue;
    deduped.add(normalized);
  }
  return [...deduped];
}

export type ApplicabilityQuery = {
  technologies: string[];
  changeTypes: string[];
  domains: string[];
  includeGeneral: boolean;
};

export function buildApplicabilityQuery(
  input: Pick<
    KnowledgeSearchQueryInput,
    "technologies" | "changeTypes" | "domains" | "includeGeneral"
  >,
  options: Pick<
    KnowledgeSearchOptions,
    "technologies" | "changeTypes" | "domains" | "includeGeneral"
  >,
): ApplicabilityQuery {
  const technologies = uniqueLowerSlugs(options.technologies ?? input.technologies);
  const changeTypes = uniqueLowerSlugs(options.changeTypes ?? input.changeTypes);
  const domains = uniqueLowerSlugs(options.domains ?? input.domains);
  const includeGeneral = options.includeGeneral ?? input.includeGeneral ?? true;
  return {
    technologies,
    changeTypes,
    domains,
    includeGeneral,
  };
}

export function hasApplicabilityQuery(query: ApplicabilityQuery): boolean {
  return query.technologies.length > 0 || query.changeTypes.length > 0 || query.domains.length > 0;
}

function intersect(queryValues: string[], sourceValues: string[]): string[] {
  if (queryValues.length === 0 || sourceValues.length === 0) return [];
  const sourceSet = new Set(sourceValues.map(normalizeFacetValue));
  const matched: string[] = [];
  for (const value of queryValues) {
    if (sourceSet.has(normalizeFacetValue(value))) matched.push(value);
  }
  return matched;
}

function facetMatchScore(queryValues: string[], matchedValues: string[], weight: number): number {
  if (queryValues.length === 0 || matchedValues.length === 0) return 0;
  return weight * Math.min(1, matchedValues.length / queryValues.length);
}

export function computeApplicability(
  appliesTo: Record<string, unknown>,
  query: ApplicabilityQuery,
) {
  const sourceTechnologies = toStringArray(appliesTo.technologies);
  const sourceChangeTypes = toStringArray(appliesTo.changeTypes);
  const sourceDomains = toStringArray(appliesTo.domains);
  const technologies = intersect(query.technologies, sourceTechnologies);
  const changeTypes = intersect(query.changeTypes, sourceChangeTypes);
  const domains = intersect(query.domains, sourceDomains);
  const hasFacetData =
    sourceTechnologies.length > 0 || sourceChangeTypes.length > 0 || sourceDomains.length > 0;
  const hasExplicitGeneral = typeof appliesTo.general === "boolean";
  const general = appliesTo.general === true || (!hasExplicitGeneral && !hasFacetData);
  const facetScore =
    facetMatchScore(query.technologies, technologies, 34) +
    facetMatchScore(query.changeTypes, changeTypes, 30) +
    facetMatchScore(query.domains, domains, 28);
  const score = Math.min(100, Math.round(facetScore));

  return {
    score,
    matches: {
      technologies,
      changeTypes,
      domains,
      general: general && query.includeGeneral,
    },
  };
}

export function buildKnowledgeScopeMetadata(
  sourceUri: string,
  metadata?: Record<string, unknown>,
  explicitAppliesTo?: Record<string, unknown> | KnowledgeApplicabilityInput,
): { metadata: Record<string, unknown>; appliesTo: Record<string, unknown> } {
  const sourceMetadata = asRecord(metadata);
  const explicit = parseApplicabilityFromRecord(explicitAppliesTo);
  const repoPathCandidate =
    explicit.repoPath ??
    valueAsString(sourceMetadata.repoPath) ??
    valueAsString(sourceMetadata.sourceRepoPath) ??
    valueAsString(sourceMetadata.workspacePath);
  const repoPath = normalizeCompileRepoPath(repoPathCandidate) ?? undefined;
  const repoKey = valueAsString(explicit.repoKey) ?? valueAsString(sourceMetadata.repoKey);
  const technologies = uniqueLowerSlugs(explicit.technologies);
  const changeTypes = uniqueLowerSlugs(explicit.changeTypes);
  const domains = uniqueLowerSlugs(explicit.domains);
  const general = explicit.general === true;

  return {
    metadata: {
      ...sourceMetadata,
      sourceUri,
      ...(repoPath ? { repoPath } : {}),
      ...(repoKey ? { repoKey } : {}),
    },
    appliesTo: {
      ...(repoPath ? { repoPath } : {}),
      ...(repoKey ? { repoKey } : {}),
      ...(general ? { general: true } : {}),
      ...(technologies.length > 0 ? { technologies } : {}),
      ...(changeTypes.length > 0 ? { changeTypes } : {}),
      ...(domains.length > 0 ? { domains } : {}),
    },
  };
}

export function resolveKnowledgeSearchIdentity(
  options: KnowledgeSearchOptions,
): ResolvedCompileProjectIdentity {
  if (options.projectIdentity) return options.projectIdentity;
  return resolveCompileProjectIdentity({
    projectRef: options.projectRef,
    repoKey: options.repoKey,
    repoPath: options.repoPath,
  });
}

export function buildRepoScopedCondition(options: KnowledgeSearchOptions): SQL {
  const identity = resolveKnowledgeSearchIdentity(options);
  const global = and(
    eq(knowledgeItems.scope, "global"),
    isNull(knowledgeItems.projectRef),
    isNull(knowledgeItems.repoKey),
    isNull(knowledgeItems.repoPath),
  ) as SQL;
  const matchValue = identity.matchValue;
  const repo =
    matchValue === null
      ? undefined
      : identity.matchBasis === "project_ref"
        ? and(eq(knowledgeItems.scope, "repo"), eq(knowledgeItems.projectRef, matchValue))
        : identity.matchBasis === "repo_key"
          ? and(eq(knowledgeItems.scope, "repo"), eq(knowledgeItems.repoKey, matchValue))
          : identity.matchBasis === "repo_path"
            ? and(eq(knowledgeItems.scope, "repo"), eq(knowledgeItems.repoPath, matchValue))
            : undefined;
  return and(
    eq(knowledgeItems.classificationStatus, "classified"),
    repo ? or(global, repo) : global,
  ) as SQL;
}

export function fallbackSourceRefsFromMetadata(metadata: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const sourceDocumentUri =
    typeof metadata.sourceDocumentUri === "string" ? metadata.sourceDocumentUri : undefined;
  const sourceUri = typeof metadata.sourceUri === "string" ? metadata.sourceUri : undefined;
  const locator =
    typeof metadata.sourceFragmentLocator === "string" && metadata.sourceFragmentLocator.trim()
      ? metadata.sourceFragmentLocator.trim()
      : "full";

  const source = sourceDocumentUri ?? sourceUri;
  if (source) refs.add(`${source}#${locator}`);
  return [...refs];
}

export function resolveKnowledgeActor(sourceUri: string): "agent" | "system" {
  return sourceUri.startsWith("agent://") ? "agent" : "system";
}
