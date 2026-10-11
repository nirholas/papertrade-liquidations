import type { Address } from 'viem';
import { PapertradeClient, fetchCandles, type Candle, type CandleInterval } from 'papertrade-sdk';
import { autoBucket, bucketPresets, bucketize, rebin, totals, type Bucket } from '../src/buckets.js';
import { cascade, cascadeCurve, protocolCascade } from '../src/cascade.js';
import { PriceTape, eventFromProtocol, eventFromTrade, removeEvents, tally, upsertEvent, type LiquidationEvent } from '../src/detect.js';
import { escapeHtml, formatBucket, formatCompactUsd, formatPercent, formatPrice } from '../src/format.js';
import { parseProtocolMap, type ProtocolMap } from '../src/heatmap.js';
import { MARKETS, instrumentTable, type InstrumentTable, type MarketSymbol } from '../src/markets.js';
import { fetchMids, type Mids } from '../src/mids.js';
import { topWallets } from '../src/collect.js';
import { distanceToBust, type TrackedPosition } from '../src/positions.js';
import { ChartView } from '../src/ui/chart.js';
import { FeedView } from '../src/ui/feed.js';
import { createLimitedFetch } from '../src/ui/limiter.js';
import { ClosestTable } from '../src/ui/table.js';
import { Tracker } from '../src/ui/tracker.js';
import { initLanding } from './landing.js';

const STREAM_BASE = 'https://exchange.papertrade.xyz';
const FOLLOW_WALLETS = 40;
const POLL_MIDS_MS = 3_000;
const POLL_CANDLES_MS = 6_000;
const POLL_PROTOCOL_MS = 20_000;
const POLL_FEED_MS = 8_000;
const REFRESH_WALLETS_MS = 5 * 60_000;
const BACKFILL_WALLETS = 12;
const BACKFILL_WINDOW_MS = 24 * 3_600_000;
const LOOKBACK_MS: Record<string, number> = { '1m': 6 * 3_600_000, '5m': 24 * 3_600_000, '15m': 3 * 24 * 3_600_000, '1h': 14 * 24 * 3_600_000 };

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const client = new PapertradeClient({ baseUrl: '/api/papertrade', clientBuild: 'papertrade-liquidations' });
const limited = createLimitedFetch();
const tape = new PriceTape();

interface State {
  market: MarketSymbol;
  interval: CandleInterval;
  bucket: number | 'auto';
  tableMarket: MarketSymbol | 'all';
  tableLimit: number;
  showProtocol: boolean;
  showCascade: boolean;
  cascadeFraction: number;
  marks: Mids | null;
  marksAt: number;
  protocol: Record<MarketSymbol, ProtocolMap | null>;
  session: LiquidationEvent[];
  earlier: LiquidationEvent[];
  instruments: InstrumentTable | null;
  booted: boolean;
  errors: string[];
}

const state: State = {
  market: 'BTC',
  interval: '1m',
  bucket: 'auto',
  tableMarket: 'all',
  tableLimit: 25,
  showProtocol: true,
  showCascade: true,
  cascadeFraction: 0.005,
  marks: null,
  marksAt: 0,
  protocol: { BTC: null, ETH: null },
  session: [],
  earlier: [],
  instruments: null,
  booted: false,
  errors: [],
};

let chart: ChartView | null = null;
let tracker: Tracker | null = null;
let lastCandle: Candle | null = null;
let candleLoadId = 0;
const table = new ClosestTable($('rows') as HTMLTableSectionElement);
const feed = new FeedView($('feed-list') as HTMLOListElement);
const timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
let audio: AudioContext | null = null;
let announcedAt = 0;

/* ---------- helpers ---------- */

