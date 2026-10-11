import type { Address } from 'viem';
import type { PapertradeClient } from 'papertrade-sdk';
import { fetchWalletState } from 'papertrade-sdk';
import type { InstrumentTable } from './markets.js';
import { packSnapshot, pickStale, unpackSnapshot, type PackedSnapshot } from './snapshots.js';
import { trackPositions, type Diagnostics, type TrackedPosition } from './positions.js';

export const MAX_TRACKED_WALLETS = 100;

/** The wallets holding the most open notional, from the leaderboard. The API serves at most 100 per page. */
export async function topWallets(client: PapertradeClient, count: number, signal?: AbortSignal): Promise<{ address: Address; openPositions: number; openNotionalUsd: number }[]> {
  const size = Math.min(MAX_TRACKED_WALLETS, Math.max(1, Math.floor(count)));
  // The leaderboard page index is 0-based; the SDK's default of 1 would skip the biggest holders.
  const board = await client.leaderboard({ window: '24h', sortKey: 'currentOpenNotional', sortDir: 'desc', page: 0, pageSize: size }, signal);
  return board.accounts
    .filter((a) => a.currentOpenPositionCount > 0)
    .map((a) => ({ address: a.address.toLowerCase() as Address, openPositions: a.currentOpenPositionCount, openNotionalUsd: Number(a.currentOpenNotional) / 1e18 }));
}

export interface CollectOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  concurrency?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface Collected {
  positions: TrackedPosition[];
  diagnostics: Diagnostics & { failedWallets: number };
}

/** Fetch each wallet's first live snapshot and recompute every bust price. Wallets that fail are counted, not hidden. */
export async function collectPositions(wallets: readonly Address[], instruments: InstrumentTable, options: CollectOptions = {}): Promise<Collected> {
  const positions: TrackedPosition[] = [];
  let mismatches = 0;
  let failedWallets = 0;
  let next = 0;
  const worker = async () => {
    while (next < wallets.length) {
      const wallet = wallets[next++]!;
      try {
        const state = await fetchWalletState(wallet, {
          baseUrl: options.baseUrl,
          fetch: options.fetch,
          timeoutMs: options.timeoutMs ?? 8000,
          signal: options.signal,
        });
        const tracked = trackPositions(wallet, state.positions, instruments);
        positions.push(...tracked.positions);
        mismatches += tracked.mismatches;
      } catch {
        failedWallets++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? 8, wallets.length) }, worker));
  return { positions, diagnostics: { positions: positions.length, mismatches, wallets: wallets.length - failedWallets, failedWallets } };
}

export interface SnapshotStore {
  get(wallet: Address): Promise<PackedSnapshot | null>;
  put(snapshot: PackedSnapshot): Promise<void>;
}

export interface IncrementalOptions extends CollectOptions {
  store: SnapshotStore;
  /** Wallets to re-read from the API per call. */
  refreshPerCall: number;
  /** Snapshots newer than this are not re-read. */
  minAgeMs: number;
  now?: number;
}

export interface IncrementalCollected extends Collected {
  freshness: { refreshed: number; cached: number; missing: number; oldestMs: number | null; newestMs: number | null };
}

/**
 * Build positions from cached per-wallet snapshots, re-reading only the few stalest wallets each call. The stream
 * endpoint allows roughly a dozen new connections a minute per IP, so a full re-read on every request is not possible.
 */
export async function collectIncremental(wallets: readonly Address[], instruments: InstrumentTable, options: IncrementalOptions): Promise<IncrementalCollected> {
  const now = options.now ?? Date.now();
  const stored = await Promise.all(wallets.map((w) => options.store.get(w)));
  const known = new Map<Address, number>();
  const snaps = new Map<Address, PackedSnapshot>();
  stored.forEach((s, i) => {
    if (s) {
      known.set(wallets[i]!, s.takenAtMs);
      snaps.set(wallets[i]!, s);
    }
  });
  const due = pickStale(wallets, known, options.refreshPerCall, now, options.minAgeMs);
  let refreshed = 0;
  let failedWallets = 0;
  for (const wallet of due) {
    try {
      const state = await fetchWalletState(wallet, { baseUrl: options.baseUrl, fetch: options.fetch, timeoutMs: options.timeoutMs ?? 8000, signal: options.signal });
      const snap = packSnapshot(wallet, state.positions, now);
      snaps.set(wallet, snap);
      await options.store.put(snap);
      refreshed++;
    } catch {
      failedWallets++;
      break;
    }
  }
  const positions: TrackedPosition[] = [];
  let mismatches = 0;
  let missing = 0;
  const ages: number[] = [];
  for (const wallet of wallets) {
    const snap = snaps.get(wallet);
    if (!snap) {
      missing++;
      continue;
    }
    ages.push(snap.takenAtMs);
    const tracked = trackPositions(wallet, unpackSnapshot(snap), instruments);
    positions.push(...tracked.positions);
    mismatches += tracked.mismatches;
  }
  const loaded = wallets.length - missing;
  return {
    positions,
    diagnostics: { positions: positions.length, mismatches, wallets: loaded, failedWallets: failedWallets + missing },
    freshness: { refreshed, cached: loaded - refreshed, missing, oldestMs: ages.length ? now - Math.min(...ages) : null, newestMs: ages.length ? now - Math.max(...ages) : null },
  };
}
