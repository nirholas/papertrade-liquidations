import type { LiquidationEvent } from '../detect.js';
import { escapeHtml, explorerWalletUrl, formatClock, formatCompactUsd, formatPrice, shortAddress } from '../format.js';

const MAX_ITEMS = 60;

function describeSource(e: LiquidationEvent): { label: string; pending: boolean } {
  if (e.source === 'inferred') return { label: 'detected, awaiting confirmation', pending: true };
  if (e.source === 'history') return { label: 'confirmed by trade history', pending: false };
  if (e.source === 'stream') return { label: 'confirmed by live stream', pending: false };
  return { label: 'confirmed by protocol feed', pending: false };
}

/** Renders the session's liquidations, newest first, followed by older ones from the followed wallets' history. */
export class FeedView {
  private readonly seen = new Set<string>();

  constructor(private readonly list: HTMLOListElement) {}

  /** Returns the keys that are new since the last render. */
  render(session: readonly LiquidationEvent[], earlier: readonly LiquidationEvent[]): string[] {
    const fresh: string[] = [];
    const sessionKeys = new Set(session.map((e) => e.key));
    const older = earlier.filter((e) => !sessionKeys.has(e.key));
    const parts: string[] = [];
    for (const e of session.slice(0, MAX_ITEMS)) {
      const isFresh = !this.seen.has(e.key);
      if (isFresh) fresh.push(e.key);
      parts.push(this.item(e, isFresh, false));
    }
    if (older.length) {
      parts.push('<li class="feed-divider" aria-hidden="true">Earlier, followed wallets</li>');
      for (const e of older.slice(0, MAX_ITEMS)) parts.push(this.item(e, false, true));
    }
    for (const e of [...session, ...older]) this.seen.add(e.key);
    this.list.innerHTML = parts.join('');
    return fresh;
  }

  private item(e: LiquidationEvent, fresh: boolean, earlier: boolean): string {
    const src = describeSource(e);
    const side = e.isLong ? 'long' : 'short';
    const levels = [
      e.entry !== null ? `entry ${formatPrice(e.entry, e.market)}` : '',
      e.bust !== null ? `bust ${formatPrice(e.bust, e.market)}` : '',
      e.exit !== null ? `exit ${formatPrice(e.exit, e.market)}` : '',
    ].filter(Boolean);
    const date = new Date(e.ts);
    return `<li class="${fresh ? 'fresh ' : ''}${earlier ? 'earlier' : ''}">
      <time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(formatClock(e.ts))}</time>
      <span class="what"><span class="${side}">${escapeHtml(e.market)} ${e.isLong ? 'long' : 'short'}</span> busted</span>
      <span class="size">${escapeHtml(formatCompactUsd(e.notionalUsd))} <span class="muted">${escapeHtml(String(e.leverage))}x</span></span>
      <span class="meta">
        <a href="${escapeHtml(explorerWalletUrl(e.wallet))}" rel="noopener">${escapeHtml(shortAddress(e.wallet))}</a>
        ${levels.map((l) => `<span>${escapeHtml(l)}</span>`).join('')}
        <span class="tag${src.pending ? ' pending' : ''}">${escapeHtml(src.label)}</span>
      </span>
    </li>`;
  }
}
