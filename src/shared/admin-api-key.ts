export const DEFAULT_ADMIN_API_KEY = "context-still-local-admin-api-key-2026";

export function resolveAdminApiKey(configuredKey: string | undefined): string {
  return configuredKey?.trim() || DEFAULT_ADMIN_API_KEY;
}
