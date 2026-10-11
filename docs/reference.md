---
title: API reference
description: The GET /api/heatmap endpoint, its parameters, response fields, caching and errors, plus the OpenAPI document.
order: 4
---
# API reference

Base URL: `https://papertrade-liquidations.pages.dev`. CORS is open (`access-control-allow-origin: *`). The machine-readable description is [/openapi.json](/openapi.json) (OpenAPI 3.1).

## GET /api/heatmap

Liquidation map for one market.

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `market` | `BTC` or `ETH` | `BTC` | |
| `bucket` | number | automatic | Bucket size in dollars, 0.0001 to 1,000,000. |
| `wallets` | integer | 40 | Largest open-notional wallets to follow, 1 to 44 (the Cloudflare free plan limit; 100 on a paid plan). |
| `cascade` | number | none | Percent move for the cascade figure, 0 to 25. |

Unknown parameters return 400, so typos fail loudly.

```bash
curl -s "https://papertrade-liquidations.pages.dev/api/heatmap?market=ETH&bucket=2&cascade=1"
```

### Response

| Field | Meaning |
| --- | --- |
| `markPrice` | Hyperliquid mid in dollars. |
| `asOfMs` | Server time of the build, Unix milliseconds. |
| `bucketUsd` | Bucket size used. |
| `coverage` | `wallets`, `positions`, `trackedNotionalUsd`, `protocolNotionalUsd` and `fraction` (tracked divided by protocol, 0 to 1, null if unavailable). |
| `totals` | Long and short notional and counts among tracked positions. |
| `buckets` | Occupied buckets, ascending: `lo`, `hi`, `mid`, `longNotional`, `shortNotional`, `longCount`, `shortCount`. |
| `cascade` | When `cascade` was given: `down` (longs that bust) and `up` (shorts that bust) with `notional`, `margin`, `count`. |
| `nearest` | The ten positions closest to bust: wallet, position id, side, leverage, margin, notional, entry, bust, `distancePercent`, `distanceUsd`. |
| `protocol` | The Papertrade API's protocol-wide map in dollars, with totals below and above the mapped range. |
| `diagnostics` | `positions`, `mismatches` (bust prices that differ from the API), `wallets`, `failedWallets`. |
| `freshness` | Snapshot age: `refreshed`, `cached`, `missing`, `oldestMs`, `newestMs`. |

### Caching and errors

Responses are cached for 10 seconds; the `x-cache` header is `HIT` or `MISS`. Errors use `{ "ok": false, "error": { "code", "message" } }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `unknown_parameter`, `invalid_parameter` | Bad input. |
| 502 | `warming_up` | No snapshots are cached yet and the stream endpoint is rate limited. Retry in a minute. |
| 502 | `upstream_error` | The Papertrade API or Hyperliquid failed. |

## Same-origin proxy

`/api/papertrade/*` forwards to the Papertrade API because its REST routes send no CORS headers. The web app uses it; it is not a stable public API.

## MCP

The same data is available to agents at `POST /mcp`. See [MCP](/docs/mcp).

## Upstream data

| Source | Used for |
| --- | --- |
| `exchange.papertrade.xyz` `/state/trading` | Instruments and bust buffers. |
| `exchange.papertrade.xyz` `/state/leaderboard/accounts` | Largest wallets by open notional (page index is 0-based). |
| `exchange.papertrade.xyz` `/state/user/live` | One wallet's open positions (SSE). |
| `exchange.papertrade.xyz` `/query/markets/{id}/liquidation-map` | Protocol-wide map. |
| `api.hyperliquid.xyz` `/info` | Mid prices and candles. |
