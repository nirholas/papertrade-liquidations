import type { TrackedPosition } from './positions.js';

export interface Bucket {
  /** Lower edge, dollars. */
  lo: number;
  hi: number;
  mid: number;
  longNotional: number;
  shortNotional: number;
  longCount: number;
  shortCount: number;
}

/** Snap to the 1-2-5 series so bucket sizes read like round numbers. */
export function niceStep(value: number): number {
  if (!(value > 0)) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const f = value / base;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * base;
}

/** A bucket size of about 5 bps of price, snapped to 1-2-5. BTC near 83,000 gives 50, ETH near 2,500 gives 1. */
export function autoBucket(mark: number): number {
  return niceStep(mark * 0.0005);
}

/** Selectable bucket sizes around the auto size (quarter, half, 1x, 2x, 5x, 10x). */
export function bucketPresets(mark: number): number[] {
  const base = autoBucket(mark);
  return [0.25, 0.5, 1, 2, 5, 10].map((m) => round(base * m));
}

function round(v: number): number {
  return Number(v.toPrecision(6));
}

export function bucketIndex(bust: number, bucketUsd: number): number {
  return Math.floor(round(bust / bucketUsd));
}

/**
 * Group positions by bust price. The grid is anchored at price zero, so a given bust price always lands in
 * the same bucket regardless of which positions are present. Only occupied buckets are returned, ascending.
 */
export function bucketize(positions: readonly Pick<TrackedPosition, 'bust' | 'isLong' | 'notionalUsd'>[], bucketUsd: number): Bucket[] {
  if (!(bucketUsd > 0)) throw new RangeError('bucketUsd must be positive');
  const map = new Map<number, Bucket>();
  for (const p of positions) {
    const idx = bucketIndex(p.bust, bucketUsd);
    let b = map.get(idx);
    if (!b) {
      const lo = round(idx * bucketUsd);
      b = { lo, hi: round(lo + bucketUsd), mid: round(lo + bucketUsd / 2), longNotional: 0, shortNotional: 0, longCount: 0, shortCount: 0 };
      map.set(idx, b);
    }
    if (p.isLong) {
      b.longNotional += p.notionalUsd;
      b.longCount++;
    } else {
      b.shortNotional += p.notionalUsd;
      b.shortCount++;
    }
  }
  return [...map.values()].sort((a, b) => a.lo - b.lo);
}

export interface Totals {
  longNotional: number;
  shortNotional: number;
  longCount: number;
  shortCount: number;
}

export function totals(positions: readonly Pick<TrackedPosition, 'isLong' | 'notionalUsd'>[]): Totals {
  const t: Totals = { longNotional: 0, shortNotional: 0, longCount: 0, shortCount: 0 };
  for (const p of positions) {
    if (p.isLong) {
      t.longNotional += p.notionalUsd;
      t.longCount++;
    } else {
      t.shortNotional += p.notionalUsd;
      t.shortCount++;
    }
  }
  return t;
}

/** Re-group buckets (for example the protocol map's native 150) onto a different grid, by bucket midpoint. */
export function rebin(buckets: readonly Bucket[], bucketUsd: number): Bucket[] {
  if (!(bucketUsd > 0)) throw new RangeError('bucketUsd must be positive');
  const map = new Map<number, Bucket>();
  for (const b of buckets) {
    const idx = bucketIndex(b.mid, bucketUsd);
    let out = map.get(idx);
    if (!out) {
      const lo = round(idx * bucketUsd);
      out = { lo, hi: round(lo + bucketUsd), mid: round(lo + bucketUsd / 2), longNotional: 0, shortNotional: 0, longCount: 0, shortCount: 0 };
      map.set(idx, out);
    }
    out.longNotional += b.longNotional;
    out.shortNotional += b.shortNotional;
    out.longCount += b.longCount;
    out.shortCount += b.shortCount;
  }
  return [...map.values()].sort((a, b) => a.lo - b.lo);
}
