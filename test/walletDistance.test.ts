import { describe, expect, it } from 'vitest';
import { trackPositions } from '../src/positions.js';
import { walletDistance } from '../src/walletDistance.js';
import { fixture, instruments, snapshots } from './fixtures.js';

const mids = fixture<{ BTC: string; ETH: string }>('mids');
const marks = { BTC: Number(mids.BTC), ETH: Number(mids.ETH) };

describe('walletDistance', () => {
  const snap = snapshots().find((s) => s.positions.length > 1)!;
  const tracked = trackPositions(snap.address, snap.positions, instruments()).positions;
  const d = walletDistance(snap.address, tracked, marks);
  it('lists every position closest first with consistent totals', () => {
    expect(d.positions).toHaveLength(tracked.length);
    for (let i = 1; i < d.positions.length; i++) expect(d.positions[i]!.distancePercent).toBeGreaterThanOrEqual(d.positions[i - 1]!.distancePercent);
    expect(d.closest).toBe(d.positions[0]);
    expect(d.totalNotionalUsd).toBeCloseTo(tracked.reduce((n, p) => n + p.notionalUsd, 0), 4);
  });
  it('measures from the live mark of the position market and labels danger', () => {
    for (const p of d.positions) {
      expect(p.markPrice).toBe(marks[p.market]);
      const expected = p.side === 'long' ? (p.markPrice - p.bust) / p.markPrice : (p.bust - p.markPrice) / p.markPrice;
      expect(p.distancePercent).toBeCloseTo(expected * 100, 8);
      expect(p.throughBust).toBe(p.distanceUsd <= 0);
    }
  });
  it('flags a position that is through its bust price as critical', () => {
    const through = walletDistance(snap.address, tracked, { BTC: marks.BTC * 3, ETH: marks.ETH * 3 });
    expect(through.positions.some((p) => p.throughBust && p.danger === 'critical')).toBe(true);
  });
  it('handles a wallet with no positions', () => {
    expect(walletDistance(snap.address, [], marks)).toMatchObject({ positions: [], closest: null, totalNotionalUsd: 0 });
  });
});