function setText(id: string, text: string): void {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function fractionFromSlider(value: number): number {
  return 0.0002 * (0.05 / 0.0002) ** (value / 100);
}

function ago(ms: number): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function currentMark(market: MarketSymbol): number | null {
  return state.marks ? state.marks[market] : null;
}

function allPositions(): TrackedPosition[] {
  return tracker ? tracker.positions() : [];
}

/* ---------- rendering ---------- */

let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function render(): void {
  const positions = allPositions();
  renderStats(positions);
  renderMap(positions);
  renderCascade(positions);
  renderTable(positions);
  renderFeed();
  renderDiagnostics(positions);
}

function renderStats(positions: TrackedPosition[]): void {
  const marks = state.marks;
  if (marks) {
    setText('mark-btc', formatPrice(marks.BTC, 'BTC'));
    setText('mark-eth', formatPrice(marks.ETH, 'ETH'));
    setText('mark-btc-sub', `Hyperliquid mid, ${ago(state.marksAt)}`);
    setText('mark-eth-sub', `Hyperliquid mid, ${ago(state.marksAt)}`);
  }
  const t = totals(positions);
  const notional = t.longNotional + t.shortNotional;
  if (positions.length) {
    setText('stat-notional', formatCompactUsd(notional));
    const proto = (['BTC', 'ETH'] as const).reduce((n, m) => n + (state.protocol[m]?.totalNotionalUsd ?? 0), 0);
    const share = proto > 0 ? ` of ${formatCompactUsd(proto)} protocol-wide (${Math.min(100, Math.round((notional / proto) * 100))}%)` : '';
    setText('stat-notional-sub', `${positions.length} positions, ${t.longCount} long / ${t.shortCount} short${share}`);
  }
  if (marks && positions.length) {
    let best: { p: TrackedPosition; fraction: number } | null = null;
    for (const p of positions) {
      const d = distanceToBust(p, marks[p.market]);
      if (!best || d.fraction < best.fraction) best = { p, fraction: d.fraction };
    }
    if (best) {
      setText('stat-closest', best.fraction <= 0 ? 'past bust' : formatPercent(best.fraction));
      setText('stat-closest-sub', `${best.p.market} ${best.p.isLong ? 'long' : 'short'} ${best.p.leverage}x, ${formatCompactUsd(best.p.notionalUsd)}`);
    }
  }
  const tl = tally(state.session);
  setText('stat-busts', String(tl.count));
  setText('stat-busts-sub', `${formatCompactUsd(tl.notionalUsd)} notional`);
}

function bucketSize(): number {
  const mark = currentMark(state.market);
  if (state.bucket !== 'auto') return state.bucket;
  return mark ? autoBucket(mark) : 1;
}

function fillBucketOptions(): void {
  const mark = currentMark(state.market);
  const select = $<HTMLSelectElement>('bucket');
  if (!mark) return;
  const auto = autoBucket(mark);
  const presets = bucketPresets(mark);
  const next = presets.map((v) => `<option value="${v}"${state.bucket === v ? ' selected' : ''}>${escapeHtml(formatBucket(v))}${v === auto ? ' (auto)' : ''}</option>`).join('');
  if (select.dataset.market !== state.market || select.dataset.auto !== String(auto)) {
    select.innerHTML = next;
    select.dataset.market = state.market;
    select.dataset.auto = String(auto);
    select.value = String(state.bucket === 'auto' ? auto : state.bucket);
  }
}

function renderMap(positions: TrackedPosition[]): void {
  const mark = currentMark(state.market);
  if (!chart || !mark) return;
  fillBucketOptions();
  const size = bucketSize();
  const mine = positions.filter((p) => p.market === state.market);
  const buckets = bucketize(mine, size);
  const proto = state.protocol[state.market];
  const protocolBuckets: Bucket[] = state.showProtocol && proto ? rebin(proto.buckets, size) : [];
  let max = 0;
  for (const b of [...buckets, ...protocolBuckets]) max = Math.max(max, b.longNotional, b.shortNotional);
  chart.setMark(mark);
  chart.setCascade({ mark, fraction: state.cascadeFraction }, state.showCascade);
  chart.setHeat({ buckets, protocol: protocolBuckets, mark, maxNotional: max, visible: { from: mark * 0.988, to: mark * 1.012 } });
}

function renderCascade(positions: TrackedPosition[]): void {
  const market = state.market;
  const mark = currentMark(market);
  setText('cascade-market', market);
  setText('cascade-value', `${(state.cascadeFraction * 100).toFixed(2)}%`);
  if (!mark) return;
  const mine = positions.filter((p) => p.market === market);
  const c = cascade(mine, mark, state.cascadeFraction);
  const t = totals(mine);
  const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}% of followed` : 'none followed');
  setText('cascade-down', formatCompactUsd(c.down.notional));
  setText('cascade-up', formatCompactUsd(c.up.notional));
  setText('cascade-down-sub', `${c.down.count} long${c.down.count === 1 ? '' : 's'} bust, ${pct(c.down.notional, t.longNotional)}`);
  setText('cascade-up-sub', `${c.up.count} short${c.up.count === 1 ? '' : 's'} bust, ${pct(c.up.notional, t.shortNotional)}`);
  const proto = state.protocol[market];
  if (proto) {
    const pc = protocolCascade(proto, mark, state.cascadeFraction);
    setText('cascade-down-proto', `Protocol-wide: ${formatCompactUsd(pc.down.notional)} (${pc.down.count})`);
    setText('cascade-up-proto', `Protocol-wide: ${formatCompactUsd(pc.up.notional)} (${pc.up.count})`);
  }
  drawCurve(mine, mark);
}

function drawCurve(mine: TrackedPosition[], mark: number): void {
  const svg = document.getElementById('cascade-curve');
  if (!svg) return;
  const curve = cascadeCurve(mine, mark, 0.05, 24);
  const max = Math.max(1, ...curve.map((c) => Math.max(c.down.notional, c.up.notional)));
  const x = (i: number) => (i / (curve.length - 1)) * 300;
  const y = (v: number) => 66 - (v / max) * 62;
  const path = (pick: (c: (typeof curve)[number]) => number) => curve.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(pick(c)).toFixed(1)}`).join(' ');
  const slider = Number($<HTMLInputElement>('cascade-range').value) / 100;
  const cx = (slider * 300).toFixed(1);
  svg.innerHTML = `<path class="down" d="${path((c) => c.down.notional)}"/><path class="up" d="${path((c) => c.up.notional)}"/><line class="cursor" x1="${cx}" x2="${cx}" y1="0" y2="70"/>`;
}

