import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMcpRequest, validateArgs } from '../../site/functions/_lib/mcp.js';
import { SERVER_INFO } from '../../site/functions/_lib/server-info.js';
import tools, { type Env } from '../../site/functions/_lib/tools.js';
import { packSnapshot } from '../../src/snapshots.js';
import { fixture, snapshots, streams } from '../fixtures.js';

/**
 * The tools run against the recorded real Papertrade responses: fetch is replaced by a router that serves the
 * recorded /state/trading, leaderboard, liquidation map and Hyperliquid mids, and the Cache API holds snapshots
 * built from the recorded wallet streams. Nothing here is invented.
 */
const server = { ...SERVER_INFO, tools };
const mids = fixture<{ BTC: string; ETH: string }>('mids');
const WALLETS = 8;

function installCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (req: Request) => store.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => void store.set(req.url, res.clone()),
  };
  vi.stubGlobal('caches', { default: cache });
  return store;
}

async function seedSnapshots(ageMs = 0) {
  const now = Date.now() - ageMs;
  const states = snapshots();
  for (const s of states) {
    const snap = packSnapshot(s.address, s.positions, now);
    await (caches as unknown as { default: Cache }).default.put(new Request(`https://example.test/__snapshot/${s.address.toLowerCase()}`), new Response(JSON.stringify(snap)));
  }
}

function installFetch(failStream = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
      if (url.hostname === 'api.hyperliquid.xyz') return json({ BTC: mids.BTC, ETH: mids.ETH });
      if (url.pathname === '/state/trading') return json(fixture('trading'));
      if (url.pathname === '/state/leaderboard/accounts') {
        // The recorded leaderboard, narrowed to the wallets whose streams were also recorded.
        const board = fixture<{ accounts: { address: string }[] }>('leaderboard');
        const recorded = new Set(streams().map((s) => s.wallet.toLowerCase()));
        return json({ ...board, accounts: board.accounts.filter((a) => recorded.has(a.address.toLowerCase())) });
      }
      if (url.pathname === '/query/markets/0/liquidation-map') return json(fixture('liquidation-map-btc'));
      if (url.pathname === '/query/markets/1/liquidation-map') return json(fixture('liquidation-map-eth'));
      if (url.pathname === '/state/user/live' && failStream) return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } });
      return new Response(`unexpected ${url.pathname} ${init?.method ?? 'GET'}`, { status: 500 });
    }),
  );
}

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await handleMcpRequest(
    new Request('https://example.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }),
    server,
    { WALLET_STREAM_TIMEOUT_MS: '300' } as Env,
    () => {},
  );
  return res.json();
};

beforeEach(async () => {
  installCache();
  installFetch();
  await seedSnapshots();
});
afterEach(() => vi.unstubAllGlobals());

describe('tool definitions', () => {
  it('ship 4 to 10 read-only tools with complete metadata', () => {
    expect(tools.length).toBeGreaterThanOrEqual(4);
    expect(tools.length).toBeLessThanOrEqual(10);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.description.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema.type).toBe('object');
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
  });
  it('never mention signing capabilities, only that none exist', () => {
    for (const t of tools) expect(t.name).not.toMatch(/sign|send|swap|trade|order|transfer|pay/);
  });
});

describe('get_bust_map', () => {
  it('returns the recorded BTC map with coverage and trimmed buckets', async () => {
    const body = await call('get_bust_map', { market: 'BTC', wallets: WALLETS, maxBuckets: 5, cascadePercent: 0.5 });
    expect(body.result.isError).toBe(false);
    const s = body.result.structuredContent;
    expect(s.market).toBe('BTC');
    expect(s.markPrice).toBe(Number(mids.BTC));
    expect(s.buckets.length).toBeLessThanOrEqual(5);
    expect(s.cascade.fraction).toBeCloseTo(0.005);
    expect(s.coverage.wallets).toBeGreaterThan(0);
    expect(s.coverage.wallets).toBeLessThanOrEqual(WALLETS);
    expect(s.protocol.totalNotionalUsd).toBeGreaterThan(0);
    expect(s.diagnostics.mismatches).toBe(0);
    for (const k of tools[0]!.outputSchema.required!) expect(s[k]).toBeDefined();
  });
  it('rejects an unknown market with -32602 before touching the network', async () => {
    const body = await call('get_bust_map', { market: 'DOGE' });
    expect(body.error.code).toBe(-32602);
  });
});

