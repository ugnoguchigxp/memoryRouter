import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const TEST_ADMIN_KEY = "context-still-isolated-test-key-0123456789abcdef";

export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

export async function waitUntil(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function createIsolatedRuntime() {
  const directory = await mkdtemp(path.join(tmpdir(), "context-still-isolated-test-"));
  const children = [];
  const endpointPath = path.join(directory, "run", "mcp-endpoint.json");
  const emptyEnv = path.join(directory, "empty.env");
  await writeFile(emptyEnv, "");
  await mkdir(path.join(directory, "wiki"));
  // Allow compiler/toolchain locations, but never inherit DB paths, credentials or service URLs.
  const env = Object.fromEntries(
    [
      "PATH",
      "HOME",
      "USER",
      "TMPDIR",
      "CARGO_HOME",
      "RUSTUP_HOME",
      "RUSTUP_TOOLCHAIN",
      "SystemRoot",
      "APPDATA",
    ]
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  Object.assign(env, {
    NODE_ENV: "production",
    DOTENV_CONFIG_PATH: emptyEnv,
    CONTEXT_STILL_APP_DATA_DIR: directory,
    CONTEXT_STILL_PROJECT_ROOT: projectRoot,
    CONTEXT_STILL_DB_BACKEND: "sqlite",
    CONTEXT_STILL_SQLITE_CORE_PATH: path.join(directory, "core.sqlite"),
    CONTEXT_STILL_MCP_HOST: "127.0.0.1",
    CONTEXT_STILL_MCP_PORT: String(await freePort()),
    CONTEXT_STILL_MCP_ENDPOINT_PATH: endpointPath,
    CONTEXT_STILL_SOURCE_CONTENT_ROOT: path.join(directory, "wiki"),
    CONTEXT_STILL_ADMIN_API_KEY: TEST_ADMIN_KEY,
    CONTEXT_STILL_EMBEDDING_PROVIDER: "disabled",
    CONTEXT_STILL_LOCAL_LLM_API_BASE_URL: "http://127.0.0.1:1",
    CONTEXT_STILL_RESIDENT_QUEUE: "0",
    CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC: "0",
    CONTEXT_STILL_RESIDENT_MCP: "1",
    CONTEXT_STILL_TEST_VITE_CACHE_DIR: path.join(directory, "vite-cache"),
  });
  const binary = path.join(
    projectRoot,
    "target",
    "debug",
    process.platform === "win32" ? "context-stilld.exe" : "context-stilld",
  );

  function start(command, args, overrides = {}) {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: { ...env, ...overrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => {
      output = (output + data).slice(-64_000);
    });
    child.stderr.on("data", (data) => {
      output = (output + data).slice(-64_000);
    });
    child.on("error", (error) => {
      output += error.message;
    });
    children.push(child);
    return { child, output: () => output };
  }

  async function run(command, args, overrides = {}, timeoutMs = 120_000) {
    const execution = start(command, args, overrides);
    const timer = setTimeout(() => execution.child.kill("SIGKILL"), timeoutMs);
    try {
      const [code] = await once(execution.child, "exit");
      assert.equal(code, 0, `${command} ${args.join(" ")} failed:\n${execution.output()}`);
      return execution.output().trim();
    } finally {
      clearTimeout(timer);
    }
  }

  async function stop(child) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  async function writer(sql, params = [], method = "run") {
    const metadata = JSON.parse(await readFile(endpointPath, "utf8"));
    const token = (await readFile(metadata.writerTokenPath, "utf8")).trim();
    const response = await fetch(metadata.writerUrl, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ clientId: "isolated-test", sql, params, method, rowMode: "object" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true, JSON.stringify(payload));
    return payload;
  }

  let mcp;
  async function startWriter() {
    mcp = start(binary, ["run"]);
    await waitUntil(async () => {
      if (mcp.child.exitCode !== null) throw new Error(mcp.output());
      try {
        await writer("SELECT 1", [], "get");
        return true;
      } catch {
        return false;
      }
    }, "isolated SQLite writer");
  }

  return {
    directory,
    env,
    binary,
    start,
    run,
    writer,
    startWriter,
    cli: (...args) => run(binary, args),
    stopWriter: () => stop(mcp.child),
    async initialize() {
      await run("cargo", ["build", "--locked", "-q", "-p", "context-stilld"], {}, 600_000);
      const report = JSON.parse(await run(binary, ["bootstrap", "init", "--json"]));
      assert.equal(report.paths.sqliteCorePath, env.CONTEXT_STILL_SQLITE_CORE_PATH);
      await startWriter();
      // Persist the same minimal-mode choice exposed in Settings, through the real writer.
      await writer(
        "INSERT INTO settings(id, namespace, key, value) VALUES(?, 'runtime', 'settings.v1', ?) ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value",
        [
          "isolated-settings",
          JSON.stringify({ taskRouting: { agenticCompile: { enabled: false, fallback: [] } } }),
        ],
      );
    },
    async startApi(port, browser = false) {
      const api = browser
        ? start(
            "bun",
            [
              "--no-env-file",
              "./node_modules/vite/bin/vite.js",
              "--host",
              "127.0.0.1",
              "--port",
              String(port),
            ],
            { NODE_ENV: "development" },
          )
        : start("bun", ["--no-env-file", "api/index.ts"], { PORT: String(port) });
      try {
        await waitUntil(
          async () => {
            if (api.child.exitCode !== null) throw new Error(api.output());
            try {
              return (
                await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
                  signal: AbortSignal.timeout(2000),
                })
              ).ok;
            } catch {
              return false;
            }
          },
          "isolated API readiness",
          60_000,
        );
      } catch (error) {
        throw new Error(`${error.message}\n${api.output()}`);
      }
      return api;
    },
    async cleanup() {
      for (const child of children.toReversed()) await stop(child);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
