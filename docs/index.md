---
title: Overview
description: Papertrade Liquidations shows where 1000x positions bust on Papertrade, as a live map, a closest-to-bust table, an HTTP API and an MCP server for AI agents.
order: 1
---
# Papertrade Liquidations

Papertrade is a fully on-chain synthetic perpetuals exchange on Hyperliquid's HyperEVM with leverage up to 1000x. At 1000x a 0.05% move wipes out a position, so the most useful signal on the exchange is where positions would bust.

Papertrade Liquidations follows the largest open positions, recomputes every bust price with the verified [papertrade-sdk](https://github.com/nirholas/papertrade-sdk) formula, and answers four questions:

- Where do liquidations cluster for BTC and ETH, and how much notional sits in each cluster?
- Which open positions are closest to their bust price right now?
- How much notional busts if price moves 0.1%, 0.5%, 1% or 5%?
- How close to bust is a specific wallet?

> Unofficial, not affiliated with Papertrade. High leverage can lose your whole margin. Everything here is read-only: no tool, page or endpoint signs, sends, trades or asks for a key.

## Three ways to use it

| Surface | For | Where |
| --- | --- | --- |
| Web app | People watching the market | [/](/) |
| HTTP API | Scripts and dashboards | [`GET /api/heatmap`](/docs/reference) and [openapi.json](/openapi.json) |
| MCP server | AI agents and assistants | `POST /mcp`, see [MCP](/docs/mcp) and [Connect your AI](/docs/connect) |

## What is inside

The app is a Cloudflare Pages site. Pure TypeScript in `src/` computes bust prices, buckets, cascades and clusters and is shared by the browser, the `/api/heatmap` function and the MCP tools, so all three always agree. The app is `site/`, the MCP server is `site/functions/mcp.ts`, and this documentation is built from `docs/*.md` by `scripts/build-docs.mjs`.

## Where to go next

- New here: [Quickstart](/docs/quickstart).
- Want to understand the numbers: [Concepts](/docs/concepts).
- Building an agent: [MCP](/docs/mcp), then [Connect your AI](/docs/connect).
- Running your own copy: [Self-hosting](/docs/self-hosting).
