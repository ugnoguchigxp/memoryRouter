import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { getRawTimezoneSetting, setTimezoneSetting, timezoneOptions } from "@/lib/timezone";
import { ArrowDown, ArrowUp } from "lucide-react";
import { distillationPriorityTargetKinds } from "./settings-primitives";
import type { SettingsController } from "./use-settings-controller";
type Props = Pick<
  SettingsController,
  "draft" | "movePriorityTargetKind" | "setSaveError" | "setSaveMessage"
>;
export function GeneralSettingsPanel({
  draft,
  movePriorityTargetKind,
  setSaveError,
  setSaveMessage,
}: Props) {
  if (!draft) return null;

  return (
    <section className="settings-general-panel space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>General Settings</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="settings-field max-w-md">
            <label className="block text-sm font-medium mb-1" htmlFor="application-timezone">
              Application Timezone
            </label>
            <Select
              id="application-timezone"
              aria-label="Application Timezone"
              value={getRawTimezoneSetting()}
              onChange={(event) => {
                const val = event.target.value;
                setTimezoneSetting(val);
                setSaveError(null);
                setSaveMessage(
                  `Timezone updated to ${val === "system" ? `System Default (${Intl.DateTimeFormat().resolvedOptions().timeZone})` : val}.`,
                );
              }}
            >
              {timezoneOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground mt-2">
              Configure the timezone used for displaying all timestamps across the dashboard.
            </p>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Distillation Target Priority Order</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Queue claim order. Top item is highest priority.
          </p>
          <div className="space-y-2">
            {draft.general.distillationPriority.targetPriorityOrder.map((kind, index) => (
              <div key={kind} className="flex items-center justify-between rounded-md border p-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">#{index + 1}</Badge>
                  <span className="text-sm font-medium">{kind}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => movePriorityTargetKind(kind, -1)}
                    disabled={index === 0}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => movePriorityTargetKind(kind, 1)}
                    disabled={
                      index === draft.general.distillationPriority.targetPriorityOrder.length - 1
                    }
                  >
                    <ArrowDown size={14} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Available kinds: {distillationPriorityTargetKinds.join(", ")}
          </p>
        </CardContent>
      </Card>
    </section>
  );
}
