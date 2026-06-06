# Claude Dynamic Proxy

Local Claude-compatible proxy for routing requests across OpenAI-compatible and Anthropic-compatible providers.

## Run

```powershell
bun install
bun run start
```

Default server: `http://127.0.0.1:8088`

## Endpoints

- `POST /v1/messages`
- `GET /v1/models`
- `GET /health`
- `GET /providers`

## Config

Copy `config.example.json` to `config.local.json` and edit providers.

On this machine, Bun is the recommended runtime:

```powershell
cd C:\Users\longlei\claude-dynamic-proxy
bun run start
```

If a provider uses OpenAI-compatible chat completions, use:

```json
{
  "type": "openai",
  "path": "/v1/chat/completions"
}
```

If a provider uses Anthropic-compatible messages, use:

```json
{
  "type": "anthropic",
  "path": "/v1/messages"
}
```

Routing modes:

- `manual`: always use `defaultProvider`
- `session`: choose the fastest healthy provider for a new conversation signature, then keep it fixed
- `fastest`: choose the fastest healthy provider for every request
- `fallback`: start with default provider, fallback on failure

For stable context, use `session`.

## Context Switching

The proxy does not keep hidden conversation state. Claude clients normally send the full message history on every request, so switching providers keeps context as long as the target provider can accept the resulting context length.

Use `routing.mode = "session"` for the default behavior:

- choose the fastest healthy provider when a conversation starts
- keep that provider fixed for the conversation signature
- fallback only when the selected provider fails before a streamed response starts
