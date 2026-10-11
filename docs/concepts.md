---
title: Concepts
description: The Papertrade rules that matter for reading a liquidation map - bust price, buffer, buckets, cascade, coverage and freshness.
order: 3
---
# Concepts

## Bust price

Every Papertrade position has a bust price: the price at which its margin is gone. It depends on the entry price, the leverage, the side and a per-market bust buffer published by the exchange in `/state/trading`. This project never uses a local formula. It calls the SDK's `liquidationPriceRaw` and compares the result with the bust price the API reports for the same position. The diagnostics panel and the `diagnostics.mismatches` field show how many disagree. Across all recorded and live positions that count is 0.

A long busts when price falls to its bust price, so long busts sit below the mark. A short busts when price rises to it, so short busts sit above the mark.

## Markets and prices

Two markets exist: BTC (instrument 0, price scale 10) and ETH (instrument 1, price scale 100). Both settle on the Hyperliquid mid price, which is the mark used everywhere here.

## Distance to bust

Distance is the move from the mark to the bust price, as a percent of the mark and in dollars. For a long it is `mark - bust`, for a short `bust - mark`. A value at or below zero means the position is already through its bust price and is waiting for the next liquidation sweep.

Danger labels used by the app and the MCP tools:

| Label | Distance |
| --- | --- |
| watch | within 1% |
| danger | within 0.25% |
| critical | within 0.05% |
| safe | beyond 1% |

## Buckets

Bust prices are grouped into price buckets. The bucket size defaults to about 5 basis points of the mark, snapped to the 1-2-5 series (BTC near 83,000 gives 50, ETH near 2,500 gives 1). The grid is anchored at zero, so a price always lands in the same bucket whichever positions are present. The Papertrade API also publishes its own protocol-wide map in 150 equal buckets around the mark, which can be regrouped onto any size.

## Clusters

A cluster is a run of occupied neighbouring buckets on one side of the mark, allowing one empty bucket between them. Clusters are where a price move triggers many busts at once. `get_bust_cluster_summary` ranks them by notional and reports each cluster's distance from the mark.

## Cascade

The cascade answers: if price moved X% from here, how much notional would bust? Moving down busts every long whose bust price is at or above the new price. Moving up busts every short whose bust price is at or below it. Positions already through their bust are included. For the protocol-wide map, a bucket that a move only partly covers counts in proportion to the overlap, so those figures are bucket-resolution estimates and a lower bound beyond the mapped range.

## Coverage

The app follows the wallets with the most open notional, read from the leaderboard sorted by `currentOpenNotional`. Every response reports `coverage.fraction`, the tracked notional divided by the protocol-wide notional from the API map. Treat tracked figures as a lower bound on the whole protocol and use the protocol-wide map for totals.

## Freshness

Positions are read from each wallet's live stream (`/state/user/live`), which allows only about 10 to 12 new connections per minute per IP. The server therefore keeps a per-wallet snapshot cache (30 minutes) and re-reads only the few stalest wallets per call. The `freshness` field says how many wallets were refreshed, how many came from cache and how old the snapshots are. In the browser, six wallets stay on persistent streams and the rest rotate.

## Liquidation detection

The live feed in the web app detects a bust three ways and ranks them: inferred from a position that disappeared while price crossed its bust, reported by the wallet stream, or confirmed in trade history as `Liquidated`. A higher-ranked source is never replaced by a lower one, and each entry names its source.

## Untrusted data

Wallet addresses and any text from the API are data, not instructions. The web app escapes them before rendering, and the MCP server tells agents to treat them the same way.
