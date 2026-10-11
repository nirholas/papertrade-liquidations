import type { Address } from 'viem';
import type { PapertradeClient, WalletState } from 'papertrade-sdk';
import { fetchWalletState, streamWallet } from 'papertrade-sdk';
import { PriceTape, classifyUpdate, resolveAgainstHistory, type LiquidationEvent } from '../detect.js';
import type { InstrumentTable } from '../markets.js';
import { trackPositions, type TrackedPosition } from '../positions.js';
import type { LimitedFetch } from './limiter.js';

export interface FollowedWallet {
  address: Address;
  openNotionalUsd: number;
}

export type WalletMode = 'live' | 'sweep';
export type WalletStatus = 'pending' | 'ok' | 'failed';

interface Entry extends FollowedWallet {
  mode: WalletMode;
  status: WalletStatus;
  loaded: boolean;
  seenAt: number;
  positions: Map<string, TrackedPosition>;
  mismatches: number;
  stop?: () => void;
}

export interface TrackerCallbacks {
  /** Positions or diagnostics changed. */
  onChange: () => void;
  /** Liquidations learned (or upgraded to a better source). */
  onLiquidations: (events: LiquidationEvent[]) => void;
  /** Inferred busts that the API history shows were ordinary closes. */
  onRetract: (market: 'BTC' | 'ETH', positionIds: string[]) => void;
}

export interface TrackerOptions extends TrackerCallbacks {
  /** Origin that serves /state/user/live with CORS open. */
  streamBase: string;
  /** Client for REST reads (same-origin proxy: the REST endpoints send no CORS headers). */
  client: PapertradeClient;
  instruments: InstrumentTable;
  tape: PriceTape;
  limited: LimitedFetch;
  /** Wallets held on a permanent stream. The rest are refreshed by rotating snapshots. */
  liveSlots?: number;
  sweepIntervalMs?: number;
}

export interface TrackerStats {
  wallets: number;
  live: number;
  sweeping: number;
  loaded: number;
  failed: number;
  positions: number;
  mismatches: number;
  verifying: number;
  lastUpdateMs: number;
}

interface Pending {
  positions: Map<string, TrackedPosition>;
  attempts: number;
  nextAt: number;
}

const VERIFY_DELAYS_MS = [4_000, 10_000, 20_000, 40_000, 90_000];

/**
 * Follows the largest open-position holders and reports when their positions disappear because of a liquidation.
 * The first `liveSlots` wallets hold a live stream; the rest are re-read one at a time in rotation, because the
 * exchange rate limits new stream connections.
 */
export class Tracker {
  private readonly wallets = new Map<Address, Entry>();
  private readonly pending = new Map<Address, Pending>();
  private readonly ctrl = new AbortController();
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private verifyTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private lastUpdateMs = 0;

  constructor(private readonly opts: TrackerOptions) {}

  setWallets(followed: readonly FollowedWallet[]): void {
    const keep = new Set(followed.map((w) => w.address));
    for (const [addr, e] of this.wallets) {
      if (!keep.has(addr)) {
        e.stop?.();
        this.wallets.delete(addr);
      }
    }
    const liveSlots = this.opts.liveSlots ?? 6;
    followed.forEach((w, i) => {
      const mode: WalletMode = i < liveSlots ? 'live' : 'sweep';
      const existing = this.wallets.get(w.address);
      if (existing) {
        existing.openNotionalUsd = w.openNotionalUsd;
        if (existing.mode !== mode) {
          existing.stop?.();
          existing.stop = undefined;
          existing.mode = mode;
        }
        return;
      }
      this.wallets.set(w.address, { ...w, mode, status: 'pending', loaded: false, seenAt: 0, positions: new Map(), mismatches: 0 });
    });
    if (this.running) this.connectLive();
    this.opts.onChange();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connectLive();
    this.scheduleSweep(0);
    this.scheduleVerify();
  }

  /** Close every stream and timer. Positions are kept, so resuming reconciles against what vanished meanwhile. */
  pause(): void {
    this.running = false;
    clearTimeout(this.sweepTimer);
    clearTimeout(this.verifyTimer);
    for (const e of this.wallets.values()) {
      e.stop?.();
      e.stop = undefined;
    }
  }

  resume(): void {
    this.start();
  }

  destroy(): void {
    this.pause();
    this.ctrl.abort();
    this.wallets.clear();
  }

  positions(): TrackedPosition[] {
    const out: TrackedPosition[] = [];
    for (const e of this.wallets.values()) out.push(...e.positions.values());
    return out;
  }

  stats(): TrackerStats {
    let live = 0;
    let sweeping = 0;
    let loaded = 0;
    let failed = 0;
    let positions = 0;
    let mismatches = 0;
    for (const e of this.wallets.values()) {
      if (e.mode === 'live') live++;
      else sweeping++;
      if (e.loaded) loaded++;
      if (e.status === 'failed') failed++;
      positions += e.positions.size;
      mismatches += e.mismatches;
    }
    return { wallets: this.wallets.size, live, sweeping, loaded, failed, positions, mismatches, verifying: this.pending.size, lastUpdateMs: this.lastUpdateMs };
  }

