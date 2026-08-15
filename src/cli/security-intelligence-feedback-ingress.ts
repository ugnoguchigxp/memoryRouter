import { receiveSecurityKnowledgeFeedbackBatch } from "../modules/security-intelligence/feedback-batch-ingress.service.js";

const raw = await Bun.stdin.text();
const response = await receiveSecurityKnowledgeFeedbackBatch({
  producerPrincipal:
    process.env.CONTEXT_STILL_SECURITY_INTELLIGENCE_PRODUCER_PRINCIPAL?.trim() ||
    "nightworkers:cli-integration",
  rawBatch: JSON.parse(raw),
});
process.stdout.write(`${JSON.stringify(response)}\n`);
