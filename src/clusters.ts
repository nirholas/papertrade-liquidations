import type { Bucket } from './buckets.js';
import { protocolCascade } from './cascade.js';

export interface Cluster {
  side: 'long' | 'short';
  fromPrice: number;
  toPrice: number;
  notionalUsd: number;
  positions: number;
  /** Move from the mark to the near edge of the cluster, in percent. Positive means price still has to travel. */
  distancePercent: number;
  /** Share of the side's notional that sits in this cluster, 0 to 1. */
  shareOfSide: number;
}

export interface LadderRung {
  movePercent: number;
  down: { notionalUsd: number; positions: number };
  up: { notionalUsd: number; positions: number };
}

const LADDER_PERCENTS = [0.1, 0.25, 0.5, 1, 2, 5];

/**
 * Merge neighbouring occupied buckets into clusters. Two buckets belong to the same cluster when the gap between
 * them is at most `gapBuckets` empty buckets. Longs bust below the mark and shorts above it, so each side is
 * clustered separately, and the largest clusters by notional come first.
 */
export function findClusters(buckets: readonly Bucket[], mark: number, gapBuckets = 1, limit = 5): Cluster[] {
  const out: Cluster[] = [];
  for (const side of ['long', 'short'] as const) {
    const occupied = buckets
      .filter((b) => (side === 'long' ? b.longCount : b.shortCount) > 0)
      .sort((a, b) => a.lo - b.lo);
    const sideTotal = occupied.reduce((n, b) => n + (side === 'long' ? b.longNotional : b.shortNotional), 0);
    const width = occupied[0] ? occupied[0].hi - occupied[0].lo : 0;
    let current: Bucket[] = [];
    const flush = () => {
      if (!current.length) return;
      const first = current[0]!;
      const last = current[current.length - 1]!;
      const notionalUsd = current.reduce((n, b) => n + (side === 'long' ? b.longNotional : b.shortNotional), 0);
      const positions = current.reduce((n, b) => n + (side === 'long' ? b.longCount : b.shortCount), 0);
      const near = side === 'long' ? last.hi : first.lo;
      out.push({
        side,
        fromPrice: first.lo,
        toPrice: last.hi,
        notionalUsd,
        positions,
        distancePercent: (side === 'long' ? mark - near : near - mark) / mark * 100,
        shareOfSide: sideTotal > 0 ? notionalUsd / sideTotal : 0,
      });
      current = [];
    };
    for (const b of occupied) {
      const prev = current[current.length - 1];
      if (prev && b.lo - prev.hi > gapBuckets * width + width * 1e-6) flush();
      current.push(b);
    }
    flush();
  }
  return out.sort((a, b) => b.notionalUsd - a.notionalUsd).slice(0, limit * 2);
}

/**
 * Notional that busts for a ladder of price moves. Works on buckets, so a bucket the move only partly covers
 * contributes in proportion to the overlap: an estimate at bucket resolution, exact only at bucket edges.
 */
export function cascadeLadder(buckets: readonly Bucket[], bucketUsd: number, mark: number, percents: readonly number[] = LADDER_PERCENTS): LadderRung[] {
  return percents.map((p) => {
    const c = protocolCascade({ buckets: buckets as Bucket[], bucketUsd }, mark, p / 100);
    return { movePercent: p, down: { notionalUsd: c.down.notional, positions: c.down.count }, up: { notionalUsd: c.up.notional, positions: c.up.count } };
  });
}
