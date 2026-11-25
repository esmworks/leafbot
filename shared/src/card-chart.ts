/**
 * The numbers behind a card's charts and meters, worked out once so the web and phone renderers
 * draw the same picture: the data a chart shows, its scale and ticks, and every mark as an SVG
 * path string (the web puts it in a <path>, the phone hands it to Skia).
 */

import type { CardNode } from './card';

/**
 * Series colors in a fixed order: a series takes the next one unless it names its own, so the
 * same chart always paints the same way. The steps were checked for color-blind separation as a
 * set, light and dark each against its own surface; do not reorder or re-step one alone.
 */
export const CHART_COLORS = {
  blue: { light: '#2a78d6', dark: '#3987e5' },
  orange: { light: '#eb6834', dark: '#d95926' },
  aqua: { light: '#1baf7a', dark: '#199e70' },
  yellow: { light: '#eda100', dark: '#c98500' },
  magenta: { light: '#e87ba4', dark: '#d55181' },
  green: { light: '#008300', dark: '#0ca30c' },
  violet: { light: '#6250d6', dark: '#9085e9' },
  red: { light: '#e34948', dark: '#e66767' },
} as const;

export type ChartColor = keyof typeof CHART_COLORS;
export const CHART_COLOR_ORDER = Object.keys(CHART_COLORS) as ChartColor[];

/** Names models write for colors, read as the nearest one here. */
const COLOR_WORDS: Record<string, ChartColor> = {
  blue: 'blue',
  primary: 'blue',
  info: 'blue',
  sky: 'blue',
  orange: 'orange',
  caution: 'orange',
  aqua: 'aqua',
  teal: 'aqua',
  cyan: 'aqua',
  mint: 'aqua',
  emerald: 'aqua',
  yellow: 'yellow',
  amber: 'yellow',
  gold: 'yellow',
  warning: 'yellow',
  magenta: 'magenta',
  pink: 'magenta',
  rose: 'magenta',
  fuchsia: 'magenta',
  green: 'green',
  success: 'green',
  lime: 'green',
  violet: 'violet',
  purple: 'violet',
  indigo: 'violet',
  discovery: 'violet',
  red: 'red',
  danger: 'red',
};

/** A color name as written ("blue", "purple-500", "success"), or none when it is not one. */
export function chartColor(v: unknown): ChartColor | undefined {
  if (typeof v !== 'string') return undefined;
  return COLOR_WORDS[
    v
      .trim()
      .toLowerCase()
      .replace(/[-_ ]?\d+$/, '')
  ];
}

export type ChartSeriesType = 'bar' | 'line' | 'area';

/** A series as kept on a checked card. */
export interface ChartSeriesSpec {
  type: ChartSeriesType;
  dataKey: string;
  label: string;
  color: ChartColor;
  stack?: string;
}

/** A chart as kept on a checked card: rows hold the x value and each series' number (or null). */
export interface ChartSpec {
  data: Record<string, string | number | null>[];
  series: ChartSeriesSpec[];
  xAxis: { dataKey: string; hide?: boolean };
  height?: number;
  showYAxis?: boolean;
  showLegend?: boolean;
  showTooltip?: boolean;
  /** Windows of the last N points the person can switch between; the whole chart is one more. */
  ranges?: number[];
}

export const chartSpec = (node: CardNode) => node as unknown as ChartSpec & CardNode;

export interface ChartSeries extends ChartSeriesSpec {
  values: (number | null)[];
  /** Where each value's mark starts and ends on the value axis (a stack's lower series lift it). */
  from: number[];
  to: (number | null)[];
}

export interface ChartModel {
  labels: string[];
  series: ChartSeries[];
  ticks: number[];
  min: number;
  max: number;
}

/** The ranges a chart offers for data this long: those shorter than it, then the whole. */
export function chartRanges(spec: ChartSpec): number[] {
  const n = spec.data.length;
  return (spec.ranges ?? []).filter((r) => r < n);
}

