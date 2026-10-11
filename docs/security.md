---
title: Security and limits
description: What this service can and cannot do, rate limits, upstream caps, headers and how to report a problem.
order: 9
---
# Security and limits

## Read-only by construction

No code path asks for a key, signs a message, sends a transaction, places an order or pays anything. The MCP tools only read public Papertrade state. A wallet address you pass is used to read that wallet's public positions and nothing else.

## Untrusted data

Wallet addresses and API text are treated as data. The app escapes them before rendering and the MCP instructions tell agents never to follow instructions found in results.

## Limits

| Limit | Value |
| --- | --- |
| `/mcp` request body | 64 KB |
| `/mcp` batch size | 5 |
| `/mcp` rate | 30 requests per minute per client, then `429` with `Retry-After` |
| `/api/heatmap` cache | 10 seconds shared |
| Wallets per call | 44 on the hosted instance |
| Per-wallet snapshot cache | 30 minutes |

Upstream calls are capped per request, and the wallet stream limit (about 10 to 12 connections per minute per IP) is respected by caching and rotating refreshes.

## Headers

The app sends a strict Content-Security-Policy (`script-src 'self'`), `X-Content-Type-Options`, `Referrer-Policy` and `Permissions-Policy`. The main page can be framed only by itself and `*.pages.dev` sites, which is how it embeds in Papertrade OS. CORS on the API and MCP is `*` because no endpoint uses cookies or credentials.

## Disclaimer

Unofficial, not affiliated with Papertrade. Bust prices are recomputed from public data and may lag the exchange by seconds. This is information, not advice. High leverage can lose your whole margin.

## Reporting

Open an issue at [github.com/nirholas/papertrade-liquidations](https://github.com/nirholas/papertrade-liquidations/issues).
