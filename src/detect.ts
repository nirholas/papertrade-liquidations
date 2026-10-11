import type { Address } from 'viem';
import type { AccountTrade, ClosedPosition, RecentTradeEvent } from 'papertrade-sdk';
import { wadToNumber } from 'papertrade-sdk';
import type { InstrumentTable, MarketSymbol } from './markets.js';
import { marketById } from './markets.js';
import type { TrackedPosition } from './positions.js';

/**
 * How a liquidation was learned.
 * - stream: a followed wallet's live stream reported `closedPositions` with liquidated=true.
 * - history: the wallet's trade history lists the position with kind `Liquidated`.
 * - protocol: the protocol-wide recent trades feed reported a liquidation.
 * - inferred: a tracked position vanished while the mark crossed its bust price (not yet confirmed by the API).
 */
export type EventSource = 'stream' | 'history' | 'protocol' | 'inferred';

export interface LiquidationEvent {
  /** `${market}:${positionId}`. Unique per liquidation. */
  key: string;
  ts: number;
  market: MarketSymbol;
  wallet: Address;
  positionId: string;
  isLong: boolean;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  entry: number | null;
  bust: number | null;
  exit: number | null;
  source: EventSource;
  /** False only for `inferred` events. */
  confirmed: boolean;
}

export const eventKey = (market: MarketSymbol, positionId: string) => `${market}:${positionId}`;

export interface PriceExtremes {
  low: number;
  high: number;
}

/** A long busts when price falls to its bust price; a short busts when price rises to it. */
export function crossedBust(p: Pick<TrackedPosition, 'isLong' | 'bust'>, ex: PriceExtremes): boolean {
  return p.isLong ? ex.low <= p.bust : ex.high >= p.bust;
}

/** A rolling record of mark samples per market, used to learn how far price travelled since a position was last seen. */
export class PriceTape {
  private readonly samples = new Map<MarketSymbol, { ts: number; price: number }[]>();

  constructor(private readonly retainMs = 10 * 60_000, private readonly maxGapMs = 20_000) {}

  record(market: MarketSymbol, price: number, ts = Date.now()): void {
    if (!(price > 0)) return;
    let list = this.samples.get(market);
    if (!list) this.samples.set(market, (list = []));
    list.push({ ts, price });
    const cutoff = ts - this.retainMs;
    let drop = 0;
    while (drop < list.length && list[drop]!.ts < cutoff) drop++;
    if (drop) list.splice(0, drop);
  }

  /**
   * High and low over [sinceMs, untilMs]. Returns null when the window is not sampled densely enough to trust:
   * a gap longer than `maxGapMs` could hide a wick, so the caller must verify against the API instead.
   */
  extremes(market: MarketSymbol, sinceMs: number, untilMs: number): PriceExtremes | null {
    const list = this.samples.get(market);
    if (!list?.length) return null;
    let low = Infinity;
    let high = -Infinity;
    let prevTs = sinceMs;
    let seen = false;
    for (const s of list) {
      if (s.ts < sinceMs) continue;
      if (s.ts > untilMs) break;
      if (s.ts - prevTs > this.maxGapMs) return null;
      prevTs = s.ts;
      low = Math.min(low, s.price);
      high = Math.max(high, s.price);
      seen = true;
    }
    if (!seen || untilMs - prevTs > this.maxGapMs) return null;
    return { low, high };
  }
}

export interface ClassifyInput {
  wallet: Address;
  prev: ReadonlyMap<string, TrackedPosition>;
  current: readonly TrackedPosition[];
  /** `closedPositions` from the stream patch that produced `current` (empty for a snapshot). */
  closed: readonly ClosedPosition[];
  instruments: InstrumentTable;
  /** Price travel for a market over the window in which the position could have busted, or null when unknown. */
  extremes: (market: MarketSymbol, sinceMs: number) => PriceExtremes | null;
  now: number;
  /** How long before `now` a bust could have happened and still be reported now. Default 45 s. */
  lookbackMs?: number;
}

export interface Classification {
  events: LiquidationEvent[];
  /** Vanished positions that need the wallet's trade history to settle whether they were liquidated. */
  verify: TrackedPosition[];
}

/**
 * Decide which vanished positions were liquidations.
 * `closedPositions.liquidated` is authoritative. A vanished position with no stream verdict is a liquidation only if
 * the mark crossed its bust price while it was open, and is queued for confirmation against the trade history.
 */
export function classifyUpdate(input: ClassifyInput): Classification {
  const { wallet, prev, current, closed, instruments, extremes, now } = input;
  const lookback = input.lookbackMs ?? 45_000;
  const events: LiquidationEvent[] = [];
  const verify: TrackedPosition[] = [];
  const closedById = new Map(closed.map((c) => [c.positionId.toString(), c]));
  const alive = new Set(current.map((p) => p.positionId));

  for (const c of closed) {
    if (!c.liquidated) continue;
    const inst = instruments.get(c.instrumentId);
    if (!inst) continue;
    const id = c.positionId.toString();
    const known = prev.get(id);
    const marginUsd = wadToNumber(c.marginRaw);
    events.push({
      key: eventKey(inst.symbol, id),
      ts: now,
      market: inst.symbol,
      wallet,
      positionId: id,
      isLong: c.isLong,
      leverage: c.leverage,
      marginUsd,
      notionalUsd: marginUsd * c.leverage,
      entry: known?.entry ?? null,
      bust: known?.bust ?? null,
      exit: null,
      source: 'stream',
      confirmed: true,
    });
  }

  for (const [id, p] of prev) {
    if (alive.has(id) || closedById.has(id)) continue;
    const ex = extremes(p.market, Math.max(now - lookback, p.openedAtMs));
    if (!ex) {
      verify.push(p);
      continue;
    }
    if (!crossedBust(p, ex)) continue;
    events.push({
      key: eventKey(p.market, id),
      ts: now,
      market: p.market,
      wallet,
      positionId: id,
      isLong: p.isLong,
      leverage: p.leverage,
      marginUsd: p.marginUsd,
      notionalUsd: p.notionalUsd,
      entry: p.entry,
      bust: p.bust,
      exit: null,
      source: 'inferred',
      confirmed: false,
    });
    verify.push(p);
  }
  return { events, verify };
}

