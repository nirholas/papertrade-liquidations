/** Escape untrusted strings (leaderboard names, API text) before they go into HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function formatUsd(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** $1.23M, $456.7K, $12. Notional sizes read better compact. */
export function formatCompactUsd(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${sign}$${(abs / size).toFixed(abs / size >= 100 ? 0 : abs / size >= 10 ? 1 : 2)}${suffix}`;
  }
  return `${sign}$${abs.toFixed(abs >= 10 ? 0 : 2)}`;
}

/** Price with decimals that match the market tick: BTC 1 dp, ETH 2 dp. */
export function formatPrice(value: number, market: 'BTC' | 'ETH'): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: market === 'BTC' ? 1 : 2, maximumFractionDigits: market === 'BTC' ? 1 : 2 });
}

/** A bucket size such as 50, 0.5 or 0.25, without trailing zeros. */
export function formatBucket(value: number): string {
  return `$${Number(value.toPrecision(4)).toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

export function formatPercent(fraction: number, digits = 3): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export const EXPLORER_WALLET_URL = 'https://papertrade-explorer.pages.dev/#/wallet/';

export function explorerWalletUrl(address: string): string {
  return `${EXPLORER_WALLET_URL}${encodeURIComponent(address)}`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour12: false });
}
