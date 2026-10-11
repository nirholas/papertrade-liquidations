/** The two Papertrade markets. Both track a Hyperliquid perp of the same name. */
export type MarketSymbol = 'BTC' | 'ETH';

export interface MarketInfo {
  symbol: MarketSymbol;
  /** Papertrade instrument id. */
  id: number;
  /** Raw price units per dollar (BTC 10, ETH 100). Confirmed at runtime from /state/trading. */
  priceScale: number;
}

export const MARKETS: readonly MarketInfo[] = [
  { symbol: 'BTC', id: 0, priceScale: 10 },
  { symbol: 'ETH', id: 1, priceScale: 100 },
];

export function marketBySymbol(symbol: string): MarketInfo | undefined {
  return MARKETS.find((m) => m.symbol === symbol.toUpperCase());
}

export function marketById(id: number): MarketInfo | undefined {
  return MARKETS.find((m) => m.id === id);
}

/** Per-instrument parameters needed to recompute a bust price. */
export interface InstrumentParams {
  id: number;
  symbol: MarketSymbol;
  priceScale: number;
  bustBufferRaw: bigint;
}

export type InstrumentTable = ReadonlyMap<number, InstrumentParams>;

/** Build the lookup table from the SDK's decoded /state/trading instruments. */
export function instrumentTable(instruments: ReadonlyArray<{ id: number; symbol: string; priceScale: bigint; bustBufferRaw: bigint }>): InstrumentTable {
  const table = new Map<number, InstrumentParams>();
  for (const i of instruments) {
    const market = marketById(i.id);
    if (!market || market.symbol !== i.symbol) continue;
    table.set(i.id, { id: i.id, symbol: market.symbol, priceScale: Number(i.priceScale), bustBufferRaw: i.bustBufferRaw });
  }
  return table;
}
