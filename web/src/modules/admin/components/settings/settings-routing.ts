import type {
  RuntimeProviderName,
  RuntimeProviderPool,
  RuntimeProviderPoolTarget,
  RuntimeProviderSetting,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "../../repositories/admin.repository";
import { normalizeAzureDeploymentSlots } from "./settings-primitives";

export function isLarmAgentConnectionRoute(
  route: RuntimeSettingsRoute,
): route is Extract<RuntimeSettingsRoute, { kind: "larm-agent-connection" }> {
  return route.kind === "larm-agent-connection";
}

export function cloneRuntimeSettingsRoute(route: RuntimeSettingsRoute): RuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) {
    return { kind: "larm-agent-connection", connectionId: route.connectionId };
  }
  return {
    ...(route.kind ? { kind: route.kind } : {}),
    provider: route.provider,
    model: route.model,
    localLlmModel: route.localLlmModel,
    providerPoolId: route.providerPoolId,
    fallback: [...route.fallback],
    azureDeploymentSlots: route.azureDeploymentSlots ? [...route.azureDeploymentSlots] : undefined,
  };
}

export function getConfiguredModelByProvider(
  settings: RuntimeSettingsEditable,
): Record<RuntimeProviderName, string> {
  return {
    openai: settings.providers.openai.model.trim(),
    "azure-openai":
      settings.providers["azure-openai"].deployments
        .find((deployment) => deployment.model.trim())
        ?.model.trim() ?? settings.providers["azure-openai"].model.trim(),
    bedrock: settings.providers.bedrock.model.trim(),
    "local-llm": settings.providers["local-llm"].model.trim(),
    codex: settings.providers.codex?.model?.trim() ?? "codex-sdk-agent",
  };
}

export function resolveConfiguredRouteModel(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderSetting,
): string | undefined {
  const modelByProvider = getConfiguredModelByProvider(settings);
  if (provider === "auto") return undefined;
  const model = modelByProvider[provider];
  return model ? model : undefined;
}

export type LocalLlmRouteOption = {
  id?: string;
  value: string;
  label: string;
  model: string;
  apiBaseUrl: string;
  apiPath: string;
};

export type AzureOpenAiRouteOption = {
  value: string;
  label: string;
  slot: number;
  model: string;
  apiBaseUrl: string;
};

export type RouteEndpointOption = {
  value: string;
  label: string;
  provider: RuntimeProviderName;
  model?: string;
  localLlmModel?: string;
  azureDeploymentSlots?: number[];
};

export type RouteTargetOption =
  | {
      kind: "pool";
      value: string;
      label: string;
      pool: RuntimeProviderPool;
    }
  | {
      kind: "endpoint";
      value: string;
      label: string;
      endpoint: RouteEndpointOption;
    }
  | {
      kind: "larm-agent-connection";
      value: string;
      label: string;
      connectionId: string;
    };

export function azureRouteOptionLabel(
  deployment: RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"][number],
  index: number,
): string {
  const name = deployment.name.trim() || `Deployment ${index + 1}`;
  const model = deployment.model.trim();
  const endpoint = deployment.apiBaseUrl.trim();
  return [name, model && model !== name ? model : "", endpoint].filter(Boolean).join(" / ");
}

export function azureOpenAiRouteOptions(
  settings: RuntimeSettingsEditable,
): AzureOpenAiRouteOption[] {
  return settings.providers["azure-openai"].deployments
    .map((deployment, index) => ({
      value: String(index + 1),
      label: azureRouteOptionLabel(deployment, index),
      slot: index + 1,
      model: deployment.model.trim(),
      apiBaseUrl: deployment.apiBaseUrl.trim().replace(/\/+$/, ""),
    }))
    .filter((option) => option.model && option.apiBaseUrl);
}

export function normalizeSelectedAzureRouteValue(
  settings: RuntimeSettingsEditable,
  slots: number[] | undefined,
): string {
  const options = azureOpenAiRouteOptions(settings);
  const firstSlot = normalizeAzureDeploymentSlots(slots)[0];
  if (firstSlot && options.some((option) => option.slot === firstSlot)) return String(firstSlot);
  return options[0]?.value ?? "";
}

export function azureDeploymentSlotsFromValue(value: string): number[] | undefined {
  const slot = Number(value);
  return Number.isInteger(slot) && slot > 0 ? [slot] : undefined;
}

export function selectedAzureRouteOption(
  settings: RuntimeSettingsEditable,
  slots: number[] | undefined,
): AzureOpenAiRouteOption | undefined {
  const selected = normalizeSelectedAzureRouteValue(settings, slots);
  return azureOpenAiRouteOptions(settings).find((option) => option.value === selected);
}

