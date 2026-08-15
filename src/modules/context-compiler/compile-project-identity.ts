import { createHash } from "node:crypto";

export const COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION = 1 as const;

export type CompileProjectIdentityInput = {
  projectRef?: string;
  repoKey?: string;
  repoPath?: string;
};

export type CompileProjectIdentityTrust = "request_hint" | "trusted_adapter";
export type CompileProjectIdentityMatchBasis = "project_ref" | "repo_key" | "repo_path" | "none";
export type CompileProjectIdentityBindingStatus = "verified" | "not_applicable" | "unverified";

export type ResolvedCompileProjectIdentity = {
  contractVersion: typeof COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION;
  scopeMode: "global_only" | "project";
  matchBasis: CompileProjectIdentityMatchBasis;
  matchValue: string | null;
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  identityFingerprint: string | null;
  trust: CompileProjectIdentityTrust;
  bindingStatus: CompileProjectIdentityBindingStatus;
};

export type CompileProjectIdentityAlias = {
  projectRef: string;
  aliasKind: "repo_key" | "repo_path";
  normalizedValue: string;
};

export type CompileProjectIdentityErrorCode =
  | "INVALID_PROJECT_REF"
  | "INVALID_REPO_KEY"
  | "INVALID_REPO_PATH"
  | "IDENTITY_CONFLICT";

export class CompileProjectIdentityError extends Error {
  readonly code: CompileProjectIdentityErrorCode;

  constructor(code: CompileProjectIdentityErrorCode, message: string) {
    super(message);
    this.name = "CompileProjectIdentityError";
    this.code = code;
  }
}

const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const WINDOWS_FILE_URI_PATH_PATTERN = /^\/[A-Za-z]:\//u;

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function exceedsCodePointLimit(value: string, maximum: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) return true;
  }
  return false;
}

function requireValidText(
  raw: string | undefined,
  options: { code: CompileProjectIdentityErrorCode; label: string; maxLength: number },
): string | null {
  if (raw === undefined) return null;
  if (containsControlCharacters(raw)) {
    throw new CompileProjectIdentityError(
      options.code,
      `${options.label} contains control characters`,
    );
  }
  const value = raw.trim();
  if (!value || exceedsCodePointLimit(value, options.maxLength)) {
    throw new CompileProjectIdentityError(
      options.code,
      `${options.label} must contain 1-${options.maxLength} characters`,
    );
  }
  return value;
}

