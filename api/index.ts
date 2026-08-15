import { serve } from "@hono/node-server";
import { closeDbPool } from "../src/db/client.js";
import { standaloneApiPort } from "../src/dev-server.config.js";
import app from "./app.js";

const port = Number(process.env.PORT ?? standaloneApiPort);
const hostname = process.env.CONTEXT_STILL_API_HOST?.trim() || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "::1"]);
if (
  !loopbackHosts.has(hostname) &&
  !(
    process.env.CONTEXT_STILL_EXTERNAL_BIND_ALLOWED === "1" &&
    process.env.CONTEXT_STILL_TLS_REVERSE_PROXY_CONFIRMED === "1"
  )
) {
  throw new Error(
    "External API bind requires CONTEXT_STILL_EXTERNAL_BIND_ALLOWED=1 and CONTEXT_STILL_TLS_REVERSE_PROXY_CONFIRMED=1.",
  );
}

const server = serve(
  {
    fetch: app.fetch,
    port,
    hostname,
  },
  (info) => {
    console.log(`[api] listening on http://${hostname}:${info.port}`);
  },
);

let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\nReceived ${signal}. Shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out. Forcing exit.");
    process.exit(1);
  }, 10_000);

  // 新規接続の受付を停止
  server.close();

  try {
    console.log("Closing database connection pool...");
    await closeDbPool();
    console.log("Shutdown complete.");
    clearTimeout(forceExitTimer);
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
