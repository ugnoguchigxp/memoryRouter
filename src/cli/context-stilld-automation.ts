import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../..");
const plistDir = path.resolve(projectRoot, "scripts/automation");
const launchAgentsDir = path.resolve(os.homedir(), "Library/LaunchAgents");
const plist = "com.context-still.daemon.plist";
const label = "com.context-still.daemon";
const legacyQueuePlist = "com.context-still.queue-supervisor.plist";
const legacyQueueLabel = "com.context-still.queue-supervisor";
const legacyMemoryRouterQueuePlist = "com.memory-router.queue-supervisor.plist";
const legacyMemoryRouterQueueLabel = "com.memory-router.queue-supervisor";
const legacyAgentLogSyncPlist = "com.context-still.agent-log-sync.plist";
const legacyAgentLogSyncLabel = "com.context-still.agent-log-sync";
const legacyMemoryRouterAgentLogSyncPlist = "com.memory-router.agent-log-sync.plist";
const legacyMemoryRouterAgentLogSyncLabel = "com.memory-router.agent-log-sync";

function isDarwin(): boolean {
  return process.platform === "darwin";
}

function ensureDarwinForLaunchCtl(action: string): void {
  if (!isDarwin()) {
    throw new Error(`${action} is only supported on macOS. Use run-once or run-continuous.`);
  }
}

function getUid(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("uid is unavailable on this platform.");
  }
  return String(process.getuid());
}

function launchctlQuiet(...args: string[]): void {
  try {
    execFileSync("launchctl", args, { stdio: "ignore" });
  } catch {
    // The old or new job may legitimately be absent.
  }
}

function launchctl(...args: string[]): void {
  execFileSync("launchctl", args, { stdio: "inherit" });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function terminateDetachedQueueSupervisors(): void {
  if (!isDarwin()) return;
  let killed = false;
  const signalMatchingSupervisors = (signal: NodeJS.Signals): boolean => {
    let signaled = false;
    try {
      const output = execFileSync("pgrep", [
        "-f",
        "bun run src/cli/queue-supervisor.ts --continuous --limit 1",
      ]);
      for (const rawPid of output
        .toString()
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)) {
        const pid = Number(rawPid);
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, signal);
            signaled = true;
          } catch {
            // Process may have exited between pgrep and kill.
          }
        }
      }
    } catch {
      // Detached queue supervisor children may legitimately be absent.
    }
    return signaled;
  };

  killed = signalMatchingSupervisors("SIGTERM");
  if (killed) sleepSync(1000);
  if (signalMatchingSupervisors("SIGKILL")) {
    sleepSync(250);
  }
}

function ensureContextStilldBinary(): string {
  const configured = process.env.CONTEXT_STILLD_PATH;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`CONTEXT_STILLD_PATH does not exist: ${configured}`);
    }
    return configured;
  }

  const profile = process.env.CONTEXT_STILLD_PROFILE === "release" ? "release" : "debug";
  const binary = path.resolve(projectRoot, "target", profile, "context-stilld");
  const args = ["build", "-p", "context-stilld"];
  if (profile === "release") args.push("--release");
  execFileSync("cargo", args, { cwd: projectRoot, stdio: "inherit" });
  return binary;
}

function isDisabledFlag(value: string): boolean {
  return value === "0" || value.toLowerCase() === "false";
}

function resolveResidentMcpFlag(): string {
  const value = process.env.CONTEXT_STILL_RESIDENT_MCP ?? "1";
  if (isDisabledFlag(value) && process.env.CONTEXT_STILL_ALLOW_RESIDENT_MCP_DISABLED !== "1") {
    throw new Error(
      [
        "Refusing to install resident LaunchAgent with CONTEXT_STILL_RESIDENT_MCP disabled.",
        "Reboot persistence without MCP breaks agent integration.",
        "Set CONTEXT_STILL_ALLOW_RESIDENT_MCP_DISABLED=1 only for an intentional MCP-disabled install.",
      ].join(" "),
    );
  }
  return value;
}

function readInstalledResidentMcpFlag(plistPath: string): string | null {
  if (!existsSync(plistPath)) return null;
  const content = readFileSync(plistPath, "utf8");
  return (
    /<key>CONTEXT_STILL_RESIDENT_MCP<\/key>\s*<string>([^<]+)<\/string>/.exec(content)?.[1] ?? null
  );
}

