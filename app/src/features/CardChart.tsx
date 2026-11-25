import {
  CHART_COLORS,
  chartGeometry,
  chartLabelSteps,
  chartModel,
  chartNumber,
  chartRanges,
  chartSpec,
  progressShare,
  progressSpec,
  progressText,
  ringArc,
  type CardNode,
  type ChartColor,
} from '@leafbot/shared';
import { ChartLine, Minus, Table2, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useLocale, useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * A series color as CSS variables: `--viz` is the light step, or the dark one under a dark page,
 * so marks and swatches read `var(--viz)` and the page's theme picks the step.
 */
export const vizColor = (c: ChartColor): CSSProperties =>
  ({ '--viz-l': CHART_COLORS[c].light, '--viz-d': CHART_COLORS[c].dark }) as CSSProperties;
export const VIZ = '[--viz:var(--viz-l)] dark:[--viz:var(--viz-d)]';

const flexStyle = (node: CardNode): CSSProperties | undefined =>
  typeof node.flex === 'number' ? { flex: node.flex } : undefined;

/** Follows an element's width, for drawing to it. */
function useWidth(initial: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const w = Math.round(e!.contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/**
 * A chart on a card: bars, lines and areas over the bot's rows, with a crosshair and the values
 * of the point under the pointer, the windows of recent points the bot offered, and the same
 * numbers as a table for whoever reads them better that way.
 */
export function CardChart({ node }: { node: CardNode }) {
  const t = useT();
  const intl = useLocale((s) => s.intl);
  const spec = chartSpec(node);
  const ranges = chartRanges(spec);
  const [range, setRange] = useState<number | undefined>(undefined);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const { ref, width } = useWidth(320);
  const model = chartModel(spec, range);
  const height = spec.height ?? 200;
  const showY = spec.showYAxis !== false;
  const tickText = model.ticks.map((v) => chartNumber(v, intl));
  const left = showY ? Math.max(...tickText.map((l) => l.length)) * 6.5 + 10 : 6;
  const box = { width, height, left, right: 8, top: 8, bottom: spec.xAxis.hide ? 6 : 24 };
  const geo = chartGeometry(model, box);
  const longest = Math.max(1, ...model.labels.map((l) => l.length));
  const shownLabels = spec.xAxis.hide ? [] : chartLabelSteps(model.labels.length, width - left - 8, longest);
  const legend = model.series.length > 1 && spec.showLegend !== false;
  const tooltip = spec.showTooltip !== false;
  const banded = model.series.some((s) => s.type === 'bar');
  const band = (width - left - 8) / Math.max(1, model.labels.length);
  const pick = (clientX: number, el: SVGSVGElement) => {
    const r = el.getBoundingClientRect();
    setHover(geo.nearest(clientX - r.left));
  };
  const name = model.series.map((s) => s.label).join(', ');
  return (
    <div className="flex min-w-0 flex-col gap-2" style={flexStyle(node)}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {legend && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
            {model.series.map((s) => (
              <span
                key={s.dataKey}
                className={cn('flex items-center gap-1.5 text-xs text-muted-foreground', VIZ)}
                style={vizColor(s.color)}
              >
                <span className="size-2.5 rounded-[3px] bg-(--viz)" aria-hidden />
                {s.label}
              </span>
            ))}
          </div>
        )}
        {ranges.length > 0 && (
          <div className="ms-auto flex rounded-lg bg-muted p-0.5" role="radiogroup">
            {[...ranges, undefined].map((r) => (
              <button
                key={r ?? 'all'}
                type="button"
                role="radio"
                aria-checked={range === r}
                onClick={() => {
                  setRange(r);
                  setHover(null);
                }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs text-muted-foreground',
                  range === r && 'bg-background font-medium text-foreground shadow-sm',
                )}
              >
                {r ? t('card.rangeLast', { n: r }) : t('card.rangeAll')}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => setTable((v) => !v)}
          title={table ? t('card.chartPlot') : t('card.chartTable')}
          aria-label={table ? t('card.chartPlot') : t('card.chartTable')}
          className={cn(
            'rounded-md p-1 text-muted-foreground/70 hover:bg-accent hover:text-foreground',
            ranges.length === 0 && 'ms-auto',
          )}
        >
          {table ? <ChartLine className="size-3.5" /> : <Table2 className="size-3.5" />}
        </button>
      </div>
      <div className="relative" ref={ref}>
        {table ? (
          <ChartTable node={node} range={range} />
        ) : (
          <>
            <svg
              width={width}
              height={height}
              role="img"
              aria-label={name}
              className="block touch-pan-y overflow-visible select-none"
              onPointerMove={(e) => tooltip && pick(e.clientX, e.currentTarget)}
              onPointerDown={(e) => tooltip && pick(e.clientX, e.currentTarget)}
              onPointerLeave={() => setHover(null)}
            >
              {model.ticks.map((v, i) => (
                <g key={v}>
                  <line
                    x1={left}
                    x2={width - 8}
                    y1={geo.y(v)}
                    y2={geo.y(v)}
                    className={v === 0 ? 'stroke-border' : 'stroke-border/60'}
                    strokeDasharray={v === 0 ? undefined : '2 4'}
                  />
                  {showY && (
                    <text
                      x={left - 8}
                      y={geo.y(v)}
                      dy="0.32em"
                      textAnchor="end"
                      className="fill-muted-foreground text-[11px] tabular-nums"
                    >
                      {tickText[i]}
                    </text>
                  )}
                </g>
              ))}
              {hover !== null && banded && (
                <rect
                  x={geo.xs[hover]! - band / 2}
                  y={box.top}
                  width={band}
                  height={height - box.top - box.bottom}
                  className="fill-muted"
                />
              )}
              {geo.marks.map((m) => (
                <g key={m.key} className={VIZ} style={vizColor(m.color)}>
                  {m.type === 'area' && m.fill && <path d={m.fill} fill="var(--viz)" fillOpacity={0.14} />}
                  {m.type === 'bar' && m.fill && <path d={m.fill} fill="var(--viz)" />}
                  {m.line && (
                    <path
                      d={m.line}
                      fill="none"
                      stroke="var(--viz)"
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                  )}
                </g>
              ))}
              {shownLabels.map((i) => (
                <text
                  key={i}
                  x={geo.xs[i]}
                  y={height - 6}
                  textAnchor={
                    !banded && i === 0 ? 'start' : !banded && i === model.labels.length - 1 ? 'end' : 'middle'
                  }
                  className="fill-muted-foreground text-[11px]"
                >
                  {model.labels[i]}
                </text>
              ))}
              {hover !== null && !banded && (
                <line
                  x1={geo.xs[hover]}
                  x2={geo.xs[hover]}
                  y1={box.top}
                  y2={height - box.bottom}
                  className="stroke-foreground/40"
                  strokeDasharray="3 3"
                />
              )}
              {hover !== null &&
                model.series.map((s) => {
                  const v = s.to[hover];
                  if (s.type === 'bar' || v === null || v === undefined) return null;
                  return (
                    <circle
                      key={s.dataKey}
                      cx={geo.xs[hover]}
                      cy={geo.y(v)}
                      r={4.5}
                      fill="var(--viz)"
                      strokeWidth={2}
                      className={cn('stroke-card', VIZ)}
                      style={vizColor(s.color)}
                    />
                  );
                })}
            </svg>
            {hover !== null && (
              <div
                className={cn(
                  'pointer-events-none absolute top-1 z-20 rounded-lg bg-foreground px-2.5 py-1.5 text-xs whitespace-nowrap text-background shadow-md',
                  // Beside the crosshair, on the side with room, so the point stays in sight.
                  geo.xs[hover]! > width / 2 ? '-translate-x-[calc(100%+10px)]' : 'translate-x-2.5',
                )}
                style={{ left: geo.xs[hover]! }}
              >
                {model.labels[hover] && <div className="font-medium">{model.labels[hover]}</div>}
                {model.series.map((s) => (
                  <div
                    key={s.dataKey}
                    className={cn('flex items-center gap-1.5', VIZ)}
                    style={vizColor(s.color)}
                  >
                    {model.series.length > 1 && (
                      <span className="size-2 rounded-[2px] bg-(--viz)" aria-hidden />
                    )}
                    {model.series.length > 1 && <span className="opacity-80">{s.label}</span>}
                    <span className="ms-auto font-medium tabular-nums">
                      {s.values[hover] === null ? '–' : chartNumber(s.values[hover]!, intl, false)}
                    </span>
                    {model.series.length === 1 && <span className="opacity-80">{s.label}</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The chart's numbers as rows. */
function ChartTable({ node, range }: { node: CardNode; range?: number }) {
  const intl = useLocale((s) => s.intl);
  const spec = chartSpec(node);
  const rows = range ? spec.data.slice(-range) : spec.data;
  const x = spec.xAxis.dataKey;
  return (
    <div className="max-h-64 overflow-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-muted text-muted-foreground">
          <tr>
            <th className="px-2 py-1.5 text-start font-medium">{x === '#' ? '' : x}</th>
            {spec.series.map((s) => (
              <th key={s.dataKey} className="px-2 py-1.5 pe-7 text-end font-medium">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="px-2 py-1">{r[x] ?? ''}</td>
              {spec.series.map((s) => {
                const v = r[s.dataKey];
                return (
                  <td key={s.dataKey} className="px-2 py-1 text-end tabular-nums">
                    {typeof v === 'number' ? chartNumber(v, intl, false) : '–'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TONE: Record<string, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  danger: 'text-destructive',
  warning: 'text-amber-600 dark:text-amber-400',
  secondary: 'text-muted-foreground',
};
const TREND: Record<string, LucideIcon> = { up: TrendingUp, down: TrendingDown, flat: Minus };

/** One headline number: what it counts, the value, and how it moved. */
export function CardStat({ node, icon: Glyph }: { node: CardNode; icon?: LucideIcon }) {
  const trend = typeof node.trend === 'string' ? node.trend : undefined;
  const tone =
    typeof node.tone === 'string'
      ? node.tone
      : trend === 'up'
        ? 'success'
        : trend === 'down'
          ? 'danger'
          : 'secondary';
  const Arrow = trend ? TREND[trend] : undefined;
  const color = (node.color as ChartColor | undefined) ?? 'blue';
  return (
    <div
      className="flex min-w-0 flex-1 basis-36 items-center gap-3 rounded-xl border bg-background/50 p-3"
      style={flexStyle(node)}
    >
      {Glyph && (
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--viz)_16%,transparent)] text-(--viz)',
            VIZ,
          )}
          style={vizColor(color)}
        >
          <Glyph className="size-4.5" aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{String(node.label)}</div>
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-2xl leading-tight font-semibold tabular-nums">{String(node.value)}</span>
          {typeof node.delta === 'string' && (
            <span className={cn('flex items-center gap-0.5 text-xs font-medium tabular-nums', TONE[tone])}>
              {Arrow && <Arrow className="size-3.5" aria-hidden />}
              {node.delta}
            </span>
          )}
        </div>
        {typeof node.caption === 'string' && (
          <div className="truncate text-xs text-muted-foreground">{node.caption}</div>
        )}
      </div>
    </div>
  );
}

const RING: Record<string, number> = { sm: 72, md: 104, lg: 136 };

/** How far along something is, as a bar or a ring. */
export function CardProgress({ node }: { node: CardNode }) {
  const intl = useLocale((s) => s.intl);
  const p = progressSpec(node);
  const share = progressShare(p);
  const text = progressText(p, intl);
  const color = p.color ?? 'blue';
  if (p.variant === 'ring') {
    const size = RING[p.size ?? 'md']!;
    const stroke = Math.round(size / 11);
    const r = (size - stroke) / 2;
    return (
      <div
        className={cn('flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center', VIZ)}
        style={{ ...vizColor(color), ...flexStyle(node) }}
      >
        <div className="relative" style={{ width: size, height: size }}>
          <svg width={size} height={size} aria-hidden>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              strokeWidth={stroke}
              className="stroke-muted"
            />
            <path
              d={ringArc(size / 2, size / 2, r, share)}
              fill="none"
              stroke="var(--viz)"
              strokeWidth={stroke}
              strokeLinecap="round"
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="flex items-baseline">
              <span className={cn('font-semibold tabular-nums', size > 90 ? 'text-2xl' : 'text-lg')}>
                {text.value}
              </span>
              {text.of && (
                <span className="text-xs text-muted-foreground tabular-nums">&nbsp;/ {text.of}</span>
              )}
            </span>
          </div>
        </div>
        {p.label && <div className="text-sm font-medium">{p.label}</div>}
        {p.caption && <div className="text-xs text-muted-foreground">{p.caption}</div>}
      </div>
    );
  }
  return (
    <div
      className={cn('flex min-w-0 flex-1 flex-col gap-1.5', VIZ)}
      style={{ ...vizColor(color), ...flexStyle(node) }}
    >
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate font-medium">{p.label}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {text.of ? `${text.value} / ${text.of}` : text.value}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
        aria-label={p.label}
      >
        <div className="h-full rounded-full bg-(--viz)" style={{ width: `${share * 100}%` }} />
      </div>
      {p.caption && <div className="text-xs text-muted-foreground">{p.caption}</div>}
    </div>
  );
}
