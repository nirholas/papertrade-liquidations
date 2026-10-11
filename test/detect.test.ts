import { describe, expect, it } from 'vitest';
import type { ClosedPosition } from 'papertrade-sdk';
import { liquidationPriceRaw, wadToNumber } from 'papertrade-sdk';
import {
  PriceTape,
  classifyUpdate,
  crossedBust,
  eventFromProtocol,
  eventKey,
  removeEvents,
  resolveAgainstHistory,
  tally,
  upsertEvent,
  type LiquidationEvent,
} from '../src/detect.js';
import { trackPositions, type TrackedPosition } from '../src/positions.js';
import { instruments, liquidatedTrades, recentTrades, snapshots } from './fixtures.js';

const table = instruments();
const WALLET = '0x0000000000000000000000000000000000000001' as const;

/** Rebuild the tracked position a recorded trade row describes, with its bust price recomputed by the SDK. */
function positionFromTrade(t: ReturnType<typeof liquidatedTrades>[number]['items'][number], wallet: `0x${string}`): TrackedPosition {
  const inst = table.get(t.instrumentId)!;
  const entryRaw = BigInt(t.entryPriceRaw);
  const bustRaw = liquidationPriceRaw({ entryPriceRaw: entryRaw, leverage: t.leverage, isLong: t.isLong, bustBufferRaw: inst.bustBufferRaw });
  const marginUsd = wadToNumber(BigInt(t.marginRaw));
  return {
    wallet,
    positionId: t.positionId,
    market: inst.symbol,
    isLong: t.isLong,
    leverage: t.leverage,
    marginUsd,
    notionalUsd: marginUsd * t.leverage,
    entry: Number(entryRaw) / inst.priceScale,
    bust: Number(bustRaw) / inst.priceScale,
    bustRaw,
    apiBustRaw: bustRaw,
    bustMatches: true,
    openedAtMs: t.openedAtMs,
  };
}

const liquidatedRows = () => liquidatedTrades().flatMap((w) => w.items.filter((t) => t.kind === 'Liquidated').map((t) => ({ wallet: w.wallet as `0x${string}`, t })));

describe('recorded liquidations', () => {
  it('every recorded Liquidated row exited at or through its recomputed bust price', () => {
    const rows = liquidatedRows();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const { wallet, t } of rows) {
      const p = positionFromTrade(t, wallet);
      const exit = Number(t.exitPriceRaw) / table.get(t.instrumentId)!.priceScale;
      expect(crossedBust(p, { low: exit, high: exit }), `${t.symbol} ${t.positionId}`).toBe(true);
    }
  });

  it('confirms a vanished position from its Liquidated history row', () => {
    const { wallet, t } = liquidatedRows()[0]!;
    const history = liquidatedTrades().find((w) => w.wallet === wallet)!.items;
    const res = resolveAgainstHistory([positionFromTrade(t, wallet)], history, table);
    expect(res.notLiquidated).toEqual([]);
    expect(res.unresolved).toEqual([]);
    const [e] = res.confirmed;
    expect(e).toMatchObject({
      key: eventKey(t.symbol as 'BTC' | 'ETH', t.positionId),
      ts: t.timestampMs,
      isLong: t.isLong,
      leverage: t.leverage,
      source: 'history',
      confirmed: true,
    });
    expect(e!.marginUsd).toBeCloseTo(wadToNumber(BigInt(t.marginRaw)), 6);
    expect(e!.notionalUsd).toBeCloseTo(e!.marginUsd * t.leverage, 6);
    expect(e!.exit).toBe(Number(t.exitPriceRaw) / table.get(t.instrumentId)!.priceScale);
  });

  it('does not call an ordinary close a liquidation', () => {
    const wallet = liquidatedTrades()[0]!.wallet as `0x${string}`;
    const closed = liquidatedTrades()[0]!.items.find((t) => t.kind === 'PositionClosed')!;
    const res = resolveAgainstHistory([positionFromTrade(closed, wallet)], liquidatedTrades()[0]!.items, table);
    expect(res.confirmed).toEqual([]);
    expect(res.notLiquidated).toEqual([closed.positionId]);
  });

  it('leaves a position that is not in the history unresolved', () => {
    const { wallet, t } = liquidatedRows()[0]!;
    const res = resolveAgainstHistory([positionFromTrade(t, wallet)], [], table);
    expect(res.unresolved).toHaveLength(1);
    expect(res.confirmed).toEqual([]);
  });
});

