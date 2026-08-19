import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const tasks = [
  { label: "system-context:check", script: "system-context:check" },
  { label: "system-context:boundary", script: "system-context:boundary" },
  { label: "typecheck", script: "typecheck" },
  { label: "lint", script: "lint" },
  { label: "format:check", script: "format:check" },
  { label: "spec:check", script: "spec:check" },
  { label: "test:unit", script: "test:unit" },
  { label: "build:web", script: "build:web" },
];

function formatDuration(startedAt) {
  return `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
}

function runTask(task) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    console.log(`[verify] ${task.label} ...`);

    const child = spawn("bun", ["--silent", "run", task.script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"],
    });

    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.on("error", (error) => {
      resolve({
        task,
        code: 1,
        signal: null,
        duration: formatDuration(startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${error.message}\n`,
      });
    });

    child.on("close", (code, signal) => {
      resolve({
        task,
        code: code ?? 1,
        signal,
        duration: formatDuration(startedAt),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

for (const task of tasks) {
  const result = await runTask(task);

  if (result.code !== 0 || result.signal) {
    console.error(`[verify] ${result.task.label} failed (${result.duration})`);

    if (result.stdout.trim()) {
      console.error(`\n--- ${result.task.label} stdout ---`);
      console.error(result.stdout.trimEnd());
    }

    if (result.stderr.trim()) {
      console.error(`\n--- ${result.task.label} stderr ---`);
      console.error(result.stderr.trimEnd());
    }

    process.exit(result.code || 1);
  }

  console.log(`[verify] ${task.label} ok (${result.duration})`);
}