function renderPlist(): string {
  const template = readFileSync(path.resolve(plistDir, plist), "utf8");
  const appDataDir =
    process.env.CONTEXT_STILL_APP_DATA_DIR ??
    path.resolve(os.homedir(), "Library/Application Support/contextStill");
  const launchPath = [
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  const sqliteCorePath =
    process.env.CONTEXT_STILL_SQLITE_CORE_PATH ??
    path.resolve(projectRoot, "data", "context-still-core.sqlite");
  return template
    .replaceAll("{{CONTEXT_STILLD_PATH}}", ensureContextStilldBinary())
    .replaceAll("{{PROJECT_ROOT}}", projectRoot)
    .replaceAll("{{PATH}}", launchPath)
    .replaceAll("{{APP_DATA_DIR}}", appDataDir)
    .replaceAll("{{DB_BACKEND}}", process.env.CONTEXT_STILL_DB_BACKEND ?? "sqlite")
    .replaceAll("{{SQLITE_CORE_PATH}}", sqliteCorePath)
    .replaceAll("{{RESIDENT_MCP}}", resolveResidentMcpFlag())
    .replaceAll("{{RESIDENT_QUEUE}}", process.env.CONTEXT_STILL_RESIDENT_QUEUE ?? "1")
    .replaceAll(
      "{{RESIDENT_QUEUE_MODE}}",
      process.env.CONTEXT_STILL_RESIDENT_QUEUE_MODE ?? "continuous",
    )
    .replaceAll(
      "{{RESIDENT_QUEUE_INTERVAL_MS}}",
      process.env.CONTEXT_STILL_RESIDENT_QUEUE_INTERVAL_MS ?? "5000",
    )
    .replaceAll(
      "{{RESIDENT_AGENT_LOG_SYNC}}",
      process.env.CONTEXT_STILL_RESIDENT_AGENT_LOG_SYNC ?? "1",
    )
    .replaceAll(
      "{{AGENT_LOG_SYNC_INTERVAL_SECONDS}}",
      process.env.CONTEXT_STILL_AGENT_LOG_SYNC_INTERVAL_SECONDS ?? "3600",
    )
    .replaceAll(
      "{{AGENT_LOG_SYNC_RUN_AT_LOAD}}",
      process.env.CONTEXT_STILL_AGENT_LOG_SYNC_RUN_AT_LOAD ?? "0",
    );
}

function install(): void {
  ensureDarwinForLaunchCtl("install");
  mkdirSync(launchAgentsDir, { recursive: true });
  mkdirSync(path.resolve(projectRoot, "logs"), { recursive: true });
  const target = path.resolve(launchAgentsDir, plist);
  writeFileSync(target, renderPlist(), { encoding: "utf8", mode: 0o644 });
  console.log(`installed: ${target}`);
}

function unloadLegacyQueueOwners(): void {
  const uid = getUid();
  for (const item of [
    [legacyQueuePlist, legacyQueueLabel],
    [legacyMemoryRouterQueuePlist, legacyMemoryRouterQueueLabel],
    [legacyAgentLogSyncPlist, legacyAgentLogSyncLabel],
    [legacyMemoryRouterAgentLogSyncPlist, legacyMemoryRouterAgentLogSyncLabel],
  ] as const) {
    const [legacyPlist, legacyLabel] = item;
    const target = path.resolve(launchAgentsDir, legacyPlist);
    launchctlQuiet("bootout", `gui/${uid}`, target);
    launchctlQuiet("bootout", `gui/${uid}/${legacyLabel}`);
  }
}

function loadJob(): void {
  ensureDarwinForLaunchCtl("load");
  const target = path.resolve(launchAgentsDir, plist);
  if (!existsSync(target)) install();
  const uid = getUid();
  launchctlQuiet("bootout", `gui/${uid}`, target);
  unloadLegacyQueueOwners();
  terminateDetachedQueueSupervisors();
  launchctl("bootstrap", `gui/${uid}`, target);
  console.log(`loaded: ${label}`);
  console.log(`unloaded legacy queue owner: ${legacyQueueLabel}`);
  console.log(`unloaded legacy agent-log-sync owner: ${legacyAgentLogSyncLabel}`);
}

function unloadJob(): void {
  ensureDarwinForLaunchCtl("unload");
  const target = path.resolve(launchAgentsDir, plist);
  const uid = getUid();
  launchctlQuiet("bootout", `gui/${uid}`, target);
  launchctlQuiet("bootout", `gui/${uid}/${label}`);
  terminateDetachedQueueSupervisors();
  console.log(`unloaded: ${label}`);
}

function uninstall(): void {
  ensureDarwinForLaunchCtl("uninstall");
  unloadJob();
  const target = path.resolve(launchAgentsDir, plist);
  rmSync(target, { force: true });
  console.log(`removed: ${target}`);
}

function status(): void {
  ensureDarwinForLaunchCtl("status");
  const target = path.resolve(launchAgentsDir, plist);
  if (!existsSync(target)) {
    console.log(`${label}: not installed`);
  } else {
    const uid = getUid();
    try {
      const output = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
        encoding: "utf8",
      });
      console.log(`${label}: loaded`);
      console.log(output);
    } catch {
      console.log(`${label}: installed but not loaded`);
    }
  }

  const residentMcp = readInstalledResidentMcpFlag(target);
  if (residentMcp && isDisabledFlag(residentMcp)) {
    console.log(
      [
        "warning: installed LaunchAgent has CONTEXT_STILL_RESIDENT_MCP disabled.",
        "Reinstall with `bun run automation:context-stilld -- install` and reload with `bun run automation:context-stilld -- load` to restore reboot-persistent MCP.",
      ].join(" "),
    );
  }

  for (const legacyLabel of [
    legacyQueueLabel,
    legacyMemoryRouterQueueLabel,
    legacyAgentLogSyncLabel,
    legacyMemoryRouterAgentLogSyncLabel,
  ]) {
    try {
      execFileSync("launchctl", ["print", `gui/${getUid()}/${legacyLabel}`], {
        encoding: "utf8",
        stdio: "ignore",
      });
      console.log(`${legacyLabel}: still loaded`);
    } catch {
      console.log(`${legacyLabel}: not loaded`);
    }
  }
}

