import { CandlestickSeries, ColorType, CrosshairMode, createChart, LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from 'papertrade-sdk';
import { HeatPrimitive, type HeatColors, type HeatData } from './heat-primitive.js';

export interface Palette extends HeatColors {
  text: string;
  grid: string;
  accent: string;
  up: string;
  down: string;
}

/** Read the page's CSS custom properties so the chart follows light and dark themes. */
export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const long = v('--long');
  const short = v('--short');
  return {
    text: v('--muted'),
    grid: v('--line'),
    accent: v('--accent'),
    up: short,
    down: long,
    long: withAlpha(long, 0.78),
    short: withAlpha(short, 0.78),
    protocolLong: withAlpha(long, 0.55),
    protocolShort: withAlpha(short, 0.55),
    label: v('--text'),
    labelBackground: v('--panel'),
  };
}

/** Add alpha to a #rrggbb colour. Falls back to the colour unchanged for any other format. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;

export class ChartView {
  private readonly chart: IChartApi;
  private readonly series: ISeriesApi<'Candlestick'>;
  private readonly heat = new HeatPrimitive();
  private markLine: IPriceLine | null = null;
  private cascadeLines: IPriceLine[] = [];
  private palette: Palette;
  private fitted = false;

  constructor(container: HTMLElement) {
    this.palette = readPalette();
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: this.palette.text, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11 },
      grid: { vertLines: { color: this.palette.grid }, horzLines: { color: this.palette.grid } },
      rightPriceScale: { borderColor: this.palette.grid, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderColor: this.palette.grid, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: (p: number) => p.toLocaleString('en-US', { maximumFractionDigits: p >= 1000 ? 1 : 2 }) },
    });
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: this.palette.up,
      downColor: this.palette.down,
      wickUpColor: this.palette.up,
      wickDownColor: this.palette.down,
      borderVisible: false,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    this.series.attachPrimitive(this.heat);
  }

  /** Re-read the CSS palette after a theme change. */
  applyTheme(): void {
    this.palette = readPalette();
    this.chart.applyOptions({
      layout: { textColor: this.palette.text },
      grid: { vertLines: { color: this.palette.grid }, horzLines: { color: this.palette.grid } },
      rightPriceScale: { borderColor: this.palette.grid },
      timeScale: { borderColor: this.palette.grid },
    });
    this.series.applyOptions({ upColor: this.palette.up, downColor: this.palette.down, wickUpColor: this.palette.up, wickDownColor: this.palette.down });
    if (this.markLine) this.markLine.applyOptions({ color: this.palette.accent });
    if (this.heat.data) this.heat.update({ ...this.heat.data, colors: this.palette });
  }

  get colors(): Palette {
    return this.palette;
  }

  setCandles(candles: readonly Candle[]): void {
    this.series.setData(candles.map((c) => ({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
    if (!this.fitted && candles.length) {
      this.chart.timeScale().fitContent();
      this.fitted = true;
    }
  }

  /** Reset the view for a new market or interval. */
  reset(): void {
    this.fitted = false;
    this.series.setData([]);
    this.setMark(null);
    this.setCascade(null, false);
  }

  updateCandle(c: Candle): void {
    this.series.update({ time: toTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close });
  }

  setMark(price: number | null): void {
    if (price === null) {
      if (this.markLine) this.series.removePriceLine(this.markLine);
      this.markLine = null;
      return;
    }
    if (this.markLine) this.markLine.applyOptions({ price });
    else {
      this.markLine = this.series.createPriceLine({ price, color: this.palette.accent, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'mark' });
    }
  }

  /** Dashed lines at mark minus and plus the cascade move. */
  setCascade(move: { mark: number; fraction: number } | null, visible: boolean): void {
    for (const l of this.cascadeLines) this.series.removePriceLine(l);
    this.cascadeLines = [];
    if (!move || !visible) return;
    const pct = (move.fraction * 100).toFixed(2);
    this.cascadeLines = [
      this.series.createPriceLine({ price: move.mark * (1 - move.fraction), color: this.palette.down, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `-${pct}%` }),
      this.series.createPriceLine({ price: move.mark * (1 + move.fraction), color: this.palette.up, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `+${pct}%` }),
    ];
  }

  setHeat(data: Omit<HeatData, 'colors'>): void {
    this.heat.update({ ...data, colors: this.palette });
  }

  destroy(): void {
    this.chart.remove();
  }
}
