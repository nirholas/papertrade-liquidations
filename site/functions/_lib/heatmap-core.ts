/**
 * Shared heatmap loader used by `GET /api/heatmap` and the MCP tools. It owns the Cache API layout (10 s response
 * cache, 30 min per-wallet snapshots) so both surfaces warm each other and never double the upstream traffic.
 */
import type { Address } from 'viem';
import { PapertradeClient, fetchWalletState } from 'papertrade-sdk';
import { collectIncremental, topWallets, type SnapshotStore } from '../../../src/collect.js';
import { assembleHeatmap, parseProtocolMap, type HeatmapResponse } from '../../../src/heatmap.js';
import { instrumentTable, type MarketInfo } from '../../../src/markets.js';
import { fetchMids } from '../../../src/mids.js';
import { packSnapshot, unpackSnapshot, type PackedSnapshot } from '../../../src/snapshots.js';
import { trackPositions } from '../../../src/positions.js';

export interface HeatmapEnv {
  PAPERTRADE_API_URL?: string;
  HEATMAP_MAX_WALLETS?: string;
  /** How long a single wallet read waits for the stream snapshot, in ms (default 8000). */
  WALLET_STREAM_TIMEOUT_MS?: string;
}

export const UPSTREAM = 'https://exchange.papertrade.xyz';
export const DEFAULT_WALLETS = 40;
export const FREE_PLAN_WALLETS = 44;
export const CACHE_SECONDS = 10;
const SNAPSHOT_TTL_SECONDS = 1800;
const REFRESH_PER_CALL = 6;
export const SNAPSHOT_MIN_AGE_MS = 20_000;

/** The Workers default cache. Typed through a cast so this module also compiles under the DOM lib used by the tests. */
export const defaultCache = (): Cache => (caches as unknown as { default: Cache }).default;

export const maxWalletsFor = (env: HeatmapEnv) => Math.min(100, Math.max(1, Number(env.HEATMAP_MAX_WALLETS) || FREE_PLAN_WALLETS));
export const baseUrlFor = (env: HeatmapEnv) => (env.PAPERTRADE_API_URL ?? UPSTREAM).replace(/\/+$/, '');