function runOnce(): void {
  const result = spawnSync(ensureContextStilldBinary(), ["run", "--once", "--json"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CONTEXT_STILL_PROJECT_ROOT: process.env.CONTEXT_STILL_PROJECT_ROOT ?? projectRoot,
      CONTEXT_STILL_DB_BACKEND: process.env.CONTEXT_STILL_DB_BACKEND ?? "sqlite",
      CONTEXT_STILL_SQLITE_CORE_PATH:
        process.env.CONTEXT_STILL_SQLITE_CORE_PATH ??
        path.resolve(projectRoot, "data", "context-still-core.sqlite"),
      CONTEXT_STILL_RESIDENT_QUEUE_MODE:
        process.env.CONTEXT_STILL_RESIDENT_QUEUE_MODE ?? "continuous",
    },
  });
  process.exitCode = result.status ?? 1;
}

function runContinuous(): void {
  const result = spawnSync(ensureContextStilldBinary(), ["run"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      CONTEXT_STILL_PROJECT_ROOT: process.env.CONTEXT_STILL_PROJECT_ROOT ?? projectRoot,
      CONTEXT_STILL_DB_BACKEND: process.env.CONTEXT_STILL_DB_BACKEND ?? "sqlite",
      CONTEXT_STILL_SQLITE_CORE_PATH:
        process.env.CONTEXT_STILL_SQLITE_CORE_PATH ??
        path.resolve(projectRoot, "data", "context-still-core.sqlite"),
      CONTEXT_STILL_RESIDENT_QUEUE_MODE:
        process.env.CONTEXT_STILL_RESIDENT_QUEUE_MODE ?? "continuous",
    },
  });
  process.exitCode = result.status ?? 1;
}

function main(): void {
  const action = process.argv[2] ?? "";
  try {
    switch (action) {
      case "install":
        install();
        break;
      case "load":
        loadJob();
        break;
      case "unload":
        unloadJob();
        break;
      case "uninstall":
        uninstall();
        break;
      case "status":
        status();
        break;
      case "run-once":
        runOnce();
        break;
      case "run-continuous":
        runContinuous();
        break;
      default:
        console.error(
          "Usage: bun run src/cli/context-stilld-automation.ts -- {install|load|unload|uninstall|status|run-once|run-continuous}",
        );
        process.exitCode = 1;
        break;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

main();
