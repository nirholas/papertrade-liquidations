/**
 * Records real Papertrade and Hyperliquid responses into test/fixtures.
 * Run with `npm run record`. The tests replay these files; nothing in them is hand-written.
 *
 *   npm run record            snapshot fixtures plus a stream capture of RECORD_SECONDS (default 90)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { SseParser } from 'papertrade-sdk';

const API = 'https://exchange.papertrade.xyz';
const HL = 'https://api.hyperliquid.xyz/info';
const OUT = new URL('../test/fixtures/', import.meta.url);
const SECONDS = Number(process.env.RECORD_SECONDS ?? 90);
const WALLETS = 8;

async function json(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

async function save(name: string, data: unknown) {
  await writeFile(new URL(name, OUT), `${JSON.stringify(data)}\n`);
  console.log('wrote', name);
}

/** Open a live stream and return every raw wallet frame received for `ms`. */
async function captureStream(wallet: string, ms: number) {
  const frames: { at: number; payload: any }[] = [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${API}/state/user/live?wallet=${wallet}`, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
    const parser = new SseParser();
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const msg of parser.push(value)) if (msg.event === 'wallet') frames.push({ at: Date.now(), payload: JSON.parse(msg.data) });
    }
  } catch (err) {
    if (!ctrl.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return frames;
}

await mkdir(OUT, { recursive: true });

/** Wallets that traded in the last minute: their streams carry real patch frames with closedPositions. */
async function recordActive() {
  const recent = await json(`${API}/query/protocol/trades/recent`);
  const active: string[] = [...new Set<string>(recent.events.map((e: { wallet: string }) => e.wallet))].slice(0, 6);
  console.log(`streaming ${active.length} active wallets for ${SECONDS}s`);
  const caps = await Promise.all(active.map((w) => captureStream(w, SECONDS * 1000)));
  await save('streams-active.json', active.map((wallet, i) => ({ wallet, frames: caps[i] })));
}

if (process.env.RECORD_ONLY === 'active') {
  await recordActive();
  process.exit(0);
}

const trading = await json(`${API}/state/trading`);
await save('trading.json', trading);

const board = await json(`${API}/state/leaderboard/accounts?page=0&pageSize=100&sortDir=desc&sortKey=currentOpenNotional&window=24h`);
await save('leaderboard.json', board);
const wallets: string[] = board.accounts.slice(0, WALLETS).map((a: { address: string }) => a.address);

const mids = await json(HL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'allMids' }) });
await save('mids.json', { BTC: mids.BTC, ETH: mids.ETH, recordedAt: Date.now() });

await save('liquidation-map-btc.json', await json(`${API}/query/markets/0/liquidation-map?range=5`));
await save('liquidation-map-eth.json', await json(`${API}/query/markets/1/liquidation-map?range=5`));
await save('recent-trades.json', await json(`${API}/query/protocol/trades/recent`));

const candles = await json(HL, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'candleSnapshot', req: { coin: 'ETH', interval: '1m', startTime: Date.now() - 30 * 60_000, endTime: Date.now() } }),
});
await save('candles-eth-1m.json', candles);

console.log(`streaming ${wallets.length} wallets for ${SECONDS}s`);
const captures = await Promise.all(wallets.map((w) => captureStream(w, SECONDS * 1000)));
await save('streams.json', wallets.map((wallet, i) => ({ wallet, frames: captures[i] })));

await recordActive();

// A real liquidation row: scan a few pages of loss-filtered history for the wallets with the most closed trades.
const found: unknown[] = [];
for (const acct of board.accounts.slice(0, 100)) {
  const page = await json(`${API}/query/accounts/${acct.address}/trades?filter=all&limit=75`).catch(() => null);
  const liq = page?.items?.filter((t: { kind: string }) => t.kind === 'Liquidated') ?? [];
  if (liq.length) found.push({ wallet: acct.address, items: page.items });
  if (found.length >= 2) break;
}
await save('trades-liquidated.json', found);
