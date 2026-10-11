import { describe, expect, it } from 'vitest';
import { liquidationPriceRaw } from 'papertrade-sdk';
import { DANGER_THRESHOLDS, dangerLabel, dangerLevel, distanceToBust, trackPositions } from '../src/positions.js';
import { instruments, snapshots } from './fixtures.js';

describe('trackPositions on recorded wallet snapshots', () => {
  it('recomputes every bust price and agrees with the API on all of them', () => {
    let seen = 0;
    let mismatches = 0;
    for (const s of snapshots()) {
      const r = trackPositions(s.address, s.positions, instruments());
      seen += r.positions.length;
      mismatches += r.mismatches;
      for (const p of r.positions) expect(p.bustRaw).toBe(p.apiBustRaw);
    }
    expect(seen).toBeGreaterThan(20);
    expect(mismatches).toBe(0);
  });

  it('counts a mismatch when the API value differs', () => {
    const s = snapshots().find((x) => x.positions.length > 0)!;
    const tampered = s.positions.map((p, i) => (i === 0 ? { ...p, bustPriceRaw: p.bustPriceRaw + 1n } : p));
    const r = trackPositions(s.address, tampered, instruments());
    expect(r.mismatches).toBe(1);
    expect(r.positions[0]!.bustMatches).toBe(false);
  });

  it('uses the SDK formula with the per-instrument buffer', () => {
    const s = snapshots().find((x) => x.positions.length > 0)!;
    const p = s.positions[0]!;
    const inst = instruments().get(p.instrumentId)!;
    const expected = liquidationPriceRaw({ entryPriceRaw: p.entryPriceRaw, leverage: p.leverage, isLong: p.isLong, bustBufferRaw: inst.bustBufferRaw });
    expect(trackPositions(s.address, [p], instruments()).positions[0]!.bustRaw).toBe(expected);
  });

  it('puts long busts below entry and short busts above', () => {
    for (const s of snapshots()) {
      for (const p of trackPositions(s.address, s.positions, instruments()).positions) {
        expect(p.isLong ? p.bust < p.entry : p.bust > p.entry).toBe(true);
        expect(p.notionalUsd).toBeCloseTo(p.marginUsd * p.leverage, 6);
      }
    }
  });
});

describe('distance and danger levels', () => {
  it('measures distance toward the bust side', () => {
    expect(distanceToBust({ isLong: true, bust: 99 }, 100)).toEqual({ fraction: 0.01, usd: 1 });
    expect(distanceToBust({ isLong: false, bust: 101 }, 100)).toEqual({ fraction: 0.01, usd: 1 });
    expect(distanceToBust({ isLong: true, bust: 101 }, 100).fraction).toBeLessThan(0);
  });

  it('maps fractions to levels at the documented thresholds', () => {
    const [critical, danger, watch] = DANGER_THRESHOLDS;
    expect(dangerLevel(critical!.maxFraction)).toBe(3);
    expect(dangerLevel(danger!.maxFraction)).toBe(2);
    expect(dangerLevel(watch!.maxFraction)).toBe(1);
    expect(dangerLevel(watch!.maxFraction * 1.001)).toBe(0);
    expect(dangerLevel(-0.001)).toBe(3);
    expect([0, 1, 2, 3].map((l) => dangerLabel(l as 0 | 1 | 2 | 3))).toEqual(['safe', 'watch', 'danger', 'critical']);
  });
});
