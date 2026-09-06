import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Plus, Stethoscope, Trash2 } from "lucide-react";
import type { RuntimeSettingsEditable } from "../../repositories/admin.repository";
import { CodexActionGuide } from "./codex-action-guide";
import { ProviderHealthBadge, SecretStatusBadge } from "./settings-controls";
import { syncAzureOpenAiProviderForDraft, syncLocalLlmProviderForDraft } from "./settings-form";
import {
  type ProviderEndpointKind,
  azureOpenAiSecretKey,
  emptyRuntimeSecretStatus,
  localLlmSecretKey,
  parseIntegerInput,
} from "./settings-primitives";
import { localLlmRouteTargetValue } from "./settings-routing";
import type { SettingsController } from "./use-settings-controller";

function isLarmConnectionReferenced(settings: RuntimeSettingsEditable, connectionId: string) {
  if (!connectionId) return false;
  const routes = [
    settings.taskRouting.findCandidate.source,
    settings.taskRouting.findCandidate.vibe,
    settings.taskRouting.webSourceResearch,
    settings.taskRouting.episodeDistiller,
    settings.taskRouting.coverEvidence.sourceSupport,
    settings.taskRouting.coverEvidence.externalEvidence,
    settings.taskRouting.coverEvidence.mcpEvidence,
    settings.taskRouting.deadZoneMergeReview,
    settings.taskRouting.landscapeCuration,
    settings.taskRouting.finalizeDistille,
    settings.taskRouting.mergeActivationFinalize,
  ];
  return (
    routes.some(
      (route) => route.kind === "larm-agent-connection" && route.connectionId === connectionId,
    ) ||
    settings.providerPools.some((pool) =>
      pool.targets.some(
        (target) =>
          target.provider === "larm-agent-connection" && target.connectionId === connectionId,
      ),
    )
  );
}

function hasLarmConnectionReferences(settings: RuntimeSettingsEditable) {
  return settings.providers["larm-agent-connection"].connections.some((connection) =>
    isLarmConnectionReferenced(settings, connection.id),
  );
}

type Props = Pick<
  SettingsController,
  | "azureDeploymentHealth"
  | "azureDeploymentTestMutation"
  | "codexAuthQuery"
  | "draft"
  | "formatDateTime"
  | "getLoginCommandMutation"
  | "localLlmModelHealth"
  | "localLlmModelTestMutation"
  | "loginCommand"
  | "patchDraft"
  | "providerHealth"
  | "providerTestMutation"
  | "renderSecretEditor"
  | "sourceView"
