import readline from "node:readline";
import type {
  AgenticCompileProvider,
  DistillationProvider,
  EmbeddingProvider,
} from "../../config.types.js";
import { projectIdentity, readProjectEnvFrom } from "../../project-identity.js";
import { type SupportedLocale, resolveLocale } from "../../shared/locales/locale.js";
import type { StartupPlan } from "./onboarding.types.js";

async function ask(query: string, defaultValue = ""): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.on("SIGINT", () => {
      rl.close();
      console.log("\n\nOperation cancelled. Exiting...");
      process.exit(1);
    });

    const formattedQuery = defaultValue ? `${query} [${defaultValue}]: ` : `${query}: `;
    rl.question(formattedQuery, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === "" ? defaultValue : trimmed);
    });
  });
}

async function askYesNo(query: string, defaultYes = true): Promise<boolean> {
  const defStr = defaultYes ? "y" : "n";
  const ans = await ask(`${query} (y/n)`, defStr);
  return ans.toLowerCase().startsWith("y");
}

export const onboardingPromptsText = {
  ja: {
    langSelect: "使用する言語を選択してください (ja / en)",
    dbUrl: "PostgreSQL データベース接続 URL",
    dbDocker: "Docker Compose で PostgreSQL を起動しますか？",
    llmProvider: "LLM プロバイダを選択してください (openai, local-llm, azure-openai, bedrock)",
    openaiKey: "OpenAI API キー",
    openaiBaseUrl: "OpenAI API ベース URL (省略時は標準)",
    openaiModel: "OpenAI モデル名 (省略時は標準)",
    azureKey: "Azure OpenAI API キー",
    azureBaseUrl: "Azure OpenAI エンドポイント URL",
    azureModel: "Azure OpenAI モデル/デプロイメント名",
    azureVersion: "Azure OpenAI API バージョン (省略時は標準)",
    bedrockModel: "AWS Bedrock モデル ID",
    bedrockRegion: "AWS Bedrock リージョン (省略時は標準)",
    bedrockProfile: "AWS プロファイル名 (省略時は標準)",
    localLlmBase: "Local LLM API ベース URL",
    localLlmKey: "Local LLM API キー (不要な場合は省略)",
    localLlmModel: "Local LLM モデル名",
    distillSame: "Distillation (蒸留) プロバイダの設定を Compile プロバイダと同一にしますか？",
    distillProvider:
      "Distillation プロバイダを選択してください (openai, local-llm, azure-openai, bedrock)",
    embeddingSelect: "Embedding プロバイダを選択してください (auto, daemon, cli, openai, disabled)",
    embeddingDaemonUrl: "外部 Embedding Provider URL",
    wikiRoot: "Wiki ページのディレクトリパス",
    importSeed: "初期サンプルシードデータをインポートしますか？",
    mcpSelect:
      "MCP クライアントの設定用スニペットを選択しますか？ (generic, cursor, cline, claude-desktop, skip)",
    confirmApply: "上記の内容で .env ファイルを更新し、起動シーケンスを開始しますか？",
  },
  en: {
    langSelect: "Select language (ja / en)",
    dbUrl: "PostgreSQL database connection URL",
    dbDocker: "Start PostgreSQL container via Docker Compose?",
    llmProvider: "Select LLM Provider (openai, local-llm, azure-openai, bedrock)",
    openaiKey: "OpenAI API Key",
    openaiBaseUrl: "OpenAI API Base URL (leave empty for default)",
    openaiModel: "OpenAI Model Name (leave empty for default)",
    azureKey: "Azure OpenAI API Key",
    azureBaseUrl: "Azure OpenAI Endpoint URL",
    azureModel: "Azure OpenAI Model/Deployment Name",
    azureVersion: "Azure OpenAI API Version (leave empty for default)",
    bedrockModel: "AWS Bedrock Model ID",
    bedrockRegion: "AWS Bedrock Region (leave empty for default)",
    bedrockProfile: "AWS Profile Name (leave empty for default)",
    localLlmBase: "Local LLM API Base URL",
    localLlmKey: "Local LLM API Key (optional, leave empty if not needed)",
    localLlmModel: "Local LLM Model Name",
    distillSame: "Use the same LLM provider for Distillation?",
    distillProvider: "Select Distillation Provider (openai, local-llm, azure-openai, bedrock)",
    embeddingSelect: "Select Embedding Provider (auto, daemon, cli, openai, disabled)",
    embeddingDaemonUrl: "External Embedding Provider URL",
    wikiRoot: "Wiki pages directory root path",
    importSeed: "Import initial sample seed data?",
    mcpSelect:
      "Select MCP client configuration snippet (generic, cursor, cline, claude-desktop, skip)",
    confirmApply: "Do you want to update .env and start the apply sequence?",
  },
};

