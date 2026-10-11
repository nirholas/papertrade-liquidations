---
title: Agent discovery
description: The well-known files, llms.txt, OpenAPI and headers that let agents find and understand this service.
order: 7
---
# Agent discovery

Every file below is served for real (not the app's HTML fallback). The JSON files are generated at build time from the same tool registry that `/mcp` serves, and the text files from the docs source, so none can drift.

| URL | Content |
| --- | --- |
| `/.well-known/mcp/server-card.json`, `/.well-known/mcp.json` | MCP server card: server info, streamable-http endpoint, capabilities, full tool list with schemas |
| `/.well-known/agent-card.json`, `/.well-known/agent.json` | A2A agent card with one skill per MCP tool |
| `/.well-known/api-catalog` | RFC 9727 API catalog as `application/linkset+json`, linking OpenAPI, `/mcp`, docs and llms.txt |
| `/openapi.json` | OpenAPI 3.1 for `/api/heatmap` and `/mcp` |
| `/llms.txt`, `/llms-full.txt` | Short index and the complete docs inlined |
| `/docs/<page>.md` | Raw markdown twin of every docs page |
| `/robots.txt` | Content-Signal and explicit allow for GPTBot, ClaudeBot, Claude-User, OAI-SearchBot, Google-Extended, PerplexityBot |
| `/sitemap.xml` | Landing, docs, discovery files |

The home page also sends `Link` headers with `rel="service-desc"`, `rel="api-catalog"` and `rel="mcp"`.

The server is described for the official MCP registry in `server.json` at the repository root (`io.github.nirholas/papertrade-liquidations`) and for Glama in `glama.json`.