  private connectLive(): void {
    for (const e of this.wallets.values()) {
      if (e.mode !== 'live' || e.stop) continue;
      e.stop = streamWallet({
        wallet: e.address,
        baseUrl: this.opts.streamBase,
        fetch: this.opts.limited,
        signal: this.ctrl.signal,
        onState: (state, kind) => this.apply(e, state, kind),
        onStatus: (status) => {
          if (status === 'reconnecting' && !e.loaded) e.status = 'failed';
          this.opts.onChange();
        },
      });
    }
  }

  private scheduleSweep(delayMs: number): void {
    clearTimeout(this.sweepTimer);
    if (!this.running) return;
    this.sweepTimer = setTimeout(() => void this.sweepOne(), delayMs);
  }

  private async sweepOne(): Promise<void> {
    const sweepers = [...this.wallets.values()].filter((e) => e.mode === 'sweep');
    const interval = this.opts.sweepIntervalMs ?? 30_000;
    if (!this.running || sweepers.length === 0) return this.scheduleSweep(interval);
    // Wallets never read come first; after that the least recently read.
    const target = sweepers.sort((a, b) => a.seenAt - b.seenAt)[0]!;
    try {
      const state = await fetchWalletState(target.address, {
        baseUrl: this.opts.streamBase,
        fetch: this.opts.limited,
        timeoutMs: 20_000,
        signal: this.ctrl.signal,
      });
      this.apply(target, state, 'snapshot');
    } catch {
      if (this.ctrl.signal.aborted) return;
      target.status = target.loaded ? 'ok' : 'failed';
      target.seenAt = Date.now();
      this.opts.onChange();
    }
    this.scheduleSweep(interval);
  }

  private apply(entry: Entry, state: WalletState, kind: 'snapshot' | 'update'): void {
    const now = Date.now();
    const tracked = trackPositions(entry.address, state.positions, this.opts.instruments);
    const current = tracked.positions;
    if (entry.loaded) {
      const lookbackMs = Math.max(15_000, now - entry.seenAt + 5_000);
      const { events, verify } = classifyUpdate({
        wallet: entry.address,
        prev: entry.positions,
        current,
        closed: kind === 'update' ? state.closedPositions : [],
        instruments: this.opts.instruments,
        extremes: (market, since) => this.opts.tape.extremes(market, since, now),
        now,
        lookbackMs,
      });
      if (events.length) this.opts.onLiquidations(events);
      if (verify.length) this.queueVerify(entry.address, verify);
    }
    entry.positions = new Map(current.map((p) => [p.positionId, p]));
    entry.mismatches = tracked.mismatches;
    entry.loaded = true;
    entry.status = 'ok';
    entry.seenAt = now;
    this.lastUpdateMs = now;
    this.opts.onChange();
  }

  private queueVerify(wallet: Address, positions: readonly TrackedPosition[]): void {
    const existing = this.pending.get(wallet) ?? { positions: new Map<string, TrackedPosition>(), attempts: 0, nextAt: 0 };
    for (const p of positions) existing.positions.set(p.positionId, p);
    existing.nextAt = Date.now() + VERIFY_DELAYS_MS[0]!;
    existing.attempts = 0;
    this.pending.set(wallet, existing);
    this.scheduleVerify();
  }

  private scheduleVerify(): void {
    clearTimeout(this.verifyTimer);
    if (!this.running || this.pending.size === 0) return;
    const next = Math.min(...[...this.pending.values()].map((p) => p.nextAt));
    this.verifyTimer = setTimeout(() => void this.verifyDue(), Math.max(250, next - Date.now()));
  }

  private async verifyDue(): Promise<void> {
    const due = [...this.pending.entries()].filter(([, p]) => p.nextAt <= Date.now());
    for (const [wallet, p] of due) {
      try {
        const page = await this.opts.client.accountTrades(wallet, { filter: 'all' }, this.ctrl.signal);
        const res = resolveAgainstHistory([...p.positions.values()], page.items, this.opts.instruments);
        if (res.confirmed.length) this.opts.onLiquidations(res.confirmed);
        for (const id of res.notLiquidated) {
          const pos = p.positions.get(id);
          if (pos) this.opts.onRetract(pos.market, [id]);
        }
        const settled = new Set([...res.confirmed.map((e) => e.positionId), ...res.notLiquidated]);
        for (const id of settled) p.positions.delete(id);
      } catch {
        if (this.ctrl.signal.aborted) return;
      }
      p.attempts++;
      const delay = VERIFY_DELAYS_MS[p.attempts];
      if (p.positions.size === 0 || delay === undefined) this.pending.delete(wallet);
      else p.nextAt = Date.now() + delay;
    }
    this.opts.onChange();
    this.scheduleVerify();
  }
}
