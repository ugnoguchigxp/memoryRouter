import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const tasks = [
  {
    label: "sqlite writer ownership",
    command: ["bun", "scripts/verify-sqlite-writer-ownership.mjs"],
  },
  { label: "cargo fmt", command: ["cargo", "fmt", "--check"] },
  {
    label: "cargo clippy",
    command: ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
  },
  { label: "cargo test", command: ["cargo", "test", "--workspace"] },
  {
    label: "context-stilld paths",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "paths", "--json"],
  },
  {
    label: "context-stilld status",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "status", "--json"],
  },
  {
    label: "context-stilld resident run once",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "run", "--once", "--json"],
    env: { CONTEXT_STILL_MCP_PORT: "0" },
  },
  {
    label: "context-stilld bootstrap preflight",
    command: [
      "cargo",
      "run",
      "-q",
      "-p",
      "context-stilld",
      "--",
      "bootstrap",
      "preflight",
      "--json",
    ],
  },
  {
    label: "context-stilld doctor summary",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "doctor", "summary", "--json"],
  },
  {
    label: "context-stilld backup preflight",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "backup", "preflight", "--json"],
  },
  {
    label: "context-stilld queue status",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "queue", "status", "--json"],
  },
  {
    label: "context-stilld queue inspect",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "queue", "inspect", "--json"],
  },
  {
    label: "context-stilld runtime sidecars",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "runtime", "sidecars", "--json"],
  },
  {
    label: "context-stilld runtime assert rust only",
    command: [
      "cargo",
      "run",
      "-q",
      "-p",
      "context-stilld",
      "--",
      "runtime",
      "assert-rust-only",
      "--json",
    ],
  },
  {
    label: "context-stilld vector smoke",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "vector", "smoke", "--json"],
  },
  {
    label: "context-stilld mcp endpoint",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "mcp", "endpoint", "--json"],
  },
  {
    label: "context-stilld mcp sessions",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "mcp", "sessions", "--json"],
  },
  {
    label: "context-stilld mcp smoke",
    command: ["cargo", "run", "-q", "-p", "context-stilld", "--", "mcp", "smoke", "--json"],
  },
  { label: "rust managed mcp smoke", command: ["bun", "scripts/rust-managed-mcp-smoke.mjs"] },
  { label: "rust managed queue smoke", command: ["bun", "scripts/rust-managed-queue-smoke.mjs"] },
  { label: "rust admin api smoke", command: ["bun", "scripts/rust-admin-api-smoke.mjs"] },
  {
    label: "rust agent log sync smoke",
    command: ["bun", "scripts/rust-agent-log-sync-smoke.mjs"],
  },
];

function formatDuration(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

async function runTask(task) {
  console.log(`[verify:rust-daemon] ${task.label} ...`);
  const result = await runCommand(task.command, { env: task.env });
  return { ...result, task };
}

function runCommand(command, options = {}) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const [bin, ...args] = command;
    const child = spawn(bin, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONTEXT_STILL_APP_DATA_DIR:
          process.env.CONTEXT_STILL_APP_DATA_DIR ?? ".tmp/context-stilld-verify",
        ...options.env,
      },
      stdio: ["inherit", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({
        code: 1,
        duration: formatDuration(startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}\n`,
      });
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        duration: formatDuration(startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function printFailure(result) {
  console.error(`[verify:rust-daemon] ${result.task.label} failed (${result.duration})`);
  if (result.stdout.trim()) {
    console.error(`\n--- ${result.task.label} stdout ---`);
    console.error(result.stdout.trimEnd());
  }
  if (result.stderr.trim()) {
    console.error(`\n--- ${result.task.label} stderr ---`);
    console.error(result.stderr.trimEnd());
  }
}

function assertJsonLine(result, expectedField) {
  try {
    const json = JSON.parse(result.stdout);
    if (!(expectedField in json)) {
      return {
        ...result,
        code: 1,
        stderr: `${result.stderr}\nMissing expected field: ${expectedField}\n`,
      };
    }
  } catch (error) {
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}\nOutput was not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    };
  }
  return result;
}

function assertRuntimeSidecars(result) {
  const checked = assertJsonLine(result, "sidecars");
  if (checked.code !== 0) return checked;
  const json = JSON.parse(result.stdout);
  if (json.residentOwnedTemporaryCount !== 0) {
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}\nExpected residentOwnedTemporaryCount=0, got ${json.residentOwnedTemporaryCount}\n`,
    };
  }
  return result;
}

function assertRuntimeRustOnly(result) {
  const checked = assertJsonLine(result, "ok");
  if (checked.code !== 0) return checked;
  const json = JSON.parse(result.stdout);
  if (json.ok !== true) {
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}\nExpected runtime assert-rust-only ok=true, got ${json.ok}. daemonDebtCount=${json.daemonDebtCount}\n`,
    };
  }
  return result;
}

function assertQueueInspect(result) {
  const checked = assertJsonLine(result, "queues");
  if (checked.code !== 0) return checked;
  const json = JSON.parse(result.stdout);
  if (json.executorMode === "maintenance_only" && Number(json.runnablePendingCount ?? 0) > 0) {
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}\nQueue has runnable pending jobs but no executor is active: executorMode=${json.executorMode} runnablePendingCount=${json.runnablePendingCount}\n`,
    };
  }
  return result;
}

function assertVectorSmoke(result) {
  const checked = assertJsonLine(result, "vecUsable");
  if (checked.code !== 0) return checked;
  const json = JSON.parse(result.stdout);
  if (json.vecUsable !== true || json.status !== "ok") {
    return {
      ...result,
      code: 1,
      stderr: `${result.stderr}\nExpected vector smoke status=ok and vecUsable=true, got status=${json.status} vecUsable=${json.vecUsable}\n`,
    };
  }
  return result;
}

