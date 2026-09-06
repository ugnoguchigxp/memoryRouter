import { createIsolatedRuntime } from "./testing/isolated-runtime.mjs";

const runtime = await createIsolatedRuntime();
let stopping = false;
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  await runtime.cleanup();
  process.exit(code);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
try {
  await runtime.initialize();
  const api = await runtime.startApi(Number(process.env.CONTEXT_STILL_E2E_PORT || 39271), true);
  console.log("Isolated browser test server ready");
  api.child.on("exit", () => {
    if (!stopping) void shutdown(1);
  });
} catch (error) {
  console.error(error);
  await shutdown(1);
}
