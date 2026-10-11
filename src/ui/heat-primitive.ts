import type { IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time, AutoscaleInfo, Logical } from 'lightweight-charts';
import type { Bucket } from '../buckets.js';

export interface HeatColors {
  long: string;
  short: string;
  protocolLong: string;
  protocolShort: string;
  label: string;
  labelBackground: string;
}

export interface HeatData {
  /** Followed wallets, drawn as solid bars. */
  buckets: readonly Bucket[];
  /** The protocol-wide API map, drawn as outline bars behind them. Empty when hidden. */
  protocol: readonly Bucket[];
  mark: number;
  colors: HeatColors;
  /** Largest notional across both layers, so the bars share one scale. */
  maxNotional: number;
  /** Price range to keep in view, in dollars. */
  visible: { from: number; to: number } | null;
}

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/** Fraction of the pane width the longest bar may use. */
const MAX_BAR_WIDTH = 0.34;

class Renderer implements IPrimitivePaneRenderer {
  constructor(private readonly source: HeatPrimitive) {}

  draw(target: DrawTarget): void {
    const { data, series } = this.source;
    if (!data || !series || data.maxNotional <= 0) return;
    target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const maxWidth = bitmapSize.width * MAX_BAR_WIDTH;
      const bar = (b: Bucket, notional: number, fill: string, outline: boolean) => {
        if (notional <= 0) return;
        const y1 = series.priceToCoordinate(b.hi);
        const y2 = series.priceToCoordinate(b.lo);
        if (y1 === null || y2 === null) return;
        const top = Math.min(y1, y2) * vr;
        const height = Math.max(1, Math.abs(y2 - y1) * vr - (outline ? 0 : 1 * vr));
        const width = Math.max(2 * hr, (notional / data.maxNotional) * maxWidth);
        const x = bitmapSize.width - width;
        if (outline) {
          ctx.strokeStyle = fill;
          ctx.lineWidth = Math.max(1, hr);
          ctx.strokeRect(x + 0.5, top + 0.5, width - 1, Math.max(1, height - 1));
        } else {
          ctx.fillStyle = fill;
          ctx.fillRect(x, top, width, height);
        }
      };
      for (const b of data.protocol) {
        bar(b, b.longNotional, data.colors.protocolLong, true);
        bar(b, b.shortNotional, data.colors.protocolShort, true);
      }
      for (const b of data.buckets) {
        bar(b, b.longNotional, data.colors.long, false);
        bar(b, b.shortNotional, data.colors.short, false);
      }
    });
  }
}

class View implements IPrimitivePaneView {
  private readonly rend: Renderer;
  constructor(source: HeatPrimitive) {
    this.rend = new Renderer(source);
  }
  zOrder() {
    return 'normal' as const;
  }
  renderer() {
    return this.rend;
  }
}

/** A series primitive that paints notional-at-risk bars against the price axis, anchored to the right edge of the pane. */
export class HeatPrimitive implements ISeriesPrimitive<Time> {
  data: HeatData | null = null;
  series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly view = new View(this);

  attached(param: SeriesAttachedParameter<Time>): void {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews() {
    return [this.view];
  }

  autoscaleInfo(_start: Logical, _end: Logical): AutoscaleInfo | null {
    const v = this.data?.visible;
    return v ? { priceRange: { minValue: v.from, maxValue: v.to } } : null;
  }

  update(data: HeatData): void {
    this.data = data;
    this.requestUpdate?.();
  }
}
