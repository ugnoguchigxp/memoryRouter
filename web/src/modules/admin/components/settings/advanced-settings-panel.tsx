import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  millisecondsToSeconds,
  parseFloatInput,
  parseIntegerInput,
  parseSecondsToMillisecondsInput,
} from "./settings-primitives";
import type { SettingsController } from "./use-settings-controller";
type Props = Pick<
  SettingsController,
  "draft" | "patchDraft" | "renderDistillationRuntimeNumberField"
>;
export function AdvancedSettingsPanel({
  draft,
  patchDraft,
  renderDistillationRuntimeNumberField,
}: Props) {
  if (!draft) return null;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Advanced Runtime Controls</CardTitle>
        </CardHeader>
        <CardContent className="settings-form-grid">
          <label className="settings-field">
            <span>Pipeline Lock Stale (sec)</span>
            <Input
              type="number"
              min={30}
              value={draft.advanced.pipelineLockStaleSeconds}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    pipelineLockStaleSeconds: parseIntegerInput(
                      event.target.value,
                      current.advanced.pipelineLockStaleSeconds,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Lock TTL (sec)</span>
            <Input
              type="number"
              min={30}
              value={draft.advanced.lockTtlSeconds}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    lockTtlSeconds: parseIntegerInput(
                      event.target.value,
                      current.advanced.lockTtlSeconds,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Pipeline Loop Claim Limit</span>
            <Input
              type="number"
              min={1}
              max={1000}
              value={draft.advanced.pipelineClaimLimit}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    pipelineClaimLimit: parseIntegerInput(
                      event.target.value,
                      current.advanced.pipelineClaimLimit,
                    ),
                  },
                }))
              }
            />
          </label>
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
          <label className="settings-field">
            <span>Continuous Idle Sleep (seconds)</span>
            <Input
              type="number"
              min={0.1}
              step={0.1}
              value={millisecondsToSeconds(draft.advanced.continuousIdleSleepMs)}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    continuousIdleSleepMs: parseSecondsToMillisecondsInput(
                      event.target.value,
                      current.advanced.continuousIdleSleepMs,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Continuous Error Sleep (seconds)</span>
            <Input
              type="number"
              min={0.1}
              step={0.1}
              value={millisecondsToSeconds(draft.advanced.continuousErrorSleepMs)}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    continuousErrorSleepMs: parseSecondsToMillisecondsInput(
                      event.target.value,
                      current.advanced.continuousErrorSleepMs,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Inventory Refresh Interval (seconds)</span>
            <Input
              type="number"
              min={0.1}
              step={0.1}
              value={millisecondsToSeconds(draft.advanced.inventoryRefreshIntervalMs)}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    inventoryRefreshIntervalMs: parseSecondsToMillisecondsInput(
                      event.target.value,
                      current.advanced.inventoryRefreshIntervalMs,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Doctor Freshness Threshold (min)</span>
            <Input
              type="number"
              min={1}
              value={draft.advanced.doctorFreshnessThresholdMinutes}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    doctorFreshnessThresholdMinutes: parseIntegerInput(
                      event.target.value,
                      current.advanced.doctorFreshnessThresholdMinutes,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Doctor Degraded Rate Threshold</span>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={draft.advanced.doctorDegradedRateThreshold}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    doctorDegradedRateThreshold: parseFloatInput(
                      event.target.value,
                      current.advanced.doctorDegradedRateThreshold,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Doctor Zero-use Warning Min Active Count</span>
            <Input
              type="number"
              min={1}
              value={draft.advanced.doctorKnowledgeZeroUseWarningMinActiveCount}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    doctorKnowledgeZeroUseWarningMinActiveCount: parseIntegerInput(
                      event.target.value,
                      current.advanced.doctorKnowledgeZeroUseWarningMinActiveCount,
                    ),
                  },
                }))
              }
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Log Synchronization</CardTitle>
        </CardHeader>
        <CardContent className="settings-form-grid">
          <label className="settings-check">
            <Checkbox
              checked={draft.advanced.codexLogSyncEnabled}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    codexLogSyncEnabled: event.target.checked,
                  },
                }))
              }
            />
            Enable Codex (Cursor) Log Sync
          </label>
          <label className="settings-check">
            <Checkbox
              checked={draft.advanced.antigravityLogSyncEnabled}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    antigravityLogSyncEnabled: event.target.checked,
                  },
                }))
              }
            />
            Enable Antigravity Log Sync
          </label>
          <label className="settings-check">
            <Checkbox
              checked={draft.advanced.claudeLogSyncEnabled}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  advanced: {
                    ...current.advanced,
                    claudeLogSyncEnabled: event.target.checked,
                  },
                }))
              }
            />
            Enable Claude Code Log Sync
          </label>
        </CardContent>
      </Card>
    </>
  );
}
