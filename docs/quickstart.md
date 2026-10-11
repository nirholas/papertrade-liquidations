---
title: Quickstart
description: Read the liquidation map in the browser, call the HTTP API with curl, and connect an AI client over MCP in under a minute.
order: 2
---
# Quickstart

## In the browser

Open [papertrade-liquidations.pages.dev](/). The map loads BTC first: candles on the left, bars on the right edge showing the notional that busts at each price. Red bars below the mark are long busts, blue bars above it are short busts, and the hollow outline is the whole protocol. Switch to ETH with the market control, drag the cascade slider to see the notional that busts at a given move, and open the closest-to-bust table below the map.

Add `?embed=1` to show only the product without the landing sections.

## With curl

```bash
curl -s "https://papertrade-liquidations.pages.dev/api/heatmap?market=BTC&cascade=0.5" | jq '{markPrice, coverage, cascade, nearest: .nearest[0]}'
```

The response carries the mark price, bust notional per bucket, coverage against the protocol total, the ten positions nearest to bust and the cascade for a 0.5% move. See the [reference](/docs/reference).

## With an AI client

Add the MCP server `https://papertrade-liquidations.pages.dev/mcp`.

```bash
claude mcp add --transport http papertrade-liquidations https://papertrade-liquidations.pages.dev/mcp
```

Then ask: "Where do BTC longs bust on Papertrade, and which positions are closest to bust?" Setup for Codex, ChatGPT, Gemini, Cursor, VS Code and others is on [Connect your AI](/docs/connect).

Check the connection from a terminal:

```bash
curl -s https://papertrade-liquidations.pages.dev/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools[].name'
```

## Run it locally

```bash
npm install ../papertrade-sdk-0.1.0.tgz viem   # until the SDK is on npm
npm install
cp .dev.vars.example site/.dev.vars
npm run dev:site      # http://localhost:8794
npm test && npm run typecheck
```
