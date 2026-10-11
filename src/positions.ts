import type { Address } from 'viem';
import type { OpenPosition } from 'papertrade-sdk';
import { liquidationPriceRaw, wadToNumber } from 'papertrade-sdk';
import type { InstrumentTable, MarketSymbol } from './markets.js';

/** An open position with its bust price recomputed by the SDK and compared with the API's value. */
export interface TrackedPosition {
  wallet: Address;
  /** Papertrade position id (decimal string). Unique per protocol. */
  positionId: string;
  market: MarketSymbol;
  isLong: boolean;
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  /** Entry price in dollars. */
  entry: number;
  /** Bust price in dollars, from the SDK's liquidationPriceRaw. */
  bust: number;
  bustRaw: bigint;
  /** The bust value the API reported for this position. */
  apiBustRaw: bigint;
  /** True when the recomputed and API bust prices are identical. */
  bustMatches: boolean;
  openedAtMs: number;
}

export interface TrackResult {
  positions: TrackedPosition[];
  /** Positions on markets this app does not chart (skipped). */
  skipped: number;
  mismatches: number;
}

export function trackPositions(wallet: Address, open: readonly OpenPosition[], instruments: InstrumentTable): TrackResult {
  const positions: TrackedPosition[] = [];
  let skipped = 0;
  let mismatches = 0;
  for (const p of open) {
    const inst = instruments.get(p.instrumentId);
    if (!inst) {
      skipped++;
      continue;
    }
    const bustRaw = liquidationPriceRaw({ entryPriceRaw: p.entryPriceRaw, leverage: p.leverage, isLong: p.isLong, bustBufferRaw: inst.bustBufferRaw });
    const bustMatches = bustRaw === p.bustPriceRaw;
    if (!bustMatches) mismatches++;
    const marginUsd = wadToNumber(p.marginRaw);
    positions.push({
      wallet: wallet.toLowerCase() as Address,
      positionId: p.positionId.toString(),
      market: inst.symbol,
      isLong: p.isLong,
      leverage: p.leverage,
      marginUsd,
      notionalUsd: marginUsd * p.leverage,
      entry: Number(p.entryPriceRaw) / inst.priceScale,
      bust: Number(bustRaw) / inst.priceScale,
      bustRaw,
      apiBustRaw: p.bustPriceRaw,
      bustMatches,
      openedAtMs: p.openedAtMs,
    });
  }
  return { positions, skipped, mismatches };
}

export interface Diagnostics {
  positions: number;
  mismatches: number;
  wallets: number;
}

/** Distance from mark to bust. `fraction` is positive while the position is still alive. */
export function distanceToBust(p: Pick<TrackedPosition, 'isLong' | 'bust'>, mark: number): { fraction: number; usd: number } {
  const usd = p.isLong ? mark - p.bust : p.bust - mark;
  return { fraction: usd / mark, usd };
}

/** Danger levels used to colour and animate rows. Higher is closer to bust. */
export type DangerLevel = 0 | 1 | 2 | 3;
export const DANGER_THRESHOLDS = [
  { level: 3 as const, label: 'critical', maxFraction: 0.0005 },
  { level: 2 as const, label: 'danger', maxFraction: 0.0025 },
  { level: 1 as const, label: 'watch', maxFraction: 0.01 },
];

export function dangerLevel(fraction: number): DangerLevel {
  for (const t of DANGER_THRESHOLDS) if (fraction <= t.maxFraction) return t.level;
  return 0;
}

export function dangerLabel(level: DangerLevel): string {
  return DANGER_THRESHOLDS.find((t) => t.level === level)?.label ?? 'safe';
}
