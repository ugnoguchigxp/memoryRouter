import assert from "node:assert/strict";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import {
  TEST_ADMIN_KEY,
  createIsolatedRuntime,
  freePort,
  projectRoot,
  waitUntil,
} from "./testing/isolated-runtime.mjs";

const runtime = await createIsolatedRuntime();
try {
  await runtime.initialize();
  const preflight = JSON.parse(await runtime.cli("bootstrap", "preflight", "--json"));
  assert.equal(preflight.overallStatus, "ready");
  const port = await freePort();
  await runtime.startApi(port);
  const origin = `http://127.0.0.1:${port}`;
  const api = (route, options = {}) =>
    fetch(`${origin}/api${route}`, {
      ...options,
      signal: AbortSignal.timeout(15_000),
      headers: {
        "x-admin-api-key": TEST_ADMIN_KEY,
        "content-type": "application/json",
        ...options.headers,
      },
    });
  assert.equal((await fetch(`${origin}/api/knowledge`)).status, 401);
  const compileArgs = [
    "--no-env-file",
    "src/cli/compile.ts",
    "--goal",
    "understand this repository's development workflow",
    "--repo-path",
    projectRoot,
    "--change-types",
    "docs,plan",
    "--domains",
    "onboarding,workflow",
    "--json",
  ];
  const empty = JSON.parse(await runtime.run("bun", compileArgs));
  assert.equal(empty.rules.length + empty.procedures.length, 0);
  assert.ok(empty.runId);

  const created = await api("/knowledge", {
    method: "POST",
    body: JSON.stringify({
      type: "rule",
      status: "active",
      scope: "global",
      general: true,
      title: "Verify the development workflow before onboarding",
      body: "For onboarding workflow changes, run the isolated onboarding smoke and confirm backup verification before declaring the workflow ready.",
      domains: ["onboarding", "workflow"],
      changeTypes: ["docs", "plan"],
      confidence: 95,
      importance: 95,
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const knowledge = (await created.json()).item;
  const pack = JSON.parse(await runtime.run("bun", compileArgs));
  assert.ok(
    [...pack.rules, ...pack.procedures].some(
      (item) => item.itemId === knowledge.id || item.id === knowledge.id,
    ),
    "first populated compile must retrieve the saved knowledge",
  );
  const persisted = await runtime.writer(
    "SELECT id FROM context_compile_runs WHERE id = ?",
    [pack.runId],
    "all",
  );
  assert.equal(persisted.rows.length, 1);
  const usage = await runtime.writer("SELECT COUNT(*) AS count FROM llm_usage_logs", [], "all");
  assert.equal(usage.rows[0].count, 0, "onboarding must not call providers");
  await assert.rejects(
    runtime.cli("backup", "create", "--json"),
    /requires the resident Writer to be stopped/,
  );
  await runtime.stopWriter();
  await waitUntil(
    async () => (await fetch(`${origin}/api/health/ready`)).status === 503,
    "writer outage readiness",
  );
  assert.equal((await fetch(`${origin}/api/health/live`)).status, 200);
  await runtime.startWriter();
  await waitUntil(
    async () => (await fetch(`${origin}/api/health/ready`)).status === 200,
    "writer recovery readiness",
  );
  await runtime.stopWriter();
  const backup = JSON.parse(await runtime.cli("backup", "create", "--json"));
  const verified = JSON.parse(
    await runtime.cli("backup", "verify", "--path", backup.output, "--json"),
  );
  assert.equal(verified.knowledgeItems, 1);
  const restoredPath = path.join(runtime.directory, "restored.sqlite");
  await copyFile(backup.output, restoredPath);
  const restored = JSON.parse(
    await runtime.cli("backup", "verify", "--path", restoredPath, "--json"),
  );
  assert.equal(restored.sha256, verified.sha256);
  const recovered = JSON.parse(
    await runtime.run("bun", [
      "--no-env-file",
      "-e",
      'const {Database}=await import("bun:sqlite"); const db=new Database(process.argv[1],{readonly:true}); console.log(JSON.stringify({knowledge:db.query("SELECT id, body FROM knowledge_items").all(),runs:db.query("SELECT id FROM context_compile_runs").all()})); db.close();',
      restoredPath,
    ]),
  );
  assert.equal(recovered.knowledge[0].id, knowledge.id);
  assert.ok(recovered.knowledge[0].body.includes("isolated onboarding smoke"));
  assert.ok(recovered.runs.some((run) => run.id === pack.runId));
  console.log(
    JSON.stringify(
      {
        ok: true,
        bootstrap: "ready",
        compile: { emptyRunPersisted: true, savedKnowledgeRetrieved: true },
        readiness: "ready -> not_ready -> ready",
        providerCalls: 0,
        backup: {
          writeLockEnforced: true,
          sha256: verified.sha256,
          restoredKnowledge: verified.knowledgeItems,
          restoredRuns: recovered.runs.length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await runtime.cleanup();
}
