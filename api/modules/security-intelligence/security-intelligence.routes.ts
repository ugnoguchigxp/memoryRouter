import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  SecurityIntelligenceIngressError,
  receiveSecurityKnowledgeCandidateBatch,
} from "../../../src/modules/security-intelligence/candidate-batch-ingress.service.js";
import { receiveSecurityKnowledgeFeedbackBatch } from "../../../src/modules/security-intelligence/feedback-batch-ingress.service.js";
import { SECURITY_KNOWLEDGE_CANDIDATE_BATCH_MAX_BYTES } from "../../../src/shared/schemas/security-knowledge-candidate-batch.schema.js";
import { SECURITY_KNOWLEDGE_FEEDBACK_BATCH_MAX_BYTES } from "../../../src/shared/schemas/security-knowledge-feedback-batch.schema.js";
import { securityIntelligenceProducerPrincipal } from "../../middleware/security-intelligence-auth.js";

const router = new Hono();

router.use(
  "/candidate-batches",
  bodyLimit({
    maxSize: SECURITY_KNOWLEDGE_CANDIDATE_BATCH_MAX_BYTES,
    onError: (c) =>
      c.json(
        { error: { code: "batch_too_large", message: "candidate batch exceeds 256 KiB" } },
        413,
      ),
  }),
);

router.post("/candidate-batches", async (c) => {
  try {
    const rawBatch = await c.req.json().catch(() => {
      throw new SecurityIntelligenceIngressError(400, "invalid_json", "request body must be JSON");
    });
    const response = await receiveSecurityKnowledgeCandidateBatch({
      producerPrincipal: securityIntelligenceProducerPrincipal(),
      rawBatch,
    });
    c.header("Cache-Control", "no-store");
    return c.json(response, response.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof SecurityIntelligenceIngressError) {
      return c.json(
        { error: { code: error.reasonCode, message: error.message } },
        error.status as 400 | 409 | 413,
      );
    }
    throw error;
  }
});

router.use(
  "/feedback-batches",
  bodyLimit({
    maxSize: SECURITY_KNOWLEDGE_FEEDBACK_BATCH_MAX_BYTES,
    onError: (c) =>
      c.json(
        { error: { code: "feedback_batch_too_large", message: "feedback batch exceeds 128 KiB" } },
        413,
      ),
  }),
);

router.post("/feedback-batches", async (c) => {
  try {
    const rawBatch = await c.req.json().catch(() => {
      throw new SecurityIntelligenceIngressError(400, "invalid_json", "request body must be JSON");
    });
    const response = await receiveSecurityKnowledgeFeedbackBatch({
      producerPrincipal: securityIntelligenceProducerPrincipal(),
      rawBatch,
    });
    c.header("Cache-Control", "no-store");
    return c.json(response, response.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof SecurityIntelligenceIngressError) {
      return c.json(
        { error: { code: error.reasonCode, message: error.message } },
        error.status as 400 | 409 | 413,
      );
    }
    throw error;
  }
});

export const securityIntelligenceIntegrationRouter = router;
