import type { TrackedPosition } from './positions.js';
import type { ProtocolMap } from './heatmap.js';

export interface CascadeSide {
  /** Notional that busts, dollars. */
  notional: number;
  /** Margin forfeited by those positions, dollars. */
  margin: number;
  count: number;
}

export interface Cascade {
  /** Move applied, as a fraction (0.005 is 0.5%). */
  fraction: number;
  /** Longs that bust if price falls by `fraction` from mark. */
  down: CascadeSide;
  /** Shorts that bust if price rises by `fraction` from mark. */
  up: CascadeSide;
}

const empty = (): CascadeSide => ({ notional: 0, margin: 0, count: 0 });

/**
 * Notional that would bust if price moved `fraction` from `mark`, in each direction.
 * A long busts when price reaches its bust price, so a fall to mark * (1 - fraction) busts every long whose bust is at or above it.
 * Positions already through their bust price (waiting for the next liquidation sweep) are included.
 */
export function cascade(positions: readonly Pick<TrackedPosition, 'bust' | 'isLong' | 'notionalUsd' | 'marginUsd'>[], mark: number, fraction: number): Cascade {
  if (!(mark > 0)) throw new RangeError('mark must be positive');
  if (!(fraction >= 0)) throw new RangeError('fraction must be non-negative');
  const floor = mark * (1 - fraction);
  const ceil = mark * (1 + fraction);
  const down = empty();
  const up = empty();
  for (const p of positions) {
    const side = p.isLong ? (p.bust >= floor ? down : null) : p.bust <= ceil ? up : null;
    if (!side) continue;
    side.notional += p.notionalUsd;
    side.margin += p.marginUsd;
    side.count++;
  }
  return { fraction, down, up };
}

/** Cascade at log-spaced moves from 0.02% to `maxFraction`, for the sensitivity curve. */
export function cascadeCurve(
  positions: readonly Pick<TrackedPosition, 'bust' | 'isLong' | 'notionalUsd' | 'marginUsd'>[],
  mark: number,
  maxFraction = 0.05,
  steps = 24,
): Cascade[] {
  const min = 0.0002;
  const out: Cascade[] = [];
  for (let i = 0; i < steps; i++) {
    const f = min * (maxFraction / min) ** (i / (steps - 1));
    out.push(cascade(positions, mark, f));
  }
  return out;
}

export interface ProtocolCascadeSide {
  notional: number;
  count: number;
}

/**
 * The same question asked of the protocol-wide map the API publishes (every open position, not just the followed wallets).
 * The map is bucketed, so a bucket the move only partly covers contributes in proportion to the overlap. Positions through
 * their bust are in the `below` and `above` totals only when outside the mapped range, so the answer is exact only for
 * moves inside the range and a lower bound beyond it.
 */
export function protocolCascade(
  map: Pick<ProtocolMap, 'buckets' | 'bucketUsd'>,
  mark: number,
  fraction: number,
): { down: ProtocolCascadeSide; up: ProtocolCascadeSide } {
  if (!(mark > 0)) throw new RangeError('mark must be positive');
  if (!(fraction >= 0)) throw new RangeError('fraction must be non-negative');
  const floor = mark * (1 - fraction);
  const ceil = mark * (1 + fraction);
  const down = { notional: 0, count: 0 };
  const up = { notional: 0, count: 0 };
  for (const b of map.buckets) {
    const width = b.hi - b.lo;
    if (!(width > 0)) continue;
    if (b.longCount > 0 && b.hi > floor) {
      const share = Math.min(1, (b.hi - Math.max(b.lo, floor)) / width);
      down.notional += b.longNotional * share;
      down.count += b.longCount * share;
    }
    if (b.shortCount > 0 && b.lo < ceil) {
      const share = Math.min(1, (Math.min(b.hi, ceil) - b.lo) / width);
      up.notional += b.shortNotional * share;
      up.count += b.shortCount * share;
    }
  }
  down.count = Math.round(down.count);
  up.count = Math.round(up.count);
  return { down, up };
}
