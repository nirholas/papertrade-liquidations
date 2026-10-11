---
title: Connect your AI
description: Copy-paste setup for Claude, Codex, ChatGPT, Gemini, Cursor, VS Code, Windsurf, Zed, Cline, Goose, Continue and any OpenAI-compatible agent.
order: 6
---
# Connect your AI

Server URL: `https://papertrade-liquidations.pages.dev/mcp`. Streamable HTTP, stateless, no OAuth, no credentials. Every tool is read-only.

Client config formats change; each snippet follows the vendor documentation at the time of writing.

## Claude Code

```bash
claude mcp add --transport http papertrade-liquidations https://papertrade-liquidations.pages.dev/mcp
```

## Claude Desktop and claude.ai

Settings, Connectors, **Add custom connector**, paste the server URL. For Claude Desktop you can also use the `mcp-remote` bridge in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "papertrade-liquidations": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://papertrade-liquidations.pages.dev/mcp"]
    }
  }
}
```

## Claude API (MCP connector)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: mcp-client-2025-11-20" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Which BTC positions on Papertrade are closest to bust?"}],
    "mcp_servers": [{"type": "url", "url": "https://papertrade-liquidations.pages.dev/mcp", "name": "papertrade-liquidations"}],
    "tools": [{"type": "mcp_toolset", "mcp_server_name": "papertrade-liquidations"}]
  }'
```

Use any current Claude model id.

## OpenAI Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.papertrade-liquidations]
url = "https://papertrade-liquidations.pages.dev/mcp"
```

Or: `codex mcp add papertrade-liquidations --url https://papertrade-liquidations.pages.dev/mcp`

## OpenAI Responses API

```json
{
  "model": "gpt-5",
  "input": "Which BTC positions on Papertrade are closest to bust?",
  "tools": [{
    "type": "mcp",
    "server_label": "papertrade_liquidations",
    "server_description": "Papertrade liquidation map. Read-only, never moves funds.",
    "server_url": "https://papertrade-liquidations.pages.dev/mcp",
    "require_approval": "never"
  }]
}
```

Every tool is read-only, so `"never"` is safe. Use `"always"` if you prefer to confirm each call.

## ChatGPT

Settings, Connectors, Advanced, enable **Developer mode**, then create a connector with the server URL and authentication set to none. Availability depends on your plan.

## Gemini CLI

`~/.gemini/settings.json` (or `.gemini/settings.json` in a project):

```json
{
  "mcpServers": {
    "papertrade-liquidations": {
      "httpUrl": "https://papertrade-liquidations.pages.dev/mcp"
    }
  }
}
```

Or: `gemini mcp add --transport http papertrade-liquidations https://papertrade-liquidations.pages.dev/mcp`

## Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "papertrade-liquidations": { "url": "https://papertrade-liquidations.pages.dev/mcp" }
  }
}
```

## VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "papertrade-liquidations": { "type": "http", "url": "https://papertrade-liquidations.pages.dev/mcp" }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "papertrade-liquidations": { "serverUrl": "https://papertrade-liquidations.pages.dev/mcp" }
  }
}
```

## Zed

`settings.json`:

```json
{
  "context_servers": {
    "papertrade-liquidations": { "url": "https://papertrade-liquidations.pages.dev/mcp" }
  }
}
```

## Cline

`cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "papertrade-liquidations": { "url": "https://papertrade-liquidations.pages.dev/mcp", "type": "streamableHttp" }
  }
}
```

## Goose

Run `goose configure`, choose **Add Extension**, then **Remote Extension (Streaming HTTP)**, and enter the server URL. Or in `~/.config/goose/config.yaml`:

```yaml
extensions:
  papertrade-liquidations:
    type: streamable_http
    name: papertrade-liquidations
    uri: https://papertrade-liquidations.pages.dev/mcp
    enabled: true
    timeout: 300
```

## Continue

`.continue/mcpServers/papertrade-liquidations.yaml`:

```yaml
name: Papertrade Liquidations
version: 0.0.1
schema: v1
mcpServers:
  - name: papertrade-liquidations
    type: streamable-http
    url: https://papertrade-liquidations.pages.dev/mcp
```

## Any other agent framework

Frameworks without MCP support can use the HTTP API through the OpenAPI document at [/openapi.json](/openapi.json), which describes every endpoint, or fetch [/llms-full.txt](/llms-full.txt) for the full documentation in one file.

## Verify

```bash
npx @modelcontextprotocol/inspector --cli https://papertrade-liquidations.pages.dev/mcp --transport http --method tools/list
```

Then ask: "Where do BTC longs bust on Papertrade?" The agent should call `get_bust_map` and answer from real numbers.
