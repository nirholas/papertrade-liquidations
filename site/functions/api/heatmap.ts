/**
 * GET /api/heatmap?market=BTC&bucket=50&wallets=40&cascade=0.5
 *
 * Liquidation map for one market, built from the largest open-position holders. Every bust price is recomputed
 * with the SDK and compared with the API's value. Responses are cached for 10 seconds in the Cache API.
 *
 * Cloudflare allows 50 subrequests per invocation on the free plan: 4 fixed reads plus one snapshot per wallet,
 * so `wallets` defaults to 40 and is capped at 44. Set HEATMAP_MAX_WALLETS on a paid plan to go up to 100.
 */
import { PapertradeClient } from 'papertrade-sdk';
import { collectIncremental, topWallets, type SnapshotStore } from '../../../src/collect.js';
import { assembleHeatmap, parseProtocolMap } from '../../../src/heatmap.js';
import { instrumentTable, marketBySymbol } from '../../../src/markets.js';
import { fetchMids } from '../../../src/mids.js';
import { type PackedSnapshot } from '../../../src/snapshots.js';

interface Env {
  PAPERTRADE_API_URL?: string;
  HEATMAP_MAX_WALLETS?: string;
}

const UPSTREAM = 'https://exchange.papertrade.xyz';
const KNOWN = new Set(['market', 'bucket', 'wallets', 'cascade']);
const DEFAULT_WALLETS = 40;
const FREE_PLAN_WALLETS = 44;
const CACHE_SECONDS = 10;
const SNAPSHOT_TTL_SECONDS = 1800;
const REFRESH_PER_CALL = 6;
const SNAPSHOT_MIN_AGE_MS = 20_000;

/** Per-wallet snapshots live in the Cache API under a synthetic URL on this origin. */
function snapshotStore(cache: Cache, origin: string, waitUntil: (p: Promise<unknown>) => void): SnapshotStore {
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

const headers = (extra: Record<string, string> = {}) => ({
  'content-type': 'application/json; charset=utf-8',
  'access-control-allow-origin': '*',
  ...extra,
});

function fail(status: number, code: string, message: string) {
  return new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: headers({ 'cache-control': 'no-store' }) });
}

function number(raw: string | null, name: string, min: number, max: number): number | Response | undefined {
  if (raw === null) return undefined;
  const v = Number(raw);
  if (!raw.trim() || !Number.isFinite(v) || v < min || v > max) return fail(400, 'invalid_parameter', `${name} must be a number between ${min} and ${max}.`);
  return v;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!KNOWN.has(key)) return fail(400, 'unknown_parameter', `Unknown parameter "${key}". Use market, bucket, wallets, cascade.`);
  }
  const market = marketBySymbol(url.searchParams.get('market') ?? 'BTC');
  if (!market) return fail(400, 'invalid_parameter', 'market must be BTC or ETH.');

  const maxWallets = Math.min(100, Math.max(1, Number(env.HEATMAP_MAX_WALLETS) || FREE_PLAN_WALLETS));
  const bucket = number(url.searchParams.get('bucket'), 'bucket', 0.0001, 1_000_000);
  const wallets = number(url.searchParams.get('wallets'), 'wallets', 1, maxWallets);
  const cascadePercent = number(url.searchParams.get('cascade'), 'cascade', 0, 25);
  if (bucket instanceof Response) return bucket;
  if (wallets instanceof Response) return wallets;
  if (cascadePercent instanceof Response) return cascadePercent;

  const walletCount = Math.floor(wallets ?? Math.min(DEFAULT_WALLETS, maxWallets));
  const normalized = new URL(url.origin + url.pathname);
  normalized.searchParams.set('market', market.symbol);
  if (bucket !== undefined) normalized.searchParams.set('bucket', String(bucket));
  normalized.searchParams.set('wallets', String(walletCount));
  if (cascadePercent !== undefined) normalized.searchParams.set('cascade', String(cascadePercent));

  const cache = caches.default;
  const cacheKey = new Request(normalized.toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const res = new Response(hit.body, hit);
    res.headers.set('x-cache', 'HIT');
    return res;
  }

  const baseUrl = (env.PAPERTRADE_API_URL ?? UPSTREAM).replace(/\/+$/, '');
  const client = new PapertradeClient({ baseUrl });
  try {
    const [trading, mids, rawMap, leaders] = await Promise.all([
      client.tradingState(),
      fetchMids(),
      client.liquidationMap(market.id, '5'),
      topWallets(client, walletCount),
    ]);
    const instruments = instrumentTable(trading.instruments);
    const collected = await collectIncremental(
      leaders.map((l) => l.address),
      instruments,
      { baseUrl, store: snapshotStore(cache, url.origin, waitUntil), refreshPerCall: REFRESH_PER_CALL, minAgeMs: SNAPSHOT_MIN_AGE_MS },
    );
    if (collected.diagnostics.wallets === 0 && leaders.length > 0) return fail(502, 'warming_up', 'No wallet snapshots are cached yet and the Papertrade stream endpoint is rate limited. Retry in a minute.');
    const body = assembleHeatmap({
      market: market.symbol,
      mark: mids[market.symbol],
      asOfMs: Date.now(),
      bucketUsd: bucket,
      positions: collected.positions,
      protocol: parseProtocolMap(rawMap),
      cascadeFraction: cascadePercent === undefined ? undefined : cascadePercent / 100,
      diagnostics: collected.diagnostics,
      freshness: collected.freshness,
    });
    const res = new Response(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), {
      headers: headers({ 'cache-control': `public, max-age=${CACHE_SECONDS}`, 'x-cache': 'MISS' }),
    });
    waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (err) {
    return fail(502, 'upstream_error', `Could not build the heatmap: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export const onRequestOptions: PagesFunction = () =>
  new Response(null, { status: 204, headers: { allow: 'GET, OPTIONS', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } });
