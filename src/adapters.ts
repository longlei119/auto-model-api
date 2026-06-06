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
  const payload: Record<string, unknown> = {
    model,
    messages: messagesToOpenAI(req.messages),
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    top_p: req.topP,
    stop: req.stop,
    stream
  };

  if (req.raw.tools && req.raw.tools.length > 0) {
    payload.tools = req.raw.tools.map(claudeToolToOpenAI);
  }

  if (req.raw.tool_choice !== undefined) {
    payload.tool_choice = claudeToolChoiceToOpenAI(req.raw.tool_choice);
  }

  return payload;
}

function claudeToolToOpenAI(tool: unknown): unknown {
  const t = tool as { name?: string; description?: string; input_schema?: unknown };
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema
    }
  };
}

function claudeToolChoiceToOpenAI(choice: unknown): unknown {
  if (!choice || typeof choice !== "object") return choice;
  const c = choice as { type?: string; name?: string };
  if (c.type === "auto") return "auto";
  if (c.type === "any") return "required";
  if (c.type === "tool" && c.name) {
    return { type: "function", function: { name: c.name } };
  }
  if (c.type === "none") return "none";
  return "auto";
}

function messagesToOpenAI(messages: InternalMessage[]): unknown[] {
  const result: unknown[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      result.push(assistantMessageToOpenAI(message));
    } else if (message.role === "user") {
      const expanded = userMessageToOpenAI(message);
      for (const msg of expanded) {
        result.push(msg);
      }
    } else {
      result.push({
        role: message.role,
        content: contentToOpenAIText(message.content)
      });
    }
  }

  return result;
}

function assistantMessageToOpenAI(message: InternalMessage): unknown {
  const content = message.content;
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content)) return { role: "assistant", content: contentToText(content) };

  const textParts: string[] = [];
  const toolCalls: unknown[] = [];

  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      if (block.type === "text" && "text" in block) {
        textParts.push(String(block.text));
      } else if (block.type === "tool_use" && "id" in block && "name" in block && "input" in block) {
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input)
          }
        });
      }
    }
  }

  const msg: Record<string, unknown> = { role: "assistant" };
  msg.content = textParts.length > 0 ? textParts.join("") : null;
  if (toolCalls.length > 0) {
    msg.tool_calls = toolCalls;
  }
  return msg;
}

function userMessageToOpenAI(message: InternalMessage): unknown[] {
  const content = message.content;
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [{ role: "user", content: contentToText(content) }];

  const results: unknown[] = [];
  const userParts: unknown[] = [];

  for (const block of content) {
    if (block && typeof block === "object" && "type" in block) {
      if (block.type === "tool_result" && "tool_use_id" in block) {
        if (userParts.length > 0) {
          results.push({ role: "user", content: userParts.splice(0) });
        }
        const toolContent = "content" in block ? block.content : "";
        let text: string;
        if (typeof toolContent === "string") {
          text = toolContent;
        } else if (Array.isArray(toolContent)) {
          text = toolContent
            .map((c: any) => (c && c.type === "text" ? c.text : JSON.stringify(c)))
            .join("\n");
        } else {
          text = JSON.stringify(toolContent);
        }
        results.push({ role: "tool", tool_call_id: block.tool_use_id, content: text });
      } else if (block.type === "text" && "text" in block) {
        userParts.push({ type: "text", text: String(block.text) });
      } else if (block.type === "image") {
        userParts.push({ type: "text", text: "[image omitted by compatibility adapter]" });
      } else {
        userParts.push({ type: "text", text: contentToText(block) });
      }
    }
  }

  if (userParts.length > 0) {
    results.push({ role: "user", content: userParts });
  }

  return results.length > 0 ? results : [{ role: "user", content: "" }];
}

function contentToOpenAIText(content: unknown): string {
  if (typeof content === "string") return content;
  return contentToText(content);
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
  const message = resp.choices?.[0]?.message;
  const text = message?.content ?? "";
  const toolCalls = message?.tool_calls as Array<{
    id: string;
    function: { name: string; arguments: string };
  }> | undefined;

  const content: unknown[] = [];
  if (text) {
    content.push({ type: "text", text });
  }
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = tc.function.arguments;
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input
      });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "" });
  }

  const finishReason = resp.choices?.[0]?.finish_reason;
  let stopReason: string;
  if (finishReason === "length") stopReason = "max_tokens";
  else if (finishReason === "tool_calls" || (toolCalls && toolCalls.length > 0)) stopReason = "tool_use";
  else stopReason = "end_turn";

  return {
    id: resp.id ?? `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: resp.model ?? model,
    content,
    stop_reason: stopReason,
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

  let blockIndex = 0;
  let textBlockOpen = false;
  let hasToolCalls = false;
  const toolCallState: Map<number, { id: string; name: string; started: boolean }> = new Map();

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

  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        if (!textBlockOpen) {
          writeSse(reply, "content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "text", text: "" }
          });
          textBlockOpen = true;
        }
        started = true;
        writeSse(reply, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: delta.content }
        });
      }

      if (delta.tool_calls) {
        hasToolCalls = true;
        started = true;

        if (textBlockOpen) {
          writeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIndex });
          textBlockOpen = false;
          blockIndex++;
        }

        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;
          let state = toolCallState.get(tcIndex);

          if (tc.id && !state) {
            state = { id: tc.id, name: tc.function?.name ?? "", started: false };
            toolCallState.set(tcIndex, state);
          }

          if (state && tc.function?.name && !state.name) {
            state.name = tc.function.name;
          }

          if (state && !state.started && state.id && state.name) {
            writeSse(reply, "content_block_start", {
              type: "content_block_start",
              index: blockIndex + tcIndex,
              content_block: { type: "tool_use", id: state.id, name: state.name, input: {} }
            });
            state.started = true;
          }

          if (tc.function?.arguments && state?.started) {
            writeSse(reply, "content_block_delta", {
              type: "content_block_delta",
              index: blockIndex + tcIndex,
              delta: { type: "input_json_delta", partial_json: tc.function.arguments }
            });
          }
        }
      }

      if (choice.finish_reason) {
        if (textBlockOpen) {
          writeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIndex });
          textBlockOpen = false;
          blockIndex++;
        }
        for (const [tcIndex, state] of toolCallState) {
          if (state.started) {
            writeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIndex + tcIndex });
            state.started = false;
          }
        }
      }
    }
  }

  if (textBlockOpen) {
    writeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIndex });
  }
  for (const [tcIndex, state] of toolCallState) {
    if (state.started) {
      writeSse(reply, "content_block_stop", { type: "content_block_stop", index: blockIndex + tcIndex });
    }
  }

  if (!started) {
    writeSse(reply, "content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" }
    });
    writeSse(reply, "content_block_stop", { type: "content_block_stop", index: 0 });
  }

  const stopReason = hasToolCalls ? "tool_use" : "end_turn";
  writeSse(reply, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
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
