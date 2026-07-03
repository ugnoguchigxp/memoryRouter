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
};

export type LlmChatResponse = {
  content: string;
  finishReason?: string;
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
