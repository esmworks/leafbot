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
import { INTL_LOCALE } from '@leafbot/shared/i18n';
import Feather from '@expo/vector-icons/Feather';
import { Canvas, Circle, DashPathEffect, Line, Path, vec } from '@shopify/react-native-skia';
import { Fragment, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import type { IconName } from '@/components/page';
import { locale, t } from '@/i18n';
import { useIsDark, type Colors } from '@/lib/theme';

const intl = () => INTL_LOCALE[locale];

/** A series color in the step for the theme shown. */
function useViz() {
  const dark = useIsDark();
  return (c: ChartColor) => CHART_COLORS[c][dark ? 'dark' : 'light'];
}

const flexOf = (node: CardNode) => (typeof node.flex === 'number' ? { flex: node.flex } : undefined);

/**
 * A chart on a card, drawn with Skia from the same paths as the web: a touch shows the values of
 * the nearest point, the bot's windows of recent points switch above it, and the numbers can be
 * read as a table instead.
 */
export function CardChart({ node, c }: { node: CardNode; c: Colors }) {
  const viz = useViz();
  const spec = chartSpec(node);
  const ranges = chartRanges(spec);
  const [range, setRange] = useState<number | undefined>(undefined);
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const model = chartModel(spec, range);
  const height = spec.height ?? 200;
  const showY = spec.showYAxis !== false;
  const tickText = model.ticks.map((v) => chartNumber(v, intl()));
  const left = showY ? Math.max(...tickText.map((l) => l.length)) * 6.5 + 10 : 6;
  const box = { width, height, left, right: 8, top: 8, bottom: spec.xAxis.hide ? 6 : 24 };
  const geo = chartGeometry(model, box);
  const longest = Math.max(1, ...model.labels.map((l) => l.length));
  const labels = spec.xAxis.hide ? [] : chartLabelSteps(model.labels.length, width - left - 8, longest);
  const legend = model.series.length > 1 && spec.showLegend !== false;
  const banded = model.series.some((s) => s.type === 'bar');
  const band = (width - left - 8) / Math.max(1, model.labels.length);
  const touch = (e: GestureResponderEvent) => {
    if (spec.showTooltip !== false) setHover(geo.nearest(e.nativeEvent.locationX));
  };
  return (
    <View style={[styles.chart, flexOf(node)]}>
      <View style={styles.head}>
        {legend ? (
          <View style={styles.legend}>
            {model.series.map((s) => (
              <View key={s.dataKey} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: viz(s.color) }]} />
                <Text style={[styles.small, { color: c.mutedForeground }]}>{s.label}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {ranges.length > 0 ? (
          <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: c.muted }]}>
            {[...ranges, undefined].map((r) => (
              <Pressable
                key={r ?? 'all'}
                accessibilityRole="radio"
                accessibilityState={{ checked: range === r }}
                onPress={() => {
                  setRange(r);
                  setHover(null);
                }}
                style={[styles.segment, range === r && { backgroundColor: c.card }]}
              >
                <Text
                  style={[
                    styles.small,
                    { color: range === r ? c.foreground : c.mutedForeground },
                    range === r && styles.strong,
                  ]}
                >
                  {r ? t('card.rangeLast', { n: r }) : t('card.rangeAll')}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={table ? t('card.chartPlot') : t('card.chartTable')}
          onPress={() => setTable((v) => !v)}
          hitSlop={8}
          style={[styles.toggle, ranges.length === 0 && styles.end]}
        >
          <Feather name={table ? 'trending-up' : 'grid'} size={14} color={c.mutedForeground} />
        </Pressable>
      </View>
      <View onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}>
        {table ? (
          <ChartTable node={node} range={range} c={c} />
        ) : width > 0 ? (
          <View
            style={{ width, height }}
            accessibilityLabel={model.series.map((s) => s.label).join(', ')}
            onStartShouldSetResponder={() => true}
            onResponderGrant={touch}
            onResponderMove={touch}
            onResponderTerminationRequest={() => true}
          >
            <Canvas style={{ width, height }}>
              {model.ticks.map((v) => (
                <Line
                  key={v}
                  p1={vec(left, geo.y(v))}
                  p2={vec(width - 8, geo.y(v))}
                  color={c.border}
                  strokeWidth={1}
                >
                  {v === 0 ? null : <DashPathEffect intervals={[2, 4]} />}
                </Line>
              ))}
              {hover !== null && banded ? (
                <Path
                  path={`M${geo.xs[hover]! - band / 2} ${box.top}h${band}V${height - box.bottom}h${-band}Z`}
                  color={c.muted}
                />
              ) : null}
              {geo.marks.map((m) => (
                <Mark key={m.key} d={m} color={viz(m.color)} />
              ))}
              {hover !== null && !banded ? (
                <Line
                  p1={vec(geo.xs[hover]!, box.top)}
                  p2={vec(geo.xs[hover]!, height - box.bottom)}
                  color={c.mutedForeground}
                  strokeWidth={1}
                >
                  <DashPathEffect intervals={[3, 3]} />
                </Line>
              ) : null}
              {hover !== null
                ? model.series.map((s) => {
                    const v = s.to[hover];
                    if (s.type === 'bar' || v === null || v === undefined) return null;
                    return (
                      <Fragment key={s.dataKey}>
                        <Circle cx={geo.xs[hover]!} cy={geo.y(v)} r={6} color={c.card} />
                        <Circle cx={geo.xs[hover]!} cy={geo.y(v)} r={4} color={viz(s.color)} />
                      </Fragment>
                    );
                  })
                : null}
            </Canvas>
            {showY
              ? model.ticks.map((v, i) => (
                  <Text
                    key={v}
                    style={[styles.yLabel, { top: geo.y(v) - 7, width: left - 8, color: c.mutedForeground }]}
                  >
                    {tickText[i]}
                  </Text>
                ))
              : null}
            {labels.map((i) => (
              <Text
                key={i}
                numberOfLines={1}
                style={[
                  styles.xLabel,
                  { left: geo.xs[i]! - 40, color: c.mutedForeground },
                  !banded && i === 0 && { left: geo.xs[i]!, textAlign: 'left' },
                  !banded && i === model.labels.length - 1 && { left: geo.xs[i]! - 80, textAlign: 'right' },
                ]}
              >
                {model.labels[i]}
              </Text>
            ))}
            {hover !== null ? (
              <View
                pointerEvents="none"
                style={[
                  styles.tip,
                  {
                    backgroundColor: c.foreground,
                    // Beside the crosshair, on the side with room, so the point stays in sight.
                    left:
                      geo.xs[hover]! > width / 2 ? Math.max(0, geo.xs[hover]! - 150) : geo.xs[hover]! + 10,
                  },
                ]}
              >
                {model.labels[hover] ? (
                  <Text style={[styles.small, styles.strong, { color: c.background }]}>
                    {model.labels[hover]}
                  </Text>
                ) : null}
                {model.series.map((s) => (
                  <View key={s.dataKey} style={styles.legendItem}>
                    <View style={[styles.dot, { backgroundColor: viz(s.color) }]} />
                    <Text style={[styles.small, { color: c.background }]}>
                      {s.values[hover] === null ? '–' : chartNumber(s.values[hover]!, intl(), false)}{' '}
                      {s.label}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ height }} />
        )}
      </View>
    </View>
  );
}

function Mark({ d, color }: { d: { type: string; line?: string; fill?: string }; color: string }) {
  return (
    <>
      {d.type === 'area' && d.fill ? <Path path={d.fill} color={color} opacity={0.14} /> : null}
      {d.type === 'bar' && d.fill ? <Path path={d.fill} color={color} /> : null}
      {d.line ? (
        <Path
          path={d.line}
          color={color}
          style="stroke"
          strokeWidth={2}
          strokeJoin="round"
          strokeCap="round"
        />
      ) : null}
    </>
  );
}

/** The chart's numbers as rows. */
function ChartTable({ node, range, c }: { node: CardNode; range?: number; c: Colors }) {
  const spec = chartSpec(node);
  const rows = range ? spec.data.slice(-range) : spec.data;
  const x = spec.xAxis.dataKey;
  const cell = [styles.small, styles.cell, { color: c.foreground }];
  return (
    <ScrollView style={[styles.table, { borderColor: c.border }]} nestedScrollEnabled>
      <View style={[styles.tr, { backgroundColor: c.muted }]}>
        <Text style={[...cell, { color: c.mutedForeground }]}>{x === '#' ? '' : x}</Text>
        {spec.series.map((s) => (
          <Text key={s.dataKey} style={[...cell, styles.num, { color: c.mutedForeground }]}>
            {s.label}
          </Text>
        ))}
      </View>
      {rows.map((r, i) => (
        <View
          key={i}
          style={[styles.tr, { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth }]}
        >
          <Text style={cell}>{r[x] ?? ''}</Text>
          {spec.series.map((s) => {
            const v = r[s.dataKey];
            return (
              <Text key={s.dataKey} style={[...cell, styles.num]}>
                {typeof v === 'number' ? chartNumber(v, intl(), false) : '–'}
              </Text>
            );
          })}
        </View>
      ))}
    </ScrollView>
  );
}

const TREND: Record<string, IconName> = { up: 'trending-up', down: 'trending-down', flat: 'minus' };

/** One headline number: what it counts, the value, and how it moved. */
/** `bare`: without a frame of its own, for a figure that already sits in one (a dashboard tile). */
export function CardStat({
  node,
  icon,
  c,
  bare,
}: {
  node: CardNode;
  icon?: IconName;
  c: Colors;
  bare?: boolean;
}) {
  const viz = useViz();
  const trend = typeof node.trend === 'string' ? node.trend : undefined;
  const tone =
    typeof node.tone === 'string'
      ? node.tone
      : trend === 'up'
        ? 'success'
        : trend === 'down'
          ? 'danger'
          : 'secondary';
  const toneColor =
    tone === 'success'
      ? c.success
      : tone === 'danger'
        ? c.destructive
        : tone === 'warning'
          ? c.amber
          : c.mutedForeground;
  const color = viz((node.color as ChartColor | undefined) ?? 'blue');
  return (
    <View
      style={[
        styles.stat,
        bare ? styles.bare : { borderColor: c.border, backgroundColor: c.background },
        flexOf(node),
      ]}
    >
      {icon ? (
        <View style={[styles.statIcon, { backgroundColor: `${color}29` }]}>
          <Feather name={icon} size={17} color={color} />
        </View>
      ) : null}
      <View style={styles.shrink}>
        <Text numberOfLines={1} style={[styles.small, { color: c.mutedForeground }]}>
          {String(node.label)}
        </Text>
        <View style={styles.statLine}>
          <Text style={[styles.statValue, { color: c.foreground }]}>{String(node.value)}</Text>
          {typeof node.delta === 'string' ? (
            <View style={styles.legendItem}>
              {trend ? <Feather name={TREND[trend]!} size={13} color={toneColor} /> : null}
              <Text style={[styles.small, styles.strong, { color: toneColor }]}>{node.delta}</Text>
            </View>
          ) : null}
        </View>
        {typeof node.caption === 'string' ? (
          <Text numberOfLines={1} style={[styles.small, { color: c.mutedForeground }]}>
            {node.caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const RING: Record<string, number> = { sm: 72, md: 104, lg: 136 };

/** How far along something is, as a bar or a ring. */
export function CardProgress({ node, c }: { node: CardNode; c: Colors }) {
  const viz = useViz();
  const p = progressSpec(node);
  const share = progressShare(p);
  const text = progressText(p, intl());
  const color = viz(p.color ?? 'blue');
  if (p.variant === 'ring') {
    const size = RING[p.size ?? 'md']!;
    const stroke = Math.round(size / 11);
    const r = (size - stroke) / 2;
    const arc = ringArc(size / 2, size / 2, r, share);
    return (
      <View style={[styles.ringBox, flexOf(node)]}>
        <View style={{ width: size, height: size }}>
          <Canvas style={{ width: size, height: size }}>
            <Circle cx={size / 2} cy={size / 2} r={r} color={c.muted} style="stroke" strokeWidth={stroke} />
            {arc ? (
              <Path path={arc} color={color} style="stroke" strokeWidth={stroke} strokeCap="round" />
            ) : null}
          </Canvas>
          <View style={styles.ringMiddle}>
            <Text style={[size > 90 ? styles.ringBig : styles.ringSmall, { color: c.foreground }]}>
              {text.value}
              {text.of ? (
                <Text style={[styles.small, { color: c.mutedForeground }]}> / {text.of}</Text>
              ) : null}
            </Text>
          </View>
        </View>
        {p.label ? (
          <Text style={[styles.body, styles.strong, { color: c.foreground }]}>{p.label}</Text>
        ) : null}
        {p.caption ? <Text style={[styles.small, { color: c.mutedForeground }]}>{p.caption}</Text> : null}
      </View>
    );
  }
  return (
    <View style={[styles.barBox, flexOf(node)]}>
      <View style={styles.barHead}>
        <Text numberOfLines={1} style={[styles.body, styles.strong, styles.shrink, { color: c.foreground }]}>
          {p.label ?? ''}
        </Text>
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {text.of ? `${text.value} / ${text.of}` : text.value}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
        style={[styles.track, { backgroundColor: c.muted }]}
      >
        <View style={[styles.fill, { width: `${share * 100}%`, backgroundColor: color }]} />
      </View>
      {p.caption ? <Text style={[styles.small, { color: c.mutedForeground }]}>{p.caption}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chart: { alignSelf: 'stretch', gap: 8 },
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  legend: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  dot: { width: 8, height: 8, borderRadius: 2 },
  segments: { flexDirection: 'row', borderRadius: 8, padding: 2, marginLeft: 'auto' },
  segment: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  toggle: { padding: 4 },
  end: { marginLeft: 'auto' },
  small: { fontSize: 12, lineHeight: 16 },
  body: { fontSize: 15, lineHeight: 21 },
  strong: { fontWeight: '600' },
  shrink: { flexShrink: 1 },
  yLabel: { position: 'absolute', left: 0, fontSize: 11, textAlign: 'right', fontVariant: ['tabular-nums'] },
  xLabel: { position: 'absolute', bottom: 2, width: 80, fontSize: 11, textAlign: 'center' },
  tip: {
    position: 'absolute',
    top: 4,
    width: 140,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 2,
  },
  table: { maxHeight: 260, borderWidth: 1, borderRadius: 8 },
  tr: { flexDirection: 'row' },
  cell: { flex: 1, paddingHorizontal: 8, paddingVertical: 5 },
  num: { textAlign: 'right', fontVariant: ['tabular-nums'] },
  stat: {
    flexGrow: 1,
    flexBasis: 140,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  // Alone in a column, a basis would set its height rather than its width.
  bare: { borderWidth: 0, padding: 0, flexGrow: 0, flexBasis: 'auto' },
  statIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  statLine: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 6 },
  statValue: { fontSize: 24, lineHeight: 30, fontWeight: '600', fontVariant: ['tabular-nums'] },
  ringBox: { flexGrow: 1, alignItems: 'center', gap: 6 },
  ringMiddle: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringBig: { fontSize: 24, fontWeight: '600', fontVariant: ['tabular-nums'] },
  ringSmall: { fontSize: 17, fontWeight: '600', fontVariant: ['tabular-nums'] },
  barBox: { flexGrow: 1, alignSelf: 'stretch', gap: 6 },
  barHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
});
