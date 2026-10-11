/**
 * GET /api/heatmap?market=BTC&bucket=50&wallets=40&cascade=0.5
 *
 * Liquidation map for one market, built from the largest open-position holders. Every bust price is recomputed
 * with the SDK and compared with the API's value. Responses are cached for 10 seconds in the Cache API.
 *
 * Cloudflare allows 50 subrequests per invocation on the free plan: 4 fixed reads plus one snapshot per wallet,
 * so `wallets` defaults to 40 and is capped at 44. Set HEATMAP_MAX_WALLETS on a paid plan to go up to 100.
 */
import { HeatmapError, loadHeatmap, maxWalletsFor, serialize, CACHE_SECONDS, DEFAULT_WALLETS, type HeatmapEnv } from '../_lib/heatmap-core.js';
import { marketBySymbol } from '../../../src/markets.js';

type Env = HeatmapEnv;

const KNOWN = new Set(['market', 'bucket', 'wallets', 'cascade']);

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

  const maxWallets = maxWalletsFor(env);
  const bucket = number(url.searchParams.get('bucket'), 'bucket', 0.0001, 1_000_000);
  const wallets = number(url.searchParams.get('wallets'), 'wallets', 1, maxWallets);
  const cascadePercent = number(url.searchParams.get('cascade'), 'cascade', 0, 25);
  if (bucket instanceof Response) return bucket;
  if (wallets instanceof Response) return wallets;
  if (cascadePercent instanceof Response) return cascadePercent;

  try {
    const { body, cached } = await loadHeatmap({
      env,
      origin: url.origin,
      waitUntil,
      market,
      bucket,
      wallets: wallets === undefined ? Math.min(DEFAULT_WALLETS, maxWallets) : Math.floor(wallets),
      cascadePercent,
    });
    return new Response(serialize(body), { headers: headers({ 'cache-control': `public, max-age=${CACHE_SECONDS}`, 'x-cache': cached ? 'HIT' : 'MISS' }) });
  } catch (err) {
    if (err instanceof HeatmapError) return fail(err.status, err.code, err.message);
    return fail(502, 'upstream_error', `Could not build the heatmap: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export const onRequestOptions: PagesFunction = () =>
  new Response(null, { status: 204, headers: { allow: 'GET, OPTIONS', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' } });
