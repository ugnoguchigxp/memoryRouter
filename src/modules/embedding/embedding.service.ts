import { groupedConfig } from "../../config.js";

export type EmbeddingKind = "query" | "passage";
type EmbeddingProviderName = "daemon" | "openai";

type EmbeddingResult = {
  embeddings: number[][];
  dimension: number;
  provider: EmbeddingProviderName;
};

export type EmbeddingHealth = {
  configured: boolean;
  provider: typeof groupedConfig.embedding.provider;
  effectiveMode: "daemon" | "openai" | "disabled" | "unavailable";
  daemon: {
    url: string;
    reachable: boolean;
    status: "external_ready" | "offline" | "not_required";
    managedBy: "external" | "none";
    error?: string;
  };
  openai: {
    configured: boolean;
    model: string;
    error?: string;
  };
};

function validateEmbeddingShape(embeddings: unknown, provider: EmbeddingProviderName): number[][] {
  if (!Array.isArray(embeddings)) {
    throw new Error(`${provider} embedding response did not include an array`);
  }
  const rows = embeddings.map((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(`${provider} embedding row ${rowIndex} is not an array`);
    }
    const vector = row.map((value) => Number(value));
    if (vector.length !== groupedConfig.embedding.dimension) {
      throw new Error(
        `${provider} embedding dimension mismatch: expected ${groupedConfig.embedding.dimension}, got ${vector.length}`,
      );
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error(`${provider} embedding row ${rowIndex} includes non-finite values`);
    }
    return vector;
  });
  return rows;
}

function embeddingHeaders(): HeadersInit {
  const headers: HeadersInit = { "content-type": "application/json" };
  if (groupedConfig.embedding.accessToken.trim()) {
    headers.Authorization = `Bearer ${groupedConfig.embedding.accessToken.trim()}`;
  }
  return headers;
}

