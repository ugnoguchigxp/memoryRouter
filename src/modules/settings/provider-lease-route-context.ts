import { AsyncLocalStorage } from "node:async_hooks";
import { isLarmAgentConnectionRoute } from "./settings.types.js";
import type {
  RuntimeProviderPoolTarget,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "./settings.types.js";

export type ProviderLeaseRouteContext = {
  poolId: string;
  targetId: string;
};

const storage = new AsyncLocalStorage<ProviderLeaseRouteContext>();

function localLlmRouteTargetValue(model: {
  apiBaseUrl: string;
  apiPath?: string;
  model: string;
}): string {
  return JSON.stringify({
    apiBaseUrl: model.apiBaseUrl.trim().replace(/\/+$/, ""),
    apiPath: model.apiPath?.trim() || "/v1/chat/completions",
    model: model.model.trim(),
  });
}

function routeClaimGroupId(route: RuntimeSettingsRoute): string | null {
  if (isLarmAgentConnectionRoute(route)) return null;
  if (route.provider === "auto") return null;
  return route.providerPoolId?.trim() || `task-routing:${route.provider}`;
}

function findLeaseTarget(params: {
  settings: RuntimeSettingsEditable;
  poolId: string;
  targetId: string;
}): RuntimeProviderPoolTarget | null {
  const configured = params.settings.providerPools
    .find((pool) => pool.id === params.poolId)
    ?.targets.find((target) => {
      if (target.provider === "larm-agent-connection") {
        return target.connectionId === params.targetId;
      }
      if (target.provider === "local-llm") return target.localLlmModelId === params.targetId;
      if (target.provider === "azure-openai") {
        return String(target.deploymentSlot) === params.targetId;
      }
      return target.targetId === params.targetId;
    });
  if (configured) return configured;
  if (params.settings.providers["local-llm"].models.some((model) => model.id === params.targetId)) {
    return { provider: "local-llm", localLlmModelId: params.targetId };
  }
  if (/^\d+$/.test(params.targetId)) {
    return { provider: "azure-openai", deploymentSlot: Number(params.targetId) };
  }
  for (const provider of ["openai", "bedrock", "codex"] as const) {
    if (params.targetId === provider) return { provider, targetId: provider };
  }
  return null;
}

export function runWithProviderLeaseRouteContext<T>(
  context: ProviderLeaseRouteContext | null | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!context) return run();
  return storage.run(context, run);
}

export function applyProviderLeaseRouteContext(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeSettingsRoute {
  if (isLarmAgentConnectionRoute(route)) return route;
  const context = storage.getStore();
  if (!context || routeClaimGroupId(route) !== context.poolId) return route;
  const target = findLeaseTarget({
    settings,
    poolId: context.poolId,
    targetId: context.targetId,
  });
  if (!target) return route;

  if (target.provider === "local-llm") {
    const model = settings.providers["local-llm"].models.find(
      (item) => item.id === target.localLlmModelId,
    );
    if (!model) return route;
    const routeTarget = localLlmRouteTargetValue(model);
    return {
      ...route,
      provider: "local-llm",
      model: routeTarget,
      localLlmModel: routeTarget,
      fallback: [],
      azureDeploymentSlots: undefined,
    };
  }

  if (target.provider === "azure-openai") {
    return {
      ...route,
      provider: "azure-openai",
      fallback: [],
      azureDeploymentSlots: [target.deploymentSlot],
    };
  }

  if (target.provider === "larm-agent-connection") {
    throw new Error(`dynamic_provider_requires_rust_resident: ${target.connectionId}`);
  }

  return {
    ...route,
    provider: target.provider,
    fallback: [],
    azureDeploymentSlots: undefined,
  };
}
