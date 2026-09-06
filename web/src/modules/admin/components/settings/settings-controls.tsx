import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import type {
  RuntimeEffectiveRouteTargets,
  RuntimeProviderHealth,
  RuntimeProviderName,
  RuntimeSecretStatus,
  RuntimeSettingsDiagnostic,
  RuntimeSettingsEditable,
  RuntimeSettingsRoute,
} from "../../repositories/admin.repository";
import {
  type RouteEndpointOption,
  fallbackRouteEndpointValue,
  isLarmAgentConnectionRoute,
  primaryRouteTargetValue,
  providerPoolTargetKey,
  providerPoolTargetLabel,
  routeEndpointOptions,
  routeTargetOptions,
  routeWithFallbackEndpoint,
  routeWithPrimaryTarget,
} from "./settings-routing";

export function SecretStatusBadge({ status }: { status: RuntimeSecretStatus }) {
  if (!status.configured) return <Badge variant="outline">unset</Badge>;
  if (status.source === "db") return <Badge variant="success">db</Badge>;
  if (status.source === "env") return <Badge variant="secondary">env</Badge>;
  if (status.source === "env-or-profile") return <Badge variant="secondary">env/profile</Badge>;
  return <Badge variant="outline">{status.source}</Badge>;
}

export function ProviderHealthBadge({ health }: { health: RuntimeProviderHealth | undefined }) {
  if (!health) return <Badge variant="outline">not tested</Badge>;
  if (!health.configured) return <Badge variant="warning">unconfigured</Badge>;
  if (health.reachable) return <Badge variant="success">reachable</Badge>;
  return <Badge variant="destructive">unreachable</Badge>;
}