function normalizeAbsoluteSegments(value: string, windowsDrive: boolean): string {
  const slashNormalized = value.replace(/\\/gu, "/");
  const prefix = windowsDrive ? slashNormalized.slice(0, 2) : "";
  const remainder = windowsDrive ? slashNormalized.slice(2) : slashNormalized;
  const segments: string[] = [];
  for (const segment of remainder.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (windowsDrive) {
    return segments.length > 0 ? `${prefix}/${segments.join("/")}` : `${prefix}/`;
  }
  return segments.length > 0 ? `/${segments.join("/")}` : "/";
}

export function normalizeCompileProjectRef(projectRef?: string): string | null {
  return requireValidText(projectRef, {
    code: "INVALID_PROJECT_REF",
    label: "projectRef",
    maxLength: 256,
  });
}

export function normalizeCompileRepoKey(repoKey?: string): string | null {
  const value = requireValidText(repoKey, {
    code: "INVALID_REPO_KEY",
    label: "repoKey",
    maxLength: 1024,
  });
  if (value === null) return null;
  return value
    .replace(/\\/gu, "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

export function normalizeCompileRepoPath(repoPath?: string): string | null {
  const value = requireValidText(repoPath, {
    code: "INVALID_REPO_PATH",
    label: "repoPath",
    maxLength: 4096,
  });
  if (value === null) return null;

  let pathValue = value;
  if (/^file:\/\//iu.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new CompileProjectIdentityError(
        "INVALID_REPO_PATH",
        "repoPath is not a valid file URI",
      );
    }
    if (
      url.protocol !== "file:" ||
      url.username ||
      url.password ||
      (url.hostname && url.hostname.toLowerCase() !== "localhost") ||
      url.search ||
      url.hash
    ) {
      throw new CompileProjectIdentityError(
        "INVALID_REPO_PATH",
        "repoPath file URI must be local, absolute, and omit query/hash",
      );
    }
    try {
      pathValue = decodeURIComponent(url.pathname);
    } catch {
      throw new CompileProjectIdentityError(
        "INVALID_REPO_PATH",
        "repoPath file URI contains malformed percent encoding",
      );
    }
    if (WINDOWS_FILE_URI_PATH_PATTERN.test(pathValue)) pathValue = pathValue.slice(1);
  } else if (
    !WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(value) &&
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    throw new CompileProjectIdentityError(
      "INVALID_REPO_PATH",
      "repoPath URI must use the file scheme",
    );
  }

  if (containsControlCharacters(pathValue)) {
    throw new CompileProjectIdentityError(
      "INVALID_REPO_PATH",
      "repoPath contains control characters",
    );
  }
  if (WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(pathValue)) {
    return normalizeAbsoluteSegments(pathValue, true);
  }
  if (pathValue.startsWith("/")) {
    return normalizeAbsoluteSegments(pathValue, false);
  }
  throw new CompileProjectIdentityError("INVALID_REPO_PATH", "repoPath must be absolute");
}

function fingerprint(basis: CompileProjectIdentityMatchBasis, value: string | null): string | null {
  if (basis === "none" || value === null) return null;
  return createHash("sha256")
    .update(`${COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION}\0${basis}\0${value}`)
    .digest("hex");
}

function resolveBindingStatus(input: {
  projectRef: string | null;
  repoKey: string | null;
  repoPath: string | null;
  aliases: readonly CompileProjectIdentityAlias[] | undefined;
}): CompileProjectIdentityBindingStatus {
  const identifiers = [input.projectRef, input.repoKey, input.repoPath].filter(
    (value): value is string => value !== null,
  );
  if (identifiers.length <= 1) return "not_applicable";
  if (!input.aliases) return "unverified";

  const candidateProjectRefs = new Set<string>();
  if (input.projectRef) candidateProjectRefs.add(input.projectRef);
  for (const alias of input.aliases) {
    if (
      (alias.aliasKind === "repo_key" && alias.normalizedValue === input.repoKey) ||
      (alias.aliasKind === "repo_path" && alias.normalizedValue === input.repoPath)
    ) {
      candidateProjectRefs.add(alias.projectRef);
    }
  }
  if (candidateProjectRefs.size !== 1) {
    throw new CompileProjectIdentityError(
      "IDENTITY_CONFLICT",
      "compile project identity aliases do not resolve to one project",
    );
  }
  const [resolvedProjectRef] = candidateProjectRefs;
  const expectedAliases = [
    ...(input.repoKey ? [{ aliasKind: "repo_key" as const, value: input.repoKey }] : []),
    ...(input.repoPath ? [{ aliasKind: "repo_path" as const, value: input.repoPath }] : []),
  ];
  const allAliasesPresent = expectedAliases.every((expected) =>
    input.aliases?.some(
      (alias) =>
        alias.projectRef === resolvedProjectRef &&
        alias.aliasKind === expected.aliasKind &&
        alias.normalizedValue === expected.value,
    ),
  );
  if (!allAliasesPresent) {
    throw new CompileProjectIdentityError(
      "IDENTITY_CONFLICT",
      "compile project identity contains an unbound alias",
    );
  }
  return "verified";
}

export function resolveCompileProjectIdentity(
  input: CompileProjectIdentityInput,
  options?: {
    trust?: CompileProjectIdentityTrust;
    aliases?: readonly CompileProjectIdentityAlias[];
  },
): ResolvedCompileProjectIdentity {
  const projectRef = normalizeCompileProjectRef(input.projectRef);
  const repoKey = normalizeCompileRepoKey(input.repoKey);
  const repoPath = normalizeCompileRepoPath(input.repoPath);
  const bindingStatus = resolveBindingStatus({
    projectRef,
    repoKey,
    repoPath,
    aliases: options?.aliases,
  });

  const matchBasis: CompileProjectIdentityMatchBasis = projectRef
    ? "project_ref"
    : repoKey
      ? "repo_key"
      : repoPath
        ? "repo_path"
        : "none";
  const matchValue = projectRef ?? repoKey ?? repoPath;

  return {
    contractVersion: COMPILE_PROJECT_IDENTITY_CONTRACT_VERSION,
    scopeMode: matchBasis === "none" ? "global_only" : "project",
    matchBasis,
    matchValue,
    projectRef,
    repoKey,
    repoPath,
    identityFingerprint: fingerprint(matchBasis, matchValue),
    trust: options?.trust ?? "request_hint",
    bindingStatus,
  };
}
