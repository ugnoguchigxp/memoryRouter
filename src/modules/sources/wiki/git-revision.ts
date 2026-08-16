export const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{7,64}$/i;
const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function assertGitObjectId(value: string): string {
  const normalized = value.trim();
  if (!GIT_OBJECT_ID_PATTERN.test(normalized)) {
    throw new Error("Invalid git object ID");
  }
  return normalized.toLowerCase();
}

export function assertFullGitObjectId(value: string): string {
  const normalized = value.trim();
  if (!FULL_GIT_OBJECT_ID_PATTERN.test(normalized)) {
    throw new Error("Git did not resolve a full object ID");
  }
  return normalized.toLowerCase();
}