function renderTable(positions: TrackedPosition[]): void {
  const marks = state.marks;
  const filtered = state.tableMarket === 'all' ? positions : positions.filter((p) => p.market === state.tableMarket);
  const loaded = positions.length > 0;
  $('table-skeleton').hidden = loaded || !!state.errors.length || state.booted;
  $('table-empty').hidden = !(state.booted && marks && filtered.length === 0 && !state.errors.length);
  $('table-error').hidden = !(state.errors.length && !loaded);
  $('rows').closest('table')!.hidden = filtered.length === 0;
  if (!marks) return;
  const result = table.update(filtered, marks, state.tableLimit);
  for (const c of result.crossed) {
    if (c.level < 3) continue;
    if (Date.now() - announcedAt < 8_000) break;
    announcedAt = Date.now();
    $('announce').textContent = `${c.position.market} ${c.position.isLong ? 'long' : 'short'} ${c.position.leverage}x is within ${formatPercent(Math.max(c.fraction, 0))} of its bust price.`;
  }
}

function renderFeed(): void {
  const fresh = feed.render(state.session, state.earlier);
  const hasAny = state.session.length + state.earlier.length > 0;
  $('feed-empty').hidden = hasAny;
  const tl = tally(state.session);
  setText('tally', `${tl.count} bust${tl.count === 1 ? '' : 's'} this session, ${formatCompactUsd(tl.notionalUsd)} notional (${tl.longs} long, ${tl.shorts} short)${tl.unconfirmed ? `, ${tl.unconfirmed} awaiting confirmation` : ''}`);
  if (fresh.length && ($('sound') as HTMLInputElement).checked) beep();
}

