import type { Address } from 'viem';
import { dangerLabel, dangerLevel, distanceToBust, type TrackedPosition } from './positions.js';
import type { Mids } from './mids.js';

export interface WalletPositionDistance {
  positionId: string;
  market: 'BTC' | 'ETH';
  side: 'long' | 'short';
  leverage: number;
  marginUsd: number;
  notionalUsd: number;
  entry: number;
  bust: number;
  markPrice: number;
  /** Move to bust as a percent of the mark. Zero or negative means the position is through its bust price. */
  distancePercent: number;
  distanceUsd: number;
  danger: 'safe' | 'watch' | 'danger' | 'critical';
  throughBust: boolean;
}

export interface WalletDistance {
  wallet: Address;
  positions: WalletPositionDistance[];
  closest: WalletPositionDistance | null;
  totalNotionalUsd: number;
  totalMarginUsd: number;
}

/** Distance to bust for every open position of one wallet, closest first. */
export function walletDistance(wallet: Address, positions: readonly TrackedPosition[], mids: Mids): WalletDistance {
  const rows = positions
    .map((p): WalletPositionDistance => {
      const mark = mids[p.market];
      const d = distanceToBust(p, mark);
      return {
        positionId: p.positionId,
        market: p.market,
        side: p.isLong ? 'long' : 'short',
        leverage: p.leverage,
        marginUsd: p.marginUsd,
        notionalUsd: p.notionalUsd,
        entry: p.entry,
        bust: p.bust,
        markPrice: mark,
        distancePercent: d.fraction * 100,
        distanceUsd: d.usd,
        danger: dangerLabel(dangerLevel(d.fraction)) as WalletPositionDistance['danger'],
        throughBust: d.usd <= 0,
      };
    })
    .sort((a, b) => a.distancePercent - b.distancePercent);
  return {
    wallet: wallet.toLowerCase() as Address,
    positions: rows,
    closest: rows[0] ?? null,
    totalNotionalUsd: rows.reduce((n, r) => n + r.notionalUsd, 0),
    totalMarginUsd: rows.reduce((n, r) => n + r.marginUsd, 0),
  };
}