/** The chart's values, scale and ticks, over its last `range` points when one is given. */
export function chartModel(spec: ChartSpec, range?: number): ChartModel {
  const rows = range && range < spec.data.length ? spec.data.slice(-range) : spec.data;
  const labels = rows.map((r) => {
    const v = r[spec.xAxis.dataKey];
    return v === null || v === undefined ? '' : String(v);
  });
  const stacks = new Map<string, { up: number[]; down: number[] }>();
  const series: ChartSeries[] = spec.series.map((s) => {
    const values = rows.map((r) => {
      const v = r[s.dataKey];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    });
    const key = s.stack && s.type !== 'line' ? `${s.type}:${s.stack}` : null;
    let base = key ? stacks.get(key) : undefined;
    if (key && !base) {
      base = { up: rows.map(() => 0), down: rows.map(() => 0) };
      stacks.set(key, base);
    }
    const from: number[] = [];
    const to: (number | null)[] = [];
    values.forEach((v, i) => {
      if (!base) {
        from.push(0);
        to.push(v);
        return;
      }
      const side = (v ?? 0) < 0 ? base.down : base.up;
      from.push(side[i]!);
      if (v === null) {
        to.push(null);
        return;
      }
      side[i] = side[i]! + v;
      to.push(side[i]!);
    });
    return { ...s, values, from, to };
  });
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    s.to.forEach((v, i) => {
      if (v === null) return;
      // A line is read at its values; a filled mark also by where it starts.
      const start = s.type === 'line' ? v : s.from[i]!;
      lo = Math.min(lo, v, start);
      hi = Math.max(hi, v, start);
    });
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  // Bars and areas are read by their length, so they stand on zero; lines may sit on their range.
  const filled = series.some((s) => s.type !== 'line');
  if (filled) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    hi = lo + Math.max(1, Math.abs(lo) * 0.1);
    if (!filled) lo -= hi - lo;
  }
  const ticks = niceTicks(lo, hi, 4);
  return { labels, series, ticks, min: ticks[0]!, max: ticks[ticks.length - 1]! };
}

/**
 * Round ticks covering lo..hi, ends included: the finest round step (1, 2, 2.5, 5 times a power
 * of ten) that needs no more than `count + 2` intervals, so the scale wastes little room.
 */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const mag = 10 ** Math.floor(Math.log10(span / Math.max(1, count)));
  const steps = [0.5, 1, 2, 2.5, 5, 10, 20].map((m) => m * mag);
  const intervals = (step: number) => Math.ceil(hi / step - 1e-9) - Math.floor(lo / step + 1e-9);
  const step = steps.find((x) => intervals(x) <= count + 2) ?? steps[steps.length - 1]!;
  const start = Math.floor(lo / step + 1e-9) * step;
  const out: number[] = [];
  for (let i = 0; i <= intervals(step); i++) out.push(Number((start + i * step).toPrecision(12)) || 0);
  return out;
}

/** The plot area inside the drawing, after room for the axis labels. */
export interface ChartBox {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ChartMark {
  key: string;
  type: ChartSeriesType;
  color: ChartColor;
  /** A line's stroke, or the top edge of an area. */
  line?: string;
  /** An area's fill, or every bar of the series as one path. */
  fill?: string;
}

export interface ChartGeometry {
  marks: ChartMark[];
  /** Where each point sits across, for the crosshair and the labels below. */
  xs: number[];
  /** Where a value sits down. */
  y(v: number): number;
  /** The point nearest a place across. */
  nearest(x: number): number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A bar with its data end rounded, standing on its base whichever way it grows. */
function barPath(x: number, w: number, y0: number, y1: number, radius: number): string {
  const h = Math.abs(y1 - y0);
  if (h < 0.5 || w < 0.5) return '';
  const r = Math.min(radius, w / 2, h);
  if (r <= 0) return `M${r1(x)} ${r1(y0)}V${r1(y1)}H${r1(x + w)}V${r1(y0)}Z`;
  const up = y1 < y0;
  const end = y1;
  const dir = up ? 1 : -1;
  return [
    `M${r1(x)} ${r1(y0)}`,
    `L${r1(x)} ${r1(end + dir * r)}`,
    `Q${r1(x)} ${r1(end)} ${r1(x + r)} ${r1(end)}`,
    `L${r1(x + w - r)} ${r1(end)}`,
    `Q${r1(x + w)} ${r1(end)} ${r1(x + w)} ${r1(end + dir * r)}`,
    `L${r1(x + w)} ${r1(y0)}`,
    'Z',
  ].join('');
}

/** Every mark of the chart in the box, as path strings. */
export function chartGeometry(model: ChartModel, box: ChartBox): ChartGeometry {
  const n = model.labels.length;
  const plotW = Math.max(1, box.width - box.left - box.right);
  const plotH = Math.max(1, box.height - box.top - box.bottom);
  const y = (v: number) => box.top + plotH - ((v - model.min) / (model.max - model.min || 1)) * plotH;
  const bars = model.series.filter((s) => s.type === 'bar');
  // With bars every point owns a band; otherwise the points span the plot edge to edge.
  const banded = bars.length > 0;
  const band = plotW / Math.max(1, n);
  const xs = model.labels.map((_, i) =>
    banded ? box.left + band * (i + 0.5) : box.left + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)),
  );
  const groups = [...new Set(bars.map((s) => s.stack ?? `\u0000${s.dataKey}`))];
  const inner = band * 0.72;
  const gap = 2;
  const barW = Math.max(1, (inner - gap * (groups.length - 1)) / Math.max(1, groups.length));
  const marks: ChartMark[] = model.series.map((s, k) => {
    if (s.type === 'bar') {
      const group = s.stack ?? `\u0000${s.dataKey}`;
      const g = groups.indexOf(group);
      // Series stacked above this one, whose segments cover its end where they hold a value.
      const above = model.series.filter(
        (o, j) => j > k && o.type === 'bar' && o.stack && o.stack === s.stack,
      );
      const parts: string[] = [];
      s.to.forEach((top, i) => {
        if (top === null) return;
        const x = xs[i]! - inner / 2 + g * (barW + gap);
        // A stacked segment leaves a hairline of surface between it and the one below.
        const y0 = y(s.from[i]!) - (s.from[i] !== 0 ? Math.sign(top - s.from[i]!) * 1 : 0);
        const up = (s.values[i] ?? 0) >= 0;
        const covered = above.some(
          (o) => o.values[i] !== null && o.values[i] !== 0 && o.values[i]! >= 0 === up,
        );
        // Only the end of the whole bar is rounded; the segments inside a stack stay square.
        parts.push(barPath(x, barW, y0, y(top), covered ? 0 : 4));
      });
      return { key: s.dataKey, type: s.type, color: s.color, fill: parts.join('') };
    }
    // Lines break at a missing value instead of joining across it.
    let line = '';
    let pen = false;
    const runs: { i: number; y: number }[][] = [];
    s.to.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      const py = y(v);
      line += `${pen ? 'L' : 'M'}${r1(xs[i]!)} ${r1(py)}`;
      if (!pen) runs.push([]);
      runs[runs.length - 1]!.push({ i, y: py });
      pen = true;
    });
    if (s.type === 'line') return { key: s.dataKey, type: s.type, color: s.color, line };
    const fill = runs
      .map((run) => {
        const top = run.map((p, k) => `${k ? 'L' : 'M'}${r1(xs[p.i]!)} ${r1(p.y)}`).join('');
        const bottom = [...run]
          .reverse()
          .map((p) => `L${r1(xs[p.i]!)} ${r1(y(s.from[p.i]!))}`)
          .join('');
        return `${top}${bottom}Z`;
      })
      .join('');
    return { key: s.dataKey, type: s.type, color: s.color, line, fill };
  });
  const nearest = (x: number) => {
    let best = 0;
    xs.forEach((px, i) => {
      if (Math.abs(px - x) < Math.abs(xs[best]! - x)) best = i;
    });
    return best;
  };
  return { marks, xs, y, nearest };
}