function renderDiagnostics(positions: TrackedPosition[]): void {
  if (!tracker) return;
  const s = tracker.stats();
  const wait = limited.cooldownUntil();
  const proto = (m: MarketSymbol) => state.protocol[m];
  const coverage = (m: MarketSymbol) => {
    const p = proto(m);
    if (!p || p.totalNotionalUsd <= 0) return 'n/a';
    const mine = totals(positions.filter((x) => x.market === m));
    return `${Math.min(100, Math.round(((mine.longNotional + mine.shortNotional) / p.totalNotionalUsd) * 100))}%`;
  };
  const rows: [string, string, 'ok' | 'bad' | 'warn' | ''][] = [
    ['Positions tracked', `${s.positions} across ${s.loaded} of ${s.wallets} wallets`, ''],
    ['Bust price check', s.positions === 0 ? 'waiting for positions' : s.mismatches === 0 ? `${s.positions} of ${s.positions} match the API` : `${s.mismatches} MISMATCH${s.mismatches === 1 ? '' : 'ES'} of ${s.positions}`, s.positions === 0 ? '' : s.mismatches === 0 ? 'ok' : 'bad'],
    ['Mismatch count', String(s.mismatches), s.mismatches === 0 ? 'ok' : 'bad'],
    ['Coverage of protocol notional', `BTC ${coverage('BTC')}, ETH ${coverage('ETH')}`, ''],
    ['Connections', `${s.live} live streams, ${s.sweeping} refreshed in rotation`, ''],
    ['Stream limiter', wait ? `rate limited, resuming in ${Math.ceil((wait - Date.now()) / 1000)}s` : `ok, ${limited.started()} connections opened`, wait ? 'warn' : 'ok'],
    ['Wallets unreadable', String(s.failed), s.failed ? 'warn' : ''],
    ['Last position update', ago(s.lastUpdateMs), ''],
    ['Prices', state.marks ? `Hyperliquid allMids, ${ago(state.marksAt)}` : 'not loaded', state.marks ? '' : 'warn'],
    ['Protocol map', proto(state.market) ? `API liquidation map, ${ago(proto(state.market)!.asOfMs)}` : 'not loaded', proto(state.market) ? '' : 'warn'],
    ['History checks pending', String(s.verifying), ''],
  ];
  $('diag-grid').innerHTML = rows.map(([k, v, cls]) => `<div class="${cls}"><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join('');
  setText('diag-summary', s.positions === 0 ? 'starting' : s.mismatches === 0 ? `${s.positions} bust prices verified, 0 mismatches` : `${s.mismatches} bust price mismatches`);
}

/* ---------- sound ---------- */

function beep(): void {
  if (!audio) return;
  const now = audio.currentTime;
  [440, 330].forEach((freq, i) => {
    const osc = audio!.createOscillator();
    const gain = audio!.createGain();
    osc.frequency.value = freq;
    osc.type = 'triangle';
    gain.gain.setValueAtTime(0.0001, now + i * 0.14);
    gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.14 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.12);
    osc.connect(gain).connect(audio!.destination);
    osc.start(now + i * 0.14);
    osc.stop(now + i * 0.14 + 0.14);
  });
}

/* ---------- data ---------- */

function addEvents(events: LiquidationEvent[]): void {
  let list = state.session;
  for (const e of events) list = upsertEvent(list, e);
  state.session = list;
  scheduleRender();
}

async function loadCandles(): Promise<void> {
  if (!chart) return;
  const id = ++candleLoadId;
  const error = $('chart-error');
  try {
    const now = Date.now();
    const candles = await fetchCandles(state.market, state.interval, now - LOOKBACK_MS[state.interval]!, now);
    if (id !== candleLoadId) return;
    if (!candles.length) throw new Error('Hyperliquid returned no candles for this range.');
    chart.reset();
    chart.setCandles(candles);
    lastCandle = candles[candles.length - 1]!;
    error.hidden = true;
    $('chart-skeleton').hidden = true;
    scheduleRender();
  } catch (err) {
    if (id !== candleLoadId) return;
    $('chart-skeleton').hidden = true;
    setText('chart-error-detail', err instanceof Error ? err.message : String(err));
    error.hidden = false;
  }
}

async function pollCandles(): Promise<void> {
  if (!chart || !lastCandle) return;
  const id = candleLoadId;
  try {
    const fresh = await fetchCandles(state.market, state.interval, lastCandle.time, Date.now());
    if (id !== candleLoadId) return;
    for (const c of fresh) {
      chart.updateCandle(c);
      lastCandle = c;
    }
  } catch {
    state.errors = state.errors.filter((e) => e !== 'candles');
  }
}

async function pollMids(): Promise<void> {
  try {
    const mids = await fetchMids();
    const at = Date.now();
    for (const m of MARKETS) tape.record(m.symbol, mids[m.symbol], at);
    state.marks = mids;
    state.marksAt = at;
    scheduleRender();
  } catch {
    scheduleRender();
  }
}

async function pollProtocol(): Promise<void> {
  const results = await Promise.allSettled(MARKETS.map((m) => client.liquidationMap(m.id, '5')));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') state.protocol[MARKETS[i]!.symbol] = parseProtocolMap(r.value);
  });
  scheduleRender();
}

async function pollFeed(): Promise<void> {
  try {
    const recent = await client.recentTrades();
    const events = recent.events.map(eventFromProtocol).filter((e): e is LiquidationEvent => e !== null);
    if (events.length) addEvents(events);
  } catch {
    scheduleRender();
  }
}

async function backfillHistory(wallets: readonly Address[]): Promise<void> {
  if (!state.instruments) return;
  const found: LiquidationEvent[] = [];
  const queue = wallets.slice(0, BACKFILL_WALLETS);
  const worker = async () => {
    for (let w = queue.shift(); w; w = queue.shift()) {
      try {
        const page = await client.accountTrades(w, { filter: 'losses' });
        for (const t of page.items) {
          if (t.timestampMs < Date.now() - BACKFILL_WINDOW_MS) continue;
          const e = eventFromTrade(w, t, state.instruments!);
          if (e) found.push(e);
        }
      } catch {
        continue;
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  state.earlier = found.sort((a, b) => b.ts - a.ts).slice(0, 30);
  scheduleRender();
}

function every(name: string, ms: number, task: () => Promise<void>): void {
  const tick = async () => {
    if (!document.hidden) await task().catch(() => undefined);
    timers[name] = setTimeout(() => void tick(), ms);
  };
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => void tick(), ms);
}

async function refreshWallets(): Promise<void> {
  if (!tracker) return;
  const leaders = await topWallets(client, FOLLOW_WALLETS);
  tracker.setWallets(leaders.map((l) => ({ address: l.address, openNotionalUsd: l.openNotionalUsd })));
}

async function boot(): Promise<void> {
  state.errors = [];
  $('table-error').hidden = true;
  $('chart-error').hidden = true;
  $('chart-skeleton').hidden = false;
  try {
    const [trading, mids] = await Promise.all([client.tradingState(), fetchMids()]);
    state.instruments = instrumentTable(trading.instruments);
    state.marks = mids;
    state.marksAt = Date.now();
    for (const m of MARKETS) tape.record(m.symbol, mids[m.symbol]);
    const leaders = await topWallets(client, FOLLOW_WALLETS);
    if (!leaders.length) throw new Error('The leaderboard returned no wallets with open positions.');

    tracker?.destroy();
    tracker = new Tracker({
      streamBase: STREAM_BASE,
      client,
      instruments: state.instruments,
      tape,
      limited,
      onChange: scheduleRender,
      onLiquidations: addEvents,
      onRetract: (market, ids) => {
        state.session = removeEvents(state.session, market, ids);
        scheduleRender();
      },
    });
    tracker.setWallets(leaders.map((l) => ({ address: l.address, openNotionalUsd: l.openNotionalUsd })));
    limited.onCooldown(scheduleRender);
    tracker.start();
    state.booted = true;
    void backfillHistory(leaders.map((l) => l.address));
    void pollProtocol();
    void pollFeed();
    await loadCandles();

    every('mids', POLL_MIDS_MS, pollMids);
    every('candles', POLL_CANDLES_MS, pollCandles);
    every('protocol', POLL_PROTOCOL_MS, pollProtocol);
    every('feed', POLL_FEED_MS, pollFeed);
    every('wallets', REFRESH_WALLETS_MS, refreshWallets);
    scheduleRender();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    state.errors = [message];
    state.booted = true;
    setText('table-error-detail', message);
    setText('chart-error-detail', message);
    $('chart-skeleton').hidden = true;
    $('chart-error').hidden = false;
    $('table-skeleton').hidden = true;
    $('table-error').hidden = false;
  }
}

/* ---------- wiring ---------- */

function bindControls(): void {
  document.querySelectorAll<HTMLInputElement>('input[name="market"]').forEach((el) =>
    el.addEventListener('change', () => {
      if (!el.checked) return;
      state.market = el.value as MarketSymbol;
      state.bucket = 'auto';
      lastCandle = null;
      $('chart-skeleton').hidden = false;
      void loadCandles();
    }),
  );
  $<HTMLSelectElement>('interval').addEventListener('change', (e) => {
    state.interval = (e.target as HTMLSelectElement).value as CandleInterval;
    lastCandle = null;
    $('chart-skeleton').hidden = false;
    void loadCandles();
  });
  $<HTMLSelectElement>('bucket').addEventListener('change', (e) => {
    state.bucket = Number((e.target as HTMLSelectElement).value);
    scheduleRender();
  });
  $<HTMLInputElement>('toggle-protocol').addEventListener('change', (e) => {
    state.showProtocol = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });
  $<HTMLInputElement>('toggle-cascade').addEventListener('change', (e) => {
    state.showCascade = (e.target as HTMLInputElement).checked;
    scheduleRender();
  });
  const range = $<HTMLInputElement>('cascade-range');
  const onRange = () => {
    state.cascadeFraction = fractionFromSlider(Number(range.value));
    scheduleRender();
  };
  range.addEventListener('input', onRange);
  document.querySelectorAll<HTMLInputElement>('input[name="table-market"]').forEach((el) =>
    el.addEventListener('change', () => {
      if (!el.checked) return;
      state.tableMarket = el.value as MarketSymbol | 'all';
      scheduleRender();
    }),
  );
  $<HTMLSelectElement>('table-limit').addEventListener('change', (e) => {
    state.tableLimit = Number((e.target as HTMLSelectElement).value);
    scheduleRender();
  });
  $<HTMLInputElement>('sound').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (on && !audio) audio = new AudioContext();
    if (on) void audio?.resume().then(beep);
  });
  const retry = () => void boot();
  $('chart-retry').addEventListener('click', retry);
  $('table-retry').addEventListener('click', retry);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      tracker?.pause();
      return;
    }
    tracker?.resume();
    void pollMids();
    void pollProtocol();
    void pollFeed();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    chart?.applyTheme();
    scheduleRender();
  });
  setInterval(() => {
    if (!document.hidden) renderDiagnostics(allPositions());
  }, 1_000);
}

function init(): void {
  chart = new ChartView($('chart'));
  const range = $<HTMLInputElement>('cascade-range');
  state.cascadeFraction = fractionFromSlider(Number(range.value));
  bindControls();
  void boot();
}

initLanding();
init();