async function embedViaOpenAi(texts: string[], type: EmbeddingKind): Promise<EmbeddingResult> {
  const apiKey = groupedConfig.azureOpenAi.apiKey;
  const apiBaseUrl = groupedConfig.azureOpenAi.apiBaseUrl;

  if (!apiKey.trim()) {
    throw new Error("OpenAI Embedding failed: API key (azureOpenAi.apiKey) is not configured");
  }

  const isAzure = apiBaseUrl.includes("openai/deployments") || apiBaseUrl.includes(".azure.com");
  let url = "";
  const headers: HeadersInit = {
    "content-type": "application/json",
  };

  if (isAzure) {
    headers["api-key"] = apiKey;
    const version = groupedConfig.azureOpenAi.apiVersion;
    // ensure azureOpenAi.apiBaseUrl ends with a slash before combining paths
    const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
    const path = `openai/deployments/${encodeURIComponent(groupedConfig.embedding.openaiModel)}/embeddings?api-version=${encodeURIComponent(version)}`;
    url = new URL(path, base).toString();
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
    url = apiBaseUrl
      ? `${apiBaseUrl.replace(/\/+$/, "")}/embeddings`
      : "https://api.openai.com/v1/embeddings";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), groupedConfig.embedding.timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: texts,
        model: isAzure ? undefined : groupedConfig.embedding.openaiModel,
        dimensions: groupedConfig.embedding.dimension,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText =
        typeof response.text === "function" ? await response.text().catch(() => "") : "";
      let errorMessage = errorText;
      try {
        const errorJson = JSON.parse(errorText) as { error?: { message?: string } };
        if (errorJson.error?.message) {
          errorMessage = errorJson.error.message;
        }
      } catch {
        // Fallback to plain text if parsing fails
      }
      throw new Error(`HTTP ${response.status}: ${errorMessage.slice(0, 500)}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding: number[] }>;
    };

    if (!payload.data || !Array.isArray(payload.data)) {
      throw new Error("OpenAI embedding response did not include data array");
    }

    const embeddings = payload.data.map((item) => item.embedding);
    const validated = validateEmbeddingShape(embeddings, "openai");

    return {
      embeddings: validated,
      dimension: validated[0]?.length ?? 0,
      provider: "openai",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function embedViaDaemon(texts: string[], type: EmbeddingKind): Promise<EmbeddingResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), groupedConfig.embedding.timeoutMs);
  try {
    const response = await fetch(`${groupedConfig.embedding.daemonUrl}/embed`, {
      method: "POST",
      headers: embeddingHeaders(),
      body: JSON.stringify({
        texts,
        type,
        normalize: true,
        priority: type === "query" ? "high" : "normal",
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errorText =
        typeof response.text === "function" ? await response.text().catch(() => "") : "";
      const detail = errorText.slice(0, 200).trim();
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    const payload = (await response.json()) as { embeddings?: unknown; dimension?: unknown };
    const embeddings = validateEmbeddingShape(payload.embeddings, "daemon");
    return {
      embeddings,
      dimension: Number(payload.dimension ?? embeddings[0]?.length ?? 0),
      provider: "daemon",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function embedTexts(texts: string[], type: EmbeddingKind): Promise<EmbeddingResult> {
  const cleanTexts = texts.map((text) => text.trim()).filter((text) => text.length > 0);
  if (cleanTexts.length === 0) {
    throw new Error("embedding input must include at least one non-empty text");
  }
  if (groupedConfig.embedding.provider === "disabled") {
    throw new Error("embedding provider is disabled");
  }

  if (groupedConfig.embedding.provider === "openai") {
    try {
      return await embedViaOpenAi(cleanTexts, type);
    } catch (error) {
      throw new Error(`openai: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (
    groupedConfig.embedding.provider === "auto" ||
    groupedConfig.embedding.provider === "daemon"
  ) {
    try {
      return await embedViaDaemon(cleanTexts, type);
    } catch (error) {
      throw new Error(`daemon: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`unsupported embedding provider: ${groupedConfig.embedding.provider}`);
}

export async function embedOne(text: string, type: EmbeddingKind): Promise<number[]> {
  const result = await embedTexts([text], type);
  const embedding = result.embeddings[0];
  if (!embedding) {
    throw new Error("embedding provider returned no vector");
  }
  return embedding;
}

export async function embeddingHealth(): Promise<EmbeddingHealth> {
  const health: EmbeddingHealth = {
    configured: groupedConfig.embedding.provider !== "disabled",
    provider: groupedConfig.embedding.provider,
    effectiveMode: "unavailable",
    daemon: {
      url: groupedConfig.embedding.daemonUrl,
      reachable: false,
      status: "offline",
      managedBy: "none",
    },
    openai: {
      configured: Boolean(groupedConfig.azureOpenAi.apiKey.trim()),
      model: groupedConfig.embedding.openaiModel,
    },
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`${groupedConfig.embedding.daemonUrl}/health`, {
        signal: controller.signal,
      });
      health.daemon.reachable = response.ok;
      if (!response.ok) {
        health.daemon.error = `HTTP ${response.status}`;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    health.daemon.error = error instanceof Error ? error.message : String(error);
  }

  if (health.daemon.reachable) {
    health.daemon.status = "external_ready";
    health.daemon.managedBy = "external";
  }

  if (groupedConfig.embedding.provider === "openai") {
    health.daemon.status = "not_required";
    if (!groupedConfig.azureOpenAi.apiKey.trim()) {
      health.openai.error = "API key (azureOpenAi.apiKey) is empty";
    } else {
      try {
        await embedOne("ping", "query");
      } catch (error) {
        health.openai.error = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (groupedConfig.embedding.provider === "disabled") {
    health.daemon.status = "not_required";
    health.effectiveMode = "disabled";
  } else if (groupedConfig.embedding.provider === "openai") {
    health.effectiveMode = "openai";
  } else if (health.daemon.reachable) {
    health.effectiveMode = "daemon";
  } else {
    health.effectiveMode = "unavailable";
  }

  return health;
}
