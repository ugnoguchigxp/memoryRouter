import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import {
  DeadZoneMergeReviewQueueError,
  applyDeadZoneMergeReviewJob,
  createDeadZoneMergeReviewJob,
  listDeadZoneMergeReviewQueueJobs,
} from "../../../src/modules/landscape/deadzone-merge-review-queue.service.js";
import {
  LandscapeCurationError,
  enqueueLandscapeCurationForReview,
  getLandscapeCurationJob,
  listLandscapeCurationJobs,
} from "../../../src/modules/landscape/landscape-curation.service.js";
import {
  DeadZoneKnowledgeMaintenanceError,
  applyDeadZoneKnowledgeReviewAction,
  buildDeadZoneKnowledgeReview,
  maintainDeadZoneKnowledge,
} from "../../../src/modules/landscape/landscape-deadzone-review.service.js";
import { buildLandscapeReplayComparison } from "../../../src/modules/landscape/landscape-replay-comparison.service.js";
import { buildLandscapeReplaySnapshot } from "../../../src/modules/landscape/landscape-replay.service.js";
import {
  LandscapeReviewCandidateLinkError,
  createLandscapeReviewCandidates,
  updateLandscapeReviewCandidateLink,
} from "../../../src/modules/landscape/landscape-review-candidate.service.js";
import {
  LandscapeReviewItemsError,
  listLandscapeContradictionOverlay,
  listLandscapeReviewItems,
  materializeLandscapeReviewItems,
  updateLandscapeReviewItemStatus,
} from "../../../src/modules/landscape/landscape-review-items.service.js";
import { getLandscapeSnapshotCacheStatus } from "../../../src/modules/landscape/landscape-snapshot-cache.service.js";
import { buildLandscapeTrajectory } from "../../../src/modules/landscape/landscape-trajectory.service.js";
import { buildLandscapeSnapshot } from "../../../src/modules/landscape/landscape.service.js";
import { createMergeActivationFinalizeJob } from "../../../src/modules/landscape/merge-activation-finalize.service.js";
import {
  landscapeContradictionOverlayListSchema,
  landscapeContradictionOverlayQuerySchema,
} from "../../../src/shared/schemas/landscape-contradiction-overlay.schema.js";
import {
  deadZoneKnowledgeMaintenanceInputSchema,
  deadZoneKnowledgeMaintenanceResultSchema,
  deadZoneKnowledgeReviewActionInputSchema,
  deadZoneKnowledgeReviewActionResultSchema,
  deadZoneKnowledgeReviewQuerySchema,
  deadZoneKnowledgeReviewResponseSchema,
  deadZoneMergeReviewJobApplyResultSchema,
  deadZoneMergeReviewJobCreateInputSchema,
  deadZoneMergeReviewJobListQuerySchema,
  deadZoneMergeReviewJobListResponseSchema,
  deadZoneMergeReviewJobSchema,
} from "../../../src/shared/schemas/landscape-deadzone-review.schema.js";
import {
  landscapeReplayComparisonResponseSchema,
  landscapeReplaySnapshotSchema,
} from "../../../src/shared/schemas/landscape-replay.schema.js";
import {
  landscapeReviewCandidateCreateInputSchema,
  landscapeReviewCandidateCreateResultSchema,
  landscapeReviewCandidateLinkUpdateInputSchema,
  landscapeReviewCandidateLinkUpdateResultSchema,
} from "../../../src/shared/schemas/landscape-review-candidate.schema.js";
import {
  landscapeReviewItemStatusUpdateSchema,
  landscapeReviewItemsListQuerySchema,
  landscapeReviewItemsMaterializeInputSchema,
  landscapeReviewItemsMaterializeResultSchema,
} from "../../../src/shared/schemas/landscape-review.schema.js";
import { landscapeSnapshotCacheStatusSchema } from "../../../src/shared/schemas/landscape-snapshot-cache.schema.js";
import {
  landscapeTrajectoryQuerySchema,
  landscapeTrajectoryResultSchema,
} from "../../../src/shared/schemas/landscape-trajectory.schema.js";
import { landscapeSnapshotSchema } from "../../../src/shared/schemas/landscape.schema.js";
import {
  type GraphRelationAxis,
  type GraphSnapshotParams,
  buildGraphSnapshot,
  fetchGraphNodeDetail,
  listGraphCommunityLabels,
  upsertGraphCommunityLabel,
} from "./graph.repository.js";

const graphQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("current"),
  view: z.enum(["relation", "semantic", "community", "evidence"]).default("relation"),
  relationAxes: z.string().default("session,project,source"),
  communityDisplay: z.enum(["detail", "supernode"]).default("detail"),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
  maxContextEdgesPerNode: z.coerce.number().int().min(1).max(10).default(3),
  sourceNodeLimit: z.coerce.number().int().min(1).max(2000).default(800),
});

const communityLabelsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("current"),
  relationAxes: z.string().default("session,project,source"),
});

const communityLabelParamSchema = z.object({
  communityKey: z.string().regex(/^[a-fA-F0-9]{64}$/),
});
const landscapeReviewItemParamSchema = z.object({
  id: z.string().trim().min(1),
});
const landscapeReviewItemCandidateLinkParamSchema = z.object({
  id: z.string().trim().min(1),
  linkId: z.string().trim().min(1),
});
const landscapeTrajectoryParamSchema = z.object({
  runId: z.string().trim().min(1),
});
const deadZoneMergeReviewJobParamSchema = z.object({
  id: z.string().trim().min(1),
});
const landscapeCurationJobParamSchema = z.object({ id: z.string().trim().min(1) });
const landscapeCurationCreateSchema = z.object({
  reviewItemId: z.string().trim().min(1),
  candidateKnowledgeIds: z.array(z.string().trim().min(1)).max(5).optional(),
});
const landscapeCurationListSchema = z.object({
  knowledgeId: z.string().trim().min(1).optional(),
  status: z
    .enum(["pending", "running", "completed", "skipped", "failed", "paused", "unresolved", "all"])
    .default("all"),
  findingType: z
    .enum([
      "duplicate_candidate",
      "reachability_gap",
      "stale_knowledge",
      "applicability_issue",
      "contradiction_candidate",
      "all",
    ])
    .default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const communityLabelBodySchema = z.object({
  label: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional().or(z.literal("")),
});

const landscapeQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
  status: z.enum(["current", "active", "draft", "deprecated", "all"]).default("active"),
  relationAxes: z.string().default("session,project,source"),
  minSelectedCount: z.coerce.number().int().min(1).max(100).default(3),
  minFeedbackCount: z.coerce.number().int().min(1).max(100).default(3),
  format: z.enum(["full"]).default("full"),
});

const landscapeReplayQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  landscapeLimit: z.coerce.number().int().min(1).max(2000).default(1000),
  runStatus: z.enum(["ok", "degraded", "failed", "all"]).default("all"),
  landscapeStatus: z.enum(["current", "active", "draft", "deprecated", "all"]).default("active"),
  relationAxes: z.string().default("session,project,source"),
  minSelectedCount: z.coerce.number().int().min(1).max(100).default(3),
  minFeedbackCount: z.coerce.number().int().min(1).max(100).default(3),
  minSimilarity: z.coerce.number().min(0).max(1).default(0.72),
  semanticTopK: z.coerce.number().int().min(1).max(10).default(3),
  includeRuns: z.preprocess((value) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return value;
  }, z.boolean().default(true)),
  format: z.enum(["full"]).default("full"),
});

const landscapeReplayComparisonQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(180).default(30),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  runStatus: z.enum(["ok", "degraded", "failed", "all"]).default("all"),
  currentLimit: z.coerce.number().int().min(1).max(50).default(12),
  includeRuns: z.preprocess((value) => {
    if (value === "true" || value === true) return true;
    if (value === "false" || value === false) return false;
    return value;
  }, z.boolean().default(true)),
  format: z.enum(["full"]).default("full"),
});

