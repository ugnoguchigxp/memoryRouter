import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { secureHeaders } from "hono/secure-headers";
import { groupedConfig } from "../src/config.js";
import { projectIdentity } from "../src/project-identity.js";
import { redactSecrets } from "../src/shared/utils/secret-redaction.js";
import { adminCors } from "./middleware/admin-cors.js";
import { apiAuthenticationDispatcher } from "./middleware/security-intelligence-auth.js";
import { adminSessionRouter } from "./modules/admin-session/admin-session.routes.js";
import { agentDiffsRouter } from "./modules/agent-diffs/agent-diffs.routes.js";
import { auditLogsRouter } from "./modules/audit/audit.routes.js";
import { candidatesRouter } from "./modules/candidates/candidates.routes.js";
import { contextCompilerRouter } from "./modules/context-compiler/context-compiler.routes.js";
import { contextDecisionRouter } from "./modules/context-decision/context-decision.routes.js";
import { doctorRouter } from "./modules/doctor/doctor.routes.js";
import { episodesRouter } from "./modules/episodes/episodes.routes.js";
import { graphRouter } from "./modules/graph/graph.routes.js";
import { knowledgeRouter } from "./modules/knowledge/knowledge.routes.js";
import { overviewRouter } from "./modules/overview/overview.routes.js";
import { queueRouter } from "./modules/queue/queue.routes.js";
import { securityIntelligenceIntegrationRouter } from "./modules/security-intelligence/security-intelligence.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { sourcesRouter } from "./modules/sources/sources.routes.js";
import { vibeMemoryRouter } from "./modules/vibe-memory/vibe-memory.routes.js";

const app = new Hono();
const MAX_ADMIN_API_REQUEST_BYTES = 16 * 1024 * 1024;

app.use(
  "*",
  logger((message) => console.log(redactSecrets(message))),
  prettyJSON(),
  secureHeaders(),
  adminCors(groupedConfig.admin.allowedOrigins),
);
app.use(
  "/api/*",
  bodyLimit({
    maxSize: MAX_ADMIN_API_REQUEST_BYTES,
    onError: (ctx) => {
      ctx.header("Cache-Control", "no-store");
      return ctx.json({ error: "request_too_large" }, 413);
    },
  }),
);
app.use("/api/*", apiAuthenticationDispatcher());

app.get("/api/health/live", (c) =>
  c.json({ status: "alive", service: projectIdentity.apiServiceName }),
);
app.get("/api/health/ready", (c) =>
  c.json({ status: "ready", service: projectIdentity.apiServiceName }),
);
app.get("/api/health", (c) => c.json({ status: "ok", service: projectIdentity.apiServiceName }));
app.route("/api/admin-session", adminSessionRouter);
app.route("/api/context", contextCompilerRouter);
app.route("/api/context-decisions", contextDecisionRouter);
app.route("/api/doctor", doctorRouter);
app.route("/api/episodes", episodesRouter);
app.route("/api/knowledge", knowledgeRouter);
app.route("/api/sources", sourcesRouter);
app.route("/api/vibe-memory", vibeMemoryRouter);
app.route("/api/agent-diffs", agentDiffsRouter);
app.route("/api/graph", graphRouter);
app.route("/api/overview", overviewRouter);
app.route("/api/queue", queueRouter);
app.route("/api/audit-logs", auditLogsRouter);
app.route("/api/candidates", candidatesRouter);
app.route("/api/settings", settingsRouter);
app.route("/api/integrations/security-intelligence/v1", securityIntelligenceIntegrationRouter);

export default app;
