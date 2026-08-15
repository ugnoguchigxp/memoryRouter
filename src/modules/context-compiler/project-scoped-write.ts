import type { AuditActor } from "../audit/audit-log.service.js";
import { auditEventTypes, recordAuditLogSafe } from "../audit/audit-log.service.js";
import {
  COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION,
  CompileProjectIdentityError,
  type CompileProjectIdentityInput,
  type CompileProjectIdentityMatchBasis,
  type CompileProjectIdentityTrust,
  type ResolvedCompileProjectIdentity,
  resolveCompileProjectIdentity,
} from "./compile-project-identity.js";

export const PROJECT_IDENTITY_REQUIRED = "PROJECT_IDENTITY_REQUIRED" as const;
export const PROJECT_IDENTITY_FORBIDDEN = "PROJECT_IDENTITY_FORBIDDEN" as const;
export const PROJECT_IDENTITY_SNAPSHOT_INVALID = "PROJECT_IDENTITY_SNAPSHOT_INVALID" as const;

export type ProjectScopedWriteErrorCode =
  | typeof PROJECT_IDENTITY_REQUIRED
  | typeof PROJECT_IDENTITY_FORBIDDEN
  | typeof PROJECT_IDENTITY_SNAPSHOT_INVALID
  | "INVALID_PROJECT_REF"
  | "INVALID_REPO_KEY"
  | "INVALID_REPO_PATH"
  | "IDENTITY_CONFLICT";

export class ProjectScopedWriteError extends Error {
  readonly code: ProjectScopedWriteErrorCode;

  constructor(code: ProjectScopedWriteErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProjectScopedWriteError";
    this.code = code;
  }
}

export type ProjectScopedWriteIdentityInput = {
  scope: "repo" | "global";
  projectRef?: string | null;
  repoKey?: string | null;
  repoPath?: string | null;
  trust?: CompileProjectIdentityTrust;
};

export type ResolvedProjectScopedWriteIdentity = {
  contractVersion: typeof COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION;
  classificationStatus: "classified";
  scope: "repo" | "global";
  scopeMode: "project" | "global_only";
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  matchBasis: CompileProjectIdentityMatchBasis;
  identityFingerprint: string | null;
  bindingStatus: "verified" | "not_applicable" | "unverified";
};

export type ProjectScopedWriteAuditContext = {
  producer: string;
  entityKind: "knowledge" | "source" | "episode" | "candidate" | "vibe_memory";
  actor?: AuditActor;
};

export type ProjectScopedWritePersistenceContext = ProjectScopedWriteAuditContext & {
  entityId?: string;
};

