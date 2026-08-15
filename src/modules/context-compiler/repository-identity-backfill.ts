import { createHash } from "node:crypto";
import {
  type CompileProjectIdentityAlias,
  CompileProjectIdentityError,
  type CompileProjectIdentityInput,
  normalizeCompileProjectRef,
  normalizeCompileRepoKey,
  normalizeCompileRepoPath,
  resolveCompileProjectIdentity,
} from "./compile-project-identity.js";

export const REPOSITORY_IDENTITY_BACKFILL_VERSION = "repository-identity-v1" as const;

export type RepositoryIdentityEntityKind = "knowledge" | "source" | "episode";
export type RepositoryIdentityClassification =
  | "classified"
  | "unresolved"
  | "conflict"
  | "malformed";

export type RepositoryIdentityProvenance = {
  source: string;
  snapshot: unknown;
};

export type RepositoryIdentityBackfillRow = {
  id: string;
  entityKind: RepositoryIdentityEntityKind;
  classificationStatus: string | null;
  scope: string | null;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  metadata: unknown;
  provenance?: readonly RepositoryIdentityProvenance[];
  explicitGlobalPromotion?: boolean;
  explicitGlobalPromotionReview?: {
    reviewer: string;
    reason: string;
    reviewedAt: string;
  };
};

export type RepositoryIdentityBackfillAfter = {
  classificationStatus: RepositoryIdentityClassification;
  scope: "repo" | "global";
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
};

export type RepositoryIdentityBackfillDecision = {
  entityKind: RepositoryIdentityEntityKind;
  entityId: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  reasonCode: string;
  provenanceSource: string;
  outcome: "backfilled" | "unresolved" | "conflict" | "malformed" | "global_promoted";
  changed: boolean;
  after: RepositoryIdentityBackfillAfter;
  review?: {
    reviewer: string;
    reason: string;
    reviewedAt: string;
  };
};

export type RepositoryIdentityBackfillPlan = {
  migrationVersion: typeof REPOSITORY_IDENTITY_BACKFILL_VERSION;
  checksum: string;
  decisions: RepositoryIdentityBackfillDecision[];
  counts: Record<RepositoryIdentityBackfillDecision["outcome"] | "unchanged", number>;
};

type Evidence = {
  source: string;
  input: CompileProjectIdentityInput;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseMetadata(value: unknown): { value: Record<string, unknown>; malformed: boolean } {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      const parsedRecord = record(parsed);
      return parsedRecord
        ? { value: parsedRecord, malformed: false }
        : { value: {}, malformed: true };
    } catch {
      return { value: {}, malformed: true };
    }
  }
  const parsedRecord = record(value);
  if (value !== null && value !== undefined && !parsedRecord) return { value: {}, malformed: true };
  return { value: parsedRecord ?? {}, malformed: false };
}

function identityInputFromRecord(value: unknown): CompileProjectIdentityInput | null {
  const source = record(value);
  if (!source) return null;
  if (source.classificationStatus !== undefined && source.classificationStatus !== "classified") {
    return null;
  }
  const projectRef = optionalString(source.projectRef);
  const repoKey = optionalString(source.repoKey);
  const repoPath = optionalString(source.repoPath);
  if (!projectRef && !repoKey && !repoPath) return null;
  return { projectRef, repoKey, repoPath };
}

