import type { DistillationProviderName } from "../distillation/llm-resolver.js";
import {
  type RuntimeSettingsRoute,
  type StaticRuntimeSettingsRoute,
  isLarmAgentConnectionRoute,
  requireStaticRuntimeSettingsRoute,
} from "../settings/settings.types.js";

export type CoverEvidenceProviderPolicy = "default" | "cloud_api";

const cloudApiProviders = new Set<DistillationProviderName>([
  "openai",
  "azure-openai",
  "bedrock",
  "codex",
]);
const distillationProviders = new Set<DistillationProviderName>([
  "local-llm",
  "openai",
  "azure-openai",
  "bedrock",
  "codex",
]);

function isDistillationProviderName(value: string): value is DistillationProviderName {
  return distillationProviders.has(value as DistillationProviderName);
}

export class CoverEvidenceProviderPolicyError extends Error {
  readonly reason: "cloud_api_provider_unavailable";
  readonly routeName?: string;

  constructor(params: { routeName?: string } = {}) {
    super(
      params.routeName
        ? `cloud_api provider is unavailable for ${params.routeName}`
        : "cloud_api provider is unavailable",
    );
    this.name = "CoverEvidenceProviderPolicyError";
    this.reason = "cloud_api_provider_unavailable";
    this.routeName = params.routeName;
  }
}

function dedupeProviders(values: DistillationProviderName[]): DistillationProviderName[] {
  const ordered: DistillationProviderName[] = [];
  const seen = new Set<DistillationProviderName>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }
  return ordered;
}

function cloudApiRouteProviders(route: RuntimeSettingsRoute): DistillationProviderName[] {
  const candidates: DistillationProviderName[] = [];
  if (isLarmAgentConnectionRoute(route)) return candidates;
  if (isDistillationProviderName(route.provider) && cloudApiProviders.has(route.provider)) {
    candidates.push(route.provider);
  }
  for (const fallback of route.fallback) {
    if (!cloudApiProviders.has(fallback)) continue;
    candidates.push(fallback);
  }
  return dedupeProviders(candidates);
}

export function resolveCloudApiRuntimeRoute(
  route: RuntimeSettingsRoute,
  options: { routeName?: string } = {},
): StaticRuntimeSettingsRoute {
  const staticRoute = requireStaticRuntimeSettingsRoute(route);
  const providers = cloudApiRouteProviders(staticRoute);
  if (providers.length === 0) {
    throw new CoverEvidenceProviderPolicyError({ routeName: options.routeName });
  }
  const [provider, ...fallback] = providers;
  if (!provider) {
    throw new CoverEvidenceProviderPolicyError({ routeName: options.routeName });
  }
  const usesPrimaryRouteModel = provider === staticRoute.provider;
  if (usesPrimaryRouteModel) {
    return {
      ...staticRoute,
      provider,
      fallback,
    };
  }
  const {
    model: _model,
    localLlmModel: _localLlmModel,
    azureDeploymentSlots: _slots,
    ...rest
  } = staticRoute;
  return {
    ...rest,
    provider,
    fallback,
  };
}

export function resolveCoverEvidenceRouteByPolicy(params: {
  route: RuntimeSettingsRoute;
  policy?: CoverEvidenceProviderPolicy;
  routeName?: string;
}): StaticRuntimeSettingsRoute {
  if (params.policy === "cloud_api") {
    return resolveCloudApiRuntimeRoute(params.route, { routeName: params.routeName });
  }
  return requireStaticRuntimeSettingsRoute(params.route);
}

export function ensureCloudApiCoverEvidenceRoutesAvailable(routes: {
  sourceSupport: RuntimeSettingsRoute;
  externalEvidence: RuntimeSettingsRoute;
  mcpEvidence: RuntimeSettingsRoute;
}): void {
  resolveCloudApiRuntimeRoute(routes.sourceSupport, { routeName: "sourceSupport" });
  resolveCloudApiRuntimeRoute(routes.externalEvidence, { routeName: "externalEvidence" });
  resolveCloudApiRuntimeRoute(routes.mcpEvidence, { routeName: "mcpEvidence" });
}