export function routeEndpointOptions(settings: RuntimeSettingsEditable): RouteEndpointOption[] {
  const options: RouteEndpointOption[] = [];
  if (
    settings.providers.openai.enabled &&
    settings.providers.openai.apiBaseUrl.trim() &&
    settings.providers.openai.model.trim()
  ) {
    options.push({
      value: "openai",
      label: `OpenAI / ${settings.providers.openai.model.trim()} / ${settings.providers.openai.apiBaseUrl.trim()}`,
      provider: "openai",
      model: settings.providers.openai.model.trim(),
    });
  }
  if (settings.providers["azure-openai"].enabled) {
    for (const option of azureOpenAiRouteOptions(settings)) {
      options.push({
        value: `azure-openai:${option.value}`,
        label: option.label,
        provider: "azure-openai",
        model: option.model,
        azureDeploymentSlots: [option.slot],
      });
    }
  }
  if (
    settings.providers.bedrock.enabled &&
    settings.providers.bedrock.region.trim() &&
    settings.providers.bedrock.model.trim()
  ) {
    options.push({
      value: "bedrock",
      label: `AWS Bedrock / ${settings.providers.bedrock.model.trim()} / ${settings.providers.bedrock.region.trim()}`,
      provider: "bedrock",
      model: settings.providers.bedrock.model.trim(),
    });
  }
  if (settings.providers["local-llm"].enabled) {
    const pooledModelIds = pooledLocalLlmModelIds(settings);
    for (const option of localLlmRouteModelOptions(settings).filter(
      (option) => !option.id || !pooledModelIds.has(option.id),
    )) {
      options.push({
        value: `local-llm:${option.value}`,
        label: option.label,
        provider: "local-llm",
        model: option.value,
        localLlmModel: option.value,
      });
    }
  }
  if (settings.providers.codex.enabled && settings.providers.codex.model.trim()) {
    options.push({
      value: "codex",
      label: `Codex / ${settings.providers.codex.model.trim()}`,
      provider: "codex",
      model: settings.providers.codex.model.trim(),
    });
  }
  return options;
}

export function pooledLocalLlmModelIds(settings: RuntimeSettingsEditable): Set<string> {
  const ids = new Set<string>();
  for (const pool of settings.providerPools) {
    if (!pool.enabled) continue;
    for (const target of pool.targets) {
      if (target.provider === "local-llm") ids.add(target.localLlmModelId);
    }
  }
  return ids;
}

export function localLlmRouteTargetValue(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
): string {
  return JSON.stringify({
    apiBaseUrl: model.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: model.apiPath.trim() || "/v1/chat/completions",
    model: model.model.trim(),
  });
}

export function parseLocalLlmRouteTarget(
  value: string | undefined,
): { apiBaseUrl: string; apiPath?: string; model: string } | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as Partial<{
      apiBaseUrl: string;
      apiPath: string;
      model: string;
    }>;
    if (typeof parsed.apiBaseUrl === "string" && typeof parsed.model === "string") {
      const apiBaseUrl = parsed.apiBaseUrl.trim().replace(/\/+$/, "");
      const apiPath =
        typeof parsed.apiPath === "string" && parsed.apiPath.trim()
          ? parsed.apiPath.trim()
          : undefined;
      const model = parsed.model.trim();
      if (apiBaseUrl && model) return { apiBaseUrl, apiPath, model };
    }
  } catch {
    // Legacy route values are plain model names.
  }
  return null;
}

