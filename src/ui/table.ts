import { escapeHtml, explorerWalletUrl, formatCompactUsd, formatPercent, formatPrice, formatUsd, shortAddress } from '../format.js';
import { dangerLabel, dangerLevel, distanceToBust, type DangerLevel, type TrackedPosition } from '../positions.js';

interface RowRef {
  tr: HTMLTableRowElement;
  level: DangerLevel;
  cells: Record<'dist' | 'distUsd' | 'bust' | 'notional', HTMLElement>;
}

export interface TableUpdate {
  /** A position that moved into a more dangerous band: `critical` ones are announced. */
  crossed: { position: TrackedPosition; level: DangerLevel; fraction: number }[];
}

/**
 * The closest-to-bust table. Rows are keyed by position and patched in place, so a row that keeps its place keeps its
 * focus and hover, and a threshold crossing can animate the very row that crossed.
 */
export class ClosestTable {
  private readonly rows = new Map<string, RowRef>();

  constructor(private readonly body: HTMLTableSectionElement) {}

  update(positions: readonly TrackedPosition[], marks: Record<'BTC' | 'ETH', number>, limit: number): TableUpdate {
    const ranked = positions
      .map((p) => ({ p, d: distanceToBust(p, marks[p.market]) }))
      .sort((a, b) => a.d.fraction - b.d.fraction)
      .slice(0, limit);
    const crossed: TableUpdate['crossed'] = [];
    const keep = new Set<string>();

    ranked.forEach(({ p, d }, index) => {
      const key = `${p.wallet}:${p.positionId}`;
      keep.add(key);
      const level = dangerLevel(d.fraction);
      let ref = this.rows.get(key);
      const isNew = !ref;
      if (!ref) {
        ref = this.create(p);
        this.rows.set(key, ref);
      }
      this.fill(ref, p, d.fraction, d.usd);
      if (!isNew && level > ref.level) {
        crossed.push({ position: p, level, fraction: d.fraction });
        ref.tr.classList.remove('cross-up');
        void ref.tr.offsetWidth;
        ref.tr.classList.add('cross-up');
      }
      ref.tr.className = ref.tr.className.replace(/\blvl-\d\b/g, '').trim();
      if (level > 0) ref.tr.classList.add(`lvl-${level}`);
      ref.level = level;
      if (this.body.children[index] !== ref.tr) this.body.insertBefore(ref.tr, this.body.children[index] ?? null);
    });

    for (const [key, ref] of this.rows) {
      if (keep.has(key)) continue;
      ref.tr.remove();
      this.rows.delete(key);
    }
    return { crossed };
  }

  get size(): number {
    return this.rows.size;
  }

  private create(p: TrackedPosition): RowRef {
    const tr = document.createElement('tr');
    const side = p.isLong ? 'long' : 'short';
    // Every interpolated value is either escaped or a number formatted by our own helpers.
    tr.innerHTML = `
      <td data-label="Side"><span class="side-pill ${side}">${p.isLong ? 'Long' : 'Short'}</span><span class="mk">${escapeHtml(p.market)}</span></td>
      <td data-label="Leverage">${escapeHtml(String(p.leverage))}x</td>
      <td class="num" data-label="Margin">${escapeHtml(formatUsd(p.marginUsd, 0))}</td>
      <td class="num" data-label="Notional" data-cell="notional"></td>
      <td class="num" data-label="Entry">${escapeHtml(formatPrice(p.entry, p.market))}</td>
      <td class="num" data-label="Bust" data-cell="bust"></td>
      <td class="num dist-cell" data-label="Distance"><span class="dist"><span data-cell="dist"></span><small data-cell="distUsd"></small></span></td>
      <td class="wallet" data-label="Wallet"><a href="${escapeHtml(explorerWalletUrl(p.wallet))}" rel="noopener" aria-label="Open wallet ${escapeHtml(p.wallet)} in the Papertrade explorer">${escapeHtml(shortAddress(p.wallet))}</a></td>`;
    const q = (name: string) => tr.querySelector<HTMLElement>(`[data-cell="${name}"]`)!;
    return { tr, level: 0, cells: { dist: q('dist'), distUsd: q('distUsd'), bust: q('bust'), notional: q('notional') } };
  }

  private fill(ref: RowRef, p: TrackedPosition, fraction: number, usd: number): void {
    const set = (el: HTMLElement, text: string) => {
      if (el.textContent !== text) el.textContent = text;
    };
    set(ref.cells.notional, formatCompactUsd(p.notionalUsd));
    set(ref.cells.bust, formatPrice(p.bust, p.market));
    if (fraction <= 0) {
      set(ref.cells.dist, 'past bust');
      set(ref.cells.distUsd, `${formatUsd(Math.abs(usd), 2)} through`);
    } else {
      set(ref.cells.dist, formatPercent(fraction));
      set(ref.cells.distUsd, formatUsd(usd, 2));
    }
    ref.tr.title = `${p.market} ${p.isLong ? 'long' : 'short'} ${dangerLabel(dangerLevel(fraction))}`;
  }
}
