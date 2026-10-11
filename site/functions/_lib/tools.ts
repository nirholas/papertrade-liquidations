/**
 * The MCP tool set for Papertrade Liquidations. Every tool reads public data and returns numbers: none can sign,
 * send, trade or ask for a key. API and on-chain strings are untrusted data and are never executed or followed.
 */
import type { Address } from 'viem';
import { rebin } from '../../../src/buckets.js';
import { cascadeLadder, findClusters } from '../../../src/clusters.js';
import { nearest, type NearestPosition } from '../../../src/heatmap.js';
import { marketBySymbol, type MarketSymbol } from '../../../src/markets.js';
import { dangerLabel, dangerLevel } from '../../../src/positions.js';
import { walletDistance } from '../../../src/walletDistance.js';
import { HeatmapError, loadHeatmap, loadProtocolMap, loadTracked, loadWallet, maxWalletsFor, type HeatmapEnv } from './heatmap-core.js';
import { ToolError, type JsonSchema, type ToolDefinition } from './mcp.js';

export type Env = HeatmapEnv;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const market: JsonSchema = { type: 'string', enum: ['BTC', 'ETH'], description: 'Papertrade market. Both track the Hyperliquid perp of the same name.' };
const walletsParam: JsonSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 100,
  description: 'How many of the largest open-notional wallets to follow (default 40). The server caps this at its plan limit, 44 on the hosted instance.',
};
const num: JsonSchema = { type: 'number' };
const int: JsonSchema = { type: 'integer' };
const str: JsonSchema = { type: 'string' };

const bucketSchema: JsonSchema = {
  type: 'object',
  properties: { lo: num, hi: num, longNotional: num, shortNotional: num, longCount: int, shortCount: int },
  required: ['lo', 'hi', 'longNotional', 'shortNotional', 'longCount', 'shortCount'],
};
const positionSchema: JsonSchema = {
  type: 'object',
  properties: {
    wallet: str, positionId: str, side: { type: 'string', enum: ['long', 'short'] }, leverage: num, marginUsd: num, notionalUsd: num,
    entry: num, bust: num, distancePercent: num, distanceUsd: num,
  },
  required: ['wallet', 'positionId', 'side', 'leverage', 'marginUsd', 'notionalUsd', 'entry', 'bust', 'distancePercent', 'distanceUsd'],
};
const coverageSchema: JsonSchema = {
  type: 'object',
  description: 'How much of the protocol this answer covers. Tracked positions are a share of the protocol total.',
  properties: { wallets: int, positions: int, trackedNotionalUsd: num, protocolNotionalUsd: num, fraction: num },
};

function pickMarket(args: Record<string, unknown>) {
  const m = marketBySymbol(String(args.market ?? 'BTC'));
  if (!m) throw new ToolError('market must be BTC or ETH.');
  return m;
}

function walletCount(args: Record<string, unknown>, env: Env, fallback?: number): number | undefined {
  const cap = maxWalletsFor(env);
  const asked = typeof args.wallets === 'number' ? args.wallets : fallback;
  return asked === undefined ? undefined : Math.max(1, Math.min(cap, Math.floor(asked)));
}

/** Turn upstream failures into messages a model can act on. */
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HeatmapError) throw new ToolError(`${err.message} (${err.code})`);
    throw err;
  }
}

const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;
const pct = (v: number) => `${v.toFixed(v < 1 ? 3 : 2)}%`;

