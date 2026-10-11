import { readFileSync } from 'node:fs';
import type { LiquidationMap } from 'papertrade-sdk';
import { describe, expect, it } from 'vitest';
import { rebin } from '../src/buckets.js';
import { collectIncremental } from '../src/collect.js';
import { assembleHeatmap, parseProtocolMap } from '../src/heatmap.js';
import { packSnapshot, pickStale, unpackSnapshot } from '../src/snapshots.js';
import { trackPositions } from '../src/positions.js';
import { fixture, instruments, snapshots } from './fixtures.js';

const mids = fixture<{ BTC: string; ETH: string }>('mids');
const map = (m: string) => parseProtocolMap(fixture<LiquidationMap>(`liquidation-map-${m}`));
const positions = () => snapshots().flatMap((s) => trackPositions(s.address, s.positions, instruments()).positions);

describe('parseProtocolMap', () => {
  it('converts the recorded BTC map to dollars with consistent totals', () => {
    const p = map('btc');
    expect(p.buckets.length).toBeGreaterThan(0);
    expect(p.toPrice).toBeGreaterThan(p.fromPrice);
    const sum = p.buckets.reduce((n, b) => n + b.longNotional + b.shortNotional, 0);
    expect(p.totalNotionalUsd).toBeCloseTo(sum + p.below.longNotional + p.below.shortNotional + p.above.longNotional + p.above.shortNotional, 2);
    for (const b of p.buckets) expect(b.hi - b.lo).toBeCloseTo(p.bucketUsd, 6);
  });
});

describe('rebin', () => {
  it('preserves total notional and count when regrouping', () => {
    const p = map('btc');
    const wide = rebin(p.buckets, p.bucketUsd * 4);
    const sum = (bs: typeof wide, k: 'longNotional' | 'shortNotional' | 'longCount' | 'shortCount') => bs.reduce((n, b) => n + b[k], 0);
    for (const k of ['longNotional', 'shortNotional', 'longCount', 'shortCount'] as const) expect(sum(wide, k)).toBeCloseTo(sum(p.buckets, k), 4);
    expect(wide.length).toBeLessThanOrEqual(p.buckets.length);
  });
  it('rejects a non-positive size', () => {
    expect(() => rebin([], 0)).toThrow(RangeError);
  });
});

describe('assembleHeatmap', () => {
  it('builds a coherent response from recorded snapshots', () => {
    const mark = Number(mids.BTC);
    const res = assembleHeatmap({
      market: 'BTC',
      mark,
      asOfMs: 1,
      positions: positions(),
      protocol: map('btc'),
      cascadeFraction: 0.01,
      diagnostics: { positions: positions().length, mismatches: 0, wallets: 8, failedWallets: 0 },
    });
    expect(res.market).toBe('BTC');
    expect(res.coverage.positions).toBe(positions().filter((p) => p.market === 'BTC').length);
    expect(res.nearest.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < res.nearest.length; i++) expect(res.nearest[i]!.distancePercent).toBeGreaterThanOrEqual(res.nearest[i - 1]!.distancePercent);
    expect(res.cascade).not.toBeNull();
    expect(res.freshness).toBeNull();
    expect(res.coverage.fraction === null || (res.coverage.fraction >= 0 && res.coverage.fraction <= 1)).toBe(true);
  });
});

describe('snapshots', () => {
  it('round-trips recorded positions through the JSON cache format', () => {
    for (const s of snapshots()) {
      const packed = JSON.parse(JSON.stringify(packSnapshot(s.address, s.positions, 5)));
      expect(unpackSnapshot(packed)).toEqual(s.positions);
    }
  });
  it('picks missing wallets first, then the stalest, and skips fresh ones', () => {
    const known = new Map([['0xa' as never, 900], ['0xb' as never, 100], ['0xc' as never, 990]]);
    const picked = pickStale(['0xa', '0xb', '0xc', '0xd'] as never[], known as never, 2, 1000, 50);
    expect(picked).toEqual(['0xd', '0xb']);
  });
  it('refreshes only a few wallets per call and reports staleness', async () => {
    const snaps = snapshots();
    const store = new Map<string, ReturnType<typeof packSnapshot>>();
    for (const s of snaps.slice(0, 3)) store.set(s.address, packSnapshot(s.address, s.positions, 1_000));
    const wallets = snaps.map((s) => s.address);
    const out = await collectIncremental(wallets, instruments(), {
      store: { get: async (w) => store.get(w) ?? null, put: async (s) => void store.set(s.wallet, s) },
      refreshPerCall: 0,
      minAgeMs: 0,
      now: 11_000,
    });
    expect(out.freshness.missing).toBe(wallets.length - 3);
    expect(out.freshness.oldestMs).toBe(10_000);
    expect(out.diagnostics.mismatches).toBe(0);
  });
});

describe('openapi.json', () => {
  const spec = JSON.parse(readFileSync(new URL('../site/public/openapi.json', import.meta.url), 'utf8'));
  it('documents /api/heatmap with the parameters the function accepts', () => {
    expect(spec.openapi).toMatch(/^3\.1/);
    const names = spec.paths['/api/heatmap'].get.parameters.map((p: { name: string }) => p.name).sort();
    expect(names).toEqual(['bucket', 'cascade', 'market', 'wallets']);
    expect(JSON.stringify(spec)).not.toMatch(new RegExp(String.fromCharCode(91, 0x2013, 0x2014, 93)));
  });
});
