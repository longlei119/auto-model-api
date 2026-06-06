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
- `GET /health-checks`
- `GET /route-preview/:model`
- `POST /providers/add`
- `POST /providers/import-text`
- `POST /providers/test-all`
- `POST /providers/:id/test`

## Features

- Claude-compatible local proxy at `http://127.0.0.1:8088`
- OpenAI-compatible provider adaptation through `/v1/chat/completions`
- Anthropic-compatible provider passthrough through `/v1/messages`
- Streaming response conversion from OpenAI-compatible SSE to Claude-compatible SSE
- Dynamic routing modes: `manual`, `session`, `fastest`, and `fallback`
- Fastest-provider routing based on real lightweight chat probes, not only `/v1/models`
- Automatic provider health checks on startup and at a configurable interval
- One-click manual test for all providers
- Per-provider manual test from each provider card
- Provider cards sorted by availability and measured chat latency
- Toggle to hide unavailable providers
- Route preview endpoint to inspect the provider selected for a model
- Local provider management UI with add-provider modal
- Batch text import that extracts URL and `sk-...` key pairs locally
- Persistent local provider storage in `config.local.json`
- Sensitive local config is ignored by git through `.gitignore`
- Basic context trimming policy for long requests
- Fallback handling for failed upstream providers before streaming starts

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
