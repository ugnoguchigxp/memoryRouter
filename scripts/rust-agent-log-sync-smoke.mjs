import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-stilld-agent-log-sync-smoke-"));
const env = {
  ...process.env,
  CONTEXT_STILL_APP_DATA_DIR: appDataDir,
  CONTEXT_STILL_PROJECT_ROOT: root,
  CONTEXT_STILL_DB_BACKEND: "sqlite",
  CONTEXT_STILL_SQLITE_CORE_PATH: path.join(appDataDir, "agent-log-sync-smoke.sqlite"),
  CONTEXT_STILL_MCP_PORT: "0",
  CONTEXT_STILL_RESIDENT_QUEUE: "0",
  CONTEXT_STILL_AGENT_LOG_SYNC_RUN_AT_LOAD: "1",
};

function run(args) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${args.join(" ")} failed\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function cargo(...args) {
  return run(["cargo", "run", "-q", "-p", "context-stilld", "--", ...args]);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}\n${text}`);
  }
}

const report = parseJson(cargo("run", "--once", "--json"), "resident run once");
const syncSurface = report.surfaces?.find((surface) => surface.name === "agent-log-sync");
if (!syncSurface || syncSurface.status !== "exited") {
  throw new Error(`resident agent-log-sync should exit cleanly: ${JSON.stringify(report)}`);
}
if (!syncSurface.message?.includes("resident Writer")) {
  throw new Error(`agent-log-sync did not use resident Writer: ${JSON.stringify(syncSurface)}`);
}
console.log(JSON.stringify({ ok: true, pid: report.pid, appDataDir }, null, 2));