export function localLlmRouteOptionLabel(
  model: RuntimeSettingsEditable["providers"]["local-llm"]["models"][number],
  duplicateModelName = false,
): string {
  const name = model.name.trim();
  const modelName = model.model.trim();
  const endpoint = model.apiBaseUrl.trim();
  return [
    name || modelName,
    modelName && name !== modelName ? modelName : "",
    duplicateModelName || endpoint ? endpoint : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

export function localLlmRouteModelOptions(
  settings: RuntimeSettingsEditable,
): LocalLlmRouteOption[] {
  const models = settings.providers["local-llm"].models
    .filter((item) => item.model.trim())
    .map((item) => ({
      ...item,
      apiBaseUrl: item.apiBaseUrl.trim().replace(/\/+$/, ""),
      apiPath: item.apiPath.trim() || "/v1/chat/completions",
      model: item.model.trim(),
    }));
  const modelCounts = new Map<string, number>();
  for (const model of models) {
    modelCounts.set(model.model, (modelCounts.get(model.model) ?? 0) + 1);
  }
  return models.map((model) => {
    const duplicateModelName = (modelCounts.get(model.model) ?? 0) > 1;
    return {
      id: model.id?.trim(),
      value: duplicateModelName ? localLlmRouteTargetValue(model) : model.model,
      label: localLlmRouteOptionLabel(model, duplicateModelName),
      model: model.model,
      apiBaseUrl: model.apiBaseUrl,
      apiPath: model.apiPath,
    };
  });
}

export function resolveConfiguredLocalLlmModel(
  settings: RuntimeSettingsEditable,
): string | undefined {
  return (
    localLlmRouteModelOptions(settings)[0]?.value ??
    resolveConfiguredRouteModel(settings, "local-llm")
  );
}

export function normalizeSelectedLocalLlmRouteValue(
  settings: RuntimeSettingsEditable,
  value: string | undefined,
): string {
  const options = localLlmRouteModelOptions(settings);
  if (!value?.trim()) return options[0]?.value ?? "";
  if (options.some((option) => option.value === value)) return value;
  const target = parseLocalLlmRouteTarget(value);
  if (target) {
    return (
      options.find(
        (option) =>
          option.apiBaseUrl === target.apiBaseUrl &&
          (!target.apiPath || option.apiPath === target.apiPath) &&
          option.model === target.model,
      )?.value ??
      options[0]?.value ??
      ""
    );
  }
  return options.find((option) => option.model === value.trim())?.value ?? options[0]?.value ?? "";
}

export function routeEndpointOptionFor(
  settings: RuntimeSettingsEditable,
  provider: RuntimeProviderName,
  route: RuntimeSettingsRoute,
  primary: boolean,
): RouteEndpointOption | undefined {
  if (isLarmAgentConnectionRoute(route)) return undefined;
  const options = routeEndpointOptions(settings);
  if (provider === "local-llm") {
    const selected = normalizeSelectedLocalLlmRouteValue(
      settings,
      primary && route.provider === "local-llm" ? route.model : route.localLlmModel,
    );
    return options.find((option) => option.value === `local-llm:${selected}`);
  }
  if (provider === "azure-openai") {
    const selected = normalizeSelectedAzureRouteValue(settings, route.azureDeploymentSlots);
    return options.find((option) => option.value === `azure-openai:${selected}`);
  }
  return options.find((option) => option.provider === provider);
}

export function primaryRouteEndpointValue(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): string {
  if (isLarmAgentConnectionRoute(route)) return "";
  if (route.provider === "auto") return "";
  return routeEndpointOptionFor(settings, route.provider, route, true)?.value ?? "";
}

export function fallbackRouteEndpointValue(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
  index: number,
): string {
  if (isLarmAgentConnectionRoute(route)) return "";
  const provider = route.fallback[index];
  if (!provider) return "";
  return routeEndpointOptionFor(settings, provider, route, false)?.value ?? "";
}

export function routeWithPrimaryEndpoint(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
  option: RouteEndpointOption,
): RuntimeSettingsRoute {
  const staticRoute: Exclude<RuntimeSettingsRoute, { kind: "larm-agent-connection" }> =
    isLarmAgentConnectionRoute(route) ? { provider: "auto", fallback: [] } : route;
  const fallback = staticRoute.fallback.filter((provider) => provider !== option.provider);
  return {
    ...staticRoute,
    provider: option.provider,
    model: option.model ?? resolveConfiguredRouteModel(settings, option.provider),
    providerPoolId: option.provider === "local-llm" ? staticRoute.providerPoolId : undefined,
    localLlmModel:
      option.provider === "local-llm"
        ? option.localLlmModel
        : fallback.includes("local-llm")
          ? (staticRoute.localLlmModel ?? resolveConfiguredLocalLlmModel(settings))
          : undefined,
    fallback,
    azureDeploymentSlots:
      option.provider === "azure-openai"
        ? option.azureDeploymentSlots
        : fallback.includes("azure-openai")
          ? (staticRoute.azureDeploymentSlots ??
            azureDeploymentSlotsFromValue(normalizeSelectedAzureRouteValue(settings, undefined)))
          : undefined,
  };
}

export function routeTargetOptions(settings: RuntimeSettingsEditable): RouteTargetOption[] {
  const pools = settings.providerPools
    .filter((pool) => pool.targets.length > 0)
    .map((pool) => ({
      kind: "pool" as const,
      value: `pool:${pool.id}`,
      label: `Pool / ${pool.label || pool.id}`,
      pool,
    }));
  const endpoints = routeEndpointOptions(settings).map((endpoint) => ({
    kind: "endpoint" as const,
    value: `endpoint:${endpoint.value}`,
    label: endpoint.label,
    endpoint,
  }));
  const dynamicConnections = settings.providers["larm-agent-connection"].enabled
    ? settings.providers["larm-agent-connection"].connections
        .filter(
          (connection) =>
            connection.id.trim() &&
            connection.controlBaseUrl.trim() &&
            connection.agentProfile.trim() &&
            connection.audience.trim(),
        )
        .map((connection) => ({
          kind: "larm-agent-connection" as const,
          value: `larm-agent-connection:${connection.id}`,
          label: `LARM / ${connection.agentProfile} / ${connection.controlBaseUrl}`,
          connectionId: connection.id,
        }))
    : [];
  return [...pools, ...endpoints, ...dynamicConnections];
}

export function primaryRouteTargetValue(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): string {
  if (isLarmAgentConnectionRoute(route)) {
    return `larm-agent-connection:${route.connectionId}`;
  }
  if (route.providerPoolId) return `pool:${route.providerPoolId}`;
  const endpointValue = primaryRouteEndpointValue(settings, route);
  return endpointValue ? `endpoint:${endpointValue}` : "";
}

export function routeWithPrimaryTarget(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
  option: RouteTargetOption,
): RuntimeSettingsRoute {
  if (option.kind === "larm-agent-connection") {
    return {
      kind: "larm-agent-connection",
      connectionId: option.connectionId,
    };
  }
  if (option.kind === "pool") {
    if (isLarmAgentConnectionRoute(route)) {
      const firstTarget = option.pool.targets[0];
      const provider = firstTarget?.provider === "local-llm" ? "local-llm" : "auto";
      return {
        provider,
        model: resolveConfiguredRouteModel(settings, provider),
        localLlmModel:
          provider === "local-llm" ? resolveConfiguredLocalLlmModel(settings) : undefined,
        providerPoolId: option.pool.id,
        fallback: [],
      };
    }
    return routeWithProviderPool(route, option.pool.id);
  }
  return routeWithProviderPool(
    routeWithPrimaryEndpoint(settings, route, option.endpoint),
    undefined,
  );
}

export function routeWithFallbackEndpoint(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
  index: 0 | 1,
  option: RouteEndpointOption | undefined,
): RuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) return route;
  const nextFallback = route.fallback.filter((provider) => provider !== route.fallback[index]);
  if (option && option.provider !== route.provider && !nextFallback.includes(option.provider)) {
    nextFallback.splice(index, 0, option.provider);
  }
  const fallback = nextFallback.slice(0, 2);
  return {
    ...route,
    fallback,
    localLlmModel:
      route.provider === "local-llm"
        ? route.model
        : option?.provider === "local-llm"
          ? option.localLlmModel
          : fallback.includes("local-llm")
            ? (route.localLlmModel ?? resolveConfiguredLocalLlmModel(settings))
            : undefined,
    azureDeploymentSlots:
      route.provider === "azure-openai"
        ? route.azureDeploymentSlots
        : option?.provider === "azure-openai"
          ? option.azureDeploymentSlots
          : fallback.includes("azure-openai")
            ? route.azureDeploymentSlots
            : undefined,
  };
}

