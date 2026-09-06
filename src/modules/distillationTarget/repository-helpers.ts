import { APP_CONSTANTS } from "../../constants.js";
import type { distillationTargetStates } from "../../db/schema.js";

export const DEFAULT_DISTILLATION_TARGET_VERSION = APP_CONSTANTS.distillationTargetVersion;

export type DistillationTargetStateRow = typeof distillationTargetStates.$inferSelect;

export function nowMinusSeconds(seconds: number, now = new Date()): Date {
  return new Date(now.getTime() - Math.max(1, seconds) * 1000);
}

export function staleThresholdMs(staleSeconds: number, now = new Date()): number {
  return nowMinusSeconds(staleSeconds, now).getTime();
}

export function rowHeartbeatMs(
  row: Pick<DistillationTargetStateRow, "heartbeatAt" | "lockedAt">,
): number {
  const value = row.heartbeatAt ?? row.lockedAt;
  if (!value) return Number.NEGATIVE_INFINITY;
  return value.getTime();
}