function parseRelationAxes(input: string): GraphRelationAxis[] {
  const deduped = new Set<GraphRelationAxis>();
  for (const token of input.split(",")) {
    const normalized = token.trim().toLowerCase();
    if (normalized === "session") deduped.add("session");
    if (normalized === "project") deduped.add("project");
    if (normalized === "source") deduped.add("source");
  }
  return deduped.size > 0 ? [...deduped] : ["session", "project", "source"];
}

export const graphRouter = new Hono()
  .get("/", zValidator("query", graphQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const params: GraphSnapshotParams = {
      ...query,
      relationAxes: parseRelationAxes(query.relationAxes),
    };
    const graph = await buildGraphSnapshot(params);
    return c.json(graph);
  })
  .get("/community-labels", zValidator("query", communityLabelsQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const labels = await listGraphCommunityLabels({
      limit: query.limit,
      status: query.status,
      relationAxes: parseRelationAxes(query.relationAxes),
    });
    return c.json({ labels });
  })
  .get("/landscape", zValidator("query", landscapeQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const snapshot = await buildLandscapeSnapshot({
      windowDays: query.windowDays,
      limit: query.limit,
      status: query.status,
      relationAxes: parseRelationAxes(query.relationAxes),
      minSelectedCount: query.minSelectedCount,
      minFeedbackCount: query.minFeedbackCount,
    });
    if (query.format === "full") {
      return c.json(landscapeSnapshotSchema.parse(snapshot));
    }
    return c.json(landscapeSnapshotSchema.parse(snapshot));
  })
  .get("/landscape/cache-status", async (c) => {
    const cacheStatus = await getLandscapeSnapshotCacheStatus();
    return c.json(landscapeSnapshotCacheStatusSchema.parse(cacheStatus));
  })
  .get("/landscape/curation-jobs", zValidator("query", landscapeCurationListSchema), async (c) => {
    const query = c.req.valid("query");
    const items = await listLandscapeCurationJobs(query);
    return c.json({ items });
  })
  .post(
    "/landscape/curation-jobs",
    zValidator("json", landscapeCurationCreateSchema),
    async (c) => {
      try {
        const id = await enqueueLandscapeCurationForReview(c.req.valid("json"));
        const job = await getLandscapeCurationJob(id);
        return c.json(job, 201);
      } catch (error) {
        if (error instanceof LandscapeCurationError) {
          return c.json({ error: error.message }, error.statusCode);
        }
        throw error;
      }
    },
  )
  .get(
    "/landscape/curation-jobs/:id",
    zValidator("param", landscapeCurationJobParamSchema),
    async (c) => {
      const job = await getLandscapeCurationJob(c.req.valid("param").id);
      return job ? c.json(job) : c.json({ error: "curation job not found" }, 404);
    },
  )
  .get(
    "/landscape/dead-zone-knowledge",
    zValidator("query", deadZoneKnowledgeReviewQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const review = await buildDeadZoneKnowledgeReview(query);
      return c.json(deadZoneKnowledgeReviewResponseSchema.parse(review));
    },
  )
  .get(
    "/landscape/dead-zone-knowledge/merge-review-jobs",
    zValidator("query", deadZoneMergeReviewJobListQuerySchema),
    async (c) => {
      const items = await listDeadZoneMergeReviewQueueJobs(c.req.valid("query"));
      return c.json(deadZoneMergeReviewJobListResponseSchema.parse({ items }));
    },
  )
  .post(
    "/landscape/dead-zone-knowledge/merge-review-jobs",
    zValidator("json", deadZoneMergeReviewJobCreateInputSchema),
    async (c) => {
      try {
        const job = await createDeadZoneMergeReviewJob(c.req.valid("json"));
        return c.json(deadZoneMergeReviewJobSchema.parse(job), 201);
      } catch (error) {
        if (error instanceof DeadZoneMergeReviewQueueError) {
          return c.json({ error: error.message }, error.statusCode as 400 | 404 | 409);
        }
        throw error;
      }
    },
  )
  .post(
    "/landscape/dead-zone-knowledge/merge-review-jobs/:id/apply",
    zValidator("param", deadZoneMergeReviewJobParamSchema),
    async (c) => {
      try {
        const result = await applyDeadZoneMergeReviewJob(c.req.valid("param").id);
        return c.json(deadZoneMergeReviewJobApplyResultSchema.parse(result));
      } catch (error) {
        if (error instanceof DeadZoneMergeReviewQueueError) {
          return c.json({ error: error.message }, error.statusCode as 400 | 404 | 409);
        }
        throw error;
      }
    },
  )
  .post(
    "/landscape/dead-zone-knowledge/merge-review-jobs/:id/finalize",
    zValidator("param", deadZoneMergeReviewJobParamSchema),
    async (c) => {
      try {
        const result = await createMergeActivationFinalizeJob(c.req.valid("param").id);
        return c.json(result, 201);
      } catch (error) {
        if (error instanceof DeadZoneMergeReviewQueueError) {
          return c.json({ error: error.message }, error.statusCode as 400 | 404 | 409 | 500);
        }
        throw error;
      }
    },
  )
  .post(
    "/landscape/dead-zone-knowledge/actions",
    zValidator("json", deadZoneKnowledgeReviewActionInputSchema),
    async (c) => {
      try {
        const result = await applyDeadZoneKnowledgeReviewAction(c.req.valid("json"));
        return c.json(deadZoneKnowledgeReviewActionResultSchema.parse(result));
      } catch (error) {
        if (error instanceof DeadZoneKnowledgeMaintenanceError) {
          const status = error.statusCode === 404 ? 404 : 400;
          return c.json({ error: error.message }, status);
        }
        throw error;
      }
    },
  )
  .post(
    "/landscape/dead-zone-knowledge/maintenance",
    zValidator("json", deadZoneKnowledgeMaintenanceInputSchema),
    async (c) => {
      try {
        const result = await maintainDeadZoneKnowledge(c.req.valid("json"));
        return c.json(deadZoneKnowledgeMaintenanceResultSchema.parse(result));
      } catch (error) {
        if (error instanceof DeadZoneKnowledgeMaintenanceError) {
          const status = error.statusCode === 404 ? 404 : 400;
          return c.json({ error: error.message }, status);
        }
        throw error;
      }
    },
  )
  .get("/landscape/replay", zValidator("query", landscapeReplayQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const snapshot = await buildLandscapeReplaySnapshot({
      windowDays: query.windowDays,
      limit: query.limit,
      landscapeLimit: query.landscapeLimit,
      runStatus: query.runStatus,
      landscapeStatus: query.landscapeStatus,
      relationAxes: parseRelationAxes(query.relationAxes),
      minSelectedCount: query.minSelectedCount,
      minFeedbackCount: query.minFeedbackCount,
      minSimilarity: query.minSimilarity,
      semanticTopK: query.semanticTopK,
      includeRuns: query.includeRuns,
    });
    if (query.format === "full") {
      return c.json(landscapeReplaySnapshotSchema.parse(snapshot));
    }
    return c.json(landscapeReplaySnapshotSchema.parse(snapshot));
  })
  .get(
    "/landscape/replay/compare",
    zValidator("query", landscapeReplayComparisonQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const comparison = await buildLandscapeReplayComparison({
        windowDays: query.windowDays,
        limit: query.limit,
        runStatus: query.runStatus,
        currentLimit: query.currentLimit,
        includeRuns: query.includeRuns,
      });
      if (query.format === "full") {
        return c.json(landscapeReplayComparisonResponseSchema.parse(comparison));
      }
      return c.json(landscapeReplayComparisonResponseSchema.parse(comparison));
    },
  )
  .get(
    "/landscape/trajectory/:runId",
    zValidator("param", landscapeTrajectoryParamSchema),
    zValidator("query", landscapeTrajectoryQuerySchema),
    async (c) => {
      const { runId } = c.req.valid("param");
      const query = c.req.valid("query");
      const trajectory = await buildLandscapeTrajectory({
        runId,
        includeCandidates: query.includeCandidates,
        limit: query.limit,
      });
      if (!trajectory) return c.json({ error: "not found" }, 404);
      return c.json(landscapeTrajectoryResultSchema.parse(trajectory));
    },
  )
  .post(
    "/landscape/replay/queue",
    zValidator("json", landscapeReviewItemsMaterializeInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      try {
        const result = await materializeLandscapeReviewItems(input);
        return c.json({
          result: landscapeReviewItemsMaterializeResultSchema.parse(result),
        });
      } catch (error) {
        if (error instanceof LandscapeReviewItemsError) {
          return c.json({ error: error.message }, error.statusCode);
        }
        throw error;
      }
    },
  )
  .post(
    "/landscape/review-items/candidates",
    zValidator("json", landscapeReviewCandidateCreateInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const result = await createLandscapeReviewCandidates(input);
      return c.json({
        result: landscapeReviewCandidateCreateResultSchema.parse(result),
      });
    },
  )
  .get(
    "/landscape/contradictions",
    zValidator("query", landscapeContradictionOverlayQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const result = await listLandscapeContradictionOverlay({
        status: query.status,
        confidenceMin: query.confidenceMin,
        limit: query.limit,
      });
      return c.json(landscapeContradictionOverlayListSchema.parse(result));
    },
  )
  .get(
    "/landscape/review-items",
    zValidator("query", landscapeReviewItemsListQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const result = await listLandscapeReviewItems({
        status: query.status,
        source: query.source,
        reason: query.reason,
        proposedAction: query.proposedAction,
        knowledgeId: query.knowledgeId,
        runId: query.runId,
        communityKey: query.communityKey,
        priorityMin: query.priorityMin,
        limit: query.limit,
      });
      return c.json(result);
    },
  )
  .patch(
    "/landscape/review-items/:id/candidate-links/:linkId",
    zValidator("param", landscapeReviewItemCandidateLinkParamSchema),
    zValidator("json", landscapeReviewCandidateLinkUpdateInputSchema),
    async (c) => {
      const { id, linkId } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const result = await updateLandscapeReviewCandidateLink(id, linkId, input);
        if (!result) return c.json({ error: "not found" }, 404);
        return c.json(landscapeReviewCandidateLinkUpdateResultSchema.parse(result));
      } catch (error) {
        if (error instanceof LandscapeReviewCandidateLinkError) {
          return c.json({ error: error.message }, error.statusCode);
        }
        throw error;
      }
    },
  )
  .patch(
    "/landscape/review-items/:id",
    zValidator("param", landscapeReviewItemParamSchema),
    zValidator("json", landscapeReviewItemStatusUpdateSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      try {
        const item = await updateLandscapeReviewItemStatus({
          id,
          status: input.status,
          note: input.note,
        });
        if (!item) return c.json({ error: "not found" }, 404);
        return c.json({ item });
      } catch (error) {
        if (error instanceof LandscapeReviewItemsError) {
          return c.json({ error: error.message }, error.statusCode);
        }
        throw error;
      }
    },
  )
  .put(
    "/community-labels/:communityKey",
    zValidator("param", communityLabelParamSchema),
    zValidator("json", communityLabelBodySchema),
    async (c) => {
      const { communityKey } = c.req.valid("param");
      const input = c.req.valid("json");
      const label = await upsertGraphCommunityLabel({
        communityKey,
        label: input.label,
        note: input.note,
      });
      return c.json({
        label: {
          communityKey: label.communityKey,
          label: label.label,
          note: label.note,
          updatedAt: label.updatedAt.toISOString(),
        },
      });
    },
  )
  .get("/nodes/:id", async (c) => {
    const id = c.req.param("id");
    const detail = await fetchGraphNodeDetail(id);
    if (!detail) {
      return c.json({ error: "Node not found" }, 404);
    }
    return c.json(detail);
  });
