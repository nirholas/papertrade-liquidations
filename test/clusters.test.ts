import { describe, expect, it } from 'vitest';
import type { Bucket } from '../src/buckets.js';
import { cascadeLadder, findClusters } from '../src/clusters.js';

const b = (lo: number, longNotional: number, shortNotional: number): Bucket => ({
  lo, hi: lo + 10, mid: lo + 5, longNotional, shortNotional, longCount: longNotional ? 1 : 0, shortCount: shortNotional ? 1 : 0,
});

describe('findClusters', () => {
  const buckets = [b(900, 5, 0), b(910, 7, 0), b(940, 100, 0), b(1020, 0, 30), b(1030, 0, 10), b(1100, 0, 4)];
  it('merges neighbours within one empty bucket and keeps far buckets apart', () => {
    const c = findClusters(buckets, 1000, 1, 5);
    const longs = c.filter((x) => x.side === 'long');
    expect(longs).toHaveLength(2);
    expect(longs.find((x) => x.fromPrice === 900)).toMatchObject({ toPrice: 920, notionalUsd: 12, positions: 2 });
    const shorts = c.filter((x) => x.side === 'short');
    expect(shorts.find((x) => x.fromPrice === 1020)).toMatchObject({ toPrice: 1040, notionalUsd: 40 });
  });
  it('orders by notional and measures distance to the near edge', () => {
    const c = findClusters(buckets, 1000, 1, 5);
    expect(c[0]).toMatchObject({ side: 'long', notionalUsd: 100 });
    expect(c[0]!.distancePercent).toBeCloseTo(((1000 - 950) / 1000) * 100);
    const short = c.find((x) => x.side === 'short' && x.fromPrice === 1020)!;
    expect(short.distancePercent).toBeCloseTo(2);
    expect(short.shareOfSide).toBeCloseTo(40 / 44);
  });
  it('returns nothing for empty input', () => {
    expect(findClusters([], 1000)).toEqual([]);
  });
});

describe('cascadeLadder', () => {
  it('accumulates notional as the move grows and splits partial buckets proportionally', () => {
    const ladder = cascadeLadder([b(940, 100, 0), b(1050, 0, 20)], 10, 1000, [1, 5, 10]);
    expect(ladder[0]!.down.notionalUsd).toBe(0);
    expect(ladder[1]!.down.notionalUsd).toBeCloseTo(0);
    expect(ladder[2]!.down.notionalUsd).toBeCloseTo(100);
    expect(ladder[2]!.up.notionalUsd).toBeCloseTo(20);
    expect(ladder[1]!.up.notionalUsd).toBeCloseTo(0);
    expect(cascadeLadder([b(1050, 0, 20)], 10, 1000, [5.5])[0]!.up.notionalUsd).toBeCloseTo(10);
  });
});
