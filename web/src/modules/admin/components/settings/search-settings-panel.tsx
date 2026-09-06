import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  millisecondsToSeconds,
  parseIntegerInput,
  parseSecondsToMillisecondsInput,
} from "./settings-primitives";
import type { SettingsController } from "./use-settings-controller";
type Props = Pick<
  SettingsController,
  "draft" | "moveSearchProvider" | "patchDraft" | "renderSecretEditor" | "sourceView"
>;
export function SearchSettingsPanel({
  draft,
  moveSearchProvider,
  patchDraft,
  renderSecretEditor,
  sourceView,
}: Props) {
  if (!draft) return null;
  if (!sourceView) return null;
  return (
    <section className="settings-search-grid">
      <Card>
        <CardHeader>
          <CardTitle>Search Routing</CardTitle>
        </CardHeader>
        <CardContent className="settings-card-grid">
          <div className="settings-provider-order-list">
            {draft.search.providerOrder.map((provider, index) => (
              <div key={provider} className="settings-provider-order-item">
                <div className="settings-provider-order-name">
                  <strong>{provider}</strong>
                  <span>
                    {provider === "brave" && draft.search.providers.brave.enabled
                      ? "enabled"
                      : provider === "exa" && draft.search.providers.exa.enabled
                        ? "enabled"
                        : provider === "duckduckgo" && draft.search.providers.duckduckgo.enabled
                          ? "enabled"
                          : "disabled"}
                  </span>
                </div>
                <div className="settings-provider-order-actions">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => moveSearchProvider(provider, -1)}
                    disabled={index === 0}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => moveSearchProvider(provider, 1)}
                    disabled={index === draft.search.providerOrder.length - 1}
                  >
                    <ArrowDown size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <label className="settings-check">
            <Checkbox
              checked={draft.search.providers.brave.enabled}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    providers: {
                      ...current.search.providers,
                      brave: { enabled: event.target.checked },
                    },
                  },
                }))
              }
            />
            brave enabled
          </label>
          <label className="settings-check">
            <Checkbox
              checked={draft.search.providers.exa.enabled}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    providers: {
                      ...current.search.providers,
                      exa: { enabled: event.target.checked },
                    },
                  },
                }))
              }
            />
            exa enabled
          </label>
          <label className="settings-check">
            <Checkbox
              checked={draft.search.providers.duckduckgo.enabled}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    providers: {
                      ...current.search.providers,
                      duckduckgo: { enabled: event.target.checked },
                    },
                  },
                }))
              }
            />
            duckduckgo enabled
          </label>
          <label className="settings-field">
            <span>Max Provider Attempts</span>
            <Input
              type="number"
              min={1}
              max={3}
              value={draft.search.maxProviderAttempts}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    maxProviderAttempts: parseIntegerInput(
                      event.target.value,
                      current.search.maxProviderAttempts,
                    ),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Result Count</span>
            <Input
              type="number"
              min={1}
              max={10}
              value={draft.search.resultCount}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    resultCount: parseIntegerInput(event.target.value, current.search.resultCount),
                  },
                }))
              }
            />
          </label>
          <label className="settings-field">
            <span>Timeout (seconds)</span>
            <Input
              type="number"
              min={1}
              max={120}
              value={millisecondsToSeconds(draft.search.timeoutMs)}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    timeoutMs: parseSecondsToMillisecondsInput(
                      event.target.value,
                      current.search.timeoutMs,
                    ),
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
              value={draft.search.rateLimitCooldownSeconds}
              onChange={(event) =>
                patchDraft((current) => ({
                  ...current,
                  search: {
                    ...current.search,
                    rateLimitCooldownSeconds: parseIntegerInput(
                      event.target.value,
                      current.search.rateLimitCooldownSeconds,
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
          <CardTitle>Search Secrets</CardTitle>
        </CardHeader>
        <CardContent className="settings-card-grid">
          {sourceView
            ? renderSecretEditor(
                "braveApiKey",
                "Brave API Key",
                sourceView.search.providers.brave.apiKeySecret,
              )
            : null}
          {sourceView
            ? renderSecretEditor(
                "exaApiKey",
                "Exa API Key",
                sourceView.search.providers.exa.apiKeySecret,
              )
            : null}
        </CardContent>
      </Card>
    </section>
  );
}
