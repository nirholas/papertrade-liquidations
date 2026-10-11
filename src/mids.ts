import type { MarketSymbol } from './markets.js';
import { MARKETS } from './markets.js';

const INFO_URL = 'https://api.hyperliquid.xyz/info';

export type Mids = Record<MarketSymbol, number>;

/**
 * Current Hyperliquid mid prices for BTC and ETH, the price Papertrade settles on.
 * Throws if either mid is missing, so callers never chart a made-up price.
 */
export async function fetchMids(options: { fetch?: typeof fetch; signal?: AbortSignal; infoApiUrl?: string } = {}): Promise<Mids> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await doFetch(options.infoApiUrl ?? INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'allMids' }),
    signal: options.signal,
  });
  if (!res.ok) throw new Error(`Hyperliquid allMids failed with HTTP ${res.status}`);
  const raw = (await res.json()) as Record<string, string>;
  const out = {} as Mids;
  for (const m of MARKETS) {
    const v = Number(raw[m.symbol]);
    if (!(v > 0)) throw new Error(`Hyperliquid returned no mid for ${m.symbol}`);
    out[m.symbol] = v;
  }
  return out;
}
