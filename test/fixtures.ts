import { readFileSync } from 'node:fs';
import type { AccountTrade, RecentTradeEvent, WalletState } from 'papertrade-sdk';
import { applyWalletPatch, decodeTradingState, decodeWalletSnapshot } from 'papertrade-sdk';
import type { RawWalletPatch, RawWalletSnapshot } from 'papertrade-sdk';
import { instrumentTable } from '../src/markets.js';

export function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;
}

/** The recorded /state/trading response, decoded by the SDK. */
export const instruments = () => instrumentTable(decodeTradingState(fixture('trading')).instruments);

export interface RecordedStream {
  wallet: string;
  frames: { at: number; payload: RawWalletSnapshot | RawWalletPatch }[];
}

export const streams = () => fixture<RecordedStream[]>('streams');
export const activeStreams = () => fixture<RecordedStream[]>('streams-active');

/** The first snapshot of every recorded stream, decoded. */
export function snapshots(): WalletState[] {
  return streams().flatMap((s) => {
    const first = s.frames.find((f) => !('baseAccountRevision' in f.payload));
    return first ? [decodeWalletSnapshot(first.payload as RawWalletSnapshot)] : [];
  });
}

/** Replay a recorded stream through the SDK's own patch logic. */
export function replay(stream: RecordedStream): WalletState[] {
  const out: WalletState[] = [];
  let state: WalletState | null = null;
  for (const f of stream.frames) {
    if ('baseAccountRevision' in f.payload) {
      if (!state) continue;
      state = applyWalletPatch(state, f.payload);
    } else {
      state = decodeWalletSnapshot(f.payload);
    }
    out.push(state);
  }
  return out;
}

export const liquidatedTrades = () => fixture<{ wallet: string; items: AccountTrade[] }[]>('trades-liquidated');
export const recentTrades = () => fixture<{ events: RecentTradeEvent[] }>('recent-trades');