const tools: ToolDefinition<Env>[] = [
  {
    name: 'get_bust_map',
    title: 'Bust map by market',
    description:
      'Liquidation (bust) map for BTC or ETH on Papertrade: notional that busts at each price bucket, split into long busts below the mark and short busts above it. Built from the largest open positions, each bust price recomputed with the verified SDK formula. Includes the protocol-wide totals, coverage of the followed wallets and an optional cascade (notional that busts if price moves X%). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        market,
        bucketUsd: { type: 'number', minimum: 0.0001, maximum: 1000000, description: 'Bucket size in dollars. Omit for an automatic size of about 5 bps of price.' },
        wallets: walletsParam,
        cascadePercent: { type: 'number', minimum: 0, maximum: 25, description: 'Also report the notional that busts if price falls or rises by this percent from the mark.' },
        maxBuckets: { type: 'integer', minimum: 1, maximum: 200, description: 'Return at most this many buckets, the ones with the most notional (default 40).' },
      },
      required: ['market'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        market: str, markPrice: num, asOf: str, bucketUsd: num, coverage: coverageSchema,
        totals: { type: 'object', properties: { longNotional: num, shortNotional: num, longCount: int, shortCount: int } },
        buckets: { type: 'array', items: bucketSchema },
        cascade: { type: 'object', description: 'Present when cascadePercent was given.' },
        protocol: { type: 'object', description: 'Protocol-wide totals from the Papertrade API map.' },
        freshness: { type: 'object' },
        diagnostics: { type: 'object', properties: { positions: int, mismatches: int, wallets: int, failedWallets: int } },
      },
      required: ['market', 'markPrice', 'buckets', 'coverage'],
    },
    annotations: READ_ONLY,
    async handler(args, { env, request, waitUntil }) {
      const m = pickMarket(args);
      const { body } = await guard(() =>
        loadHeatmap({
          env, origin: new URL(request.url).origin, waitUntil, market: m,
          bucket: args.bucketUsd as number | undefined,
          wallets: walletCount(args, env, 40),
          cascadePercent: args.cascadePercent as number | undefined,
        }),
      );
      const limit = typeof args.maxBuckets === 'number' ? args.maxBuckets : 40;
      const buckets = [...body.buckets]
        .sort((a, b) => b.longNotional + b.shortNotional - (a.longNotional + a.shortNotional))
        .slice(0, limit)
        .sort((a, b) => a.lo - b.lo)
        .map(({ lo, hi, longNotional, shortNotional, longCount, shortCount }) => ({ lo, hi, longNotional, shortNotional, longCount, shortCount }));
      const protocol = body.protocol && {
        rangePercent: body.protocol.rangePercent, fromPrice: body.protocol.fromPrice, toPrice: body.protocol.toPrice,
        totalNotionalUsd: body.protocol.totalNotionalUsd, totalCount: body.protocol.totalCount, below: body.protocol.below, above: body.protocol.above,
      };
      const structured = {
        market: body.market, markPrice: body.markPrice, asOf: new Date(body.asOfMs).toISOString(), bucketUsd: body.bucketUsd,
        coverage: body.coverage, totals: body.totals, buckets, cascade: body.cascade, protocol, freshness: body.freshness, diagnostics: body.diagnostics,
      };
      return {
        structured,
        summary: `${body.market} mark ${body.markPrice}. Tracked ${body.coverage.positions} positions (${usd(body.totals.longNotional)} long busts below, ${usd(body.totals.shortNotional)} short busts above), ${body.coverage.fraction === null ? 'protocol coverage unknown' : `${(body.coverage.fraction * 100).toFixed(0)}% of protocol notional`}. Showing the ${buckets.length} largest of ${body.buckets.length} buckets.`,
      };
    },
  },
  {
    name: 'get_closest_to_bust',
    title: 'Closest-to-bust positions',
    description:
      'The open Papertrade positions closest to their bust price right now, nearest first, across BTC and ETH or one market. Each row has side, leverage, margin, notional, entry, bust price and the distance to bust in percent and dollars. Covers the largest open-notional wallets. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string', enum: ['BTC', 'ETH', 'all'], description: 'One market or all (default all).' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Rows to return (default 10).' },
        side: { type: 'string', enum: ['long', 'short', 'both'], description: 'Filter by side (default both).' },
        maxDistancePercent: { type: 'number', minimum: 0, maximum: 100, description: 'Only positions within this percent of bust.' },
        wallets: walletsParam,
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        asOf: str, marks: { type: 'object', properties: { BTC: num, ETH: num } }, count: int,
        positions: { type: 'array', items: { ...positionSchema, properties: { ...positionSchema.properties, market: str, danger: str } } },
        coverage: { type: 'object', properties: { wallets: int, positions: int } },
      },
      required: ['positions', 'marks'],
    },
    annotations: READ_ONLY,
    async handler(args, { env, request, waitUntil }) {
      const which = String(args.market ?? 'all');
      if (which !== 'all' && !marketBySymbol(which)) throw new ToolError('market must be BTC, ETH or all.');
      const side = String(args.side ?? 'both');
      const limit = typeof args.limit === 'number' ? args.limit : 10;
      const maxDistance = typeof args.maxDistancePercent === 'number' ? args.maxDistancePercent : Infinity;
      const tracked = await guard(() => loadTracked({ env, origin: new URL(request.url).origin, waitUntil, wallets: walletCount(args, env, 40)! }));
      const rows: (NearestPosition & { market: MarketSymbol; danger: string })[] = [];
      for (const sym of ['BTC', 'ETH'] as const) {
        if (which !== 'all' && which !== sym) continue;
        const pool = tracked.positions.filter((p) => p.market === sym && (side === 'both' || (side === 'long') === p.isLong));
        for (const n of nearest(pool, tracked.mids[sym], pool.length)) {
          rows.push({ ...n, market: sym, danger: dangerLabel(dangerLevel(n.distancePercent / 100)) });
        }
      }
      const positions = rows.filter((r) => r.distancePercent <= maxDistance).sort((a, b) => a.distancePercent - b.distancePercent).slice(0, limit);
      const structured = {
        asOf: new Date().toISOString(), marks: tracked.mids, count: positions.length, positions,
        coverage: { wallets: tracked.diagnostics.wallets, positions: tracked.diagnostics.positions }, freshness: tracked.freshness,
      };
      const first = positions[0];
      return {
        structured,
        summary: first
          ? `${positions.length} positions. Closest: ${first.market} ${first.side} at ${first.leverage}x, bust ${first.bust}, ${pct(first.distancePercent)} (${usd(first.distanceUsd)}) away.`
          : 'No followed position matches the filter right now.',
      };
    },
  },
  {
    name: 'get_bust_cluster_summary',
    title: 'Bust cluster summary',
    description:
      'Where liquidations cluster for a market: the largest groups of neighbouring bust prices on each side of the mark with their notional, position count and distance, plus a cascade ladder (notional that busts for moves of 0.1%, 0.25%, 0.5%, 1%, 2% and 5%) for the followed wallets and for the whole protocol. The ladder is estimated at bucket resolution. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { market, wallets: walletsParam, clusters: { type: 'integer', minimum: 1, maximum: 10, description: 'Clusters per side (default 3).' } },
      required: ['market'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        market: str, markPrice: num, bucketUsd: num,
        clusters: { type: 'array', items: { type: 'object', properties: { side: str, fromPrice: num, toPrice: num, notionalUsd: num, positions: int, distancePercent: num, shareOfSide: num } } },
        ladder: { type: 'array', items: { type: 'object', properties: { movePercent: num, tracked: { type: 'object' }, protocol: { type: 'object' } } } },
        coverage: coverageSchema,
      },
      required: ['market', 'markPrice', 'clusters', 'ladder'],
    },
    annotations: READ_ONLY,
    async handler(args, { env, request, waitUntil }) {
      const m = pickMarket(args);
      const perSide = typeof args.clusters === 'number' ? args.clusters : 3;
      const { body } = await guard(() => loadHeatmap({ env, origin: new URL(request.url).origin, waitUntil, market: m, wallets: walletCount(args, env, 40) }));
      const mark = body.markPrice;
      const all = findClusters(body.buckets, mark, 1, perSide);
      const longs = all.filter((c) => c.side === 'long').slice(0, perSide);
      const shorts = all.filter((c) => c.side === 'short').slice(0, perSide);
      const clusters = [...longs, ...shorts].sort((a, b) => b.notionalUsd - a.notionalUsd);
      const tracked = cascadeLadder(body.buckets, body.bucketUsd, mark);
      const proto = body.protocol ? cascadeLadder(body.protocol.buckets, body.protocol.bucketUsd, mark) : null;
      const ladder = tracked.map((r, i) => ({ movePercent: r.movePercent, tracked: { down: r.down, up: r.up }, protocol: proto ? { down: proto[i]!.down, up: proto[i]!.up } : null }));
      const top = clusters[0];
      return {
        structured: { market: body.market, markPrice: mark, bucketUsd: body.bucketUsd, clusters, ladder, coverage: body.coverage },
        summary: top
          ? `${body.market} mark ${mark}. Largest cluster: ${top.side} busts ${top.fromPrice} to ${top.toPrice}, ${usd(top.notionalUsd)} across ${top.positions} positions, ${pct(top.distancePercent)} from the mark.`
          : `${body.market} mark ${mark}. No bust clusters among the followed wallets.`,
      };
    },
  },
  {
    name: 'get_wallet_distance_to_bust',
    title: 'Distance to bust for a wallet',
    description:
      'Distance to bust for every open Papertrade position of one wallet address: side, leverage, margin, notional, entry, bust price, the live mark, the move left in percent and dollars, and a danger label (watch within 1%, danger within 0.25%, critical within 0.05%). Public on-chain data only, no signing and no key. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { wallet: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'EVM wallet address (0x plus 40 hex characters).' } },
      required: ['wallet'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        wallet: str, count: int, totalNotionalUsd: num, totalMarginUsd: num, closest: { type: 'object' },
        positions: { type: 'array', items: { type: 'object' } }, snapshotAgeSeconds: int, stale: { type: 'boolean' },
      },
      required: ['wallet', 'positions'],
    },
    annotations: READ_ONLY,
    async handler(args, { env, request, waitUntil }) {
      const wallet = String(args.wallet) as Address;
      const data = await guard(() => loadWallet({ env, origin: new URL(request.url).origin, waitUntil, wallet }));
      const d = walletDistance(wallet, data.positions, data.mids);
      return {
        structured: {
          wallet: d.wallet, count: d.positions.length, totalNotionalUsd: d.totalNotionalUsd, totalMarginUsd: d.totalMarginUsd, closest: d.closest,
          positions: d.positions, snapshotAgeSeconds: Math.round(data.ageMs / 1000), stale: data.stale,
        },
        summary: d.closest
          ? `${d.positions.length} open positions. Closest: ${d.closest.market} ${d.closest.side} at ${d.closest.leverage}x, bust ${d.closest.bust}, ${pct(d.closest.distancePercent)} away (${d.closest.danger}).${data.stale ? ' Snapshot is stale because the stream endpoint was rate limited.' : ''}`
          : 'This wallet has no open positions on BTC or ETH.',
      };
    },
  },
  {
    name: 'get_protocol_liquidation_map',
    title: 'Protocol-wide liquidation map',
    description:
      'The whole-protocol liquidation map published by the Papertrade API: every open position, not just the largest wallets, in buckets around the mark (plus totals beyond the range). Cheaper and wider than get_bust_map, with no per-position detail. Optionally regroup onto a coarser bucket size. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        market,
        bucketUsd: { type: 'number', minimum: 0.0001, maximum: 1000000, description: 'Regroup the API buckets onto this size in dollars. Omit for the native 150 buckets.' },
      },
      required: ['market'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        market: str, markPrice: num, rangePercent: num, fromPrice: num, toPrice: num, bucketUsd: num, totalNotionalUsd: num, totalCount: int,
        below: { type: 'object' }, above: { type: 'object' }, buckets: { type: 'array', items: bucketSchema },
      },
      required: ['market', 'markPrice', 'buckets'],
    },
    annotations: READ_ONLY,
    async handler(args, { env }) {
      const m = pickMarket(args);
      const { map, mark } = await guard(() => loadProtocolMap(env, m));
      const size = typeof args.bucketUsd === 'number' ? args.bucketUsd : undefined;
      const buckets = (size ? rebin(map.buckets, size) : map.buckets).map(({ lo, hi, longNotional, shortNotional, longCount, shortCount }) => ({ lo, hi, longNotional, shortNotional, longCount, shortCount }));
      return {
        structured: {
          market: m.symbol, markPrice: mark, rangePercent: map.rangePercent, fromPrice: map.fromPrice, toPrice: map.toPrice, bucketUsd: size ?? map.bucketUsd,
          totalNotionalUsd: map.totalNotionalUsd, totalCount: map.totalCount, below: map.below, above: map.above, buckets,
        },
        summary: `${m.symbol} mark ${mark}. Protocol-wide ${usd(map.totalNotionalUsd)} across ${map.totalCount} positions, mapped from ${map.fromPrice} to ${map.toPrice}.`,
      };
    },
  },
];

export default tools;
