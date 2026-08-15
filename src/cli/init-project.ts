import path from "node:path";
import { closeDbPool } from "../db/index.js";
import { compileContextPack } from "../modules/context-compiler/context-compiler.service.js";
import { upsertKnowledgeFromSource } from "../modules/knowledge/knowledge.repository.js";
import { importMarkdownDirectory } from "../modules/sources/markdown-importer.service.js";
import { readProjectEnvFrom } from "../project-identity.js";
import { type SupportedLocale, resolveLocale } from "../shared/locales/locale.js";
import { buildMcpConfigSnippet } from "./onboarding/mcp-config.js";

type CliOptions = {
  wikiRoot: string;
  runImport: boolean;
  seedPreset: boolean;
  presetName: "typescript-react";
  runSmokeCompile: boolean;
  smokeGoal: string;
  repoPath: string;
  lang: SupportedLocale;
};

type PresetKnowledge = {
  id: string;
  type: "rule" | "procedure";
  title: string;
  body: string;
  confidence: number;
  importance: number;
};

type InitProjectSummary = {
  ok: boolean;
  lang: SupportedLocale;
  options: {
    wikiRoot: string;
    runImport: boolean;
    seedPreset: boolean;
    presetName: string;
    runSmokeCompile: boolean;
    smokeGoal: string;
    repoPath: string;
    lang: SupportedLocale;
  };
  mcpConfigSnippet: string;
  steps: {
    import?: {
      rootPath: string;
      importedFiles: number;
      importedSources: number;
      importedKnowledge: number;
      skippedFiles: number;
      removedSources: number;
    };
    globalPreset?: {
      presetName: string;
      insertedOrUpdated: number;
      knowledgeIds: string[];
      scope: "global";
    };
    smokeCompile?: {
      ok: boolean;
      status: "ok" | "degraded" | "failed";
      runId: string;
      relevantKnowledgeCount: number;
      degradedReasons: string[];
      suggestedNext: string[];
    };
  };
  nextActions: string[];
};

type InitProjectLocaleText = {
  defaultSmokeGoal: string;
  smokeNoKnowledgeSuggestions: string[];
  nextActionsNoSmoke: string[];
  nextActionsSmokeOk: string[];
  nextActionsSmokeFailed: string[];
};

const initProjectLocaleText: Record<SupportedLocale, InitProjectLocaleText> = {
  ja: {
    defaultSmokeGoal: "このリポジトリの初回セットアップ手順と検証手順を確認したい",
    smokeNoKnowledgeSuggestions: [
      "bun run import:sources -- <wiki root>",
      "bun run queue:finding:once",
      "Admin UI で draft knowledge を review して active に更新",
    ],
    nextActionsNoSmoke: [
      '必要なら bun run compile --goal "<your task>" --change-types bugfix,backend --json で smoke を実行する',
      "bun run doctor でシステム健全性を確認する",
      "mcpConfigSnippet を MCP クライアント設定へ貼り付ける",
      "Admin UI で新規 draft knowledge を review し、必要なものだけ active に昇格する",
    ],
    nextActionsSmokeOk: [
      "bun run doctor でシステム健全性を確認する",
      "mcpConfigSnippet を MCP クライアント設定へ貼り付ける",
      "Admin UI で新規 draft knowledge を review し、必要なものだけ active に昇格する",
      "通常運用では import:sources と resident context-stilld daemon を使う",
    ],
    nextActionsSmokeFailed: [
      "bun run import:sources -- <wiki root>",
      "bun run queue:finding:once",
      "bun run doctor でシステム健全性を確認する",
      "mcpConfigSnippet を MCP クライアント設定へ貼り付ける",
      "Admin UI で draft knowledge の根拠を確認して active/deprecated を整理する",
      'bun run compile --goal "<your task>" --change-types bugfix,backend --json',
    ],
  },
  en: {
    defaultSmokeGoal: "I want to validate initial setup and verification flow for this repository.",
    smokeNoKnowledgeSuggestions: [
      "bun run import:sources -- <wiki root>",
      "bun run queue:finding:once",
      "Review draft knowledge in Admin UI and promote required items to active",
    ],
    nextActionsNoSmoke: [
      'Run smoke compile manually if needed: bun run compile --goal "<your task>" --change-types bugfix,backend --json',
      "Run bun run doctor to confirm system health",
      "Paste mcpConfigSnippet into your MCP client config",
      "Review new draft knowledge in Admin UI and promote only required items",
    ],
    nextActionsSmokeOk: [
      "Run bun run doctor to confirm system health",
      "Paste mcpConfigSnippet into your MCP client config",
      "Review new draft knowledge in Admin UI and promote only required items",
      "In normal operations, use import:sources and the resident context-stilld daemon",
    ],
    nextActionsSmokeFailed: [
      "bun run import:sources -- <wiki root>",
      "bun run queue:finding:once",
      "Run bun run doctor to confirm system health",
      "Paste mcpConfigSnippet into your MCP client config",
      "Review evidence for draft knowledge in Admin UI and triage active/deprecated",
      'bun run compile --goal "<your task>" --change-types bugfix,backend --json',
    ],
  },
};