export interface Resolution {
  confirmed: LiquidationEvent[];
  /** Positions the history shows as ordinary closes. Drop any inferred event for these. */
  notLiquidated: string[];
  /** Positions not (yet) in the history. Try again later. */
  unresolved: TrackedPosition[];
}

/** Settle vanished positions against a page of the wallet's trade history, which is the API's own record. */
export function resolveAgainstHistory(pending: readonly TrackedPosition[], trades: readonly AccountTrade[], instruments: InstrumentTable): Resolution {
  const byId = new Map(trades.map((t) => [t.positionId, t]));
  const out: Resolution = { confirmed: [], notLiquidated: [], unresolved: [] };
  for (const p of pending) {
    const t = byId.get(p.positionId);
    if (!t) {
      out.unresolved.push(p);
      continue;
    }
    if (t.kind !== 'Liquidated') {
      out.notLiquidated.push(p.positionId);
      continue;
    }
    const event = eventFromTrade(p.wallet, t, instruments, p.bust);
    if (event) out.confirmed.push(event);
  }
  return out;
}

/** The liquidation a trade-history row records, or null for any other kind of row or a market this app does not chart. */
export function eventFromTrade(wallet: Address, t: AccountTrade, instruments: InstrumentTable, bust: number | null = null): LiquidationEvent | null {
  if (t.kind !== 'Liquidated') return null;
  const inst = instruments.get(t.instrumentId);
  if (!inst) return null;
  const marginUsd = wadToNumber(t.marginRaw);
  return {
    key: eventKey(inst.symbol, t.positionId),
    ts: t.timestampMs,
    market: inst.symbol,
    wallet,
    positionId: t.positionId,
    isLong: t.isLong,
    leverage: t.leverage,
    marginUsd,
    notionalUsd: marginUsd * t.leverage,
    entry: Number(t.entryPriceRaw) / inst.priceScale,
    bust,
    exit: Number(t.exitPriceRaw) / inst.priceScale,
    source: 'history',
    confirmed: true,
  };
}

/** A liquidation reported by the protocol-wide recent trades feed, or null for opens and ordinary closes. */
export function eventFromProtocol(e: RecentTradeEvent): LiquidationEvent | null {
  if (!/liquidat/i.test(e.kind)) return null;
  const market = marketById(e.instrumentId)?.symbol;
  if (!market) return null;
  return {
    key: eventKey(market, e.positionId),
    ts: e.ts,
    market,
    wallet: e.wallet,
    positionId: e.positionId,
    isLong: e.side === 'long',
    leverage: e.leverage,
    marginUsd: e.notionalUsd / e.leverage,
    notionalUsd: e.notionalUsd,
    entry: e.entry,
    bust: null,
    exit: e.exit,
    source: 'protocol',
    confirmed: true,
  };
}

const RANK: Record<EventSource, number> = { inferred: 0, protocol: 1, stream: 2, history: 3 };

/** Insert or upgrade an event, newest first. A better-sourced duplicate replaces a weaker one and keeps the earlier detection time. */
export function upsertEvent(list: LiquidationEvent[], incoming: LiquidationEvent): LiquidationEvent[] {
  const idx = list.findIndex((e) => e.key === incoming.key);
  if (idx < 0) return [incoming, ...list].sort((a, b) => b.ts - a.ts);
  const existing = list[idx]!;
  if (RANK[incoming.source] < RANK[existing.source]) return list;
  const merged: LiquidationEvent = {
    ...existing,
    ...incoming,
    ts: incoming.source === 'history' ? incoming.ts : Math.min(existing.ts, incoming.ts),
    entry: incoming.entry ?? existing.entry,
    bust: incoming.bust ?? existing.bust,
  };
  const next = list.slice();
  next[idx] = merged;
  return next.sort((a, b) => b.ts - a.ts);
}

export function removeEvents(list: LiquidationEvent[], market: MarketSymbol, positionIds: readonly string[]): LiquidationEvent[] {
  const drop = new Set(positionIds.map((id) => eventKey(market, id)));
  return list.filter((e) => e.confirmed || !drop.has(e.key));
}

export interface Tally {
  count: number;
  notionalUsd: number;
  marginUsd: number;
  longs: number;
  shorts: number;
  unconfirmed: number;
}

export function tally(events: readonly LiquidationEvent[]): Tally {
  const t: Tally = { count: 0, notionalUsd: 0, marginUsd: 0, longs: 0, shorts: 0, unconfirmed: 0 };
  for (const e of events) {
    t.count++;
    t.notionalUsd += e.notionalUsd;
    t.marginUsd += e.marginUsd;
    if (e.isLong) t.longs++;
    else t.shorts++;
    if (!e.confirmed) t.unconfirmed++;
  }
  return t;
}
