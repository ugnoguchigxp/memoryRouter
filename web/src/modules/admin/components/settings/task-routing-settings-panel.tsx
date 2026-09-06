import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { RuntimeProviderName } from "../../repositories/admin.repository";
import { RouteEditor } from "./settings-controls";
import {
  millisecondsToSeconds,
  parseFloatInput,
  parseIntegerInput,
  parseSecondsToMillisecondsInput,
} from "./settings-primitives";
import { isLarmAgentConnectionRoute, resolveConfiguredRouteModel } from "./settings-routing";
import type { SettingsController } from "./use-settings-controller";
type Props = Pick<
  SettingsController,
  "draft" | "patchDraft" | "renderDistillationRuntimeNumberField" | "sourceView"
>;
export function TaskRoutingSettingsPanel({
  draft,
  patchDraft,
  renderDistillationRuntimeNumberField,
  sourceView,
}: Props) {
  if (!draft) return null;
  if (!sourceView) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Task Routing</CardTitle>
        <p className="settings-task-routing-intro">
          Assign configured endpoints and task-specific runtime limits per pipeline step. Endpoint
          options are derived from Provider Endpoints.
        </p>
      </CardHeader>
      <CardContent className="settings-routes">
        <section className="settings-route-matrix">
          <div className="settings-route-matrix-header">
            <div>
              <h3>Route Matrix</h3>
              <p>
                Primary and fallback endpoint order for each task. Only endpoints that can be routed
                by the current settings are selectable.
              </p>
            </div>
          </div>
          <RouteEditor
            label="findCandidate"
            description="Candidate extraction from source and vibe-memory targets."
            settings={draft}
            route={draft.taskRouting.findCandidate.source}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.findCandidate.source}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  findCandidate: {
                    ...current.taskRouting.findCandidate,
                    source: next,
                    vibe: next,
                  },
                },
              }))
            }
          />
          <RouteEditor
            label="webSourceResearch"
            description="URL fetch and web-source markdown generation."
            settings={draft}
            route={draft.taskRouting.webSourceResearch}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.webSourceResearch}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  webSourceResearch: next,
                },
              }))
            }
          />
          <RouteEditor
            label="episodeDistiller"
            description="Episode card generation from completed compile and vibe-memory runs."
            settings={draft}
            route={draft.taskRouting.episodeDistiller}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.episodeDistiller}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  episodeDistiller: next,
                },
              }))
            }
          />
          <RouteEditor
            label="coverEvidence"
            description="Shared route for source support, external evidence, and MCP evidence."
            settings={draft}
            route={draft.taskRouting.coverEvidence.externalEvidence}
            effectiveTargets={
              sourceView?.effectiveTargets?.taskRouting.coverEvidence.externalEvidence
            }
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  coverEvidence: {
                    sourceSupport: next,
                    externalEvidence: next,
                    mcpEvidence: next,
                  },
                },
              }))
            }
          />
          <RouteEditor
            label="deadZoneMergeReview"
            description="Queued DeadZone merge verification and cleanup."
            settings={draft}
            route={draft.taskRouting.deadZoneMergeReview}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.deadZoneMergeReview}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  deadZoneMergeReview: next,
                },
              }))
            }
          />
          <RouteEditor
            label="landscapeCuration"
            description="Autonomous Landscape evaluation and policy-gated curation."
            settings={draft}
            route={draft.taskRouting.landscapeCuration}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.landscapeCuration}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  landscapeCuration: next,
                },
              }))
            }
          />
          <RouteEditor
            label="finalizeDistille"
            description="Final candidate-to-knowledge generation."
            settings={draft}
            route={draft.taskRouting.finalizeDistille}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.finalizeDistille}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  finalizeDistille: next,
                },
              }))
            }
          />
          <RouteEditor
            label="mergeActivationFinalize"
            description="Final activation pass for accepted merge candidates."
            settings={draft}
            route={draft.taskRouting.mergeActivationFinalize}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.mergeActivationFinalize}
            onChange={(next) =>
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  mergeActivationFinalize: next,
                },
              }))
            }
          />
          <RouteEditor
            label="agenticCompile"
            description="Compile helper route used by context compile and related runtime paths."
            settings={draft}
            route={{
              provider: draft.taskRouting.agenticCompile.provider,
              model: draft.taskRouting.agenticCompile.model,
              localLlmModel: draft.taskRouting.agenticCompile.localLlmModel,
              fallback: draft.taskRouting.agenticCompile.fallback,
              azureDeploymentSlots: draft.taskRouting.agenticCompile.azureDeploymentSlots,
            }}
            effectiveTargets={sourceView?.effectiveTargets?.taskRouting.agenticCompile}
            allowDynamic={false}
            onChange={(next) => {
              if (isLarmAgentConnectionRoute(next)) return;
              patchDraft((current) => ({
                ...current,
                taskRouting: {
                  ...current.taskRouting,
                  agenticCompile: {
                    ...current.taskRouting.agenticCompile,
                    provider: next.provider as RuntimeProviderName,
                    model:
                      next.model ??
                      resolveConfiguredRouteModel(current, next.provider) ??
                      current.taskRouting.agenticCompile.model,
                    localLlmModel: next.localLlmModel,
                    fallback: next.fallback,
                    azureDeploymentSlots: next.azureDeploymentSlots,
                  },
                },
              }));
            }}
          />
        </section>

        <section className="settings-route-section">
          <div className="settings-route-section-header">
            <h3>Find Candidate Runtime</h3>
            <p>Candidate extraction timeouts, tool budget, and queue cadence.</p>
          </div>
          <div className="settings-route-row">
            <div className="settings-route-header">
              <div className="settings-route-label">findCandidate.runtime</div>
              <p className="settings-route-description">
                Limit the candidate extraction LLM call and source reader loop.
              </p>
            </div>
            <div className="settings-route-fields">
              {renderDistillationRuntimeNumberField({
                label: "Find Candidate LLM Timeout (seconds)",
                settingKey: "findCandidateTimeoutMs",
                min: 1,
                max: 3600,
                unit: "secondsFromMilliseconds",
              })}
              {renderDistillationRuntimeNumberField({
                label: "Find Candidate Tool Calls",
                settingKey: "findCandidateMaxToolCalls",
                min: 1,
                max: 64,
              })}
            </div>
          </div>
          <div className="settings-route-row">
            <div className="settings-route-header">
              <div className="settings-route-label">findCandidate.throttling</div>
              <p className="settings-route-description">
                Background interval and cooldown controls for findCandidate.
              </p>
            </div>
            <div className="settings-route-fields">
              <label className="settings-field">
                <span>Finding Queue Task Interval (seconds)</span>
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={draft.advanced.findingQueueTaskIntervalSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      advanced: {
                        ...current.advanced,
                        findingQueueTaskIntervalSeconds: parseIntegerInput(
                          event.target.value,
                          current.advanced.findingQueueTaskIntervalSeconds,
                        ),
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Enable Background Scheduler</span>
                <Checkbox
                  checked={draft.taskRouting.findCandidate.throttling.backgroundEnabled}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            backgroundEnabled: event.target.checked,
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Interactive Window (sec)</span>
                <Input
                  type="number"
                  min={30}
                  max={3600}
                  value={draft.taskRouting.findCandidate.throttling.interactiveWindowSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            interactiveWindowSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.interactiveWindowSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Recent Interactive Block (sec)</span>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={draft.taskRouting.findCandidate.throttling.recentBlockSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            recentBlockSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.recentBlockSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Min Interval (sec)</span>
                <Input
                  type="number"
                  min={1}
                  max={3600}
                  value={draft.taskRouting.findCandidate.throttling.minIntervalSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            minIntervalSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.minIntervalSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Medium Interval (sec)</span>
                <Input
                  type="number"
                  min={1}
                  max={7200}
                  value={draft.taskRouting.findCandidate.throttling.mediumIntervalSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            mediumIntervalSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.mediumIntervalSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Busy Interval (sec)</span>
                <Input
                  type="number"
                  min={1}
                  max={21600}
                  value={draft.taskRouting.findCandidate.throttling.busyIntervalSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            busyIntervalSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.busyIntervalSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Max Interval (sec)</span>
                <Input
                  type="number"
                  min={1}
                  max={86400}
                  value={draft.taskRouting.findCandidate.throttling.maxIntervalSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            maxIntervalSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.maxIntervalSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Rate Limit Cooldown (sec)</span>
                <Input
                  type="number"
                  min={30}
                  max={172800}
                  value={draft.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            rateLimitCooldownSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.rateLimitCooldownSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Jitter (sec)</span>
                <Input
                  type="number"
                  min={0}
                  max={600}
                  value={draft.taskRouting.findCandidate.throttling.jitterSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        findCandidate: {
                          ...current.taskRouting.findCandidate,
                          throttling: {
                            ...current.taskRouting.findCandidate.throttling,
                            jitterSeconds: parseIntegerInput(
                              event.target.value,
                              current.taskRouting.findCandidate.throttling.jitterSeconds,
                            ),
                          },
                        },
                      },
                    }))
                  }
                />
              </label>
            </div>
          </div>
        </section>

        <section className="settings-route-section">
          <div className="settings-route-section-header">
            <h3>Cover Evidence Runtime</h3>
            <p>Covering Evidence queue cadence, LLM timeout, and tool-call limits.</p>
          </div>
          <div className="settings-route-row">
            <div className="settings-route-header">
              <div className="settings-route-label">coverEvidence.runtime</div>
              <p className="settings-route-description">
                Limit Cover Evidence LLM calls and external evidence tools.
              </p>
            </div>
            <div className="settings-route-fields">
              <label className="settings-field">
                <span>Covering Queue Task Interval (seconds)</span>
                <Input
                  type="number"
                  min={0}
                  max={3600}
                  value={draft.advanced.coveringQueueTaskIntervalSeconds}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      advanced: {
                        ...current.advanced,
                        coveringQueueTaskIntervalSeconds: parseIntegerInput(
                          event.target.value,
                          current.advanced.coveringQueueTaskIntervalSeconds,
                        ),
                      },
                    }))
                  }
                />
              </label>
              {renderDistillationRuntimeNumberField({
                label: "Cover Evidence LLM Timeout (seconds)",
                settingKey: "coverEvidenceTimeoutMs",
                min: 1,
                max: 3600,
                unit: "secondsFromMilliseconds",
              })}
              {renderDistillationRuntimeNumberField({
                label: "Cover Evidence Search Calls",
                settingKey: "coverEvidenceSearchMaxCalls",
                min: 0,
                max: 16,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Cover Evidence Fetch Calls",
                settingKey: "coverEvidenceFetchMaxCalls",
                min: 0,
                max: 16,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Cover Evidence Fetch Tokens Per Site",
                settingKey: "coverEvidenceFetchMaxTokensPerSite",
                min: 128,
                max: 50000,
              })}
            </div>
          </div>
        </section>

        <section className="settings-route-section">
          <div className="settings-route-section-header">
            <h3>Shared Distillation Runtime</h3>
            <p>Cross-step defaults and fallback limits that are not owned by a single task.</p>
          </div>
          <div className="settings-route-row">
            <div className="settings-route-header">
              <div className="settings-route-label">distillation.sharedRuntime</div>
              <p className="settings-route-description">
                These values still save to distillationRuntime, but live beside routing so task
                behavior can be reviewed in one place.
              </p>
            </div>
            <div className="settings-route-fields">
              {renderDistillationRuntimeNumberField({
                label: "Distillation Timeout (seconds)",
                settingKey: "timeoutMs",
                min: 1,
                max: 3600,
                unit: "secondsFromMilliseconds",
              })}
              {renderDistillationRuntimeNumberField({
                label: "Candidate Timeout (seconds)",
                settingKey: "candidateTimeoutMs",
                min: 1,
                max: 3600,
                unit: "secondsFromMilliseconds",
              })}
              {renderDistillationRuntimeNumberField({
                label: "Max Tool Rounds",
                settingKey: "maxToolRounds",
                min: 0,
                max: 64,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Tool Result Max Chars",
                settingKey: "toolResultMaxChars",
                min: 512,
                max: 200_000,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Failure Retry Delay (sec)",
                settingKey: "failureRetryDelaySeconds",
                min: 1,
                max: 604_800,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Reader Max Reads",
                settingKey: "readerMaxReads",
                min: 1,
                max: 64,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Reader Max Chars Per Read",
                settingKey: "readerMaxCharsPerRead",
                min: 128,
                max: 200_000,
              })}
              {renderDistillationRuntimeNumberField({
                label: "LLM Context Window Tokens",
                settingKey: "llmContextWindowTokens",
                min: 4096,
                max: 1_000_000,
              })}
              {renderDistillationRuntimeNumberField({
                label: "LLM Max Input Tokens",
                settingKey: "llmMaxInputTokens",
                min: 1024,
                max: 1_000_000,
              })}
              {renderDistillationRuntimeNumberField({
                label: "LLM Input Safety Margin Tokens",
                settingKey: "llmInputSafetyMarginTokens",
                min: 0,
                max: 200_000,
              })}
              {renderDistillationRuntimeNumberField({
                label: "Low Importance Reject Threshold",
                settingKey: "lowImportanceRejectThreshold",
                min: 0,
                max: 100,
                step: 0.1,
                parse: parseFloatInput,
              })}
            </div>
          </div>
        </section>

        <section className="settings-route-section">
          <div className="settings-route-section-header">
            <h3>Agentic Compile</h3>
            <p>
              Configure the compile helper route used by context compile and related runtime paths.
            </p>
          </div>
          <div className="settings-route-row">
            <div className="settings-route-header">
              <div className="settings-route-label">agenticCompile.runtime</div>
              <p className="settings-route-description">
                Orchestrates compile-time reasoning. Enable/disable and set timeout/token limits
                here.
              </p>
            </div>
            <div className="settings-route-fields settings-route-fields-agentic">
              <label className="settings-check settings-check-inline">
                <Checkbox
                  checked={draft.taskRouting.agenticCompile.enabled}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        agenticCompile: {
                          ...current.taskRouting.agenticCompile,
                          enabled: event.target.checked,
                        },
                      },
                    }))
                  }
                />
                enabled
              </label>
              <label className="settings-field">
                <span>Timeout (seconds)</span>
                <Input
                  type="number"
                  min={1}
                  value={millisecondsToSeconds(draft.taskRouting.agenticCompile.timeoutMs)}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        agenticCompile: {
                          ...current.taskRouting.agenticCompile,
                          timeoutMs: parseSecondsToMillisecondsInput(
                            event.target.value,
                            current.taskRouting.agenticCompile.timeoutMs,
                          ),
                        },
                      },
                    }))
                  }
                />
              </label>
              <label className="settings-field">
                <span>Max Tokens</span>
                <Input
                  type="number"
                  min={128}
                  value={draft.taskRouting.agenticCompile.maxTokens}
                  onChange={(event) =>
                    patchDraft((current) => ({
                      ...current,
                      taskRouting: {
                        ...current.taskRouting,
                        agenticCompile: {
                          ...current.taskRouting.agenticCompile,
                          maxTokens: parseIntegerInput(
                            event.target.value,
                            current.taskRouting.agenticCompile.maxTokens,
                          ),
                        },
                      },
                    }))
                  }
                />
              </label>
            </div>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}
