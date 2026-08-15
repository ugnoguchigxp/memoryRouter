import type { ResolvedCompileProjectIdentity } from "./compile-project-identity.js";

export const repositoryEntityKindValues = ["knowledge", "source", "episode"] as const;
export type RepositoryEntityKind = (typeof repositoryEntityKindValues)[number];

export const repositoryClassificationValues = [
  "global",
  "repo",
  "unresolved",
  "malformed",
  "conflict",
] as const;
export type RepositoryClassification = (typeof repositoryClassificationValues)[number];

export const repositoryScopeDecisionReasonValues = [
  "ALLOW_GLOBAL",
  "ALLOW_REPOSITORY",
  "STATUS_DENIED",
  "CLASSIFICATION_UNRESOLVED",
  "CLASSIFICATION_MALFORMED",
  "CLASSIFICATION_CONFLICT",
  "SCOPE_MALFORMED",
  "PROJECT_SCOPE_MISSING",
  "PROJECT_IDENTITY_BASIS_MISSING",
  "PROJECT_SCOPE_MISMATCH",
  "FACET_MISMATCH",
] as const;
export type RepositoryScopeDecisionReason = (typeof repositoryScopeDecisionReasonValues)[number];

export type RepositoryFacets = {
  technologies?: string[];
  changeTypes?: string[];
  domains?: string[];
};

export type RepositoryScopeCandidate = {
  id: string;
  entityKind: RepositoryEntityKind;
  status: string | null;
  classificationStatus: string | null;
  scope: string | null;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  general: boolean;
  facets: RepositoryFacets;
  producer: string;
};

export type RepositoryScopeDecision = {
  allowed: boolean;
  reason: RepositoryScopeDecisionReason;
  classification: RepositoryClassification;
  matchBasis: ResolvedCompileProjectIdentity["matchBasis"];
};

export type RepositorySelectionScopeSnapshot = {
  contractVersion: number;
  matchBasis: ResolvedCompileProjectIdentity["matchBasis"];
  scopeMode: ResolvedCompileProjectIdentity["scopeMode"];
  identityFingerprint: string | null;
  candidateClassification: RepositoryClassification;
  candidateScope: "global" | "repo";
  decision: RepositoryScopeDecisionReason;
  allowed: boolean;
};

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

export function repositoryCandidateIdentityBasis(
  candidate: Pick<RepositoryScopeCandidate, "projectRef" | "repoKey" | "repoPath">,
): "project_ref" | "repo_key" | "repo_path" | "none" {
  if (present(candidate.projectRef)) return "project_ref";
  if (present(candidate.repoKey)) return "repo_key";
  if (present(candidate.repoPath)) return "repo_path";
  return "none";
}

export function classifyRepositoryCandidate(
  candidate: Pick<
    RepositoryScopeCandidate,
    "classificationStatus" | "scope" | "projectRef" | "repoKey" | "repoPath"
  >,
): RepositoryClassification {
  if (candidate.classificationStatus === "unresolved") return "unresolved";
  if (candidate.classificationStatus === "malformed") return "malformed";
  if (candidate.classificationStatus === "conflict") return "conflict";
  if (candidate.classificationStatus !== "classified") return "malformed";

  const hasIdentity =
    present(candidate.projectRef) || present(candidate.repoKey) || present(candidate.repoPath);
  if (candidate.scope === "global") return hasIdentity ? "conflict" : "global";
  if (candidate.scope === "repo") return hasIdentity ? "repo" : "unresolved";
  return "malformed";
}

function normalizedFacetSet(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) =>
        value
          .trim()
          .toLocaleLowerCase("en-US")
          .replace(/[\s_]+/g, "-")
          .replace(/[^\p{L}\p{N}./+#-]/gu, "-")
          .replace(/-+/g, "-")
          .replace(/^-+|-+$/g, ""),
      )
      .filter((value) => value.length > 0),
  );
}

