---
title: Self-hosting
description: Run Papertrade Liquidations on your own Cloudflare Pages project, with environment variables, plan limits and local development.
order: 8
---
# Self-hosting

The whole product is one Cloudflare Pages project: static files in `site/public`, Pages Functions in `site/functions`. No database, no queue, no secrets.

## Deploy

```bash
git clone https://github.com/nirholas/papertrade-liquidations
cd papertrade-liquidations
npm install
npm run build:site
cd site
npx wrangler pages deploy --project-name <your-project> --branch main
```

`build:site` bundles the app with esbuild, renders the docs from `docs/*.md`, and regenerates the llms files and discovery JSON. Update the `SITE` constant in `site/functions/_lib/server-info.ts` and the URLs in `server.json` if you use another domain.

## Configuration

Set in `site/wrangler.toml` under `[vars]` or in the Pages dashboard.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PAPERTRADE_API_URL` | `https://exchange.papertrade.xyz` | Upstream Papertrade API. |
| `HEATMAP_MAX_WALLETS` | 44 | Wallets followed per call. Raise to 100 on a paid plan. |
| `WALLET_STREAM_TIMEOUT_MS` | 8000 | How long to wait for one wallet stream before using the cached snapshot. |

## Plan limits

The free plan allows 50 subrequests per invocation. A heatmap call uses 4 fixed reads plus one per wallet, hence the default cap of 44. The Cache API is per data center, so snapshots warm independently in each region; the first request in a cold region can answer with `warming_up` and the next works.

## Local development

```bash
cp .dev.vars.example site/.dev.vars
npm run dev:site
npm test
npm run typecheck
```

## Dependencies

The app depends at runtime only on the Papertrade API and the Hyperliquid info API for candles and mid prices, both read-only.