describe('PriceTape', () => {
  it('reports the high and low of densely sampled prices', () => {
    const tape = new PriceTape();
    [100, 101, 99.5, 100.2].forEach((p, i) => tape.record('ETH', p, 1_000 + i * 5_000));
    expect(tape.extremes('ETH', 1_000, 16_000)).toEqual({ low: 99.5, high: 101 });
    expect(tape.extremes('ETH', 11_000, 16_000)).toEqual({ low: 99.5, high: 100.2 });
  });

  it('refuses to answer across a gap that could hide a wick', () => {
    const tape = new PriceTape(600_000, 20_000);
    tape.record('BTC', 100, 0);
    tape.record('BTC', 100, 60_000);
    expect(tape.extremes('BTC', 0, 60_000)).toBeNull();
    expect(tape.extremes('BTC', 50_000, 60_000)).toEqual({ low: 100, high: 100 });
  });

  it('refuses when sampling stopped before the window ended, and for unknown markets', () => {
    const tape = new PriceTape(600_000, 20_000);
    tape.record('BTC', 100, 0);
    expect(tape.extremes('BTC', 0, 40_000)).toBeNull();
    expect(tape.extremes('ETH', 0, 1)).toBeNull();
  });

  it('keeps markets apart and drops samples past the retention window', () => {
    const tape = new PriceTape(30_000, 20_000);
    tape.record('BTC', 1, 0);
    tape.record('ETH', 9, 5_000);
    tape.record('BTC', 2, 40_000);
    expect(tape.extremes('BTC', 0, 40_000)).toBeNull();
    expect(tape.extremes('ETH', 5_000, 5_000)).toEqual({ low: 9, high: 9 });
    tape.record('BTC', -5, 41_000);
    expect(tape.extremes('BTC', 40_000, 41_000)).toEqual({ low: 2, high: 2 });
  });
});

function recordedBook() {
  const snap = snapshots().find((s) => trackPositions(s.address, s.positions, table).positions.length >= 2)!;
  const positions = trackPositions(snap.address, snap.positions, table).positions;
  return { wallet: snap.address, positions, prev: new Map(positions.map((p) => [p.positionId, p])) };
}

const closedRow = (p: TrackedPosition, liquidated: boolean): ClosedPosition => ({
  positionId: BigInt(p.positionId),
  instrumentId: p.market === 'BTC' ? 0 : 1,
  isLong: p.isLong,
  marginRaw: BigInt(Math.round(p.marginUsd)) * 10n ** 18n,
  leverage: p.leverage,
  liquidated,
  netPnlRaw: 0n,
  paperMintedRaw: 0n,
});

describe('classifyUpdate on a recorded wallet book', () => {
  const NOW = 1_800_000_000_000;
  const never = () => null;

  it('reports nothing when no position vanished', () => {
    const { wallet, positions, prev } = recordedBook();
    const r = classifyUpdate({ wallet, prev, current: positions, closed: [], instruments: table, extremes: never, now: NOW });
    expect(r).toEqual({ events: [], verify: [] });
  });

  it('trusts closedPositions.liquidated and keeps the entry and bust it knew', () => {
    const { wallet, positions, prev } = recordedBook();
    const gone = positions[0]!;
    const r = classifyUpdate({ wallet, prev, current: positions.slice(1), closed: [closedRow(gone, true)], instruments: table, extremes: never, now: NOW });
    expect(r.verify).toEqual([]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ key: eventKey(gone.market, gone.positionId), source: 'stream', confirmed: true, entry: gone.entry, bust: gone.bust, isLong: gone.isLong, ts: NOW });
  });

  it('ignores a voluntary close even when price never came near', () => {
    const { wallet, positions, prev } = recordedBook();
    const gone = positions[0]!;
    const r = classifyUpdate({ wallet, prev, current: positions.slice(1), closed: [closedRow(gone, false)], instruments: table, extremes: never, now: NOW });
    expect(r).toEqual({ events: [], verify: [] });
  });

  it('infers a bust when the position vanished after the mark crossed its bust price, and queues it for verification', () => {
    const { wallet, positions, prev } = recordedBook();
    const gone = positions[0]!;
    const through = gone.isLong ? { low: gone.bust, high: gone.bust * 1.0001 } : { low: gone.bust * 0.9999, high: gone.bust };
    const r = classifyUpdate({ wallet, prev, current: positions.slice(1), closed: [], instruments: table, extremes: () => through, now: NOW });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ source: 'inferred', confirmed: false, positionId: gone.positionId });
    expect(r.verify.map((p) => p.positionId)).toEqual([gone.positionId]);
  });

  it('does not infer a bust when the mark stayed one tick short of it', () => {
    const { wallet, positions, prev } = recordedBook();
    const gone = positions[0]!;
    const short = gone.isLong ? { low: gone.bust + 0.1, high: gone.bust + 5 } : { low: gone.bust - 5, high: gone.bust - 0.1 };
    const r = classifyUpdate({ wallet, prev, current: positions.slice(1), closed: [], instruments: table, extremes: () => short, now: NOW });
    expect(r.events).toEqual([]);
    expect(r.verify).toEqual([]);
  });

  it('sends a vanished position to history verification when price coverage is unknown', () => {
    const { wallet, positions, prev } = recordedBook();
    const gone = positions[0]!;
    const r = classifyUpdate({ wallet, prev, current: positions.slice(1), closed: [], instruments: table, extremes: never, now: NOW });
    expect(r.events).toEqual([]);
    expect(r.verify.map((p) => p.positionId)).toEqual([gone.positionId]);
  });

  it('looks back only over the window in which the position was open', () => {
    const { wallet, positions, prev } = recordedBook();
    const gone = { ...positions[0]!, openedAtMs: NOW - 1_000 };
    const seen: number[] = [];
    classifyUpdate({ wallet, prev: new Map([[gone.positionId, gone]]), current: [], closed: [], instruments: table, extremes: (_m, since) => (seen.push(since), null), now: NOW });
    expect(seen).toEqual([NOW - 1_000]);
  });
});

