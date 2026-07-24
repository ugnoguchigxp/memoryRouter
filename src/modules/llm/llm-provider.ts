import type { SystemContextManifest } from "../system-context/system-context.service.js";

export type LlmChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type LlmChatRequest = {
  model?: string;
  messages: LlmChatMessage[];
  maxTokens: number;
  temperature?: number;
  responseFormat?: "json" | "text";
  /**
   * The exact s11tnext manifests for SystemContext text included in this request.
   * Providers must not serialize this host-only metadata into their API payloads.
   */
  systemContexts?: readonly SystemContextManifest[];
};

export type LlmChatResponse = {
  content: string;
  finishReason?: string;
  /** SystemContext manifests added by the provider adapter itself. */
  systemContexts?: readonly SystemContextManifest[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
};

export type LlmProviderName = "openai" | "azure-openai" | "bedrock" | "local-llm" | "codex";

export type LlmHealthStatus = {
  provider: LlmProviderName;
  configured: boolean;
  reachable: boolean;
  model: string;
  endpoint: string;
  error?: string;
};

export type LlmHealthCheckOptions = {
  model?: string;
};

export type LlmProvider = {
  name: LlmProviderName;
  isConfigured(): boolean;
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
  healthCheck(options?: LlmHealthCheckOptions): Promise<LlmHealthStatus>;
};
