import assert from "node:assert/strict";
import { createIsolatedRuntime, freePort } from "./testing/isolated-runtime.mjs";

const runtime = await createIsolatedRuntime();
try {
  await runtime.initialize();
  runtime.env.PORT = String(await freePort());
  runtime.env.CONTEXT_STILL_ADMIN_API_READY_TIMEOUT_MS = "30000";
  const start = JSON.parse(await runtime.cli("admin-api", "start", "--json"));
  assert.equal(start.status, "started");
  const status = JSON.parse(await runtime.cli("admin-api", "status", "--json"));
  assert.equal(status.status, "running");
  console.log(JSON.stringify({ ok: true, writer: "ready", adminApi: status.status }, null, 2));
} finally {
  try {
    await runtime.cli("admin-api", "stop", "--json");
  } finally {
    await runtime.cleanup();
  }
}
