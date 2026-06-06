import type { AppConfig, ClaudeMessagesRequest, InternalMessage, InternalRequest } from "./types.js";

export function toInternalRequest(req: ClaudeMessagesRequest, config: AppConfig): InternalRequest {
  const messages: InternalMessage[] = [];
  const system = normalizeSystem(req.system);

  if (system) {
    messages.push({ role: "system", content: system });
  }

  for (const message of req.messages ?? []) {
    messages.push({
      role: message.role,
      content: message.content
    });
  }

  const normalized: InternalRequest = {
    model: req.model,
    maxTokens: req.max_tokens,
    messages,
    stream: Boolean(req.stream),
    temperature: req.temperature,
    topP: req.top_p,
    stop: req.stop_sequences,
    raw: req
  };

  return trimContext(normalized, config);
}

function normalizeSystem(system: ClaudeMessagesRequest["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  return system.map((block) => block.text).join("\n");
}

function trimContext(req: InternalRequest, config: AppConfig): InternalRequest {
  const serialized = JSON.stringify(req.messages);
  if (config.context.mode === "preserve" || serialized.length <= config.context.maxInputChars) {
    return req;
  }

  const system = config.context.pinSystem
    ? req.messages.filter((message) => message.role === "system")
    : [];
  const nonSystem = req.messages.filter((message) => message.role !== "system");
  const recent = nonSystem.slice(-config.context.pinRecentTurns * 2);
  let messages = [...system, ...recent];

  while (JSON.stringify(messages).length > config.context.maxInputChars && messages.length > system.length + 1) {
    messages = [...system, ...messages.slice(system.length + 1)];
  }

  return { ...req, messages };
}

export function conversationSignature(req: InternalRequest): string {
  const firstUser = req.messages.find((message) => message.role === "user");
  const system = req.messages.find((message) => message.role === "system");
  return hashString(JSON.stringify([req.model, system?.content ?? "", firstUser?.content ?? ""]));
}

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}
