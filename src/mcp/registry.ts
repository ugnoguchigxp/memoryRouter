type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
};

export type ToolHandlerContext = {
  requestMeta?: Record<string, unknown>;
  toolName: string;
};

export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown, context?: ToolHandlerContext) => Promise<ToolResult>;
}
