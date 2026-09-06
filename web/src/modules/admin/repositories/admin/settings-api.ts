import { getJson, requestJson } from "./http";
import type {
  RuntimeAzureOpenAiDeploymentHealthResponse,
  RuntimeLocalLlmModelHealthResponse,
  RuntimeProviderHealthResponse,
  RuntimeProviderName,
  RuntimeSettingsReloadResponse,
  RuntimeSettingsSnapshotResponse,
  RuntimeSettingsUpdateRequest,
  RuntimeSettingsUpdateResponse,
} from "./settings-contracts";

export async function fetchRuntimeSettings(): Promise<RuntimeSettingsSnapshotResponse> {
  return getJson<RuntimeSettingsSnapshotResponse>("/api/settings");
}

export async function updateRuntimeSettings(
  input: RuntimeSettingsUpdateRequest,
): Promise<RuntimeSettingsUpdateResponse> {
  return requestJson<RuntimeSettingsUpdateResponse>("/api/settings", "PUT", input);
}

export async function testRuntimeProvider(
  provider: RuntimeProviderName,
): Promise<RuntimeProviderHealthResponse> {
  return requestJson<RuntimeProviderHealthResponse>(
    `/api/settings/providers/${provider}/test`,
    "POST",
  );
}

export async function testAzureOpenAiDeployment(
  deploymentIndex: number,
): Promise<RuntimeAzureOpenAiDeploymentHealthResponse> {
  const deployment = deploymentIndex + 1;
  return requestJson<RuntimeAzureOpenAiDeploymentHealthResponse>(
    `/api/settings/providers/azure-openai/deployments/${deployment}/test`,
    "POST",
  );
}

export async function testLocalLlmModel(
  model: string,
): Promise<RuntimeLocalLlmModelHealthResponse> {
  return requestJson<RuntimeLocalLlmModelHealthResponse>(
    "/api/settings/providers/local-llm/models/test",
    "POST",
    { model },
  );
}

export async function reloadRuntimeSettingsCache(): Promise<RuntimeSettingsReloadResponse> {
  return requestJson<RuntimeSettingsReloadResponse>("/api/settings/reload-runtime-cache", "POST");
}

export type CodexAuthTokenInfo = {
  authMode: string;
  email: string | null;
  expiresAt: string | null;
  isExpired: boolean;
};

export type CodexAuthStatus = {
  codexHome: string;
  cliAvailable: boolean;
  authJsonExists: boolean;
  accessTokenConfigured: boolean;
  /** Detailed token information parsed from auth.json */
  tokenInfo: CodexAuthTokenInfo | null;
  recommendedAction: "ready" | "run-codex-login" | "set-codex-access-token" | "install-codex-cli";
};

export type CodexLoginCommandResponse = {
  command: string;
};

export async function fetchCodexAuthStatus(): Promise<CodexAuthStatus> {
  return getJson<CodexAuthStatus>("/api/settings/providers/codex/auth/status");
}

export async function fetchCodexLoginCommand(): Promise<CodexLoginCommandResponse> {
  return requestJson<CodexLoginCommandResponse>(
    "/api/settings/providers/codex/auth/login-command",
    "POST",
  );
}
