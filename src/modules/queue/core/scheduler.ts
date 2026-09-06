import { resolveDatabaseBackendConfig } from "../../../db/backend.js";
import { getRuntimeSettingsSnapshot } from "../../settings/settings.service.js";
import { isLarmAgentConnectionRoute } from "../../settings/settings.types.js";
import type {
  RuntimeProviderPool,
  RuntimeProviderPoolTarget,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "../../settings/settings.types.js";
import type { DistillationQueueName } from "./types.js";

export const providerPoolQueuePriorityOrder: DistillationQueueName[] = [
  "findingCandidate",
  "coveringEvidence",
  "episodeDistiller",
  "deadZoneMergeReview",
  "landscapeCuration",
  "mergeActivationFinalize",
  "finalizeDistille",
];

export function routeClaimGroupId(route: RuntimeSettingsRoute | undefined): string | null {
  if (route && isLarmAgentConnectionRoute(route)) return null;
  if (!route || route.provider === "auto") return null;
  return route.providerPoolId?.trim() || `task-routing:${route.provider}`;
}

function parseLocalLlmRouteTarget(
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

function localLlmTargetForRoute(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeProviderPoolTarget | null {
  if (isLarmAgentConnectionRoute(route)) return null;
  const routeValue = route.localLlmModel ?? route.model;
  const parsed = parseLocalLlmRouteTarget(routeValue);
  const matched = parsed
    ? settings.providers["local-llm"].models.find(
        (model) =>
          model.apiBaseUrl.trim().replace(/\/+$/, "") === parsed.apiBaseUrl &&
          (!parsed.apiPath || model.apiPath === parsed.apiPath) &&
          model.model === parsed.model,
      )
    : settings.providers["local-llm"].models.find(
        (model) =>
          model.id === routeValue || model.model === routeValue || model.name === routeValue,
      );
  return matched?.id ? { provider: "local-llm", localLlmModelId: matched.id } : null;
}

function targetsForRoute(
  settings: RuntimeSettingsEditable,
  route: RuntimeSettingsRoute,
): RuntimeProviderPoolTarget[] {
  if (isLarmAgentConnectionRoute(route)) return [];
  if (route.provider === "local-llm") {
    const target = localLlmTargetForRoute(settings, route);
    return target ? [target] : [];
  }
  if (route.provider === "azure-openai") {
    return (route.azureDeploymentSlots ?? []).map((deploymentSlot) => ({
      provider: "azure-openai",
      deploymentSlot,
    }));
  }
  if (route.provider === "openai" || route.provider === "bedrock" || route.provider === "codex") {
    return [{ provider: route.provider, targetId: route.provider }];
  }
  return [];
}

function targetKey(target: RuntimeProviderPoolTarget): string {
  if (target.provider === "larm-agent-connection") {
    return `${target.provider}:${target.connectionId}`;
  }
  if (target.provider === "local-llm") return `${target.provider}:${target.localLlmModelId}`;
  if (target.provider === "azure-openai") return `${target.provider}:${target.deploymentSlot}`;
  return `${target.provider}:${target.targetId}`;
}

function dedupeTargets(targets: RuntimeProviderPoolTarget[]): RuntimeProviderPoolTarget[] {
  const seen = new Set<string>();
  const deduped: RuntimeProviderPoolTarget[] = [];
  for (const target of targets) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

function queueRoutes(
  settings: RuntimeSettingsEditable,
  queueName: DistillationQueueName,
): RuntimeSettingsRoute[] {
  if (queueName === "findingCandidate") {
    return [settings.taskRouting.findCandidate.source, settings.taskRouting.findCandidate.vibe];
  }
  if (queueName === "coveringEvidence") {
    return [
      settings.taskRouting.coverEvidence.sourceSupport,
      settings.taskRouting.coverEvidence.externalEvidence,
      settings.taskRouting.coverEvidence.mcpEvidence,
    ];
  }
  if (queueName === "episodeDistiller") return [settings.taskRouting.episodeDistiller];
  if (queueName === "deadZoneMergeReview") return [settings.taskRouting.deadZoneMergeReview];
  if (queueName === "landscapeCuration") return [settings.taskRouting.landscapeCuration];
  if (queueName === "mergeActivationFinalize") {
    return [settings.taskRouting.mergeActivationFinalize];
  }
  return [settings.taskRouting.finalizeDistille];
}

export function providerPoolIdsForQueue(queueName: DistillationQueueName): string[] {
  const settings = getRuntimeSettingsSnapshot();
  const ids = new Set<string>();
  for (const route of queueRoutes(settings, queueName)) {
    const id = routeClaimGroupId(route);
    if (id) ids.add(id);
  }
  return [...ids];
}

export function priorityQueuesForProviderPool(params: {
  poolId: string;
  allowedQueues: DistillationQueueName[];
}): DistillationQueueName[] {
  const allowed = new Set(params.allowedQueues);
  return providerPoolQueuePriorityOrder.filter(
    (queueName) =>
      allowed.has(queueName) && providerPoolIdsForQueue(queueName).includes(params.poolId),
  );
}

export function enabledProviderPoolsForQueues(
  queueNames: DistillationQueueName[],
): RuntimeProviderPool[] {
  if (resolveDatabaseBackendConfig().kind !== "sqlite") return [];
  const queueNameSet = new Set(queueNames);
  const settings = getRuntimeSettingsSnapshot();
  const legacyPools = new Map(settings.providerPools.map((pool) => [pool.id, pool]));
  const groups = new Map<string, RuntimeProviderPool>();

  for (const queueName of providerPoolQueuePriorityOrder) {
    if (!queueNameSet.has(queueName)) continue;
    for (const route of queueRoutes(settings, queueName)) {
      if (isLarmAgentConnectionRoute(route)) continue;
      const groupId = routeClaimGroupId(route);
      if (!groupId) continue;
      const legacy = legacyPools.get(groupId);
      if (legacy?.targets.some((target) => target.provider === "larm-agent-connection")) {
        continue;
      }
      const routeTargets = (
        route.providerPoolId?.trim()
          ? dedupeTargets(legacy?.targets ?? [])
          : targetsForRoute(settings, route)
      ).filter((target) => target.provider !== "larm-agent-connection");
      if (routeTargets.length === 0) continue;
      const group =
        groups.get(groupId) ??
        ({
          id: groupId,
          label: legacy?.label ?? groupId,
          targets: [],
          maxConcurrent: legacy?.maxConcurrent ?? routeTargets.length,
          staleLeaseSeconds: legacy?.staleLeaseSeconds ?? 120,
          enabled: legacy?.enabled ?? true,
          lowPriorityAgingSeconds: legacy?.lowPriorityAgingSeconds ?? 1800,
        } satisfies RuntimeProviderPool);
      const seen = new Set(group.targets.map(targetKey));
      for (const target of routeTargets) {
        const key = targetKey(target);
        if (!seen.has(key)) {
          group.targets.push(target);
          seen.add(key);
        }
      }
      groups.set(groupId, group);
    }
  }

  return [...groups.values()]
    .filter((group) => group.enabled && group.targets.length > 0)
    .map((group) => ({
      ...group,
      maxConcurrent: Math.max(1, Math.min(group.maxConcurrent, group.targets.length)),
    }));
}

export function unpooledQueues(queueNames: DistillationQueueName[]): DistillationQueueName[] {
  const settings = getRuntimeSettingsSnapshot();
  const staticQueueNames = queueNames.filter(
    (queueName) => !queueRoutes(settings, queueName).some(isLarmAgentConnectionRoute),
  );
  if (resolveDatabaseBackendConfig().kind !== "sqlite") return staticQueueNames;
  return staticQueueNames.filter((queueName) => providerPoolIdsForQueue(queueName).length === 0);
}