const presetKnowledgeByLocale: Record<
  CliOptions["presetName"],
  Record<SupportedLocale, PresetKnowledge[]>
> = {
  "typescript-react": {
    ja: [
      {
        id: "rule-verify-before-merge",
        type: "rule",
        title: "変更後は verify を完了させてから判断する",
        body: "TypeScript/Bun プロジェクトでは、変更後に `bun run verify` を実行し、typecheck, lint, format, unit, build が全て通ることを確認してから次の判断に進む。",
        confidence: 90,
        importance: 90,
      },
      {
        id: "rule-minimize-scope",
        type: "rule",
        title: "変更スコープは機能単位で最小化する",
        body: "修正時は関連しない領域へ影響を広げず、対象機能に必要な最小変更で完了させる。追加変更が必要なら別タスクとして分離し、回帰リスクを局所化する。",
        confidence: 85,
        importance: 85,
      },
      {
        id: "procedure-implement-loop",
        type: "procedure",
        title: "実装時の基本ループ",
        body: "1) 対象コードを読み、失敗条件と受け入れ条件を明確化する。 2) 変更を実装する。 3) 関連テストと verify を実行する。 4) 失敗時は原因を特定し、再実装して再検証する。",
        confidence: 85,
        importance: 80,
      },
      {
        id: "procedure-review-draft-knowledge",
        type: "procedure",
        title: "draft knowledge を active 化する手順",
        body: "distillation 後は draft knowledge を一覧確認し、根拠となる source/vibe memory を確認してから active に更新する。根拠が弱い項目は deprecated にして誤学習を防ぐ。",
        confidence: 88,
        importance: 82,
      },
    ],
    en: [
      {
        id: "rule-verify-before-merge",
        type: "rule",
        title: "Run verify before final judgment",
        body: "For TypeScript/Bun projects, run `bun run verify` after changes and continue only when typecheck, lint, format, unit tests, and build all pass.",
        confidence: 90,
        importance: 90,
      },
      {
        id: "rule-minimize-scope",
        type: "rule",
        title: "Keep change scope minimal per feature",
        body: "When fixing issues, avoid spreading impact into unrelated areas. Complete with the smallest required change and split extra work into separate tasks to localize regression risk.",
        confidence: 85,
        importance: 85,
      },
      {
        id: "procedure-implement-loop",
        type: "procedure",
        title: "Default implementation loop",
        body: "1) Read target code and define failure/acceptance conditions. 2) Implement the change. 3) Run relevant tests and verify. 4) If failing, identify root cause, re-implement, and validate again.",
        confidence: 85,
        importance: 80,
      },
      {
        id: "procedure-review-draft-knowledge",
        type: "procedure",
        title: "Promote draft knowledge to active",
        body: "After distillation, review draft knowledge, validate source/vibe-memory evidence, and then promote to active. Mark weak entries as deprecated to avoid low-quality learning.",
        confidence: 88,
        importance: 82,
      },
    ],
  },
};

