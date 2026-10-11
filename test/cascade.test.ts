import { describe, expect, it } from 'vitest';
import { cascade, cascadeCurve, protocolCascade } from '../src/cascade.js';
import { parseProtocolMap } from '../src/heatmap.js';
import { trackPositions } from '../src/positions.js';
import { fixture, instruments, snapshots } from './fixtures.js';

const mids = fixture<{ BTC: string; ETH: string }>('mids');
const positions = () => snapshots().flatMap((s) => trackPositions(s.address, s.positions, instruments()).positions);

describe('cascade', () => {
  it('counts exactly the positions whose bust lies within the move', () => {
    for (const market of ['BTC', 'ETH'] as const) {
      const mark = Number(mids[market]);
      const ps = positions().filter((p) => p.market === market);
      const f = 0.01;
      const c = cascade(ps, mark, f);
      const longs = ps.filter((p) => p.isLong && p.bust >= mark * (1 - f));
      const shorts = ps.filter((p) => !p.isLong && p.bust <= mark * (1 + f));
      expect(c.down.count).toBe(longs.length);
      expect(c.up.count).toBe(shorts.length);
      expect(c.down.notional).toBeCloseTo(longs.reduce((n, p) => n + p.notionalUsd, 0), 4);
      expect(c.up.margin).toBeCloseTo(shorts.reduce((n, p) => n + p.marginUsd, 0), 4);
    }
  });

  it('is zero for a zero move unless a position is already through its bust', () => {
    const mark = Number(mids.ETH);
    const ps = positions().filter((p) => p.market === 'ETH' && (p.isLong ? p.bust < mark : p.bust > mark));
    const c = cascade(ps, mark, 0);
    expect(c.down.count + c.up.count).toBe(0);
  });

  it('grows monotonically with the move and the margin never exceeds the notional', () => {
    const mark = Number(mids.BTC);
    const ps = positions().filter((p) => p.market === 'BTC');
    const curve = cascadeCurve(ps, mark, 0.2, 30);
    expect(curve).toHaveLength(30);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.fraction).toBeGreaterThan(curve[i - 1]!.fraction);
      expect(curve[i]!.down.notional).toBeGreaterThanOrEqual(curve[i - 1]!.down.notional);
      expect(curve[i]!.up.notional).toBeGreaterThanOrEqual(curve[i - 1]!.up.notional);
    }
    for (const c of curve) {
      expect(c.down.margin).toBeLessThanOrEqual(c.down.notional);
      expect(c.up.margin).toBeLessThanOrEqual(c.up.notional);
    }
  });

  it('captures every position at a very large move', () => {
    const ps = positions().filter((p) => p.market === 'ETH');
    const c = cascade(ps, Number(mids.ETH), 1);
    expect(c.down.count).toBe(ps.filter((p) => p.isLong).length);
    expect(c.up.count).toBe(ps.filter((p) => !p.isLong).length);
  });

  it('rejects invalid inputs', () => {
    expect(() => cascade([], 0, 0.01)).toThrow(RangeError);
    expect(() => cascade([], 100, -1)).toThrow(RangeError);
  });
});

describe('protocolCascade on the recorded protocol map', () => {
  const map = () => parseProtocolMap(fixture('liquidation-map-eth'));

  it('sums whole buckets and prorates a partly covered one', () => {
    const m = map();
    const mark = Number(mids.ETH);
    const wide = protocolCascade(m, mark, 0.06);
    const sumLong = m.buckets.reduce((n, b) => n + b.longNotional, 0);
    const sumShort = m.buckets.reduce((n, b) => n + b.shortNotional, 0);
    expect(wide.down.notional).toBeCloseTo(sumLong, 3);
    expect(wide.up.notional).toBeCloseTo(sumShort, 3);
    expect(protocolCascade(m, mark, 0).down.notional).toBeLessThanOrEqual(wide.down.notional);
  });

  it('grows with the move', () => {
    const m = map();
    const mark = Number(mids.ETH);
    let prev = { down: 0, up: 0 };
    for (const f of [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025]) {
      const c = protocolCascade(m, mark, f);
      expect(c.down.notional).toBeGreaterThanOrEqual(prev.down);
      expect(c.up.notional).toBeGreaterThanOrEqual(prev.up);
      prev = { down: c.down.notional, up: c.up.notional };
    }
  });

  it('rejects invalid inputs', () => {
    expect(() => protocolCascade(map(), 0, 0.01)).toThrow(RangeError);
    expect(() => protocolCascade(map(), 1, -1)).toThrow(RangeError);
  });
});