>;
export function ProviderEndpointsPanel({
  azureDeploymentHealth,
  azureDeploymentTestMutation,
  codexAuthQuery,
  draft,
  formatDateTime,
  getLoginCommandMutation,
  localLlmModelHealth,
  localLlmModelTestMutation,
  loginCommand,
  patchDraft,
  providerHealth,
  providerTestMutation,
  renderSecretEditor,
  sourceView,
}: Props) {
  if (!draft) return null;

  const updateAzureDeployment = (
    index: number,
    patch: Partial<RuntimeSettingsEditable["providers"]["azure-openai"]["deployments"][number]>,
  ) =>
    patchDraft((current) => {
      const deployments = current.providers["azure-openai"].deployments.map(
        (deployment, itemIndex) => (itemIndex === index ? { ...deployment, ...patch } : deployment),
      );
      return {
        ...current,
        providers: {
          ...current.providers,
          "azure-openai": syncAzureOpenAiProviderForDraft(
            current.providers["azure-openai"],
            deployments,
          ),
        },
      };
    });

  const updateLocalLlmModel = (
    index: number,
    patch: Partial<RuntimeSettingsEditable["providers"]["local-llm"]["models"][number]>,
  ) =>
    patchDraft((current) => {
      const models = current.providers["local-llm"].models.map((model, itemIndex) =>
        itemIndex === index ? { ...model, ...patch } : model,
      );
      return {
        ...current,
        providers: {
          ...current.providers,
          "local-llm": syncLocalLlmProviderForDraft(current.providers["local-llm"], models),
        },
      };
    });

  const updateLarmConnection = (
    index: number,
    patch: Partial<
      RuntimeSettingsEditable["providers"]["larm-agent-connection"]["connections"][number]
    >,
  ) =>
    patchDraft((current) => {
      const previousId = current.providers["larm-agent-connection"].connections[index]?.id;
      const nextId = patch.id;
      const replaceId = <T extends RuntimeSettingsEditable["taskRouting"]["episodeDistiller"]>(
        route: T,
      ): T =>
        (previousId &&
        typeof nextId === "string" &&
        nextId !== previousId &&
        route.kind === "larm-agent-connection" &&
        route.connectionId === previousId
          ? { ...route, connectionId: nextId }
          : route) as T;
      const shouldReplaceId = Boolean(
        previousId && typeof nextId === "string" && nextId !== previousId,
      );
      return {
        ...current,
        providers: {
          ...current.providers,
          "larm-agent-connection": {
            ...current.providers["larm-agent-connection"],
            connections: current.providers["larm-agent-connection"].connections.map(
              (connection, itemIndex) =>
                itemIndex === index ? { ...connection, ...patch } : connection,
            ),
          },
        },
        providerPools: shouldReplaceId
          ? current.providerPools.map((pool) => ({
              ...pool,
              targets: pool.targets.map((target) =>
                target.provider === "larm-agent-connection" && target.connectionId === previousId
                  ? { ...target, connectionId: nextId as string }
                  : target,
              ),
            }))
          : current.providerPools,
        taskRouting: shouldReplaceId
          ? {
              ...current.taskRouting,
              findCandidate: {
                ...current.taskRouting.findCandidate,
                source: replaceId(current.taskRouting.findCandidate.source),
                vibe: replaceId(current.taskRouting.findCandidate.vibe),
              },
              webSourceResearch: replaceId(current.taskRouting.webSourceResearch),
              episodeDistiller: replaceId(current.taskRouting.episodeDistiller),
              coverEvidence: {
                sourceSupport: replaceId(current.taskRouting.coverEvidence.sourceSupport),
                externalEvidence: replaceId(current.taskRouting.coverEvidence.externalEvidence),
                mcpEvidence: replaceId(current.taskRouting.coverEvidence.mcpEvidence),
              },
              deadZoneMergeReview: replaceId(current.taskRouting.deadZoneMergeReview),
              landscapeCuration: replaceId(current.taskRouting.landscapeCuration),
              finalizeDistille: replaceId(current.taskRouting.finalizeDistille),
              mergeActivationFinalize: replaceId(current.taskRouting.mergeActivationFinalize),
            }
          : current.taskRouting,
      };
    });

  const endpointKindOptions = () => (
    <>
      <option value="openai">OpenAI</option>
      <option value="azure-openai">Azure OpenAI</option>
      <option value="bedrock">AWS Bedrock</option>
      <option value="local-llm">Local LLM</option>
    </>
  );

  const addLocalEndpoint = (
    current: RuntimeSettingsEditable,
    input: { name: string; apiBaseUrl?: string; apiPath?: string; model?: string },
  ): RuntimeSettingsEditable["providers"]["local-llm"] =>
    syncLocalLlmProviderForDraft(current.providers["local-llm"], [
      ...current.providers["local-llm"].models,
      {
        name: input.name,
        apiBaseUrl: input.apiBaseUrl ?? "",
        apiPath: input.apiPath || current.providers["local-llm"].apiPath || "/v1/chat/completions",
        model: input.model ?? "",
      },
    ]);

  const addAzureEndpoint = (
    current: RuntimeSettingsEditable,
    input: { name: string; apiBaseUrl?: string; model?: string },
  ): RuntimeSettingsEditable["providers"]["azure-openai"] =>
    syncAzureOpenAiProviderForDraft(current.providers["azure-openai"], [
      ...current.providers["azure-openai"].deployments,
      {
        name: input.name,
        apiBaseUrl: input.apiBaseUrl ?? "",
        apiPath: current.providers["azure-openai"].apiPath || "/openai/deployments",
        apiVersion: current.providers["azure-openai"].apiVersion || "2025-04-01-preview",
        model: input.model ?? "",
      },
    ]);

  const convertOpenAiEndpointTo = (kind: ProviderEndpointKind) => {
    if (kind === "openai") return;
    patchDraft((current) => {
      const source = current.providers.openai;
      const providers = {
        ...current.providers,
        openai: { ...source, enabled: false },
      };
      if (kind === "local-llm") {
        providers["local-llm"] = addLocalEndpoint(current, {
          name: "OpenAI",
          apiBaseUrl: source.apiBaseUrl,
          model: source.model,
        });
      } else if (kind === "azure-openai") {
        providers["azure-openai"] = addAzureEndpoint(current, {
          name: "OpenAI",
          apiBaseUrl: source.apiBaseUrl,
          model: source.model,
        });
      } else if (kind === "bedrock") {
        providers.bedrock = {
          ...current.providers.bedrock,
          enabled: true,
          model: source.model || current.providers.bedrock.model,
        };
      }
      return { ...current, providers };
    });
  };

  const convertBedrockEndpointTo = (kind: ProviderEndpointKind) => {
    if (kind === "bedrock") return;
    patchDraft((current) => {
      const source = current.providers.bedrock;
      const providers = {
        ...current.providers,
        bedrock: { ...source, enabled: false },
      };
      if (kind === "local-llm") {
        providers["local-llm"] = addLocalEndpoint(current, {
          name: "AWS Bedrock",
          model: source.model,
        });
      } else if (kind === "azure-openai") {
        providers["azure-openai"] = addAzureEndpoint(current, {
          name: "AWS Bedrock",
          model: source.model,
        });
      } else if (kind === "openai") {
        providers.openai = {
          ...current.providers.openai,
          enabled: true,
          model: source.model || current.providers.openai.model,
        };
      }
      return { ...current, providers };
    });
  };

  const addEndpoint = () =>
    patchDraft((current) => {
      const models = current.providers["local-llm"].models;
      const nextIndex = models.length;
      return {
        ...current,
        providers: {
          ...current.providers,
          "local-llm": syncLocalLlmProviderForDraft(current.providers["local-llm"], [
            ...models,
            {
              name: `Local LLM ${nextIndex + 1}`,
              apiBaseUrl: "",
              apiPath: current.providers["local-llm"].apiPath || "/v1/chat/completions",
              model: "",
            },
          ]),
        },
      };
    });

  const addLarmConnection = () =>
    patchDraft((current) => {
      const connections = current.providers["larm-agent-connection"].connections;
      const existingIds = new Set(connections.map((connection) => connection.id));
      let suffix = connections.length + 1;
      let id = suffix === 1 ? "contextstill-background" : `contextstill-background-${suffix}`;
      while (existingIds.has(id)) {
        suffix += 1;
        id = `contextstill-background-${suffix}`;
      }
      return {
        ...current,
        providers: {
          ...current.providers,
          "larm-agent-connection": {
            enabled: true,
            connections: [
              ...connections,
              {
                id,
                controlBaseUrl: "http://192.168.0.130:9810",
                agentProfile: "contextstill-background",
                audience: "saaa-desktop",
                availabilityPollMs: 5_000,
                availabilityTimeoutMs: 2_000,
                controlTimeoutMs: 5_000,
                readyTimeoutMs: 180_000,
                ttlSeconds: 900,
                requestTimeoutMs: 300_000,
              },
            ],
          },
        },
      };
    });

  const convertAzureEndpointTo = (index: number, kind: ProviderEndpointKind) =>
    patchDraft((current) => {
      const deployment = current.providers["azure-openai"].deployments[index];
      if (!deployment || kind === "azure-openai") return current;
      const nextAzureDeployments = current.providers["azure-openai"].deployments.filter(
        (_deployment, deploymentIndex) => deploymentIndex !== index,
      );
      const providers = {
        ...current.providers,
        "azure-openai": syncAzureOpenAiProviderForDraft(
          current.providers["azure-openai"],
          nextAzureDeployments,
        ),
      };
      if (kind === "local-llm") {
        providers["local-llm"] = addLocalEndpoint(current, {
          name: deployment.name || `Local LLM ${current.providers["local-llm"].models.length + 1}`,
          apiBaseUrl: deployment.apiBaseUrl,
          model: deployment.model,
        });
      } else if (kind === "openai") {
        providers.openai = {
          ...current.providers.openai,
          enabled: true,
          apiBaseUrl: deployment.apiBaseUrl || current.providers.openai.apiBaseUrl,
          model: deployment.model || current.providers.openai.model,
        };
      } else if (kind === "bedrock") {
        providers.bedrock = {
          ...current.providers.bedrock,
          enabled: true,
          model: deployment.model || current.providers.bedrock.model,
        };
      }
      return {
        ...current,
        providers,
      };
    });

  const convertLocalEndpointTo = (index: number, kind: ProviderEndpointKind) =>
    patchDraft((current) => {
      const model = current.providers["local-llm"].models[index];
      if (!model || kind === "local-llm") return current;
      const nextLocalModels = current.providers["local-llm"].models.filter(
        (_model, modelIndex) => modelIndex !== index,
      );
      const providers = {
        ...current.providers,
        "local-llm": syncLocalLlmProviderForDraft(current.providers["local-llm"], nextLocalModels),
      };
      if (kind === "azure-openai") {
        providers["azure-openai"] = addAzureEndpoint(current, {
          name:
            model.name || `Deployment ${current.providers["azure-openai"].deployments.length + 1}`,
          apiBaseUrl: model.apiBaseUrl,
          model: model.model,
        });
      } else if (kind === "openai") {
        providers.openai = {
          ...current.providers.openai,
          enabled: true,
          apiBaseUrl: model.apiBaseUrl || current.providers.openai.apiBaseUrl,
          model: model.model || current.providers.openai.model,
        };
      } else if (kind === "bedrock") {
        providers.bedrock = {
          ...current.providers.bedrock,
          enabled: true,
          model: model.model || current.providers.bedrock.model,
        };
      }
      return {
        ...current,
        providers,
      };
    });

  return (
    <section className="settings-provider-endpoints">
      <div className="settings-provider-endpoints-header">
        <div>
          <h2>Provider Endpoints</h2>
          <p>LLM provider endpoints and credentials. Task Routing selects from these endpoints.</p>
        </div>
        <div className="settings-provider-endpoints-actions">
          <Button type="button" size="sm" variant="outline" onClick={addEndpoint}>
            <Plus size={14} />
            Add Endpoint
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={addLarmConnection}>
            <Plus size={14} />
            Add LARM Connection
          </Button>
        </div>
      </div>

      <div className="settings-provider-endpoint-list">
        {draft.providers.openai.enabled ? (
          <div className="settings-provider-endpoint-card">
            <div className="settings-provider-endpoint-top">
              <div className="settings-provider-endpoint-title">
                <strong>OpenAI</strong>
                <span>OpenAI</span>
              </div>
              <div className="settings-provider-actions">
                <label className="settings-check">
                  <Checkbox
                    checked={draft.providers.openai.enabled}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          openai: { ...current.providers.openai, enabled: event.target.checked },
                        },
                      }))
                    }
                  />
                  Enabled
                </label>
                <ProviderHealthBadge health={providerHealth.openai} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => providerTestMutation.mutate("openai")}
                  disabled={providerTestMutation.isPending}
                >
                  <Stethoscope size={14} />
                  Health
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        openai: { ...current.providers.openai, enabled: false },
                      },
                    }))
                  }
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </div>
            <div className="settings-provider-endpoint-fields">
              <label className="settings-field">
                <span>Kind</span>
                <Select
                  value="openai"
                  onChange={(event) =>
                    convertOpenAiEndpointTo(event.target.value as ProviderEndpointKind)
                  }
                >
                  {endpointKindOptions()}
                </Select>
              </label>
              <label className="settings-field">
                <span>Endpoint</span>
                <Input
                  value={draft.providers.openai.apiBaseUrl}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        openai: {
                          ...current.providers.openai,
                          apiBaseUrl: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Models</span>
                <Input
                  value={draft.providers.openai.model}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        openai: { ...current.providers.openai, model: event.target.value },
                      },
                    }))
                  }
                />
              </label>
            </div>
            {sourceView
              ? renderSecretEditor(
                  "openaiApiKey",
                  "API Key",
                  sourceView.providers.openai.apiKeySecret,
                )
              : null}
          </div>
        ) : null}

        {draft.providers["azure-openai"].deployments.map((deployment, index) => {
          const secretKey = azureOpenAiSecretKey(index);
          const secretStatus =
            secretKey && sourceView
              ? (sourceView.providers["azure-openai"].apiKeySecrets[index] ??
                emptyRuntimeSecretStatus())
              : null;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Endpoint rows are controlled inputs; value-derived keys remount rows while editing.
            <div key={`azure-openai:${index}`} className="settings-provider-endpoint-card">
              <div className="settings-provider-endpoint-top">
                <div className="settings-provider-endpoint-title">
                  <strong>{deployment.name || `Deployment ${index + 1}`}</strong>
                  <span>Azure OpenAI</span>
                </div>
                <div className="settings-provider-actions">
                  <label className="settings-check">
                    <Checkbox
                      checked={draft.providers["azure-openai"].enabled}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          providers: {
                            ...current.providers,
                            "azure-openai": {
                              ...current.providers["azure-openai"],
                              enabled: event.target.checked,
                            },
                          },
                        }))
                      }
                    />
                    Enabled
                  </label>
                  <ProviderHealthBadge health={azureDeploymentHealth[index]} />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => azureDeploymentTestMutation.mutate(index)}
                    disabled={azureDeploymentTestMutation.isPending}
                  >
                    <Stethoscope size={14} />
                    Health
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          "azure-openai": syncAzureOpenAiProviderForDraft(
                            current.providers["azure-openai"],
                            current.providers["azure-openai"].deployments.filter(
                              (_deployment, deploymentIndex) => deploymentIndex !== index,
                            ),
                          ),
                        },
                      }))
                    }
                  >
                    <Trash2 size={14} />
                    Delete
                  </Button>
                </div>
              </div>
              <div className="settings-provider-endpoint-fields">
                <label className="settings-field">
                  <span>Name</span>
                  <Input
                    value={deployment.name}
                    onChange={(event) => updateAzureDeployment(index, { name: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Kind</span>
                  <Select
                    value="azure-openai"
                    onChange={(event) => {
                      convertAzureEndpointTo(index, event.target.value as ProviderEndpointKind);
                    }}
                  >
                    {endpointKindOptions()}
                  </Select>
                </label>
                <label className="settings-field">
                  <span>Endpoint</span>
                  <Input
                    value={deployment.apiBaseUrl}
                    onChange={(event) =>
                      updateAzureDeployment(index, { apiBaseUrl: event.target.value })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>API Version</span>
                  <Input
                    value={deployment.apiVersion}
                    onChange={(event) =>
                      updateAzureDeployment(index, { apiVersion: event.target.value })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>API Path</span>
                  <Input
                    value={deployment.apiPath}
                    onChange={(event) =>
                      updateAzureDeployment(index, { apiPath: event.target.value })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>Models</span>
                  <Input
                    value={deployment.model}
                    onChange={(event) =>
                      updateAzureDeployment(index, { model: event.target.value })
                    }
                  />
                </label>
              </div>
              {secretKey && secretStatus ? (
                renderSecretEditor(secretKey, `API Key ${index + 1}`, secretStatus)
              ) : (
                <div className="settings-secret-row">
                  <div className="settings-secret-meta">
                    <strong>API Key</strong>
                    <div className="settings-secret-status">
                      <span>uses primary Azure OpenAI API key</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {draft.providers["local-llm"].models.map((model, index) => {
          const routeValue = localLlmRouteTargetValue(model);
          const secretKey = localLlmSecretKey(index);
          const secretStatus = sourceView
            ? (sourceView.providers["local-llm"].apiKeySecrets[index] ?? emptyRuntimeSecretStatus())
            : null;
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: Endpoint rows are controlled inputs; value-derived keys remount rows while editing.
              key={`local-llm:${index}`}
              className="settings-provider-endpoint-card settings-local-llm-model"
            >
              <div className="settings-provider-endpoint-top">
                <div className="settings-provider-endpoint-title">
                  <strong>{model.name || `Local LLM ${index + 1}`}</strong>
                  <span>Local LLM</span>
                </div>
                <div className="settings-provider-actions">
                  <label className="settings-check">
                    <Checkbox
                      checked={draft.providers["local-llm"].enabled}
                      onChange={(event) =>
                        patchDraft((current) => ({
                          ...current,
                          providers: {
                            ...current.providers,
                            "local-llm": {
                              ...current.providers["local-llm"],
                              enabled: event.target.checked,
                            },
                          },
                        }))
                      }
                    />
                    Enabled
                  </label>
                  <ProviderHealthBadge health={localLlmModelHealth[routeValue]} />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => localLlmModelTestMutation.mutate(routeValue)}
                    disabled={!model.model.trim() || localLlmModelTestMutation.isPending}
                  >
                    <Stethoscope size={14} />
                    Health
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          "local-llm": syncLocalLlmProviderForDraft(
                            current.providers["local-llm"],
                            current.providers["local-llm"].models.filter(
                              (_model, modelIndex) => modelIndex !== index,
                            ),
                          ),
                        },
                      }))
                    }
                  >
                    <Trash2 size={14} />
                    Delete
                  </Button>
                </div>
              </div>
              <div className="settings-provider-endpoint-fields">
                <label className="settings-field">
                  <span>Name</span>
                  <Input
                    value={model.name}
                    onChange={(event) => updateLocalLlmModel(index, { name: event.target.value })}
                  />
                </label>
                <label className="settings-field">
                  <span>Kind</span>
                  <Select
                    value="local-llm"
                    onChange={(event) => {
                      convertLocalEndpointTo(index, event.target.value as ProviderEndpointKind);
                    }}
                  >
                    {endpointKindOptions()}
                  </Select>
                </label>
                <label className="settings-field">
                  <span>Endpoint</span>
                  <Input
                    value={model.apiBaseUrl}
                    onChange={(event) =>
                      updateLocalLlmModel(index, { apiBaseUrl: event.target.value })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>API Path</span>
                  <Input
                    value={model.apiPath}
                    onChange={(event) =>
                      updateLocalLlmModel(index, { apiPath: event.target.value })
                    }
                  />
                </label>
                <label className="settings-field">
                  <span>Models</span>
                  <Input
                    value={model.model}
                    onChange={(event) => updateLocalLlmModel(index, { model: event.target.value })}
                  />
                </label>
              </div>
              {secretStatus
                ? renderSecretEditor(secretKey, `API Key ${index + 1}`, secretStatus)
                : null}
            </div>
          );
        })}

        {draft.providers["larm-agent-connection"].connections.map((connection, index) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: Connection ids are editable controlled inputs.
            key={`larm-agent-connection:${index}`}
            className="settings-provider-endpoint-card"
          >
            <div className="settings-provider-endpoint-top">
              <div className="settings-provider-endpoint-title">
                <strong>{connection.id || `LARM Connection ${index + 1}`}</strong>
                <span>LARM Agent Connection</span>
              </div>
              <div className="settings-provider-actions">
                <label className="settings-check">
                  <Checkbox
                    checked={draft.providers["larm-agent-connection"].enabled}
                    disabled={
                      draft.providers["larm-agent-connection"].enabled &&
                      hasLarmConnectionReferences(draft)
                    }
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          "larm-agent-connection": {
                            ...current.providers["larm-agent-connection"],
                            enabled: event.target.checked,
                          },
                        },
                      }))
                    }
                  />
                  Enabled
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isLarmConnectionReferenced(draft, connection.id)}
                  title={
                    isLarmConnectionReferenced(draft, connection.id)
                      ? "Reassign routes and provider pools before deleting this connection."
                      : undefined
                  }
                  onClick={() =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        "larm-agent-connection": {
                          ...current.providers["larm-agent-connection"],
                          connections: current.providers[
                            "larm-agent-connection"
                          ].connections.filter((_item, itemIndex) => itemIndex !== index),
                        },
                      },
                    }))
                  }
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </div>
            <div className="settings-provider-endpoint-fields">
              <label className="settings-field">
                <span>Connection ID</span>
                <Input
                  value={connection.id}
                  onChange={(event) => updateLarmConnection(index, { id: event.target.value })}
                />
              </label>
              <label className="settings-field">
                <span>Control Endpoint</span>
                <Input
                  value={connection.controlBaseUrl}
                  onChange={(event) =>
                    updateLarmConnection(index, { controlBaseUrl: event.target.value })
                  }
                />
              </label>
              <label className="settings-field">
                <span>Agent Profile</span>
                <Input
                  value={connection.agentProfile}
                  onChange={(event) =>
                    updateLarmConnection(index, { agentProfile: event.target.value })
                  }
                />
              </label>
              <label className="settings-field">
                <span>Audience</span>
                <Input
                  value={connection.audience}
                  onChange={(event) =>
                    updateLarmConnection(index, { audience: event.target.value })
                  }
                />
              </label>
              {(
                [
                  ["Availability Poll (ms)", "availabilityPollMs", 1_000],
                  ["Availability Timeout (ms)", "availabilityTimeoutMs", 250],
                  ["Control Timeout (ms)", "controlTimeoutMs", 250],
                  ["Ready Timeout (ms)", "readyTimeoutMs", 1_000],
                  ["TTL (seconds)", "ttlSeconds", 60],
                  ["Request Timeout (ms)", "requestTimeoutMs", 1_000],
                ] as const
              ).map(([label, key, minimum]) => (
                <label key={key} className="settings-field">
                  <span>{label}</span>
                  <Input
                    type="number"
                    min={minimum}
                    value={connection[key]}
                    onChange={(event) =>
                      updateLarmConnection(index, {
                        [key]: Math.max(
                          minimum,
                          parseIntegerInput(event.target.value, connection[key]),
                        ),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <div className="settings-route-chain">
              <span className="settings-route-chain-item">
                <strong>Integration status</strong>
                The Rust resident polls availability and claims this connection only while routed
                queue work is due.
              </span>
            </div>
          </div>
        ))}

        {draft.providers.bedrock.enabled ? (
          <div className="settings-provider-endpoint-card">
            <div className="settings-provider-endpoint-top">
              <div className="settings-provider-endpoint-title">
                <strong>AWS Bedrock</strong>
                <span>AWS Bedrock</span>
              </div>
              <div className="settings-provider-actions">
                <label className="settings-check">
                  <Checkbox
                    checked={draft.providers.bedrock.enabled}
                    onChange={(event) =>
                      patchDraft((current) => ({
                        ...current,
                        providers: {
                          ...current.providers,
                          bedrock: {
                            ...current.providers.bedrock,
                            enabled: event.target.checked,
                          },
                        },
                      }))
                    }
                  />
                  Enabled
                </label>
                <ProviderHealthBadge health={providerHealth.bedrock} />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => providerTestMutation.mutate("bedrock")}
                  disabled={providerTestMutation.isPending}
                >
                  <Stethoscope size={14} />
                  Health
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, enabled: false },
                      },
                    }))
                  }
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </div>
            <div className="settings-provider-endpoint-fields">
              <label className="settings-field">
                <span>Kind</span>
                <Select
                  value="bedrock"
                  onChange={(event) =>
                    convertBedrockEndpointTo(event.target.value as ProviderEndpointKind)
                  }
                >
                  {endpointKindOptions()}
                </Select>
              </label>
              <label className="settings-field">
                <span>Region</span>
                <Input
                  value={draft.providers.bedrock.region}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, region: event.target.value },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Profile</span>
                <Input
                  value={draft.providers.bedrock.profile}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, profile: event.target.value },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Models</span>
                <Input
                  value={draft.providers.bedrock.model}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        bedrock: { ...current.providers.bedrock, model: event.target.value },
                      },
                    }))
                  }
                />
              </label>
            </div>
            {sourceView ? (
              <div className="settings-secret-row">
                <div className="settings-secret-meta">
                  <strong>Credential Status</strong>
                  <div className="settings-secret-status">
                    <SecretStatusBadge status={sourceView.providers.bedrock.credentialSecret} />
                    <span>
                      {sourceView.providers.bedrock.credentialSecret.maskedValue ?? "unset"}
                    </span>
                    <span>
                      updated{" "}
                      {formatDateTime(sourceView.providers.bedrock.credentialSecret.updatedAt)}
                    </span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="settings-provider-endpoint-card">
          <div className="settings-provider-endpoint-top">
            <div className="settings-provider-endpoint-title">
              <strong>Codex Auth</strong>
              <span>Codex SDK</span>
            </div>
            <div className="settings-provider-actions">
              <label className="settings-check">
                <Checkbox
                  checked={draft.providers.codex?.enabled ?? false}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      providers: {
                        ...current.providers,
                        codex: { ...current.providers.codex, enabled: event.target.checked },
                      },
                    }))
                  }
                />
                Enabled
              </label>
              {codexAuthQuery.isLoading ? <Badge variant="outline">Checking...</Badge> : null}
              {codexAuthQuery.data ? (
                <Badge
                  variant={
                    codexAuthQuery.data.recommendedAction === "ready"
                      ? "success"
                      : codexAuthQuery.data.tokenInfo?.isExpired
                        ? "destructive"
                        : "warning"
                  }
                >
                  {codexAuthQuery.data.recommendedAction === "ready"
                    ? "Logged in"
                    : codexAuthQuery.data.tokenInfo?.isExpired
                      ? "Token expired"
                      : "Login required"}
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="settings-provider-endpoint-fields">
            <label className="settings-field">
              <span>Name</span>
              <Input value="Codex Auth" readOnly />
            </label>
            <label className="settings-field">
              <span>Kind</span>
              <Select value="codex" disabled>
                <option value="codex">Codex SDK</option>
              </Select>
            </label>
            <label className="settings-field">
              <span>Models</span>
              <Select
                value={draft.providers.codex?.model ?? "codex-sdk-agent"}
                onChange={(event) =>
                  patchDraft((current) => ({
                    ...current,
                    providers: {
                      ...current.providers,
                      codex: { ...current.providers.codex, model: event.target.value },
                    },
                  }))
                }
              >
                <option value="codex-sdk-agent">codex-sdk-agent</option>
                <option value="gpt-5.5">gpt-5.5</option>
                <option value="gpt-5.4-mini">gpt-5.4-mini</option>
                <option value="gpt-5.2-codex">gpt-5.2-codex</option>
              </Select>
            </label>
          </div>
          {codexAuthQuery.data ? (
            <CodexActionGuide
              recommendedAction={codexAuthQuery.data.recommendedAction}
              isExpired={codexAuthQuery.data.tokenInfo?.isExpired ?? false}
              loginCommand={loginCommand}
              onGetCommand={() => getLoginCommandMutation.mutate()}
              isPending={getLoginCommandMutation.isPending}
              onRefresh={() => void codexAuthQuery.refetch()}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}