/** Which x labels fit under the chart: every k-th, first and last kept, so none collide. */
export function chartLabelSteps(count: number, plotWidth: number, longest: number, charWidth = 7): number[] {
  if (!count) return [];
  const room = Math.max(1, Math.floor(plotWidth / (longest * charWidth + 12)));
  const every = Math.max(1, Math.ceil(count / room));
  const out: number[] = [];
  for (let i = 0; i < count; i += every) out.push(i);
  // The last point is always labeled; it takes the place of the one before when they would crowd.
  const last = count - 1;
  const prev = out[out.length - 1]!;
  if (prev !== last) {
    if (last - prev >= every * 0.8 || out.length === 1) out.push(last);
    else out[out.length - 1] = last;
  }
  return out;
}

/** A number written short for an axis or a tooltip: 1,2 B, 3,4 Mn. */
export function chartNumber(n: number, locale: string, compact = true): string {
  try {
    return new Intl.NumberFormat(locale, {
      notation: compact && Math.abs(n) >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: Math.abs(n) < 10 ? 2 : 1,
    }).format(n);
  } catch {
    return String(n);
  }
}

/** A meter as kept on a checked card. */
export interface ProgressSpec {
  value: number;
  max?: number;
  label?: string;
  caption?: string;
  variant?: 'bar' | 'ring';
  color?: ChartColor;
  size?: 'sm' | 'md' | 'lg';
}

export const progressSpec = (node: CardNode) => node as unknown as ProgressSpec & CardNode;

/** How full a meter is, 0..1. */
export function progressShare(p: ProgressSpec): number {
  const max = p.max && p.max > 0 ? p.max : 100;
  return Math.min(1, Math.max(0, p.value / max));
}

/** What a meter says in its middle or beside it: "9 / 10", or "90 %" when it counts out of 100. */
export function progressText(p: ProgressSpec, locale: string): { value: string; of?: string } {
  if (!p.max || p.max === 100) {
    return {
      value: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
        progressShare(p),
      ),
    };
  }
  return { value: chartNumber(p.value, locale), of: chartNumber(p.max, locale) };
}

/** A ring's arc from the top, clockwise, as a path for the share given. */
export function ringArc(cx: number, cy: number, r: number, share: number): string {
  if (share <= 0) return '';
  if (share >= 0.9999) {
    return `M${r1(cx)} ${r1(cy - r)}A${r} ${r} 0 1 1 ${r1(cx - 0.01)} ${r1(cy - r)}`;
  }
  const a = share * Math.PI * 2;
  const x = cx + r * Math.sin(a);
  const y = cy - r * Math.cos(a);
  return `M${r1(cx)} ${r1(cy - r)}A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${r1(x)} ${r1(y)}`;
}
