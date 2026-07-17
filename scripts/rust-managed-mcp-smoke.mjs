import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-stilld-mcp-smoke-"));
const port = String(41000 + Math.floor(Math.random() * 10000));
const env = {
  ...process.env,
  CONTEXT_STILL_APP_DATA_DIR: appDataDir,
  CONTEXT_STILL_PROJECT_ROOT: root,
  CONTEXT_STILL_MCP_HOST: "127.0.0.1",
  CONTEXT_STILL_MCP_PORT: port,
};

function run(args, options = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let managedPid = null;
try {
  const start = parseJson(cargo("mcp", "start", "--json"), "mcp start");
  if (!["started", "already_running"].includes(start.status)) {
    throw new Error(`unexpected start status: ${start.status}`);
  }

  let smoke;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    smoke = parseJson(cargo("mcp", "smoke", "--json"), "mcp smoke");
    if (smoke.ok) break;
    sleep(250);
  }
  if (!smoke?.ok) {
    throw new Error(`MCP smoke did not become ready: ${JSON.stringify(smoke)}`);
  }
  if (!Number.isInteger(smoke.toolCount) || smoke.toolCount <= 0) {
    throw new Error(`MCP smoke reported no tools: ${JSON.stringify(smoke)}`);
  }
  if (smoke.toolOwners?.counts?.rustNative !== 12 || smoke.toolOwners?.counts?.tsSidecar !== 0) {
    throw new Error(
      `MCP smoke reported unexpected tool owners: ${JSON.stringify(smoke.toolOwners)}`,
    );
  }

  const sessions = parseJson(cargo("mcp", "sessions", "--json"), "mcp sessions");
  if (!Array.isArray(sessions.sessions)) {
    throw new Error(`MCP sessions payload is invalid: ${JSON.stringify(sessions)}`);
  }

  const status = parseJson(cargo("mcp", "status", "--json"), "mcp status");
  if (!["running", "degraded"].includes(status.status)) {
    throw new Error(`MCP status should be running/degraded before stop: ${JSON.stringify(status)}`);
  }
  managedPid = status.pid;

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpoint: smoke.endpoint.url,
        toolCount: smoke.toolCount,
        toolOwners: smoke.toolOwners,
        pid: status.pid,
        appDataDir,
      },
      null,
      2,
    ),
  );
} finally {
  if (Number.isInteger(managedPid) && managedPid > 1 && managedPid !== process.pid) {
    try {
      process.kill(managedPid, "SIGTERM");
    } catch {}
  }
}
