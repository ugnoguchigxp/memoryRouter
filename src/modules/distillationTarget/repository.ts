import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { distillationTargetStates } from "../../db/schema.js";
import type { DistillationTargetStateRow } from "./repository-helpers.js";

export {
  DEFAULT_DISTILLATION_TARGET_VERSION,
  type DistillationTargetStateRow,
} from "./repository-helpers.js";
export {
  type RecoveryResult,
  releaseRetryablePausedDistillationTargets,
  recoverStaleDistillationTargets,
} from "./repository-maintenance.js";

export async function getDistillationTargetStateById(
  id: string,
): Promise<DistillationTargetStateRow | null> {
  const [row] = await db
    .select()
    .from(distillationTargetStates)
    .where(eq(distillationTargetStates.id, id))
    .limit(1);
  return row ?? null;
}
