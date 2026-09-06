import type {
  RuntimeProviderName,
  RuntimeSearchProvider,
  RuntimeSecretKey,
  RuntimeSecretStatus,
} from "../../repositories/admin.repository";

export type SettingsTabId =
  | "general"
  | "providers"
  | "pools"
  | "taskRouting"
  | "search"
  | "embedding"
  | "advanced";

export type SettingsTabPath =
  | "general"
  | "llmprovider"
  | "llmpool"
  | "taskrouting"
  | "search"
  | "embedding"
  | "advanced";

export type SecretDraftState = Partial<Record<RuntimeSecretKey, { value: string; clear: boolean }>>;

export type ProviderEndpointKind = "openai" | "azure-openai" | "bedrock" | "local-llm";

export function azureOpenAiSecretKey(index: number): RuntimeSecretKey {
  return index === 0 ? "azureOpenAiApiKey" : (`azureOpenAiApiKey${index + 1}` as RuntimeSecretKey);
}

export function localLlmSecretKey(index: number): RuntimeSecretKey {
  return index === 0 ? "localLlmApiKey" : (`localLlmApiKey${index + 1}` as RuntimeSecretKey);
}

export function emptyRuntimeSecretStatus(): RuntimeSecretStatus {
  return {
    configured: false,
    source: "none",
    maskedValue: null,
    updatedAt: null,
  };
}

export const settingsTabs: Array<{ id: SettingsTabId; label: string; path: SettingsTabPath }> = [
  { id: "general", label: "General", path: "general" },
  { id: "providers", label: "LLM Providers", path: "llmprovider" },
  { id: "pools", label: "LLM Pool", path: "llmpool" },
  { id: "taskRouting", label: "Task Routing", path: "taskrouting" },
  { id: "search", label: "Search", path: "search" },
  { id: "embedding", label: "Embedding / Local Runtime", path: "embedding" },
  { id: "advanced", label: "Advanced", path: "advanced" },
];

export const runtimeProviders: RuntimeProviderName[] = [
  "openai",
  "azure-openai",
  "bedrock",
  "local-llm",
  "codex",
];

export const runtimeSearchProviders: RuntimeSearchProvider[] = ["brave", "exa", "duckduckgo"];

export const localLlmDefaultProviderPoolId = "local-llm-default";

export const distillationPriorityTargetKinds = [
  "knowledge_candidate",
  "web_ingest",
  "wiki_file",
  "vibe_memory",
] as const;

export type DistillationPriorityTargetKind = (typeof distillationPriorityTargetKinds)[number];

export function parseIntegerInput(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFloatInput(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function millisecondsToSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number((value / 1000).toFixed(3));
}

export function parseSecondsToMillisecondsInput(value: string, fallbackMs: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 1000) : fallbackMs;
}

export function normalizeAzureDeploymentSlots(values: number[] | undefined): number[] {
  if (!values || values.length === 0) return [];
  const deduped = new Set<number>();
  for (const value of values) {
    if (!Number.isInteger(value) || value < 1) continue;
    deduped.add(value);
  }
  return [...deduped];
}

export function resolveActiveSettingsTab(pathname: string): SettingsTabId {
  const match = pathname.match(/^\/(?:setting|settings)\/([^/]+)\/?$/);
  if (!match) return "providers";
  const slug = match[1];
  if (slug === "distillation-runtime") return "taskRouting";
  const found = settingsTabs.find((tab) => tab.path === slug);
  return found?.id ?? "providers";
}