export function repositoryFacetAllows(
  candidate: Pick<RepositoryScopeCandidate, "general" | "facets">,
  request: RepositoryFacets,
): boolean {
  const requested = {
    technologies: normalizedFacetSet(request.technologies),
    changeTypes: normalizedFacetSet(request.changeTypes),
    domains: normalizedFacetSet(request.domains),
  };
  if (
    requested.technologies.size === 0 &&
    requested.changeTypes.size === 0 &&
    requested.domains.size === 0
  ) {
    return true;
  }
  if (candidate.general) return true;

  const candidateFacets = {
    technologies: normalizedFacetSet(candidate.facets.technologies),
    changeTypes: normalizedFacetSet(candidate.facets.changeTypes),
    domains: normalizedFacetSet(candidate.facets.domains),
  };
  return (Object.keys(requested) as Array<keyof typeof requested>).some((kind) =>
    [...requested[kind]].some((value) => candidateFacets[kind].has(value)),
  );
}

function candidateIdentityForBasis(
  candidate: Pick<RepositoryScopeCandidate, "projectRef" | "repoKey" | "repoPath">,
  basis: ResolvedCompileProjectIdentity["matchBasis"],
): string | null {
  if (basis === "project_ref") return candidate.projectRef;
  if (basis === "repo_key") return candidate.repoKey;
  if (basis === "repo_path") return candidate.repoPath;
  return null;
}

export function evaluateRepositoryScope(
  candidate: RepositoryScopeCandidate,
  identity: ResolvedCompileProjectIdentity,
  requestFacets: RepositoryFacets = {},
): RepositoryScopeDecision {
  const classification = classifyRepositoryCandidate(candidate);
  const denied = (reason: RepositoryScopeDecisionReason): RepositoryScopeDecision => ({
    allowed: false,
    reason,
    classification,
    matchBasis: identity.matchBasis,
  });

  if (candidate.status !== "active" && candidate.status !== "draft") {
    return denied("STATUS_DENIED");
  }
  if (classification === "unresolved") return denied("CLASSIFICATION_UNRESOLVED");
  if (classification === "malformed") return denied("CLASSIFICATION_MALFORMED");
  if (classification === "conflict") return denied("CLASSIFICATION_CONFLICT");

  if (classification === "global") {
    if (!repositoryFacetAllows(candidate, requestFacets)) return denied("FACET_MISMATCH");
    return {
      allowed: true,
      reason: "ALLOW_GLOBAL",
      classification,
      matchBasis: identity.matchBasis,
    };
  }
  if (classification !== "repo" || candidate.scope !== "repo") {
    return denied("SCOPE_MALFORMED");
  }
  if (identity.matchBasis === "none" || identity.matchValue === null) {
    return denied("PROJECT_SCOPE_MISSING");
  }
  const candidateIdentity = candidateIdentityForBasis(candidate, identity.matchBasis);
  if (!present(candidateIdentity)) return denied("PROJECT_IDENTITY_BASIS_MISSING");
  if (candidateIdentity !== identity.matchValue) return denied("PROJECT_SCOPE_MISMATCH");
  if (!repositoryFacetAllows(candidate, requestFacets)) return denied("FACET_MISMATCH");
  return {
    allowed: true,
    reason: "ALLOW_REPOSITORY",
    classification,
    matchBasis: identity.matchBasis,
  };
}

export function selectRepositoryScopedCandidates(
  candidates: RepositoryScopeCandidate[],
  identity: ResolvedCompileProjectIdentity,
  requestFacets: RepositoryFacets = {},
): RepositoryScopeCandidate[] {
  return candidates.filter(
    (candidate) => evaluateRepositoryScope(candidate, identity, requestFacets).allowed,
  );
}

export function buildRepositorySelectionScopeSnapshot(
  candidate: RepositoryScopeCandidate,
  identity: ResolvedCompileProjectIdentity,
  requestFacets: RepositoryFacets = {},
): RepositorySelectionScopeSnapshot {
  const decision = evaluateRepositoryScope(candidate, identity, requestFacets);
  return {
    contractVersion: identity.contractVersion,
    matchBasis: identity.matchBasis,
    scopeMode: identity.scopeMode,
    identityFingerprint: identity.identityFingerprint,
    candidateClassification: decision.classification,
    candidateScope: candidate.scope === "global" ? "global" : "repo",
    decision: decision.reason,
    allowed: decision.allowed,
  };
}