/** Per-wallet snapshots live in the Cache API under a synthetic URL on this origin. */
export function snapshotStore(cache: Cache, origin: string, waitUntil: (p: Promise<unknown>) => void): SnapshotStore {
  const key = (wallet: string) => new Request(`${origin}/__snapshot/${wallet}`, { method: 'GET' });
  return {
    async get(wallet) {
      const hit = await cache.match(key(wallet));
      return hit ? ((await hit.json()) as PackedSnapshot) : null;
    },
    async put(snapshot) {
      const res = new Response(JSON.stringify(snapshot), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${SNAPSHOT_TTL_SECONDS}` } });
      waitUntil(cache.put(key(snapshot.wallet), res));
    },
  };
}

export interface HeatmapRequest {
  env: HeatmapEnv;
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
  market: MarketInfo;
  bucket?: number;
  wallets?: number;
  cascadePercent?: number;
}

export class HeatmapError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const serialize = (body: unknown) => JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** Load the heatmap, from cache when a fresh copy exists. `cached` tells the caller which. */
export async function loadHeatmap(req: HeatmapRequest): Promise<{ body: HeatmapResponse; cached: boolean }> {
  const maxWallets = maxWalletsFor(req.env);
  const walletCount = Math.floor(req.wallets ?? Math.min(DEFAULT_WALLETS, maxWallets));
  const normalized = new URL(`${req.origin}/api/heatmap`);
  normalized.searchParams.set('market', req.market.symbol);
  if (req.bucket !== undefined) normalized.searchParams.set('bucket', String(req.bucket));
  normalized.searchParams.set('wallets', String(walletCount));
  if (req.cascadePercent !== undefined) normalized.searchParams.set('cascade', String(req.cascadePercent));

  const cache = defaultCache();
  const cacheKey = new Request(normalized.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return { body: (await hit.json()) as HeatmapResponse, cached: true };

  const baseUrl = baseUrlFor(req.env);
  const client = new PapertradeClient({ baseUrl });
  try {
    const [trading, mids, rawMap, leaders] = await Promise.all([
      client.tradingState(),
      fetchMids(),
      client.liquidationMap(req.market.id, '5'),
      topWallets(client, walletCount),
    ]);
    const instruments = instrumentTable(trading.instruments);
    const collected = await collectIncremental(
      leaders.map((l) => l.address),
      instruments,
      { baseUrl, store: snapshotStore(cache, req.origin, req.waitUntil), refreshPerCall: REFRESH_PER_CALL, minAgeMs: SNAPSHOT_MIN_AGE_MS },
    );
    if (collected.diagnostics.wallets === 0 && leaders.length > 0) {
      throw new HeatmapError(502, 'warming_up', 'No wallet snapshots are cached yet and the Papertrade stream endpoint is rate limited. Retry in a minute.');
    }
    const body = assembleHeatmap({
      market: req.market.symbol,
      mark: mids[req.market.symbol],
      asOfMs: Date.now(),
      bucketUsd: req.bucket,
      positions: collected.positions,
      protocol: parseProtocolMap(rawMap),
      cascadeFraction: req.cascadePercent === undefined ? undefined : req.cascadePercent / 100,
      diagnostics: collected.diagnostics,
      freshness: collected.freshness,
    });
    const res = new Response(serialize(body), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${CACHE_SECONDS}` } });
    req.waitUntil(cache.put(cacheKey, res.clone()));
    return { body, cached: false };
  } catch (err) {
    if (err instanceof HeatmapError) throw err;
    throw new HeatmapError(502, 'upstream_error', `Could not build the heatmap: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface TrackedRequest {
  env: HeatmapEnv;
  origin: string;
  waitUntil: (p: Promise<unknown>) => void;
  wallets: number;
}

/** Every followed position across both markets in one pass: 3 fixed reads plus at most a few stream refreshes. */
export async function loadTracked(req: TrackedRequest) {
  const baseUrl = baseUrlFor(req.env);
  const client = new PapertradeClient({ baseUrl });
  const cache = defaultCache();
  try {
    const [trading, mids, leaders] = await Promise.all([client.tradingState(), fetchMids(), topWallets(client, req.wallets)]);
    const collected = await collectIncremental(
      leaders.map((l) => l.address),
      instrumentTable(trading.instruments),
      { baseUrl, store: snapshotStore(cache, req.origin, req.waitUntil), refreshPerCall: REFRESH_PER_CALL, minAgeMs: SNAPSHOT_MIN_AGE_MS },
    );
    if (collected.diagnostics.wallets === 0 && leaders.length > 0) {
      throw new HeatmapError(502, 'warming_up', 'No wallet snapshots are cached yet and the Papertrade stream endpoint is rate limited. Retry in a minute.');
    }
    return { ...collected, mids };
  } catch (err) {
    if (err instanceof HeatmapError) throw err;
    throw new HeatmapError(502, 'upstream_error', `Could not read positions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** One wallet's open positions with their bust prices recomputed. Falls back to a cached snapshot when the stream is rate limited. */
export async function loadWallet(req: Omit<TrackedRequest, 'wallets'> & { wallet: Address }) {
  const baseUrl = baseUrlFor(req.env);
  const client = new PapertradeClient({ baseUrl });
  const store = snapshotStore(defaultCache(), req.origin, req.waitUntil);
  const wallet = req.wallet.toLowerCase() as Address;
  try {
    const [trading, mids, cached] = await Promise.all([client.tradingState(), fetchMids(), store.get(wallet)]);
    const instruments = instrumentTable(trading.instruments);
    const now = Date.now();
    let snapshot = cached;
    let stale = false;
    if (!cached || now - cached.takenAtMs >= SNAPSHOT_MIN_AGE_MS) {
      try {
        const state = await fetchWalletState(wallet, { baseUrl, timeoutMs: Math.max(200, Number(req.env.WALLET_STREAM_TIMEOUT_MS) || 8000) });
        snapshot = packSnapshot(wallet, state.positions, now);
        await store.put(snapshot);
      } catch (err) {
        if (!cached) throw new HeatmapError(502, 'wallet_unavailable', `Could not read this wallet from Papertrade: ${err instanceof Error ? err.message : String(err)}. The stream endpoint allows about a dozen new connections a minute, so retry shortly.`);
        stale = true;
      }
    }
    const tracked = trackPositions(wallet, unpackSnapshot(snapshot!), instruments);
    return { positions: tracked.positions, mismatches: tracked.mismatches, skipped: tracked.skipped, mids, ageMs: now - snapshot!.takenAtMs, stale };
  } catch (err) {
    if (err instanceof HeatmapError) throw err;
    throw new HeatmapError(502, 'upstream_error', `Could not read the wallet: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The protocol-wide liquidation map the Papertrade API publishes (every open position), plus the mark. */
export async function loadProtocolMap(env: HeatmapEnv, market: MarketInfo) {
  const client = new PapertradeClient({ baseUrl: baseUrlFor(env) });
  try {
    const [raw, mids] = await Promise.all([client.liquidationMap(market.id, '5'), fetchMids()]);
    return { map: parseProtocolMap(raw), mark: mids[market.symbol] };
  } catch (err) {
    throw new HeatmapError(502, 'upstream_error', `Could not read the protocol map: ${err instanceof Error ? err.message : String(err)}`);
  }
}