function present(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function asIdentityInput(input: ProjectScopedWriteIdentityInput): CompileProjectIdentityInput {
  return {
    ...(present(input.projectRef) ? { projectRef: input.projectRef as string } : {}),
    ...(present(input.repoKey) ? { repoKey: input.repoKey as string } : {}),
    ...(present(input.repoPath) ? { repoPath: input.repoPath as string } : {}),
  };
}

export function resolveProjectScopedWriteIdentity(
  input: ProjectScopedWriteIdentityInput,
): ResolvedProjectScopedWriteIdentity {
  let resolved: ResolvedCompileProjectIdentity;
  try {
    resolved = resolveCompileProjectIdentity(asIdentityInput(input), {
      trust: input.trust ?? "trusted_adapter",
    });
  } catch (error) {
    if (error instanceof CompileProjectIdentityError) {
      throw new ProjectScopedWriteError(error.code, error.message);
    }
    throw error;
  }

  if (input.scope === "global") {
    if (resolved.matchBasis !== "none") {
      throw new ProjectScopedWriteError(
        PROJECT_IDENTITY_FORBIDDEN,
        "global writes must not carry project identity",
      );
    }
    return {
      contractVersion: COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION,
      classificationStatus: "classified",
      scope: "global",
      scopeMode: "global_only",
      projectRef: null,
      repoKey: null,
      repoPath: null,
      matchBasis: "none",
      identityFingerprint: null,
      bindingStatus: "not_applicable",
    };
  }

  if (resolved.matchBasis === "none") {
    throw new ProjectScopedWriteError(
      PROJECT_IDENTITY_REQUIRED,
      "repo-scoped writes require projectRef, repoKey, or an absolute repoPath",
    );
  }

  return {
    contractVersion: COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION,
    classificationStatus: "classified",
    scope: "repo",
    scopeMode: "project",
    projectRef: resolved.projectRef,
    repoKey: resolved.repoKey,
    repoPath: resolved.repoPath,
    matchBasis: resolved.matchBasis,
    identityFingerprint: resolved.identityFingerprint,
    bindingStatus: resolved.bindingStatus,
  };
}

function rejectionCode(error: unknown): string {
  if (error instanceof ProjectScopedWriteError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "UNKNOWN";
}

export async function resolveAuditedProjectScopedWriteIdentity(
  input: ProjectScopedWriteIdentityInput,
  context: ProjectScopedWriteAuditContext,
): Promise<ResolvedProjectScopedWriteIdentity> {
  try {
    const identity = resolveProjectScopedWriteIdentity(input);
    await recordAuditLogSafe({
      eventType: auditEventTypes.projectIdentityProducerValidated,
      actor: context.actor ?? "system",
      payload: {
        producer: context.producer,
        entityKind: context.entityKind,
        scope: identity.scope,
        matchBasis: identity.matchBasis,
        identityFingerprint: identity.identityFingerprint,
        bindingStatus: identity.bindingStatus,
      },
    });
    return identity;
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.projectIdentityProducerRejected,
      actor: context.actor ?? "system",
      payload: {
        producer: context.producer,
        entityKind: context.entityKind,
        scope: input.scope,
        rejectionCode: rejectionCode(error),
      },
    });
    throw error;
  }
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function resolveAuditedStoredProjectScopedWriteIdentity(
  rawSnapshot: unknown,
  context: ProjectScopedWriteAuditContext,
): Promise<ResolvedProjectScopedWriteIdentity> {
  const snapshot = recordFromUnknown(rawSnapshot);
  const scope = snapshot.scope === "global" ? "global" : "repo";
  try {
    if (
      snapshot.contractVersion !== COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION ||
      snapshot.classificationStatus !== "classified" ||
      (snapshot.scope !== "repo" && snapshot.scope !== "global")
    ) {
      throw new ProjectScopedWriteError(
        PROJECT_IDENTITY_SNAPSHOT_INVALID,
        "stored project identity snapshot has an invalid version, classification, or scope",
      );
    }
    const identity = resolveProjectScopedWriteIdentity({
      scope,
      projectRef: typeof snapshot.projectRef === "string" ? snapshot.projectRef : undefined,
      repoKey: typeof snapshot.repoKey === "string" ? snapshot.repoKey : undefined,
      repoPath: typeof snapshot.repoPath === "string" ? snapshot.repoPath : undefined,
    });
    if (
      snapshot.scopeMode !== identity.scopeMode ||
      (snapshot.matchBasis !== undefined && snapshot.matchBasis !== identity.matchBasis) ||
      (snapshot.identityFingerprint !== undefined &&
        snapshot.identityFingerprint !== identity.identityFingerprint) ||
      snapshot.projectRef !== identity.projectRef ||
      snapshot.repoKey !== identity.repoKey ||
      snapshot.repoPath !== identity.repoPath
    ) {
      throw new ProjectScopedWriteError(
        PROJECT_IDENTITY_SNAPSHOT_INVALID,
        "stored project identity snapshot is not canonical",
      );
    }
    await recordAuditLogSafe({
      eventType: auditEventTypes.projectIdentityProducerValidated,
      actor: context.actor ?? "system",
      payload: {
        producer: context.producer,
        entityKind: context.entityKind,
        scope: identity.scope,
        matchBasis: identity.matchBasis,
        identityFingerprint: identity.identityFingerprint,
        bindingStatus: identity.bindingStatus,
      },
    });
    return identity;
  } catch (error) {
    await recordAuditLogSafe({
      eventType: auditEventTypes.projectIdentityProducerRejected,
      actor: context.actor ?? "system",
      payload: {
        producer: context.producer,
        entityKind: context.entityKind,
        scope,
        rejectionCode: rejectionCode(error),
      },
    });
    throw error;
  }
}

export async function recordProjectScopedWritePersisted(
  identity: ResolvedProjectScopedWriteIdentity,
  context: ProjectScopedWritePersistenceContext,
): Promise<void> {
  await recordAuditLogSafe({
    eventType: auditEventTypes.projectIdentityProducerPersisted,
    actor: context.actor ?? "system",
    payload: {
      producer: context.producer,
      entityKind: context.entityKind,
      entityId: context.entityId,
      scope: identity.scope,
      matchBasis: identity.matchBasis,
      identityFingerprint: identity.identityFingerprint,
      bindingStatus: identity.bindingStatus,
    },
  });
}
