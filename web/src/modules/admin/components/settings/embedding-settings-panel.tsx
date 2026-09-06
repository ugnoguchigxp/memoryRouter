import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { RuntimeSettingsEditable } from "../../repositories/admin.repository";
import { millisecondsToSeconds, parseSecondsToMillisecondsInput } from "./settings-primitives";
import type { SettingsController } from "./use-settings-controller";
type Props = Pick<SettingsController, "draft" | "patchDraft">;
export function EmbeddingSettingsPanel({ draft, patchDraft }: Props) {
  if (!draft) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Embedding Provider</CardTitle>
      </CardHeader>
      <CardContent className="settings-form-grid">
        <label className="settings-field">
          <span>Provider</span>
          <Select
            value={draft.embedding.provider}
            onChange={(event) =>
              patchDraft((current) => ({
                ...current,
                embedding: {
                  ...current.embedding,
                  provider: event.target.value as RuntimeSettingsEditable["embedding"]["provider"],
                },
              }))
            }
          >
            <option value="auto">auto</option>
            <option value="daemon">daemon</option>
            <option value="openai">openai</option>
            <option value="disabled">disabled</option>
          </Select>
        </label>
        <label className="settings-field">
          <span>External provider URL</span>
          <Input
            value={draft.embedding.daemonUrl}
            onChange={(event) =>
              patchDraft((current) => ({
                ...current,
                embedding: {
                  ...current.embedding,
                  daemonUrl: event.target.value,
                },
              }))
            }
          />
        </label>
        <label className="settings-field">
          <span>OpenAI Model</span>
          <Input
            value={draft.embedding.openaiModel}
            onChange={(event) =>
              patchDraft((current) => ({
                ...current,
                embedding: {
                  ...current.embedding,
                  openaiModel: event.target.value,
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
            value={millisecondsToSeconds(draft.embedding.timeoutMs)}
            onChange={(event) =>
              patchDraft((current) => ({
                ...current,
                embedding: {
                  ...current.embedding,
                  timeoutMs: parseSecondsToMillisecondsInput(
                    event.target.value,
                    current.embedding.timeoutMs,
                  ),
                },
              }))
            }
          />
        </label>
      </CardContent>
    </Card>
  );
}