function metadataEvidence(metadata: Record<string, unknown>): Evidence[] {
  const evidence: Evidence[] = [];
  const direct = identityInputFromRecord(metadata);
  if (direct) evidence.push({ source: "canonical_metadata", input: direct });

  for (const [key, source] of [
    ["projectIdentity", "canonical_metadata.project_identity"],
    ["repositoryIdentity", "canonical_metadata.repository_identity"],
    ["compileProjectIdentity", "compile_run_identity"],
    ["sourceCaptureIdentity", "source_capture_identity"],
  ] as const) {
    const input = identityInputFromRecord(metadata[key]);
    if (input) evidence.push({ source, input });
  }

  const capture = record(metadata.capture) ?? record(metadata.sourceCapture);
  const captureInput = identityInputFromRecord(capture?.projectIdentity ?? capture);
  if (captureInput) evidence.push({ source: "source_capture_identity", input: captureInput });

  return evidence;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalState(row: RepositoryIdentityBackfillRow): RepositoryIdentityBackfillAfter {
  return {
    classificationStatus:
      row.classificationStatus === "classified" ||
      row.classificationStatus === "conflict" ||
      row.classificationStatus === "malformed"
        ? row.classificationStatus
        : "unresolved",
    scope: row.scope === "global" ? "global" : "repo",
    projectRef: row.projectRef ?? null,
    repoKey: row.repoKey ?? null,
    repoPath: row.repoPath ?? null,
  };
}

function stateFingerprint(state: RepositoryIdentityBackfillAfter): string {
  return fingerprint([
    state.classificationStatus,
    state.scope,
    state.projectRef,
    state.repoKey,
    state.repoPath,
  ]);
}

function sameState(
  left: RepositoryIdentityBackfillAfter,
  right: RepositoryIdentityBackfillAfter,
): boolean {
  return stateFingerprint(left) === stateFingerprint(right);
}

function aliasProjectRef(
  input: CompileProjectIdentityInput,
  aliases: readonly CompileProjectIdentityAlias[],
): string | undefined {
  const matches = new Set<string>();
  const repoKey = input.repoKey ? normalizeCompileRepoKey(input.repoKey) : null;
  const repoPath = input.repoPath ? normalizeCompileRepoPath(input.repoPath) : null;
  for (const alias of aliases) {
    if (
      (alias.aliasKind === "repo_key" && alias.normalizedValue === repoKey) ||
      (alias.aliasKind === "repo_path" && alias.normalizedValue === repoPath)
    ) {
      matches.add(alias.projectRef);
    }
  }
  if (matches.size > 1) {
    throw new CompileProjectIdentityError(
      "IDENTITY_CONFLICT",
      "authoritative aliases resolve one identity to multiple projects",
    );
  }
  return [...matches][0];
}

function normalizeEvidence(
  evidence: Evidence,
  aliases: readonly CompileProjectIdentityAlias[],
): Evidence {
  const aliasedProjectRef = aliasProjectRef(evidence.input, aliases);
  const projectRef = normalizeCompileProjectRef(evidence.input.projectRef);
  if (projectRef && aliasedProjectRef && projectRef !== aliasedProjectRef) {
    throw new CompileProjectIdentityError(
      "IDENTITY_CONFLICT",
      "projectRef conflicts with an authoritative alias",
    );
  }
  const input = {
    projectRef: projectRef ?? aliasedProjectRef,
    repoKey: normalizeCompileRepoKey(evidence.input.repoKey) ?? undefined,
    repoPath: normalizeCompileRepoPath(evidence.input.repoPath) ?? undefined,
  };
  const resolved = resolveCompileProjectIdentity(input, {
    trust: "trusted_adapter",
    ...(aliases.length > 0 ? { aliases } : {}),
  });
  return {
    source: evidence.source,
    input: {
      projectRef: resolved.projectRef ?? undefined,
      repoKey: resolved.repoKey ?? undefined,
      repoPath: resolved.repoPath ?? undefined,
    },
  };
}

function mergeEvidence(evidence: Evidence[]): Evidence {
  const merged: CompileProjectIdentityInput = {};
  const sources = new Set<string>();
  for (const entry of evidence) {
    sources.add(entry.source);
    for (const key of ["projectRef", "repoKey", "repoPath"] as const) {
      const value = entry.input[key];
      if (!value) continue;
      if (merged[key] && merged[key] !== value) {
        throw new CompileProjectIdentityError(
          "IDENTITY_CONFLICT",
          `provenance contains conflicting ${key} values`,
        );
      }
      merged[key] = value;
    }
  }
  return { source: [...sources].sort().join("+"), input: merged };
}

function decision(
  row: RepositoryIdentityBackfillRow,
  before: RepositoryIdentityBackfillAfter,
  after: RepositoryIdentityBackfillAfter,
  details: Pick<RepositoryIdentityBackfillDecision, "reasonCode" | "provenanceSource" | "outcome">,
): RepositoryIdentityBackfillDecision {
  return {
    entityKind: row.entityKind,
    entityId: row.id,
    beforeFingerprint: stateFingerprint(before),
    afterFingerprint: stateFingerprint(after),
    ...details,
    changed: !sameState(before, after),
    after,
  };
}

function planRow(
  row: RepositoryIdentityBackfillRow,
  aliases: readonly CompileProjectIdentityAlias[],
): RepositoryIdentityBackfillDecision {
  const before = canonicalState(row);
  if (row.explicitGlobalPromotion) {
    const reviewed = decision(
      row,
      before,
      {
        classificationStatus: "classified",
        scope: "global",
        projectRef: null,
        repoKey: null,
        repoPath: null,
      },
      {
        reasonCode: "explicit_user_reviewed_global_promotion",
        provenanceSource: "user_reviewed_global_promotion",
        outcome: "global_promoted",
      },
    );
    if (row.explicitGlobalPromotionReview) {
      reviewed.review = row.explicitGlobalPromotionReview;
    }
    return reviewed;
  }

  if (before.classificationStatus === "classified" && before.scope === "global") {
    const hasIdentity = Boolean(before.projectRef || before.repoKey || before.repoPath);
    return decision(
      row,
      before,
      hasIdentity ? { ...before, classificationStatus: "conflict" } : before,
      {
        reasonCode: hasIdentity ? "global_identity_conflict" : "already_classified_global",
        provenanceSource: "canonical_columns",
        outcome: hasIdentity ? "conflict" : "backfilled",
      },
    );
  }

  const parsedMetadata = parseMetadata(row.metadata);
  if (parsedMetadata.malformed && before.classificationStatus !== "classified") {
    return decision(
      row,
      before,
      { ...before, classificationStatus: "malformed", scope: "repo" },
      {
        reasonCode: "metadata_not_object_or_invalid_json",
        provenanceSource: "metadata",
        outcome: "malformed",
      },
    );
  }

  const evidence: Evidence[] = [];
  if (before.projectRef || before.repoKey || before.repoPath) {
    evidence.push({
      source: "canonical_columns",
      input: {
        projectRef: before.projectRef ?? undefined,
        repoKey: before.repoKey ?? undefined,
        repoPath: before.repoPath ?? undefined,
      },
    });
  }
  evidence.push(...metadataEvidence(parsedMetadata.value));
  for (const provenance of row.provenance ?? []) {
    const parsed = parseMetadata(provenance.snapshot);
    if (parsed.malformed) {
      return decision(
        row,
        before,
        { ...before, classificationStatus: "malformed", scope: "repo" },
        {
          reasonCode: "provenance_snapshot_malformed",
          provenanceSource: provenance.source,
          outcome: "malformed",
        },
      );
    }
    const direct = identityInputFromRecord(parsed.value);
    if (direct) evidence.push({ source: provenance.source, input: direct });
    evidence.push(
      ...metadataEvidence(parsed.value).map((item) => ({
        source: `${provenance.source}.${item.source}`,
        input: item.input,
      })),
    );
  }

  if (evidence.length === 0) {
    return decision(
      row,
      before,
      {
        classificationStatus: "unresolved",
        scope: "repo",
        projectRef: null,
        repoKey: null,
        repoPath: null,
      },
      {
        reasonCode: "no_authoritative_identity_provenance",
        provenanceSource: "none",
        outcome: "unresolved",
      },
    );
  }

  try {
    const normalized = evidence.map((entry) => normalizeEvidence(entry, aliases));
    const merged = mergeEvidence(normalized);
    const resolved = resolveCompileProjectIdentity(merged.input, {
      trust: "trusted_adapter",
      ...(aliases.length > 0 ? { aliases } : {}),
    });
    if (resolved.matchBasis === "none") throw new Error("identity unexpectedly resolved empty");
    return decision(
      row,
      before,
      {
        classificationStatus: "classified",
        scope: "repo",
        projectRef: resolved.projectRef,
        repoKey: resolved.repoKey,
        repoPath: resolved.repoPath,
      },
      {
        reasonCode: "authoritative_identity_exact_match",
        provenanceSource: merged.source,
        outcome: "backfilled",
      },
    );
  } catch (error) {
    const conflict =
      error instanceof CompileProjectIdentityError && error.code === "IDENTITY_CONFLICT";
    return decision(
      row,
      before,
      { ...before, classificationStatus: conflict ? "conflict" : "malformed", scope: "repo" },
      {
        reasonCode:
          error instanceof CompileProjectIdentityError
            ? error.code.toLowerCase()
            : "identity_invalid",
        provenanceSource: [...new Set(evidence.map((entry) => entry.source))].sort().join("+"),
        outcome: conflict ? "conflict" : "malformed",
      },
    );
  }
}

export function planRepositoryIdentityBackfill(input: {
  rows: readonly RepositoryIdentityBackfillRow[];
  aliases?: readonly CompileProjectIdentityAlias[];
}): RepositoryIdentityBackfillPlan {
  const aliases = [...(input.aliases ?? [])].sort((left, right) =>
    `${left.projectRef}\0${left.aliasKind}\0${left.normalizedValue}`.localeCompare(
      `${right.projectRef}\0${right.aliasKind}\0${right.normalizedValue}`,
    ),
  );
  const decisions = [...input.rows]
    .sort((left, right) =>
      `${left.entityKind}\0${left.id}`.localeCompare(`${right.entityKind}\0${right.id}`),
    )
    .map((row) => planRow(row, aliases));
  const counts: RepositoryIdentityBackfillPlan["counts"] = {
    backfilled: 0,
    unresolved: 0,
    conflict: 0,
    malformed: 0,
    global_promoted: 0,
    unchanged: 0,
  };
  for (const item of decisions) {
    counts[item.changed ? item.outcome : "unchanged"] += 1;
  }
  const checksum = fingerprint(
    decisions.map((item) => [
      item.entityKind,
      item.entityId,
      item.beforeFingerprint,
      item.afterFingerprint,
      item.reasonCode,
      item.provenanceSource,
      item.outcome,
      item.changed,
    ]),
  );
  return {
    migrationVersion: REPOSITORY_IDENTITY_BACKFILL_VERSION,
    checksum,
    decisions,
    counts,
  };
}
