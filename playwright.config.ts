import { defineConfig } from "@playwright/test";

const port = 39271;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun --no-env-file scripts/e2e-server.mjs",
    url: `${baseURL}/api/health/ready`,
    env: { CONTEXT_STILL_E2E_PORT: String(port) },
    reuseExistingServer: false,
    timeout: 600_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
