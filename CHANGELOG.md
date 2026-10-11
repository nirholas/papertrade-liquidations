# Changelog

## 0.2.0 - 2026-10-11

- MCP server at `/mcp` (Streamable HTTP, stateless, read-only) with five tools: `get_bust_map`, `get_closest_to_bust`, `get_bust_cluster_summary`, `get_wallet_distance_to_bust`, `get_protocol_liquidation_map`.
- Documentation site at `/docs/` with search, markdown twins and a Connect your AI guide.
- Agent discovery: MCP server card, A2A agent card, RFC 9727 API catalog, `llms.txt`, `llms-full.txt`, `robots.txt` with Content-Signal, sitemap, `Link` headers, `server.json` and `glama.json`.
- Landing page with hero, feature grid, works-with strip and connect tabs.
- `?embed=1` and an "Open in Papertrade OS" link. Framing allowed for `papertrade-os.pages.dev` and `*.pages.dev`.
- Shared heatmap loader with per-wallet snapshot cache, so the API and MCP agree and survive stream rate limits.

## 0.1.0 - 2026-10-10

- Liquidation map for BTC and ETH with candles, bust histogram, mark line and bucket control.
- Closest-to-bust table with threshold animations and explorer wallet links.
- Liquidation feed with three detection sources and a session tally.
- Cascade card for moves of 0.02% to 5% in both directions.
- Diagnostics panel with SDK bust price cross-check and mismatch count.
- `/api/heatmap` Pages Function with 10 second cache and `/openapi.json`.