export function RouteEditor({
  label,
  description,
  settings,
  route,
  effectiveTargets,
  onChange,
  allowDynamic = true,
}: {
  label: string;
  description: string;
  settings: RuntimeSettingsEditable;
  route: RuntimeSettingsRoute;
  effectiveTargets?: RuntimeEffectiveRouteTargets;
  onChange: (next: RuntimeSettingsRoute) => void;
  allowDynamic?: boolean;
}) {
  const isDynamicRoute = isLarmAgentConnectionRoute(route);
  const endpointOptions = routeEndpointOptions(settings);
  const endpointOptionByValue = new Map(endpointOptions.map((option) => [option.value, option]));
  const targetOptions = routeTargetOptions(settings).filter(
    (option) =>
      allowDynamic ||
      (option.kind !== "larm-agent-connection" &&
        (option.kind !== "pool" ||
          option.pool.targets.every((target) => target.provider !== "larm-agent-connection"))),
  );
  const targetOptionByValue = new Map(targetOptions.map((option) => [option.value, option]));
  const primaryTargetValue = primaryRouteTargetValue(settings, route);
  const selectedFallbackValues = [
    fallbackRouteEndpointValue(settings, route, 0),
    fallbackRouteEndpointValue(settings, route, 1),
  ];
  const poolOptions = settings.providerPools.filter((pool) => pool.targets.length > 0);
  const selectedPool =
    !isDynamicRoute && route.providerPoolId
      ? poolOptions.find((pool) => pool.id === route.providerPoolId)
      : undefined;
  const selectedTargetOption = targetOptionByValue.get(primaryTargetValue);
  const effectiveTargetList =
    effectiveTargets &&
    effectiveTargets.providerPoolId === (isDynamicRoute ? undefined : route.providerPoolId)
      ? effectiveTargets.targets
      : [];
  const effectiveTargetValues =
    effectiveTargetList.length > 0
      ? effectiveTargetList.map((target) => target.label)
      : selectedPool
        ? selectedPool.targets.map((target) => providerPoolTargetLabel(settings, target))
        : selectedTargetOption
          ? [selectedTargetOption.label]
          : [];
  const fallbackOptionsFor = (index: 0 | 1): RouteEndpointOption[] => {
    const currentValue = selectedFallbackValues[index];
    const blockedProviders = new Set<RuntimeProviderName>([
      ...(isDynamicRoute || route.provider === "auto" ? [] : [route.provider]),
      ...selectedFallbackValues
        .filter((value, valueIndex) => value && valueIndex !== index)
        .map((value) => endpointOptionByValue.get(value)?.provider)
        .filter((provider): provider is RuntimeProviderName => Boolean(provider)),
    ]);
    return endpointOptions.filter(
      (option) => option.value === currentValue || !blockedProviders.has(option.provider),
    );
  };
  const routeChain = [
    {
      label: "Effective Target",
      value:
        effectiveTargetValues.length > 0 ? effectiveTargetValues.join(" / ") : "not configured",
    },
    ...selectedFallbackValues.filter(Boolean).map((value, index) => ({
      label: `Fallback ${index + 1}`,
      value: endpointOptionByValue.get(value)?.label ?? "not configured",
    })),
  ];

  return (
    <div className="settings-route-row">
      <div className="settings-route-header">
        <div className="settings-route-label">{label}</div>
        <p className="settings-route-description">{description}</p>
      </div>
      <div className="settings-route-fields settings-route-fields-routing">
        <label className="settings-field">
          <span>Routing Target</span>
          <Select
            value={primaryTargetValue}
            onChange={(event) => {
              const option = targetOptionByValue.get(event.target.value);
              if (option) onChange(routeWithPrimaryTarget(settings, route, option));
            }}
            disabled={targetOptions.length === 0}
          >
            {targetOptions.length === 0 ? (
              <option value="">No configured targets</option>
            ) : (
              <>
                {primaryTargetValue ? null : (
                  <option value="" disabled>
                    not configured
                  </option>
                )}
                {targetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </>
            )}
          </Select>
        </label>
        <label className="settings-field">
          <span>Fallback 1 Endpoint</span>
          <Select
            value={selectedFallbackValues[0]}
            onChange={(event) => {
              onChange(
                routeWithFallbackEndpoint(
                  settings,
                  route,
                  0,
                  endpointOptionByValue.get(event.target.value),
                ),
              );
            }}
            disabled={isDynamicRoute}
          >
            <option value="">none</option>
            {fallbackOptionsFor(0).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
        <label className="settings-field">
          <span>Fallback 2 Endpoint</span>
          <Select
            value={selectedFallbackValues[1]}
            onChange={(event) => {
              onChange(
                routeWithFallbackEndpoint(
                  settings,
                  route,
                  1,
                  endpointOptionByValue.get(event.target.value),
                ),
              );
            }}
            disabled={isDynamicRoute}
          >
            <option value="">none</option>
            {fallbackOptionsFor(1).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <div className="settings-route-chain" aria-label={`${label} effective route`}>
        {routeChain.map((item) => (
          <span key={`${item.label}:${item.value}`} className="settings-route-chain-item">
            <strong>{item.label}</strong>
            {item.value}
          </span>
        ))}
      </div>
      {selectedPool ? (
        <div className="settings-route-chain" aria-label={`${label} effective pool targets`}>
          {selectedPool.targets.map((target) => (
            <span key={providerPoolTargetKey(target)} className="settings-route-chain-item">
              <strong>{target.provider}</strong>
              {providerPoolTargetLabel(settings, target)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderPoolDiagnostics({ items }: { items: RuntimeSettingsDiagnostic[] }) {
  if (items.length === 0) return null;
  return (
    <div className="settings-route-row" aria-label="provider pool diagnostics">
      <div className="settings-route-header">
        <div className="settings-route-label">Provider Pool Diagnostics</div>
        <p className="settings-route-description">
          Resolve these warnings before relying on queue-backed Local LLM routing.
        </p>
      </div>
      <div className="settings-route-chain">
        {items.map((item) => (
          <span
            key={`${item.code}:${item.path}:${item.message}`}
            className="settings-route-chain-item"
          >
            <strong>{item.severity === "error" ? "Error" : "Warning"}</strong>
            {item.message}
          </span>
        ))}
      </div>
    </div>
  );
}