export async function promptStartupPlan(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartupPlan> {
  // 1. Language Select
  const defaultLang = resolveLocale(readProjectEnvFrom(env, "LANG"));
  const langInput = await ask(onboardingPromptsText.ja.langSelect, defaultLang);
  const lang: SupportedLocale = langInput.toLowerCase().startsWith("j") ? "ja" : "en";
  const t = onboardingPromptsText[lang];

  console.log(`\n--- Starting configuration in [${lang.toUpperCase()}] ---`);

  // 2. Database
  const defaultDbUrl =
    env.DATABASE_URL ||
    `postgres://postgres:postgres@localhost:7889/${projectIdentity.databaseName}`;
  const dbUrl = await ask(t.dbUrl, defaultDbUrl);
  const startDocker = await askYesNo(
    t.dbDocker,
    dbUrl.includes("localhost") || dbUrl.includes("127.0.0.1"),
  );

  // 3. Compile LLM Provider
  const defaultProvider = (readProjectEnvFrom(env, "AGENTIC_COMPILE_PROVIDER") ||
    "openai") as AgenticCompileProvider;
  const compileProviderInput = await ask(t.llmProvider, defaultProvider);
  let compileProvider = compileProviderInput.trim().toLowerCase() as AgenticCompileProvider;

  const validCompileProviders = ["openai", "local-llm", "azure-openai", "bedrock", "auto"];
  if (!validCompileProviders.includes(compileProvider)) {
    console.log(
      `\n⚠️ Invalid provider [${compileProviderInput}]. Falling back to default [${defaultProvider}].`,
    );
    compileProvider = defaultProvider;
  }

  const compileConfig: StartupPlan["compile"] = {
    provider: compileProvider,
  };

  if (compileProvider === "openai") {
    compileConfig.openaiKey = await ask(
      t.openaiKey,
      readProjectEnvFrom(env, "OPENAI_API_KEY") || "",
    );
    compileConfig.openaiBaseUrl = await ask(
      t.openaiBaseUrl,
      readProjectEnvFrom(env, "OPENAI_API_BASE_URL") || "",
    );
    compileConfig.openaiModel = await ask(
      t.openaiModel,
      readProjectEnvFrom(env, "OPENAI_MODEL") || "",
    );
  } else if (compileProvider === "azure-openai") {
    compileConfig.azureKey = await ask(
      t.azureKey,
      readProjectEnvFrom(env, "AZURE_OPENAI_API_KEY") || "",
    );
    compileConfig.azureBaseUrl = await ask(
      t.azureBaseUrl,
      readProjectEnvFrom(env, "AZURE_OPENAI_API_BASE_URL") || "",
    );
    compileConfig.azureModel = await ask(
      t.azureModel,
      readProjectEnvFrom(env, "AZURE_OPENAI_MODEL") || "",
    );
    compileConfig.azureVersion = await ask(
      t.azureVersion,
      readProjectEnvFrom(env, "AZURE_OPENAI_API_VERSION") || "",
    );
  } else if (compileProvider === "bedrock") {
    compileConfig.bedrockModel = await ask(
      t.bedrockModel,
      readProjectEnvFrom(env, "BEDROCK_MODEL") || "",
    );
    compileConfig.bedrockRegion = await ask(
      t.bedrockRegion,
      readProjectEnvFrom(env, "BEDROCK_REGION") || "",
    );
    compileConfig.bedrockProfile = await ask(
      t.bedrockProfile,
      readProjectEnvFrom(env, "BEDROCK_PROFILE") || "",
    );
  } else if (compileProvider === "local-llm") {
    compileConfig.localLlmBaseUrl = await ask(
      t.localLlmBase,
      readProjectEnvFrom(env, "LOCAL_LLM_API_BASE_URL") || "http://127.0.0.1:44448",
    );
    compileConfig.localLlmKey = await ask(
      t.localLlmKey,
      readProjectEnvFrom(env, "LOCAL_LLM_API_KEY") || "",
    );
    compileConfig.localLlmModel = await ask(
      t.localLlmModel,
      readProjectEnvFrom(env, "LOCAL_LLM_MODEL") || "gemma-4-e4b-it",
    );
  }

  // 4. Distillation Provider
  const distillSame = await askYesNo(t.distillSame, true);
  let distillationProvider: DistillationProvider = "local-llm";
  let findCandidateProvider: DistillationProvider = "openai";

  if (distillSame) {
    distillationProvider = compileProvider as DistillationProvider;
    findCandidateProvider = compileProvider as DistillationProvider;
  } else {
    const dProviderInput = await ask(t.distillProvider, "local-llm");
    let dProvider = dProviderInput.trim().toLowerCase() as DistillationProvider;
    const validDistillProviders = ["openai", "local-llm", "azure-openai", "bedrock", "auto"];
    if (!validDistillProviders.includes(dProvider)) {
      console.log(`\n⚠️ Invalid provider [${dProviderInput}]. Falling back to [local-llm].`);
      dProvider = "local-llm";
    }
    distillationProvider = dProvider;
    findCandidateProvider = distillationProvider;
  }

  // 5. Embedding
  const validEmbedProviders: EmbeddingProvider[] = ["auto", "daemon", "openai", "disabled"];
  const configuredEmbedProvider = (
    readProjectEnvFrom(env, "EMBEDDING_PROVIDER") || "auto"
  ).trim() as EmbeddingProvider;
  const defaultEmbed = validEmbedProviders.includes(configuredEmbedProvider)
    ? configuredEmbedProvider
    : "auto";
  const embedProviderInput = await ask(t.embeddingSelect, defaultEmbed);
  let embeddingProvider = embedProviderInput.trim().toLowerCase() as EmbeddingProvider;

  if (!validEmbedProviders.includes(embeddingProvider)) {
    console.log(
      `\n⚠️ Invalid provider [${embedProviderInput}]. Falling back to default [${defaultEmbed}].`,
    );
    embeddingProvider = defaultEmbed;
  }

  const embeddingConfig: StartupPlan["embedding"] = {
    provider: embeddingProvider,
  };

  if (embeddingProvider === "daemon") {
    embeddingConfig.daemonUrl = await ask(
      t.embeddingDaemonUrl,
      readProjectEnvFrom(env, "EMBEDDING_DAEMON_URL") || "http://127.0.0.1:44512",
    );
  }

  // 6. Project Init
  const defaultWiki = readProjectEnvFrom(env, "WIKI_ROOT") || "wiki/pages";
  const wikiRoot = await ask(t.wikiRoot, defaultWiki);
  const importSeed = await askYesNo(t.importSeed, true);

  // 7. MCP Client
  const mcpInput = await ask(t.mcpSelect, "generic");
  const mcpClient = mcpInput.trim().toLowerCase() as StartupPlan["mcpClient"];

  return {
    lang,
    database: {
      provider: "postgres",
      url: dbUrl,
      startDocker,
    },
    compile: compileConfig,
    distillation: {
      provider: distillationProvider,
      findCandidateProvider,
    },
    embedding: embeddingConfig,
    project: {
      wikiRoot,
      importSeed,
    },
    mcpClient,
  };
}
