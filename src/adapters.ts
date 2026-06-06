import type { FastifyReply } from "fastify";
import type { InternalMessage, InternalRequest, ProviderConfig } from "./types.js";

export type ProviderResult = {
  response: unknown;
  latencyMs: number;
};

export type ProviderStreamResult = {
  started: boolean;
  latencyMs: number;
};

export async function testProviderModels(provider: ProviderConfig, timeoutMs: number): Promise<ProviderResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL("/v1/models", provider.baseUrl).toString(), {
      method: "GET",
      headers: providerHeaders(provider),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${provider.id} returned HTTP ${response.status}: ${await response.text()}`);
    }

    return { response: await response.json(), latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function testProviderChat(provider: ProviderConfig, timeoutMs: number): Promise<ProviderResult> {
  const model = provider.models[0];
  if (!model) {
    throw new Error(`${provider.id} has no configured models`);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const req: InternalRequest = {
    model,
    maxTokens: 1,
    messages: [{ role: "user", content: "ping" }],
    stream: false,
    temperature: 0,
    raw: {
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      temperature: 0
    }
  };

  try {
    const response = await fetch(providerUrl(provider), {
      method: "POST",
      headers: providerHeaders(provider),
      body: JSON.stringify(provider.type === "anthropic" ? toAnthropic(req, model, false) : toOpenAI(req, model, false)),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${provider.id} returned HTTP ${response.status}: ${await response.text()}`);
    }

    const text = await response.text();
    const normalized = parseMaybeSseJson(text);
    return { response: normalized, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function callProvider(
  provider: ProviderConfig,
  model: string,
  req: InternalRequest,
  timeoutMs: number
): Promise<ProviderResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(providerUrl(provider), {
      method: "POST",
      headers: providerHeaders(provider),
      body: JSON.stringify(provider.type === "anthropic" ? toAnthropic(req, model, false) : toOpenAI(req, model, false)),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${provider.id} returned HTTP ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    const normalized = provider.type === "anthropic" ? json : openAIToClaude(json, model);
    return { response: normalized, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

export async function streamProvider(
  provider: ProviderConfig,
  model: string,
  req: InternalRequest,
  reply: FastifyReply,
  timeoutMs: number
): Promise<ProviderStreamResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let started = false;

  try {
    const response = await fetch(providerUrl(provider), {
      method: "POST",
      headers: providerHeaders(provider),
      body: JSON.stringify(provider.type === "anthropic" ? toAnthropic(req, model, true) : toOpenAI(req, model, true)),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new Error(`${provider.id} returned HTTP ${response.status}: ${await response.text()}`);
    }

    if (provider.type === "anthropic") {
      started = await pipeAnthropicStream(response, reply);
    } else {
      started = await pipeOpenAIStreamAsClaude(response, reply, model);
    }

    return { started, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function providerUrl(provider: ProviderConfig): string {
  return new URL(provider.path, provider.baseUrl).toString();
}

function providerHeaders(provider: ProviderConfig): Record<string, string> {
  if (provider.type === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01"
    };
  }

  return {
    "content-type": "application/json",
    authorization: `Bearer ${provider.apiKey}`
  };
}

function toAnthropic(req: InternalRequest, model: string, stream: boolean): unknown {
  const system = req.messages
    .filter((message) => message.role === "system")
    .map((message) => contentToText(message.content))
    .join("\n");

  return {
    ...req.raw,
    model,
    max_tokens: req.maxTokens,
    system: system || req.raw.system,
    messages: req.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content
      })),
    stream
  };
}

function toOpenAI(req: InternalRequest, model: string, stream: boolean): unknown {
  return {
    model,
    messages: req.messages.map((message) => ({
      role: openAIRole(message),
      content: contentToOpenAI(message.content)
    })),
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    top_p: req.topP,
    stop: req.stop,
    stream
  };
}

function openAIRole(message: InternalMessage): string {
  if (message.role === "tool") return "tool";
  return message.role;
}

function contentToOpenAI(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return contentToText(content);

  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        return { type: "text", text: String("text" in block ? block.text : "") };
      }
      if (block && typeof block === "object" && "type" in block && block.type === "image") {
        return { type: "text", text: "[image omitted by compatibility adapter]" };
      }
      return { type: "text", text: contentToText(block) };
    });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "text" in block) {
          return String(block.text);
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

function openAIToClaude(resp: any, model: string): unknown {
  const text = resp.choices?.[0]?.message?.content ?? "";
  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model ?? model,
    content: [{ type: "text", text }],
    stop_reason: resp.choices?.[0]?.finish_reason === "length" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: resp.usage?.prompt_tokens ?? 0,
      output_tokens: resp.usage?.completion_tokens ?? 0
    }
  };
}

function parseMaybeSseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("data:")) {
    return JSON.parse(trimmed);
  }

  const chunks: unknown[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    chunks.push(JSON.parse(data));
  }

  return { type: "sse_probe", chunks };
}

async function pipeAnthropicStream(response: Response, reply: FastifyReply): Promise<boolean> {
  let started = false;
  reply.raw.writeHead(200, sseHeaders());

  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    started = true;
    reply.raw.write(chunk);
  }

  reply.raw.end();
  return started;
}

async function pipeOpenAIStreamAsClaude(response: Response, reply: FastifyReply, model: string): Promise<boolean> {
  let started = false;
  const decoder = new TextDecoder();
  let buffer = "";

  reply.raw.writeHead(200, sseHeaders());
  writeSse(reply, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  });
  writeSse(reply, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" }
  });

  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        started = true;
        writeSse(reply, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta }
        });
      }
    }
  }

  writeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  writeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 0 }
  });
  writeSse(reply, "message_stop", { type: "message_stop" });
  reply.raw.end();
  return started;
}

function sseHeaders(): Record<string, string> {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  };
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