describe('protocol feed events', () => {
  it('ignores the recorded opens and closes', () => {
    const events = recentTrades().events;
    expect(events.length).toBeGreaterThanOrEqual(50);
    expect(events.map(eventFromProtocol).filter(Boolean)).toEqual([]);
  });

  it('converts a liquidation record into a confirmed protocol event', () => {
    const base = recentTrades().events.find((e) => e.kind === 'close')!;
    const e = eventFromProtocol({ ...base, kind: 'liquidation' })!;
    expect(e).toMatchObject({ source: 'protocol', confirmed: true, market: base.instrument, notionalUsd: base.notionalUsd, positionId: base.positionId });
    expect(e.marginUsd).toBeCloseTo(base.notionalUsd / base.leverage, 6);
  });
});

describe('event list', () => {
  const mk = (over: Partial<LiquidationEvent>): LiquidationEvent => ({
    key: 'ETH:1',
    ts: 1_000,
    market: 'ETH',
    wallet: WALLET,
    positionId: '1',
    isLong: true,
    leverage: 1000,
    marginUsd: 10,
    notionalUsd: 10_000,
    entry: null,
    bust: 2_500,
    exit: null,
    source: 'inferred',
    confirmed: false,
    ...over,
  });

  it('upgrades a weaker source and never downgrades', () => {
    let list = upsertEvent([], mk({}));
    list = upsertEvent(list, mk({ source: 'stream', confirmed: true, ts: 3_000, entry: 2_510 }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ source: 'stream', confirmed: true, ts: 1_000, entry: 2_510, bust: 2_500 });
    const same = upsertEvent(list, mk({ source: 'inferred', ts: 500 }));
    expect(same).toBe(list);
    const final = upsertEvent(list, mk({ source: 'history', confirmed: true, ts: 2_000, exit: 2_499 }));
    expect(final[0]).toMatchObject({ source: 'history', ts: 2_000, exit: 2_499 });
  });

  it('keeps newest first and tallies count, notional and sides', () => {
    let list: LiquidationEvent[] = [];
    list = upsertEvent(list, mk({ key: 'ETH:1', ts: 1_000 }));
    list = upsertEvent(list, mk({ key: 'BTC:2', market: 'BTC', positionId: '2', ts: 5_000, isLong: false, notionalUsd: 50_000, marginUsd: 50, source: 'stream', confirmed: true }));
    expect(list.map((e) => e.key)).toEqual(['BTC:2', 'ETH:1']);
    expect(tally(list)).toEqual({ count: 2, notionalUsd: 60_000, marginUsd: 60, longs: 1, shorts: 1, unconfirmed: 1 });
    expect(tally([])).toEqual({ count: 0, notionalUsd: 0, marginUsd: 0, longs: 0, shorts: 0, unconfirmed: 0 });
  });

  it('retracts only unconfirmed inferred events', () => {
    const list = [mk({ key: 'ETH:1' }), mk({ key: 'ETH:2', positionId: '2', source: 'history', confirmed: true })];
    expect(removeEvents(list, 'ETH', ['1', '2']).map((e) => e.key)).toEqual(['ETH:2']);
  });
});
