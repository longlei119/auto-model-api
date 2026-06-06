export type ProviderType = "openai" | "anthropic";
export type RoutingMode = "manual" | "session" | "fastest" | "fallback";

export type ProviderConfig = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  path: string;
  apiKey: string;
  models: string[];
  enabled: boolean;
  priority: number;
};

export type AppConfig = {
  server: {
    host: string;
    port: number;
  };
  routing: {
    mode: RoutingMode;
    fallback: boolean;
    healthCheckIntervalMs: number;
    requestTimeoutMs: number;
  };
  defaultProvider: string;
  context: {
    mode: "preserve" | "truncate";
    maxInputChars: number;
    pinSystem: boolean;
    pinRecentTurns: number;
  };
  modelAliases: Record<string, string[]>;
  providers: ProviderConfig[];
};

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: unknown }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: unknown };

export type ClaudeMessage = {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
};

export type ClaudeMessagesRequest = {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string | Array<{ type: "text"; text: string }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

export type ProviderMetric = {
  providerId: string;
  model: string;
  successCount: number;
  failureCount: number;
  latencies: number[];
  lastErrorAt?: number;
  lastOkAt?: number;
};

export type InternalMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: unknown;
};

export type InternalRequest = {
  model: string;
  maxTokens: number;
  messages: InternalMessage[];
  stream: boolean;
  temperature?: number;
  topP?: number;
  stop?: string[];
  raw: ClaudeMessagesRequest;
};

export type RouteDecision = {
  provider: ProviderConfig;
  model: string;
  candidates: Array<{ provider: ProviderConfig; model: string }>;
};
