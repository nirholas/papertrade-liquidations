import type { LiquidationMap } from 'papertrade-sdk';
import { wadToNumber } from 'papertrade-sdk';
import { autoBucket, bucketize, totals, type Bucket, type Totals } from './buckets.js';
import { cascade, type Cascade } from './cascade.js';
import type { MarketSymbol } from './markets.js';
import { distanceToBust, type Diagnostics, type TrackedPosition } from './positions.js';

/** The protocol-wide map the API publishes, converted to dollars. 150 equal buckets around the mark. */
export interface ProtocolMap {
  rangePercent: number;
  fromPrice: number;
  toPrice: number;
  bucketUsd: number;
  buckets: Bucket[];
  below: { longNotional: number; shortNotional: number; longCount: number; shortCount: number };
  above: { longNotional: number; shortNotional: number; longCount: number; shortCount: number };
  totalNotionalUsd: number;
  totalCount: number;
  asOfMs: number;
}

export function parseProtocolMap(map: LiquidationMap): ProtocolMap {
  const scale = Number(map.priceScale);
  const fromPrice = Number(map.fromRaw) / scale;
  const toPrice = Number(map.toRaw) / scale;
  const bucketUsd = (toPrice - fromPrice) / map.buckets.length;
  const sum = (b: LiquidationMap['below']) => ({ longNotional: wadToNumber(b[0]), shortNotional: wadToNumber(b[1]), longCount: b[2], shortCount: b[3] });
  const buckets = map.buckets.map((b, i) => {
    const lo = fromPrice + i * bucketUsd;
    const s = sum(b);
    return { lo, hi: lo + bucketUsd, mid: lo + bucketUsd / 2, ...s };
  });
  const below = sum(map.below);
  const above = sum(map.above);
  const all = [...buckets, below, above];
  return {
    rangePercent: Number(map.range),
    fromPrice,
    toPrice,
    bucketUsd,
    buckets: buckets.filter((b) => b.longCount + b.shortCount > 0),
    below,
    above,
    totalNotionalUsd: all.reduce((n, b) => n + b.longNotional + b.shortNotional, 0),
    totalCount: all.reduce((n, b) => n + b.longCount + b.shortCount, 0),
    asOfMs: map.source.priceAt,
  };
}

export interface NearestPosition {
  wallet: string;
  positionId: string;
  side: 'long' | 'short';
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  entry: number;
  bust: number;
  distancePercent: number;
  distanceUsd: number;
}

export interface HeatmapResponse {
  ok: true;
  market: MarketSymbol;
  markPrice: number;
  asOfMs: number;
  bucketUsd: number;
  coverage: {
    wallets: number;
    positions: number;
    trackedNotionalUsd: number;
    protocolNotionalUsd: number | null;
    /** Tracked notional divided by protocol-wide notional, 0 to 1. Null when the protocol map was unavailable. */
    fraction: number | null;
  };
  totals: Totals;
  buckets: Bucket[];
  cascade: Cascade | null;
  nearest: NearestPosition[];
  protocol: ProtocolMap | null;
  diagnostics: Diagnostics & { failedWallets: number };
  /** How old the per-wallet snapshots behind this response are. Null when every wallet was read live. */
  freshness: Freshness | null;
}

export interface Freshness {
  refreshed: number;
  cached: number;
  missing: number;
  oldestMs: number | null;
  newestMs: number | null;
}

export interface AssembleInput {
  market: MarketSymbol;
  mark: number;
  asOfMs: number;
  /** Bucket size in dollars; omit for the automatic size. */
  bucketUsd?: number;
  positions: readonly TrackedPosition[];
  protocol: ProtocolMap | null;
  /** Cascade move as a fraction, or undefined to skip. */
  cascadeFraction?: number;
  diagnostics: Diagnostics & { failedWallets: number };
  freshness?: Freshness;
  nearestCount?: number;
}

export function nearest(positions: readonly TrackedPosition[], mark: number, count: number): NearestPosition[] {
  return positions
    .map((p) => ({ p, d: distanceToBust(p, mark) }))
    .sort((a, b) => a.d.fraction - b.d.fraction)
    .slice(0, count)
    .map(({ p, d }) => ({
      wallet: p.wallet,
      positionId: p.positionId,
      side: p.isLong ? ('long' as const) : ('short' as const),
      leverage: p.leverage,
      marginUsd: p.marginUsd,
      notionalUsd: p.notionalUsd,
      entry: p.entry,
      bust: p.bust,
      distancePercent: d.fraction * 100,
      distanceUsd: d.usd,
    }));
}

export function assembleHeatmap(input: AssembleInput): HeatmapResponse {
  const positions = input.positions.filter((p) => p.market === input.market);
  const bucketUsd = input.bucketUsd ?? autoBucket(input.mark);
  const t = totals(positions);
  const tracked = t.longNotional + t.shortNotional;
  const protocolNotional = input.protocol?.totalNotionalUsd ?? null;
  return {
    ok: true,
    market: input.market,
    markPrice: input.mark,
    asOfMs: input.asOfMs,
    bucketUsd,
    coverage: {
      wallets: new Set(positions.map((p) => p.wallet)).size,
      positions: positions.length,
      trackedNotionalUsd: tracked,
      protocolNotionalUsd: protocolNotional,
      fraction: protocolNotional && protocolNotional > 0 ? Math.min(1, tracked / protocolNotional) : null,
    },
    totals: t,
    buckets: bucketize(positions, bucketUsd),
    cascade: input.cascadeFraction === undefined ? null : cascade(positions, input.mark, input.cascadeFraction),
    nearest: nearest(positions, input.mark, input.nearestCount ?? 10),
    protocol: input.protocol,
    diagnostics: input.diagnostics,
    freshness: input.freshness ?? null,
  };
}