async function runLiveOwnershipCheck() {
  console.log("[verify:rust-daemon] live ownership check ...");
  if (process.platform !== "darwin") {
    console.error("Live ownership check currently supports macOS launchd only.");
    process.exit(1);
  }

  const guiDomain = `gui/${process.getuid()}`;
  const expectedDaemon = await runCommand([
    "launchctl",
    "print",
    `${guiDomain}/com.context-still.daemon`,
  ]);
  if (expectedDaemon.code !== 0) {
    console.error("[verify:rust-daemon] live ownership check failed");
    console.error("Expected com.context-still.daemon to be loaded.");
    if (expectedDaemon.stderr.trim()) {
      console.error(expectedDaemon.stderr.trimEnd());
    }
    process.exit(1);
  }

  for (const label of [
    "com.context-still.queue-supervisor",
    "com.context-still.finding-worker",
    "com.context-still.covering-worker",
    "com.context-still.agent-log-sync",
    "com.memory-router.queue-supervisor",
    "com.memory-router.agent-log-sync",
  ]) {
    const legacy = await runCommand(["launchctl", "print", `${guiDomain}/${label}`]);
    if (legacy.code === 0) {
      console.error("[verify:rust-daemon] live ownership check failed");
      console.error(`Legacy LaunchAgent ${label} is loaded; durable ownership is ambiguous.`);
      if (legacy.stdout.trim()) {
        console.error(legacy.stdout.trimEnd());
      }
      process.exit(1);
    }
  }

  const status = assertJsonLine(
    await runCommand(["cargo", "run", "-q", "-p", "context-stilld", "--", "status", "--json"]),
    "runtimeHost",
  );
  if (status.code !== 0) {
    console.error("[verify:rust-daemon] live ownership status JSON failed");
    if (status.stderr.trim()) {
      console.error(status.stderr.trimEnd());
    }
    process.exit(1);
  }
  const statusJson = JSON.parse(status.stdout);
  if (statusJson.runtimeHost !== "rust-resident") {
    console.error("[verify:rust-daemon] live ownership check failed");
    console.error(`Expected runtimeHost=rust-resident, got ${statusJson.runtimeHost}`);
    process.exit(1);
  }

  const processList = await runCommand(["ps", "axo", "pid=,command="]);
  if (processList.code !== 0) {
    console.error("[verify:rust-daemon] live ownership process inspection failed");
    if (processList.stderr.trim()) console.error(processList.stderr.trimEnd());
    process.exit(1);
  }
  for (const pattern of [
    "src/mcp/http-server.ts",
    "src/cli/mcp-dispatch-once.ts",
    "src/cli/queue-supervisor.ts --continuous",
  ]) {
    if (processList.stdout.includes(pattern)) {
      console.error("[verify:rust-daemon] live ownership check failed");
      console.error(`Unexpected daemon-era Bun process still running: ${pattern}`);
      process.exit(1);
    }
  }

  console.log(`[verify:rust-daemon] live ownership check ok (${expectedDaemon.duration})`);
}

for (const task of tasks) {
  let result = await runTask(task);
  if (task.label === "context-stilld paths" && result.code === 0) {
    result = assertJsonLine(result, "appDataDir");
  }
  if (task.label === "context-stilld status" && result.code === 0) {
    result = assertJsonLine(result, "runtimeHost");
  }
  if (task.label === "context-stilld resident run once" && result.code === 0) {
    result = assertJsonLine(result, "surfaces");
  }
  if (task.label === "context-stilld bootstrap preflight" && result.code === 0) {
    result = assertJsonLine(result, "overallStatus");
  }
  if (task.label === "context-stilld doctor summary" && result.code === 0) {
    result = assertJsonLine(result, "readinessCheck");
  }
  if (task.label === "context-stilld backup preflight" && result.code === 0) {
    result = assertJsonLine(result, "delegatedBackupCommand");
  }
  if (task.label === "context-stilld queue status" && result.code === 0) {
    result = assertJsonLine(result, "process");
  }
  if (task.label === "context-stilld queue inspect" && result.code === 0) {
    result = assertQueueInspect(result);
  }
  if (task.label === "context-stilld runtime sidecars" && result.code === 0) {
    result = assertRuntimeSidecars(result);
  }
  if (task.label === "context-stilld runtime assert rust only" && result.code === 0) {
    result = assertRuntimeRustOnly(result);
  }
  if (task.label === "context-stilld vector smoke" && result.code === 0) {
    result = assertVectorSmoke(result);
  }
  if (task.label === "context-stilld mcp endpoint" && result.code === 0) {
    result = assertJsonLine(result, "url");
  }
  if (task.label === "context-stilld mcp sessions" && result.code === 0) {
    result = assertJsonLine(result, "activeSessionCount");
  }
  if (task.label === "context-stilld mcp smoke" && result.code === 0) {
    result = assertJsonLine(result, "ok");
  }
  if (task.label.startsWith("rust ") && result.code === 0) {
    result = assertJsonLine(result, "ok");
  }
  if (result.code !== 0) {
    printFailure(result);
    process.exit(result.code);
  }
  console.log(`[verify:rust-daemon] ${task.label} ok (${result.duration})`);
}

if (process.env.CONTEXT_STILL_VERIFY_LIVE_OWNERSHIP === "1") {
  await runLiveOwnershipCheck();
}