function readArgValue(args: string[], index: number, name: string): string {
  const inline = args[index]?.match(new RegExp(`^${name}=(.*)$`))?.[1];
  if (inline !== undefined) return inline;
  const next = args[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return next;
}

function parseExplicitLocale(value: string): SupportedLocale {
  const normalized = value.trim().toLowerCase();
  if (normalized === "en") return "en";
  if (normalized === "ja") return "ja";
  throw new Error("--lang currently supports only: en, ja");
}

export function parseArgs(args: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const defaultLocale = resolveLocale(readProjectEnvFrom(env, "LANG"));
  const options: CliOptions = {
    wikiRoot: path.resolve(process.cwd(), "wiki/pages"),
    runImport: true,
    seedPreset: true,
    presetName: "typescript-react",
    runSmokeCompile: true,
    smokeGoal: initProjectLocaleText[defaultLocale].defaultSmokeGoal,
    repoPath: path.resolve(process.cwd()),
    lang: defaultLocale,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--wiki-root" || arg.startsWith("--wiki-root=")) {
      const value = readArgValue(args, index, "--wiki-root");
      if (arg === "--wiki-root") index += 1;
      options.wikiRoot = path.resolve(value);
    } else if (arg === "--skip-import") {
      options.runImport = false;
    } else if (arg === "--no-preset") {
      options.seedPreset = false;
    } else if (arg === "--preset" || arg.startsWith("--preset=")) {
      const value = readArgValue(args, index, "--preset").trim();
      if (arg === "--preset") index += 1;
      if (value !== "typescript-react") {
        throw new Error("--preset currently supports only: typescript-react");
      }
      options.presetName = value;
    } else if (arg === "--skip-smoke") {
      options.runSmokeCompile = false;
    } else if (arg === "--smoke-goal" || arg.startsWith("--smoke-goal=")) {
      const value = readArgValue(args, index, "--smoke-goal").trim();
      if (arg === "--smoke-goal") index += 1;
      if (!value) throw new Error("--smoke-goal must not be empty");
      options.smokeGoal = value;
    } else if (arg === "--repo-path" || arg.startsWith("--repo-path=")) {
      const value = readArgValue(args, index, "--repo-path").trim();
      if (arg === "--repo-path") index += 1;
      if (!value) throw new Error("--repo-path must not be empty");
      options.repoPath = path.resolve(value);
    } else if (arg === "--lang" || arg.startsWith("--lang=")) {
      const value = readArgValue(args, index, "--lang");
      if (arg === "--lang") index += 1;
      options.lang = parseExplicitLocale(value);
      if (!args.some((entry) => entry === "--smoke-goal" || entry.startsWith("--smoke-goal="))) {
        options.smokeGoal = initProjectLocaleText[options.lang].defaultSmokeGoal;
      }
    } else if (arg === "--json") {
      // JSON is the only output format.
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function seedGlobalPreset(
  presetName: CliOptions["presetName"],
  locale: SupportedLocale,
): Promise<{
  presetName: string;
  insertedOrUpdated: number;
  knowledgeIds: string[];
  scope: "global";
}> {
  const entries = presetKnowledgeByLocale[presetName][locale];
  const knowledgeIds: string[] = [];

  for (const entry of entries) {
    const sourceUri = `preset://context-still/${presetName}/${entry.id}`;
    const knowledgeId = await upsertKnowledgeFromSource({
      sourceUri,
      type: entry.type,
      status: "active",
      scope: "global",
      title: entry.title,
      body: entry.body,
      confidence: entry.confidence,
      importance: entry.importance,
      metadata: {
        sourceKind: "preset",
        presetName,
        presetVersion: "2026-05-15",
        language: locale,
      },
    });
    knowledgeIds.push(knowledgeId);
  }

  return {
    presetName,
    insertedOrUpdated: knowledgeIds.length,
    knowledgeIds,
    scope: "global",
  };
}

async function runSmokeCompile(
  options: CliOptions,
): Promise<InitProjectSummary["steps"]["smokeCompile"]> {
  if (!options.runSmokeCompile) return undefined;

  const { pack } = await compileContextPack(
    {
      goal: options.smokeGoal,
      changeTypes: ["plan", "docs"],
      domains: ["context-compiler", "knowledge"],
    },
    { source: "cli" },
  );

  const relevantKnowledgeCount = pack.rules.length + pack.procedures.length;
  const degradedReasons = [...pack.diagnostics.degradedReasons];
  const suggestedNext =
    relevantKnowledgeCount > 0
      ? []
      : initProjectLocaleText[options.lang].smokeNoKnowledgeSuggestions;

  return {
    ok: relevantKnowledgeCount > 0,
    status: pack.status,
    runId: pack.runId,
    relevantKnowledgeCount,
    degradedReasons,
    suggestedNext,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const localeText = initProjectLocaleText[options.lang];
  const summary: InitProjectSummary = {
    ok: true,
    lang: options.lang,
    options: {
      wikiRoot: options.wikiRoot,
      runImport: options.runImport,
      seedPreset: options.seedPreset,
      presetName: options.presetName,
      runSmokeCompile: options.runSmokeCompile,
      smokeGoal: options.smokeGoal,
      repoPath: options.repoPath,
      lang: options.lang,
    },
    mcpConfigSnippet: buildMcpConfigSnippet(options.repoPath),
    steps: {},
    nextActions: [],
  };

  if (options.runImport) {
    const importResult = await importMarkdownDirectory(options.wikiRoot, {
      scope: "repo",
      projectRoot: options.repoPath,
    }).catch((error) => {
      throw new Error(
        `[init-project/import] ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    summary.steps.import = {
      rootPath: options.wikiRoot,
      importedFiles: importResult.importedFiles,
      importedSources: importResult.importedSources,
      importedKnowledge: importResult.importedKnowledge,
      skippedFiles: importResult.skippedFiles,
      removedSources: importResult.removedSources,
    };
  }

  if (options.seedPreset) {
    summary.steps.globalPreset = await seedGlobalPreset(options.presetName, options.lang).catch(
      (error) => {
        throw new Error(
          `[init-project/seed-preset] ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  }

  summary.steps.smokeCompile = await runSmokeCompile(options);
  if (summary.steps.smokeCompile && !summary.steps.smokeCompile.ok) {
    summary.ok = false;
  }

  if (!options.runSmokeCompile) {
    summary.nextActions = localeText.nextActionsNoSmoke;
  } else if (summary.steps.smokeCompile?.ok) {
    summary.nextActions = localeText.nextActionsSmokeOk;
  } else {
    summary.nextActions = localeText.nextActionsSmokeFailed;
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDbPool();
  });
