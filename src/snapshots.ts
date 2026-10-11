import type { Address } from 'viem';
import type { OpenPosition } from 'papertrade-sdk';

/** A wallet's open positions as stored in the cache: bigints become decimal strings so JSON can carry them. */
export interface PackedSnapshot {
  wallet: Address;
  takenAtMs: number;
  positions: {
    positionId: string;
    instrumentId: number;
    isLong: boolean;
    useDebt: boolean;
    entryPriceRaw: string;
    marginRaw: string;
    leverage: number;
    bustPriceRaw: string;
    openedAtMs: number;
    intentId: string | null;
  }[];
}

export function packSnapshot(wallet: Address, positions: readonly OpenPosition[], takenAtMs: number): PackedSnapshot {
  return {
    wallet,
    takenAtMs,
    positions: positions.map((p) => ({
      positionId: p.positionId.toString(),
      instrumentId: p.instrumentId,
      isLong: p.isLong,
      useDebt: p.useDebt,
      entryPriceRaw: p.entryPriceRaw.toString(),
      marginRaw: p.marginRaw.toString(),
      leverage: p.leverage,
      bustPriceRaw: p.bustPriceRaw.toString(),
      openedAtMs: p.openedAtMs,
      intentId: p.intentId,
    })),
  };
}

export function unpackSnapshot(snapshot: PackedSnapshot): OpenPosition[] {
  return snapshot.positions.map((p) => ({
    positionId: BigInt(p.positionId),
    instrumentId: p.instrumentId,
    isLong: p.isLong,
    useDebt: p.useDebt,
    entryPriceRaw: BigInt(p.entryPriceRaw),
    marginRaw: BigInt(p.marginRaw),
    leverage: p.leverage,
    bustPriceRaw: BigInt(p.bustPriceRaw),
    openedAtMs: p.openedAtMs,
    intentId: p.intentId as OpenPosition['intentId'],
  }));
}

/**
 * Choose which wallets to re-read now. Wallets with no snapshot come first, then the stalest. Snapshots younger than
 * `minAgeMs` are left alone, so a burst of requests never hammers the stream endpoint.
 */
export function pickStale(wallets: readonly Address[], known: ReadonlyMap<Address, number>, limit: number, now: number, minAgeMs: number): Address[] {
  return wallets
    .map((w) => ({ w, age: known.has(w) ? now - known.get(w)! : Number.POSITIVE_INFINITY }))
    .filter((x) => x.age >= minAgeMs)
    .sort((a, b) => b.age - a.age)
    .slice(0, Math.max(0, limit))
    .map((x) => x.w);
}
