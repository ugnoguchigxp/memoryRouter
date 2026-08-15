import { asRecord } from "../../shared/utils/normalize.js";
import { normalizeCompileRepoPath } from "../context-compiler/compile-project-identity.js";
import { type KnowledgeTagKind, listKnowledgeTagDefinitions } from "./knowledge-tags.repository.js";

export type KnowledgeApplicabilityInput = {
  general?: boolean;
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
  repoPath?: string;
  repoKey?: string;
};

export type KnowledgeApplicabilityUnknownTag = {
  kind: KnowledgeTagKind;
  value: string;
  normalizedSlug: string;
  reason: string;
};

export type NormalizedKnowledgeApplicability = {
  appliesTo: Record<string, unknown>;
  warnings: string[];
  unknownTagCandidates: KnowledgeApplicabilityUnknownTag[];
};

type ApplicabilityFacetKind = Extract<KnowledgeTagKind, "technology" | "change_type" | "domain">;

const FACET_TO_KIND = {
  technologies: "technology",
  changeTypes: "change_type",
  domains: "domain",
} satisfies Record<"technologies" | "changeTypes" | "domains", ApplicabilityFacetKind>;

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return undefined;
}

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9./-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return [];
}

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mergeFacetArrays(primary: unknown, fallback: unknown): string[] {
  return dedupe([...toStringArray(primary), ...toStringArray(fallback)]);
}

function buildDefinitionMaps(definitions: Awaited<ReturnType<typeof listKnowledgeTagDefinitions>>) {
  const slugsByKind = new Map<KnowledgeTagKind, Set<string>>();
  const aliasesByKind = new Map<KnowledgeTagKind, Map<string, string>>();

  for (const definition of definitions) {
    const slugSet = slugsByKind.get(definition.kind) ?? new Set<string>();
    slugSet.add(toSlug(definition.slug));
    slugsByKind.set(definition.kind, slugSet);

    const aliasMap = aliasesByKind.get(definition.kind) ?? new Map<string, string>();
    for (const alias of definition.aliases) {
      aliasMap.set(toSlug(alias), toSlug(definition.slug));
    }
    aliasMap.set(toSlug(definition.slug), toSlug(definition.slug));
    aliasesByKind.set(definition.kind, aliasMap);
  }

  return { slugsByKind, aliasesByKind };
}

function normalizeFacetValues(params: {
  kind: ApplicabilityFacetKind;
  values: string[];
  slugsByKind: Map<KnowledgeTagKind, Set<string>>;
  aliasesByKind: Map<KnowledgeTagKind, Map<string, string>>;
  warnings: string[];
  unknownTagCandidates: KnowledgeApplicabilityUnknownTag[];
}): string[] {
  const slugSet = params.slugsByKind.get(params.kind) ?? new Set<string>();
  const aliasMap = params.aliasesByKind.get(params.kind) ?? new Map<string, string>();
  const resolved: string[] = [];

  for (const rawValue of params.values) {
    const normalized = toSlug(rawValue);
    if (!normalized) continue;
    const aliased = aliasMap.get(normalized) ?? normalized;
    if (slugSet.has(aliased)) {
      resolved.push(aliased);
      if (aliased !== normalized) {
        params.warnings.push(`normalized ${params.kind} tag: ${rawValue} -> ${aliased}`);
      }
      continue;
    }
    params.unknownTagCandidates.push({
      kind: params.kind,
      value: rawValue,
      normalizedSlug: aliased,
      reason: "no matching active tag definition",
    });
    params.warnings.push(`unknown ${params.kind} tag: ${rawValue}`);
    // Keep unknown facets in appliesTo to avoid destructive data loss on edit/update.
    resolved.push(aliased);
  }

  return dedupe(resolved);
}

export function mergeApplicabilityInput(params: {
  appliesTo?: unknown;
  general?: unknown;
  technologies?: unknown;
  changeTypes?: unknown;
  domains?: unknown;
  repoPath?: unknown;
  repoKey?: unknown;
}): KnowledgeApplicabilityInput {
  const appliesTo = asRecord(params.appliesTo);
  return {
    general: asBoolean(params.general ?? appliesTo.general),
    technologies: mergeFacetArrays(params.technologies, appliesTo.technologies),
    changeTypes: mergeFacetArrays(params.changeTypes, appliesTo.changeTypes),
    domains: mergeFacetArrays(params.domains, appliesTo.domains),
    repoPath: pickString(params.repoPath ?? appliesTo.repoPath),
    repoKey: pickString(params.repoKey ?? appliesTo.repoKey),
  };
}

export async function normalizeKnowledgeApplicability(
  input: KnowledgeApplicabilityInput,
): Promise<NormalizedKnowledgeApplicability> {
  const warnings: string[] = [];
  const unknownTagCandidates: KnowledgeApplicabilityUnknownTag[] = [];

  let definitions: Awaited<ReturnType<typeof listKnowledgeTagDefinitions>> = [];
  try {
    definitions = await listKnowledgeTagDefinitions({
      statuses: ["active"],
    });
  } catch {
    warnings.push("knowledge tag definitions unavailable; applying best-effort normalization");
  }
  const { slugsByKind, aliasesByKind } = buildDefinitionMaps(definitions);

  const technologies = normalizeFacetValues({
    kind: FACET_TO_KIND.technologies,
    values: input.technologies ?? [],
    slugsByKind,
    aliasesByKind,
    warnings,
    unknownTagCandidates,
  });
  const changeTypes = normalizeFacetValues({
    kind: FACET_TO_KIND.changeTypes,
    values: input.changeTypes ?? [],
    slugsByKind,
    aliasesByKind,
    warnings,
    unknownTagCandidates,
  });
  const domains = normalizeFacetValues({
    kind: FACET_TO_KIND.domains,
    values: input.domains ?? [],
    slugsByKind,
    aliasesByKind,
    warnings,
    unknownTagCandidates,
  });
  const repoPath = normalizeCompileRepoPath(input.repoPath) ?? undefined;
  const repoKey = input.repoKey?.trim().toLowerCase();
  const general = Boolean(input.general);

  const appliesTo: Record<string, unknown> = {
    ...(repoPath ? { repoPath } : {}),
    ...(repoKey ? { repoKey } : {}),
    ...(general ? { general: true } : {}),
    ...(technologies.length > 0 ? { technologies } : {}),
    ...(changeTypes.length > 0 ? { changeTypes } : {}),
    ...(domains.length > 0 ? { domains } : {}),
  };

  return {
    appliesTo,
    warnings: dedupe(warnings),
    unknownTagCandidates,
  };
}

export function parseApplicabilityFromRecord(value: unknown): KnowledgeApplicabilityInput {
  const record = asRecord(value);
  return {
    general: asBoolean(record.general),
    technologies: toStringArray(record.technologies),
    changeTypes: toStringArray(record.changeTypes),
    domains: toStringArray(record.domains),
    repoPath: pickString(record.repoPath),
    repoKey: pickString(record.repoKey),
  };
}
