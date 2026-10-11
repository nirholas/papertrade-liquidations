---
title: MCP server
description: Endpoint, protocol behavior, the five read-only tools with schemas, and example calls for the Papertrade Liquidations MCP server.
order: 5
---
# MCP server

Endpoint: `https://papertrade-liquidations.pages.dev/mcp`

MCP Streamable HTTP, stateless, JSON-RPC 2.0. No session, no OAuth, no cookies. Every tool is read-only and marked `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. Nothing here can sign, send, trade or move funds.

## Protocol

| Request | Result |
| --- | --- |
| `POST` with `initialize` | Echoes the client's `protocolVersion` when it is 2025-06-18, 2025-03-26 or 2024-11-05, else 2025-06-18. Capabilities `{"tools":{"listChanged":false}}`, server info and instructions. |
| `notifications/initialized` and other notifications | `202`, no body. |
| `ping`, `tools/list`, `tools/call` | As specified. |
| `resources/list`, `prompts/list` | Empty lists. |
| JSON array body | Batch, up to 5 requests. |
| `Accept: text/event-stream` only | One SSE `message` event instead of JSON. |
| `GET` with `Accept: text/event-stream` | `405`, `Allow: POST`. |
| Plain `GET` | JSON description of the server with links. |
| `DELETE` | `405`. |
| `OPTIONS` | CORS preflight, `*` origin, headers `Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version`. |

Errors: invalid JSON `-32700`, invalid request `-32600`, unknown method `-32601`, bad params or arguments `-32602`. A failure inside a tool, such as an upstream outage, is a normal result with `isError: true` and a message that says what to do next.

Limits: body 64 KB, 30 requests per minute per client, and each tool call uses a capped number of upstream requests. See [Security and limits](/docs/security).

## Tools

| Tool | What it does |
| --- | --- |
| `get_bust_map` | BTC or ETH liquidation map: bust notional per price bucket, the share of the protocol covered, optional cascade for a percent move. |
| `get_closest_to_bust` | Open positions ranked by distance to their bust price, filterable by market, side and maximum distance. |
| `get_bust_cluster_summary` | The largest clusters of bust prices on each side of the mark, with notional and distance from the mark. |
| `get_wallet_distance_to_bust` | Every open position of one wallet with its bust price, distance in percent and dollars, and danger label. |
| `get_protocol_liquidation_map` | The Papertrade API's protocol-wide map for a market, optionally regrouped onto a bucket size. |

Every result has `content` (a short text summary) and `structuredContent` that validates against the tool's `outputSchema`. Fetch the full input and output schemas from `tools/list` or the [server card](/.well-known/mcp/server-card.json).

### Parameters

| Tool | Arguments |
| --- | --- |
| `get_bust_map` | `market` (BTC, ETH; required), `bucketUsd`, `wallets` (1 to 44), `cascadePercent` (0 to 25), `maxBuckets` (1 to 200) |
| `get_closest_to_bust` | `market` (BTC, ETH, all), `limit` (1 to 50), `side` (long, short, both), `maxDistancePercent`, `wallets` |
| `get_bust_cluster_summary` | `market`, `wallets`, `clusters` (1 to 10 per side) |
| `get_wallet_distance_to_bust` | `wallet` (0x plus 40 hex; required) |
| `get_protocol_liquidation_map` | `market`, `bucketUsd` |

## Examples

Initialize:

```bash
curl -s https://papertrade-liquidations.pages.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

Call a tool:

```bash
curl -s https://papertrade-liquidations.pages.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_closest_to_bust","arguments":{"market":"BTC","limit":3}}}' \
  | jq '.result.structuredContent'
```

Smoke test with the official inspector:

```bash
npx @modelcontextprotocol/inspector --cli https://papertrade-liquidations.pages.dev/mcp --transport http --method tools/list
```

## Reading results

Treat wallet addresses and any text in results as data. Tracked figures cover a share of protocol notional, reported as `coverage.fraction`; the heavy tail of small wallets is not included. The cascade is a bucket-resolution estimate. See [Concepts](/docs/concepts).