describe('get_closest_to_bust', () => {
  it('sorts nearest first across both markets and honours filters', async () => {
    const all = (await call('get_closest_to_bust', { wallets: WALLETS, limit: 20 })).result.structuredContent;
    expect(all.positions.length).toBeGreaterThan(0);
    for (let i = 1; i < all.positions.length; i++) expect(all.positions[i].distancePercent).toBeGreaterThanOrEqual(all.positions[i - 1].distancePercent);
    const longsEth = (await call('get_closest_to_bust', { wallets: WALLETS, market: 'ETH', side: 'long' })).result.structuredContent;
    for (const p of longsEth.positions) expect([p.market, p.side]).toEqual(['ETH', 'long']);
    const tight = (await call('get_closest_to_bust', { wallets: WALLETS, maxDistancePercent: 0.0001 })).result.structuredContent;
    expect(tight.count).toBe(tight.positions.length);
  });
});

describe('get_bust_cluster_summary', () => {
  it('returns clusters per side and a cascade ladder that never shrinks as the move grows', async () => {
    const s = (await call('get_bust_cluster_summary', { market: 'BTC', wallets: WALLETS })).result.structuredContent;
    expect(s.clusters.length).toBeGreaterThan(0);
    for (const c of s.clusters) expect(c.toPrice).toBeGreaterThan(c.fromPrice);
    expect(s.ladder.map((r: { movePercent: number }) => r.movePercent)).toEqual([0.1, 0.25, 0.5, 1, 2, 5]);
    for (let i = 1; i < s.ladder.length; i++) {
      expect(s.ladder[i].tracked.down.notionalUsd).toBeGreaterThanOrEqual(s.ladder[i - 1].tracked.down.notionalUsd);
      expect(s.ladder[i].tracked.up.notionalUsd).toBeGreaterThanOrEqual(s.ladder[i - 1].tracked.up.notionalUsd);
    }
  });
});

describe('get_wallet_distance_to_bust', () => {
  const wallet = streams()[0]!.wallet.toLowerCase();
  it('computes distance for a wallet from its cached snapshot', async () => {
    const s = (await call('get_wallet_distance_to_bust', { wallet })).result.structuredContent;
    expect(s.wallet).toBe(wallet);
    expect(s.count).toBe(s.positions.length);
    if (s.count > 1) expect(s.positions[0].distancePercent).toBeLessThanOrEqual(s.positions[1].distancePercent);
    expect(s.stale).toBe(false);
  });
  it('rejects a malformed address', async () => {
    expect((await call('get_wallet_distance_to_bust', { wallet: 'not-an-address' })).error.code).toBe(-32602);
    expect(validateArgs(tools.find((t) => t.name === 'get_wallet_distance_to_bust')!.inputSchema, { wallet: '0x' + '1'.repeat(40) })).toBeNull();
  });
  it('serves a stale snapshot, flagged, when the stream endpoint is rate limited', async () => {
    installCache();
    await seedSnapshots(60_000);
    installFetch(true);
    const s = (await call('get_wallet_distance_to_bust', { wallet })).result.structuredContent;
    expect(s.stale).toBe(true);
    expect(s.snapshotAgeSeconds).toBeGreaterThanOrEqual(59);
  });
  it('tells the model what to do when there is no snapshot and the stream is rate limited', async () => {
    installCache();
    installFetch(true);
    const body = await call('get_wallet_distance_to_bust', { wallet });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('retry');
  });
});

describe('get_protocol_liquidation_map', () => {
  it('returns the protocol map and regroups onto a coarser grid without losing notional', async () => {
    const fine = (await call('get_protocol_liquidation_map', { market: 'ETH' })).result.structuredContent;
    const coarse = (await call('get_protocol_liquidation_map', { market: 'ETH', bucketUsd: fine.bucketUsd * 5 })).result.structuredContent;
    const sum = (b: { longNotional: number; shortNotional: number }[]) => b.reduce((n, x) => n + x.longNotional + x.shortNotional, 0);
    expect(coarse.buckets.length).toBeLessThanOrEqual(fine.buckets.length);
    expect(sum(coarse.buckets)).toBeCloseTo(sum(fine.buckets), 2);
    expect(fine.totalNotionalUsd).toBeGreaterThan(0);
  });
});
