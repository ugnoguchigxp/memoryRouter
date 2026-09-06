import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@tanstack/react-router";
import { RotateCcw, Save } from "lucide-react";
import { AdminPageHeader } from "../admin-page-header";
import { AdvancedSettingsPanel } from "./advanced-settings-panel";
import { EmbeddingSettingsPanel } from "./embedding-settings-panel";
import { GeneralSettingsPanel } from "./general-settings-panel";
import { LocalLlmPools } from "./local-llm-pools";
import { ProviderEndpointsPanel } from "./provider-endpoints-panel";
import { SearchSettingsPanel } from "./search-settings-panel";
import { ProviderPoolDiagnostics } from "./settings-controls";
import { settingsTabs } from "./settings-primitives";
import { TaskRoutingSettingsPanel } from "./task-routing-settings-panel";
import { useSettingsController } from "./use-settings-controller";
export function SettingsPage() {
  const model = useSettingsController();
  const {
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
  } = model;
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <AdminPageHeader
        title="Settings"
        checkedAtText={formatDateTime(snapshot?.loadedAt)}
        onRefresh={() => {
          void settingsQuery.refetch();
        }}
        refreshDisabled={settingsQuery.isFetching}
        status={settingsStatus}
        rightSlot={
          <div className="settings-header-actions">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => reloadMutation.mutate()}
              disabled={reloadMutation.isPending}
            >
              <RotateCcw size={14} />
              Reload Runtime Cache
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!draft || (!hasSettingsDiff && !hasSecretDiff) || saveMutation.isPending}
            >
              <Save size={14} />
              Save Settings
            </Button>
          </div>
        }
      />

      <div className="settings-layout">
        {settingsQuery.isError ? (
          <Card>
            <CardContent className="metric-card">
              <span className="metric-label text-red-600">Settings API Error</span>
              <strong className="metric-value">
                {settingsQuery.error instanceof Error
                  ? settingsQuery.error.message
                  : "/api/settings response could not be loaded."}
              </strong>
            </CardContent>
          </Card>
        ) : null}

        {saveError ? (
          <Card className="border-red-300">
            <CardContent className="settings-message error">{saveError}</CardContent>
          </Card>
        ) : null}
        {saveMessage ? (
          <Card className="border-emerald-300">
            <CardContent className="settings-message success">{saveMessage}</CardContent>
          </Card>
        ) : null}

        {!draft ? (
          <Card>
            <CardContent className="settings-loading">Loading settings...</CardContent>
          </Card>
        ) : (
          <>
            <section className="settings-tab-list" aria-label="settings tabs">
              {settingsTabs.map((tab) => (
                <Link
                  key={tab.id}
                  to="/setting/$section"
                  params={{ section: tab.path }}
                  className={`settings-tab ${activeTab === tab.id ? "active" : ""}`}
                >
                  {tab.label}
                </Link>
              ))}
            </section>

            {activeTab === "general" ? <GeneralSettingsPanel {...model} /> : null}

            {activeTab === "providers" ? <ProviderEndpointsPanel {...model} /> : null}

            {activeTab === "pools" ? (
              <Card>
                <CardHeader>
                  <CardTitle>LLM Pool</CardTitle>
                  <p className="settings-task-routing-intro">
                    Group Local LLM endpoints into named pools for queue-backed task routing.
                  </p>
                </CardHeader>
                <CardContent className="settings-routes">
                  <ProviderPoolDiagnostics items={sourceView?.diagnostics?.providerPools ?? []} />
                  {<LocalLlmPools {...model} />}
                </CardContent>
              </Card>
            ) : null}

            {activeTab === "taskRouting" ? <TaskRoutingSettingsPanel {...model} /> : null}

            {activeTab === "search" ? <SearchSettingsPanel {...model} /> : null}

            {activeTab === "embedding" ? <EmbeddingSettingsPanel {...model} /> : null}

            {activeTab === "advanced" ? <AdvancedSettingsPanel {...model} /> : null}
          </>
        )}
      </div>
    </div>
  );
}
