import { describe, expect, it } from 'vitest';
import { trackPositions } from '../src/positions.js';
import { autoBucket, bucketIndex, bucketize, bucketPresets, niceStep, totals } from '../src/buckets.js';
import { fixture, instruments, snapshots } from './fixtures.js';

const mids = fixture<{ BTC: string; ETH: string }>('mids');
const all = () => snapshots().flatMap((s) => trackPositions(s.address, s.positions, instruments()).positions);

describe('bucket sizes', () => {
  it('snaps to the 1-2-5 series', () => {
    expect(niceStep(0.9)).toBe(1);
    expect(niceStep(1.6)).toBe(2);
    expect(niceStep(4)).toBe(5);
    expect(niceStep(8)).toBe(10);
    expect(niceStep(41.5)).toBe(50);
    expect(niceStep(0)).toBe(1);
  });

  it('chooses about 5 bps of the recorded marks', () => {
    expect(autoBucket(Number(mids.BTC))).toBe(50);
    expect(autoBucket(Number(mids.ETH))).toBe(1);
  });

  it('offers ascending presets that include the automatic size', () => {
    const presets = bucketPresets(Number(mids.BTC));
    expect(presets).toEqual([...presets].sort((a, b) => a - b));
    expect(presets).toContain(autoBucket(Number(mids.BTC)));
    expect(new Set(presets).size).toBe(presets.length);
  });
});

describe('bucketize recorded positions', () => {
  it('conserves notional and counts', () => {
    const positions = all();
    expect(positions.length).toBeGreaterThan(20);
    for (const market of ['BTC', 'ETH'] as const) {
      const ofMarket = positions.filter((p) => p.market === market);
      const size = autoBucket(Number(mids[market]));
      const buckets = bucketize(ofMarket, size);
      const t = totals(ofMarket);
      const sum = (f: (b: (typeof buckets)[number]) => number) => buckets.reduce((n, b) => n + f(b), 0);
      expect(sum((b) => b.longNotional)).toBeCloseTo(t.longNotional, 4);
      expect(sum((b) => b.shortNotional)).toBeCloseTo(t.shortNotional, 4);
      expect(sum((b) => b.longCount)).toBe(t.longCount);
      expect(sum((b) => b.shortCount)).toBe(t.shortCount);
    }
  });

  it('places every bust price inside its bucket, ascending, with no empty buckets', () => {
    const positions = all().filter((p) => p.market === 'ETH');
    const size = 2;
    const buckets = bucketize(positions, size);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]!.lo).toBeGreaterThan(buckets[i - 1]!.lo);
    for (const b of buckets) expect(b.longCount + b.shortCount).toBeGreaterThan(0);
    for (const p of positions) {
      const b = buckets.find((x) => p.bust >= x.lo && p.bust < x.hi);
      expect(b, `bust ${p.bust}`).toBeDefined();
    }
  });

  it('puts long busts below the mark and short busts above it', () => {
    const positions = all().filter((p) => p.market === 'ETH');
    const mark = Number(mids.ETH);
    const live = positions.filter((p) => (p.isLong ? p.bust < mark : p.bust > mark));
    expect(live.length).toBeGreaterThan(0);
    for (const b of bucketize(live, 1)) {
      if (b.longCount) expect(b.hi).toBeLessThanOrEqual(mark + 1);
      if (b.shortCount) expect(b.lo).toBeGreaterThanOrEqual(mark - 1);
    }
  });

  it('merges buckets when the size grows without losing notional', () => {
    const positions = all().filter((p) => p.market === 'BTC');
    const fine = bucketize(positions, 25);
    const coarse = bucketize(positions, 250);
    expect(coarse.length).toBeLessThanOrEqual(fine.length);
    const total = (bs: typeof fine) => bs.reduce((n, b) => n + b.longNotional + b.shortNotional, 0);
    expect(total(coarse)).toBeCloseTo(total(fine), 4);
  });

  it('is anchored at zero so one price always lands in one bucket', () => {
    const [one] = bucketize([{ bust: 2512.4, isLong: true, notionalUsd: 10_000 }], 5);
    const [alone] = bucketize([{ bust: 2512.4, isLong: false, notionalUsd: 1 }, { bust: 90, isLong: true, notionalUsd: 1 }], 5).filter((b) => b.shortCount);
    expect(one!.lo).toBe(2510);
    expect(alone!.lo).toBe(2510);
    expect(bucketIndex(2510, 5)).toBe(502);
  });

  it('rejects a non-positive bucket size', () => {
    expect(() => bucketize([], 0)).toThrow(RangeError);
  });
});
