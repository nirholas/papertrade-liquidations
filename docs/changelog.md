---
title: Changelog
description: Release notes for Papertrade Liquidations.
order: 11
---
# Changelog

## 0.2.0 - 2026-10-11

- MCP server at `/mcp` with five read-only tools: bust map, closest to bust, bust clusters, wallet distance, protocol map.
- Documentation site at `/docs/` with search, markdown twins and a Connect your AI guide.
- Agent discovery: MCP server card, A2A agent card, API catalog, llms.txt, llms-full.txt, robots.txt with Content-Signal, sitemap.
- Landing page with live data, feature grid, client strip and quickstart.
- `?embed=1` and an "Open in Papertrade OS" link; framing allowed for `*.pages.dev`.
- Shared heatmap loader and per-wallet snapshot cache so the API and MCP agree and survive stream rate limits.

## 0.1.0 - 2026-10-10

- Liquidation map for BTC and ETH with candles, bust histogram, mark line and bucket control.
- Closest-to-bust table, liquidation feed with three detection sources, cascade card and diagnostics panel.
- `/api/heatmap` Pages Function with 10 second cache and `/openapi.json`.
