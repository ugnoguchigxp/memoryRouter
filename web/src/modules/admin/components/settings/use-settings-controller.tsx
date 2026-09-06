import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDateTime as formatDateTimeTz, useTimezone } from "@/lib/timezone";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type RuntimeProviderHealth,
  type RuntimeProviderName,
  type RuntimeSearchProvider,
  type RuntimeSecretKey,
  type RuntimeSecretStatus,
  type RuntimeSettingsEditable,
  fetchCodexAuthStatus,
  fetchCodexLoginCommand,
  fetchRuntimeSettings,
  reloadRuntimeSettingsCache,
  testAzureOpenAiDeployment,
  testLocalLlmModel,
  testRuntimeProvider,
  updateRuntimeSettings,
} from "../../repositories/admin.repository";
import { SecretStatusBadge } from "./settings-controls";
import {
  buildSecretPayload,
  createEmptySecretDraftState,
  prepareSettingsForSave,
  settingsViewToEditable,
} from "./settings-form";
import {
  type DistillationPriorityTargetKind,
  type SecretDraftState,
  millisecondsToSeconds,
  parseIntegerInput,
  parseSecondsToMillisecondsInput,
  resolveActiveSettingsTab,
} from "./settings-primitives";
export function useSettingsController() {
  const tz = useTimezone();
  const formatDateTime = (value: string | null | undefined): string => {
    return formatDateTimeTz(value, tz);
  };
  const queryClient = useQueryClient();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeTab = useMemo(() => resolveActiveSettingsTab(pathname), [pathname]);
  const [draft, setDraft] = useState<RuntimeSettingsEditable | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<SecretDraftState>(createEmptySecretDraftState());
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState<
    Partial<Record<RuntimeProviderName, RuntimeProviderHealth>>
  >({});
  const [azureDeploymentHealth, setAzureDeploymentHealth] = useState<
    Partial<Record<number, RuntimeProviderHealth>>
  >({});
  const [localLlmModelHealth, setLocalLlmModelHealth] = useState<
    Partial<Record<string, RuntimeProviderHealth>>
  >({});
  const settingsQuery = useQuery({
    queryKey: ["runtime-settings"],
    queryFn: () => fetchRuntimeSettings(),
  });
  const codexAuthQuery = useQuery({
    queryKey: ["codex-auth-status"],
    queryFn: () => fetchCodexAuthStatus(),
    enabled: activeTab === "providers",
  });
  const [loginCommand, setLoginCommand] = useState<string | null>(null);
  const getLoginCommandMutation = useMutation({
    mutationFn: () => fetchCodexLoginCommand(),
    onSuccess: (result) => {
      setLoginCommand(result.command);
    },
  });
  const snapshot = settingsQuery.data;
  const sourceView = snapshot?.settings;
  const baseEditable = useMemo(
    () => (sourceView ? settingsViewToEditable(sourceView) : null),
    [sourceView],
  );
  useEffect(() => {
    if (!baseEditable) return;
    setDraft(baseEditable);
    setSecretDrafts(createEmptySecretDraftState());
    setSaveError(null);
    setSaveMessage(null);
    setAzureDeploymentHealth({});
  }, [baseEditable]);
  const hasSettingsDiff = useMemo(() => {
    if (!draft || !baseEditable) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseEditable);
  }, [draft, baseEditable]);
  const hasSecretDiff = useMemo(
    () =>
      (Object.keys(secretDrafts) as RuntimeSecretKey[]).some((key) => {
        const item = secretDrafts[key];
        return Boolean(item?.clear || item?.value.trim().length);
      }),
    [secretDrafts],
  );
  const patchDraft = (
    next: (current: RuntimeSettingsEditable) => RuntimeSettingsEditable,
  ): void => {
    setDraft((current) => (current ? next(current) : current));
  };
  const renderDistillationRuntimeNumberField = ({
    label,
    settingKey,
    min,
    max,
    step,
    parse = parseIntegerInput,
    unit = "raw",
  }: {
    label: string;
    settingKey: keyof RuntimeSettingsEditable["distillationRuntime"];
    min?: number;
    max?: number;
    step?: number;
    parse?: (value: string, fallback: number) => number;
    unit?: "raw" | "secondsFromMilliseconds";
  }) => (
    <label className="settings-field">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={
          unit === "secondsFromMilliseconds"
            ? millisecondsToSeconds(Number(draft?.distillationRuntime[settingKey] ?? 0))
            : (draft?.distillationRuntime[settingKey] ?? 0)
        }
        onChange={(event) =>
          patchDraft((current) => ({
            ...current,
            distillationRuntime: {
              ...current.distillationRuntime,
              [settingKey]:
                unit === "secondsFromMilliseconds"
                  ? parseSecondsToMillisecondsInput(
                      event.target.value,
                      Number(current.distillationRuntime[settingKey]),
                    )
                  : parse(event.target.value, current.distillationRuntime[settingKey]),
            },
          }))
        }
      />
    </label>
  );
  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("settings are not loaded");
      return updateRuntimeSettings({
        settings: prepareSettingsForSave(draft),
        secrets: buildSecretPayload(secretDrafts),
        updatedBy: "admin-ui",
      });
    },
    onSuccess: async (result) => {
      setSaveError(null);
      setSaveMessage(`Saved revision ${result.revision} at ${formatDateTime(result.updatedAt)}.`);
      setSecretDrafts(createEmptySecretDraftState());
      await queryClient.invalidateQueries({ queryKey: ["runtime-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });
  const reloadMutation = useMutation({
    mutationFn: () => reloadRuntimeSettingsCache(),
    onSuccess: async (result) => {
      setSaveError(null);
      setSaveMessage(`Runtime cache reloaded at ${formatDateTime(result.reloadedAt)}.`);
      await queryClient.invalidateQueries({ queryKey: ["runtime-settings"] });
      await queryClient.invalidateQueries({ queryKey: ["doctor"] });
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });
  const providerTestMutation = useMutation({
    mutationFn: (provider: RuntimeProviderName) => testRuntimeProvider(provider),
    onSuccess: (result) => {
      setProviderHealth((current) => ({
        ...current,
        [result.provider]: result.health,
      }));
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });
  const azureDeploymentTestMutation = useMutation({
    mutationFn: (deploymentIndex: number) => testAzureOpenAiDeployment(deploymentIndex),
    onSuccess: (result, deploymentIndex) => {
      setAzureDeploymentHealth((current) => ({
        ...current,
        [deploymentIndex]: result.health,
      }));
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });
  const localLlmModelTestMutation = useMutation({
    mutationFn: (model: string) => testLocalLlmModel(model),
    onSuccess: (result) => {
      setLocalLlmModelHealth((current) => ({
        ...current,
        [result.model]: result.health,
      }));
    },
    onError: (error) => {
      setSaveMessage(null);
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });
  const setSecretValue = (key: RuntimeSecretKey, value: string): void => {
    setSecretDrafts((current) => ({
      ...current,
      [key]: { value, clear: false },
    }));
  };
  const markSecretClear = (key: RuntimeSecretKey): void => {
    setSecretDrafts((current) => ({
      ...current,
      [key]: { value: "", clear: true },
    }));
  };
  const markSecretReplace = (key: RuntimeSecretKey): void => {
    setSecretDrafts((current) => ({
      ...current,
      [key]: { value: current[key]?.value ?? "", clear: false },
    }));
  };
  const renderSecretEditor = (
    key: RuntimeSecretKey,
    label: string,
    status: RuntimeSecretStatus,
  ) => {
    const draftSecret = secretDrafts[key] ?? { value: "", clear: false };
    return (
      <div className="settings-secret-row">
        <div className="settings-secret-meta">
          <strong>{label}</strong>
          <div className="settings-secret-status">
            <SecretStatusBadge status={status} />
            <span>{status.maskedValue ?? "not configured"}</span>
            <span>updated {formatDateTime(status.updatedAt)}</span>
          </div>
        </div>
        <div className="settings-secret-inputs">
          <Input
            type="password"
            aria-label={`${label} value`}
            value={draftSecret.value}
            placeholder="new value"
            onChange={(event) => setSecretValue(key, event.target.value)}
          />
          <Button type="button" size="sm" variant="outline" onClick={() => markSecretReplace(key)}>
            <Save size={14} />
            Replace
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => markSecretClear(key)}
          >
            <Trash2 size={14} />
            Clear
          </Button>
          {draftSecret.clear ? <Badge variant="destructive">pending clear</Badge> : null}
          {draftSecret.value.trim() ? <Badge variant="warning">pending replace</Badge> : null}
        </div>
      </div>
    );
  };
  const moveSearchProvider = (provider: RuntimeSearchProvider, direction: -1 | 1): void => {
    patchDraft((current) => {
      const order = [...current.search.providerOrder];
      const index = order.indexOf(provider);
      if (index < 0) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= order.length) return current;
      const swap = order[nextIndex];
      order[nextIndex] = order[index];
      order[index] = swap;
      return {
        ...current,
        search: {
          ...current.search,
          providerOrder: order,
        },
      };
    });
  };
  const movePriorityTargetKind = (
    kind: DistillationPriorityTargetKind,
    direction: -1 | 1,
  ): void => {
    patchDraft((current) => {
      const order = [...current.general.distillationPriority.targetPriorityOrder];
      const index = order.indexOf(kind);
      if (index < 0) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= order.length) return current;
      const swap = order[nextIndex];
      order[nextIndex] = order[index];
      order[index] = swap;
      return {
        ...current,
        general: {
          ...current.general,
          distillationPriority: {
            ...current.general.distillationPriority,
            targetPriorityOrder: order,
          },
        },
      };
    });
  };
  const settingsStatus: "ok" | "failed" = settingsQuery.isError || saveError ? "failed" : "ok";
  return {
    activeTab,
    azureDeploymentHealth,
    azureDeploymentTestMutation,
    codexAuthQuery,
    draft,
    formatDateTime,
    getLoginCommandMutation,
    hasSecretDiff,
    hasSettingsDiff,
    localLlmModelHealth,
    localLlmModelTestMutation,
    loginCommand,
    movePriorityTargetKind,
    moveSearchProvider,
    patchDraft,
    providerHealth,
    providerTestMutation,
    reloadMutation,
    renderDistillationRuntimeNumberField,
    renderSecretEditor,
    saveError,
    saveMessage,
    saveMutation,
    setSaveError,
    setSaveMessage,
    settingsQuery,
    settingsStatus,
    snapshot,
    sourceView,
  };
}
export type SettingsController = ReturnType<typeof useSettingsController>;
