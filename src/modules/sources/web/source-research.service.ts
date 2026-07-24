import crypto from "node:crypto";
import path from "node:path";
import { groupedConfig } from "../../../config.js";
import {
  type DistillationProviderSetting,
  resolveRouteModelForProvider,
  runDistillationCompletion,
} from "../../distillation/distillation-runtime.service.js";
import {
  ensureRuntimeSettingsLoaded,
  resolveWebSourceResearchRoute,
} from "../../settings/settings.service.js";
import {
  renderSystemContext,
  systemContextMessage,
} from "../../system-context/system-context.service.js";
import { upsertSourceDocument } from "../source.repository.js";
import { ensureContentRoot, writePage } from "../wiki/content-repo.js";

export type WebSourceResearchResult = {
  sourceUrl: string;
  normalizedUrl: string;
  savedWikiSlug: string;
  savedWikiTargetKey: string;
  savedWikiPath: string;
  title: string;
  body: string;
  llmProvider: DistillationProviderSetting;
  llmModel: string;
  fetchFinalUrl: string | null;
};

function extractMarkdownBody(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function slugSegment(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extractTitle(markdown: string, fallback: string): string {
  const heading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^#\s+.+/.test(line));
  if (heading) {
    const value = heading.replace(/^#\s+/, "").trim();
    if (value) return value.slice(0, 200);
  }
  return fallback.slice(0, 200);
}

function computeWebSourceSlug(url: URL): string {
  const host = slugSegment(url.hostname) || "unknown-host";
  const pathSegments = url.pathname
    .split("/")
    .map((segment) => slugSegment(segment))
    .filter(Boolean);
  const pathPart = pathSegments.length > 0 ? pathSegments.join("-") : "index";
  const queryHash = url.search
    ? `-${crypto.createHash("sha1").update(url.search).digest("hex").slice(0, 8)}`
    : "";
  return `websource/${host}/${pathPart}${queryHash}`;
}

function extractFetchFinalUrl(
  toolEvents: Array<{ name: string; metadata?: Record<string, unknown> }>,
): string | null {
  for (const event of toolEvents) {
    if (event.name !== "fetch_content") continue;
    const finalUrl = event.metadata?.finalUrl;
    if (typeof finalUrl === "string" && finalUrl.trim()) return finalUrl.trim();
  }
  return null;
}

function webResearchUserPrompt(url: string): string {
  return [
    `調査対象 URL: ${url}`,
    "最初に fetch_content を呼び出し、その結果を読んでから Markdown を返してください。",
  ].join("\n");
}

export async function researchWebSourceToMarkdown(params: {
  url: string;
  normalizedUrl: string;
  provider?: DistillationProviderSetting;
  signal?: AbortSignal;
}): Promise<WebSourceResearchResult> {
  await ensureRuntimeSettingsLoaded();
  const configuredRoute = resolveWebSourceResearchRoute();
  const provider = params.provider ?? (configuredRoute.provider as DistillationProviderSetting);
  const fallbackOrder = params.provider ? [] : configuredRoute.fallback;
  const azureDeploymentSlots = params.provider ? undefined : configuredRoute.azureDeploymentSlots;
  const localLlmModel = params.provider ? undefined : configuredRoute.localLlmModel;
  const model = resolveRouteModelForProvider({
    provider,
    routeModel: params.provider ? undefined : configuredRoute.model,
    localLlmModel,
  });
  const systemContext = renderSystemContext("sourceResearch.web", {});

  const completion = await runDistillationCompletion(
    {
      model,
      maxTokens: Math.max(2048, groupedConfig.vibeDistillation.maxOutputTokens),
      messages: [
        systemContextMessage(systemContext),
        { role: "user", content: webResearchUserPrompt(params.url) },
      ],
      systemContexts: [systemContext.manifest],
    },
    {
      providerSetting: provider,
      fallbackOrder,
      azureDeploymentSlots,
      localLlmModel,
      usageSource: "web-source-research",
      requireToolCall: true,
      toolNames: ["fetch_content"],
      signal: params.signal,
    },
  );

  const body = extractMarkdownBody(completion.content);
  if (!body.trim()) {
    throw new Error("web source research markdown is empty");
  }

  const url = new URL(params.normalizedUrl);
  const slug = computeWebSourceSlug(url);
  const title = extractTitle(body, `${url.hostname}${url.pathname}`);
  const meta: Record<string, unknown> = {
    sourceType: "web_research",
    sourceUrl: params.url,
    normalizedUrl: params.normalizedUrl,
    fetchedAt: new Date().toISOString(),
    researchGeneratedAt: new Date().toISOString(),
    showOnMenu: false,
    showOnHome: false,
  };

  await ensureContentRoot(groupedConfig.sourceContent.root);
  const saved = await writePage(groupedConfig.sourceContent.root, slug, title, body, meta);
  const pagesRoot = path.resolve(groupedConfig.sourceContent.root, "pages");
  const relativeFromPages = path.relative(pagesRoot, saved.path);
  if (relativeFromPages.startsWith("..") || path.isAbsolute(relativeFromPages)) {
    throw new Error("saved wiki path must stay inside wiki/pages");
  }
  const savedWikiTargetKey = relativeFromPages.split(path.sep).join("/");

  await upsertSourceDocument({
    sourceKind: "wiki",
    uri: savedWikiTargetKey,
    title,
    body,
    metadata: {
      ...meta,
      savedWikiSlug: slug,
      savedWikiTargetKey,
      sourceWebUrl: params.url,
    },
    actor: "system",
  });

  return {
    sourceUrl: params.url,
    normalizedUrl: params.normalizedUrl,
    savedWikiSlug: slug,
    savedWikiTargetKey,
    savedWikiPath: saved.path,
    title,
    body,
    llmProvider: provider,
    llmModel: model,
    fetchFinalUrl: extractFetchFinalUrl(completion.toolEvents),
  };
}
