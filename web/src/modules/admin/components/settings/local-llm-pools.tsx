import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";
import type { RuntimeProviderPool } from "../../repositories/admin.repository";
import {
  isLocalLlmPoolTarget,
  localLlmPoolTargetId,
  localLlmPoolTargetLabel,
  localLlmProviderPool,
} from "./settings-form";
import { localLlmDefaultProviderPoolId, parseIntegerInput } from "./settings-primitives";
import { routeWithProviderPool } from "./settings-routing";
import type { SettingsController } from "./use-settings-controller";
type Props = Pick<SettingsController, "draft" | "patchDraft">;
export function LocalLlmPools({ draft, patchDraft }: Props) {
  if (!draft) return null;
  const localModels = draft.providers["local-llm"].models
    .map((model, index) => ({
      id: localLlmPoolTargetId(model),
      index,
      label: localLlmPoolTargetLabel(model, index),
      complete: Boolean(model.apiBaseUrl.trim() && model.model.trim()),
    }))
    .filter((model) => model.complete);
  const localTargetIds = new Set(localModels.map((model) => model.id).filter(Boolean));
  const poolList = draft.providerPools.length ? draft.providerPools : [localLlmProviderPool(draft)];
  const canAddPool = localModels.some((model) => Boolean(model.id));

  const patchPool = (poolId: string, nextPool: RuntimeProviderPool) =>
    patchDraft((current) => ({
      ...current,
      providerPools: current.providerPools.some((pool) => pool.id === poolId)
        ? current.providerPools.map((pool) => (pool.id === poolId ? nextPool : pool))
        : [...current.providerPools, nextPool],
    }));

  const removePool = (poolId: string) =>
    patchDraft((current) => ({
      ...current,
      providerPools: current.providerPools.filter((pool) => pool.id !== poolId),
      taskRouting: {
        ...current.taskRouting,
        findCandidate: {
          ...current.taskRouting.findCandidate,
          source: routeWithProviderPool(
            current.taskRouting.findCandidate.source,
            current.taskRouting.findCandidate.source.providerPoolId === poolId
              ? undefined
              : current.taskRouting.findCandidate.source.providerPoolId,
          ),
          vibe: routeWithProviderPool(
            current.taskRouting.findCandidate.vibe,
            current.taskRouting.findCandidate.vibe.providerPoolId === poolId
              ? undefined
              : current.taskRouting.findCandidate.vibe.providerPoolId,
          ),
          throttling: current.taskRouting.findCandidate.throttling,
        },
        webSourceResearch: routeWithProviderPool(
          current.taskRouting.webSourceResearch,
          current.taskRouting.webSourceResearch.providerPoolId === poolId
            ? undefined
            : current.taskRouting.webSourceResearch.providerPoolId,
        ),
        episodeDistiller: routeWithProviderPool(
          current.taskRouting.episodeDistiller,
          current.taskRouting.episodeDistiller.providerPoolId === poolId
            ? undefined
            : current.taskRouting.episodeDistiller.providerPoolId,
        ),
        coverEvidence: {
          sourceSupport: routeWithProviderPool(
            current.taskRouting.coverEvidence.sourceSupport,
            current.taskRouting.coverEvidence.sourceSupport.providerPoolId === poolId
              ? undefined
              : current.taskRouting.coverEvidence.sourceSupport.providerPoolId,
          ),
          externalEvidence: routeWithProviderPool(
            current.taskRouting.coverEvidence.externalEvidence,
            current.taskRouting.coverEvidence.externalEvidence.providerPoolId === poolId
              ? undefined
              : current.taskRouting.coverEvidence.externalEvidence.providerPoolId,
          ),
          mcpEvidence: routeWithProviderPool(
            current.taskRouting.coverEvidence.mcpEvidence,
            current.taskRouting.coverEvidence.mcpEvidence.providerPoolId === poolId
              ? undefined
              : current.taskRouting.coverEvidence.mcpEvidence.providerPoolId,
          ),
        },
        finalizeDistille: routeWithProviderPool(
          current.taskRouting.finalizeDistille,
          current.taskRouting.finalizeDistille.providerPoolId === poolId
            ? undefined
            : current.taskRouting.finalizeDistille.providerPoolId,
        ),
        mergeActivationFinalize: routeWithProviderPool(
          current.taskRouting.mergeActivationFinalize,
          current.taskRouting.mergeActivationFinalize.providerPoolId === poolId
            ? undefined
            : current.taskRouting.mergeActivationFinalize.providerPoolId,
        ),
        deadZoneMergeReview: routeWithProviderPool(
          current.taskRouting.deadZoneMergeReview,
          current.taskRouting.deadZoneMergeReview.providerPoolId === poolId
            ? undefined
            : current.taskRouting.deadZoneMergeReview.providerPoolId,
        ),
        landscapeCuration: routeWithProviderPool(
          current.taskRouting.landscapeCuration,
          current.taskRouting.landscapeCuration.providerPoolId === poolId
            ? undefined
            : current.taskRouting.landscapeCuration.providerPoolId,
        ),
        agenticCompile: current.taskRouting.agenticCompile,
      },
    }));

  const setTargetEnabled = (pool: RuntimeProviderPool, targetId: string, enabled: boolean) =>
    patchDraft((current) => {
      const nonLocalTargets = pool.targets.filter((target) => !isLocalLlmPoolTarget(target));
      const ids = new Set(
        pool.targets.filter(isLocalLlmPoolTarget).map((target) => target.localLlmModelId),
      );
      if (enabled) {
        ids.add(targetId);
      } else if (pool.targets.length > 1) {
        ids.delete(targetId);
      }
      const targets = [
        ...nonLocalTargets,
        ...[...ids].map((localLlmModelId) => ({
          provider: "local-llm" as const,
          localLlmModelId,
        })),
      ];
      const nextPool = {
        ...pool,
        label: pool.label.trim() || pool.id,
        targets,
        maxConcurrent: Math.min(Math.max(1, pool.maxConcurrent), targets.length),
      };
      return {
        ...current,
        providerPools: current.providerPools.some((item) => item.id === pool.id)
          ? current.providerPools.map((item) => (item.id === pool.id ? nextPool : item))
          : [...current.providerPools, nextPool],
      };
    });

  const addPool = () =>
    patchDraft((current) => {
      const firstTarget = current.providers["local-llm"].models
        .map(localLlmPoolTargetId)
        .find((id): id is string => Boolean(id));
      if (!firstTarget) return current;
      const existingIds = new Set(current.providerPools.map((pool) => pool.id));
      let index = current.providerPools.length + 1;
      let id = `local-llm-pool-${index}`;
      while (existingIds.has(id)) {
        index += 1;
        id = `local-llm-pool-${index}`;
      }
      return {
        ...current,
        providerPools: [
          ...current.providerPools,
          {
            id,
            label: `Local LLM Pool ${index}`,
            enabled: true,
            targets: [{ provider: "local-llm", localLlmModelId: firstTarget }],
            maxConcurrent: 1,
            staleLeaseSeconds: 660,
            lowPriorityAgingSeconds: 1800,
          },
        ],
      };
    });

  return (
    <section className="settings-route-section">
      <div className="settings-route-section-header">
        <h3>Local LLM Pools</h3>
        <p>Choose which Local LLM endpoints belong to each named routing pool.</p>
        <Button type="button" size="sm" variant="outline" onClick={addPool} disabled={!canAddPool}>
          <Plus size={14} />
          Add Pool
        </Button>
      </div>
      {localModels.length === 0 ? (
        <div className="settings-route-row">
          <div className="settings-route-header">
            <div className="settings-route-label">No Local LLM endpoints</div>
            <p className="settings-route-description">
              Add a Local LLM endpoint with an endpoint URL and model before creating a pool.
            </p>
          </div>
        </div>
      ) : null}
      {poolList.map((pool) => {
        const selectedTargetIds = new Set(
          pool.targets.filter(isLocalLlmPoolTarget).map((target) => target.localLlmModelId),
        );
        const targetCount = pool.targets.length;
        const concurrencyLimit = Math.max(1, targetCount);
        const displayedMaxConcurrent = Math.min(Math.max(1, pool.maxConcurrent), concurrencyLimit);
        return (
          <div key={pool.id} className="settings-route-row">
            <div className="settings-route-header">
              <div className="settings-route-label">{pool.id}</div>
              <p className="settings-route-description">
                Active endpoints define the maximum number of concurrent queue leases.
              </p>
            </div>
            <div className="settings-route-fields settings-route-fields-pool">
              <label className="settings-field">
                <span>Pool Name</span>
                <Input
                  value={pool.label}
                  onChange={(event) => patchPool(pool.id, { ...pool, label: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>Queue Pool Concurrent Jobs</span>
                <Input
                  type="number"
                  min={1}
                  max={concurrencyLimit}
                  value={displayedMaxConcurrent}
                  disabled={targetCount === 0}
                  onChange={(event) => {
                    const next = parseIntegerInput(event.target.value, pool.maxConcurrent);
                    patchPool(pool.id, {
                      ...pool,
                      maxConcurrent: Math.max(1, Math.min(concurrencyLimit, next)),
                    });
                  }}
                />
              </label>
              <label className="settings-field">
                <span>Stale Lease Seconds</span>
                <Input
                  type="number"
                  min={30}
                  value={pool.staleLeaseSeconds}
                  onChange={(event) =>
                    patchPool(pool.id, {
                      ...pool,
                      staleLeaseSeconds: Math.max(
                        30,
                        parseIntegerInput(event.target.value, pool.staleLeaseSeconds),
                      ),
                    })
                  }
                />
              </label>
              <label className="settings-field">
                <span>Aging Seconds</span>
                <Input
                  type="number"
                  min={60}
                  value={pool.lowPriorityAgingSeconds}
                  onChange={(event) =>
                    patchPool(pool.id, {
                      ...pool,
                      lowPriorityAgingSeconds: Math.max(
                        60,
                        parseIntegerInput(event.target.value, pool.lowPriorityAgingSeconds),
                      ),
                    })
                  }
                />
              </label>
              <label className="settings-check">
                <Checkbox
                  checked={pool.enabled}
                  onChange={(event) =>
                    patchPool(pool.id, { ...pool, enabled: event.target.checked })
                  }
                />
                Enabled
              </label>
              {pool.id !== localLlmDefaultProviderPoolId ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => removePool(pool.id)}
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              ) : null}
            </div>
            <div className="settings-provider-pool-targets">
              {localModels.map((model) => {
                const checked = Boolean(model.id && selectedTargetIds.has(model.id));
                const disabled = !model.id || (checked && targetCount <= 1);
                return (
                  <label
                    key={`${pool.id}:${model.index}:${model.label}`}
                    className="settings-provider-pool-target"
                  >
                    <Checkbox
                      aria-label={`Use ${model.label} for ${pool.label || pool.id}`}
                      checked={checked}
                      disabled={disabled}
                      onChange={(event) => {
                        if (!model.id) return;
                        setTargetEnabled(pool, model.id, event.target.checked);
                      }}
                    />
                    <span>{model.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="settings-route-chain" aria-label={`${pool.label} capacity`}>
              <span className="settings-route-chain-item">
                <strong>Targets</strong>
                {targetCount}
              </span>
              <span className="settings-route-chain-item">
                <strong>Concurrent</strong>
                {displayedMaxConcurrent}
              </span>
            </div>
          </div>
        );
      })}
    </section>
  );
}