export function providerPoolTargetKey(target: RuntimeProviderPoolTarget): string {
  if (target.provider === "larm-agent-connection") {
    return `${target.provider}:${target.connectionId}`;
  }
  if (target.provider === "local-llm") return `${target.provider}:${target.localLlmModelId}`;
  if (target.provider === "azure-openai") return `${target.provider}:${target.deploymentSlot}`;
  return `${target.provider}:${target.targetId}`;
}

export function providerPoolTargetLabel(
  settings: RuntimeSettingsEditable,
  target: RuntimeProviderPoolTarget,
): string {
  if (target.provider === "larm-agent-connection") {
    const connection = settings.providers["larm-agent-connection"].connections.find(
      (item) => item.id === target.connectionId,
    );
    return connection?.agentProfile || target.connectionId;
  }
  if (target.provider === "local-llm") {
    const model = settings.providers["local-llm"].models.find(
      (item) => item.id === target.localLlmModelId,
    );
    return model
      ? localLlmRouteOptionLabel(
          {
            ...model,
            apiBaseUrl: model.apiBaseUrl.trim(),
            apiPath: model.apiPath.trim() || "/v1/chat/completions",
            model: model.model.trim(),
          },
          true,
        )
      : target.localLlmModelId;
  }
  if (target.provider === "azure-openai") {
    const deployment = settings.providers["azure-openai"].deployments[target.deploymentSlot - 1];
    return deployment
      ? azureRouteOptionLabel(deployment, target.deploymentSlot - 1)
      : target.provider;
  }
  return target.provider;
}

export function routeWithProviderPool(
  route: RuntimeSettingsRoute,
  providerPoolId: string | undefined,
): RuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) return route;
  const normalized = providerPoolId?.trim();
  return {
    ...route,
    providerPoolId: normalized || undefined,
  };
}
