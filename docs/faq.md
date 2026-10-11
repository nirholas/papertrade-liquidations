---
title: FAQ
description: Common questions about coverage, accuracy, rate limits and agent use.
order: 10
---
# FAQ

## Is this official?
No. It is an unofficial tool built on Papertrade's public API.

## Can an agent trade with it?
No. Every tool is read-only and no endpoint holds or asks for keys.

## Why do totals differ from the protocol total?
Tracked positions come from the largest wallets and cover a share of notional, shown as coverage. Use `get_protocol_liquidation_map` for protocol-wide totals.

## How fresh is the data?
The heatmap response is cached 10 seconds. Per-wallet positions can be up to 30 minutes old on the server when streams are rate limited, and `freshness` reports exactly how old. The browser app keeps live streams for the top wallets.

## What does `warming_up` mean?
No wallet snapshots are cached in that region yet and the live stream was rate limited. Retry after a minute.

## How do I know the bust prices are right?
Each is recomputed with the SDK and compared with the API's own value. `diagnostics.mismatches` counts differences.

## Which markets?
BTC and ETH.

## Does it need an API key?
No.

## Can I embed it?
Yes. Use `?embed=1` for the product without marketing sections. Framing is allowed for `*.pages.dev`.

## Where is the changelog?
[Changelog](/docs/changelog).
