import { describe, expect, it } from 'vitest';
import { parseCard } from './card';
import {
  chartColor,
  chartGeometry,
  chartLabelSteps,
  chartModel,
  chartRanges,
  chartSpec,
  niceTicks,
  progressShare,
  progressText,
  ringArc,
} from './card-chart';

const spec = (input: unknown) => {
  const r = parseCard(input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return chartSpec(r.card.root.children![0]!);
};

describe('chart numbers', () => {
  it('reads color names models write', () => {
    expect(chartColor('purple-500')).toBe('violet');
    expect(chartColor('Success')).toBe('green');
    expect(chartColor('#ff0000')).toBeUndefined();
  });

  it('picks round ticks that cover the values', () => {
    expect(niceTicks(0, 208, 4)).toEqual([0, 50, 100, 150, 200, 250]);
    expect(niceTicks(98, 208, 4)).toEqual([75, 100, 125, 150, 175, 200, 225]);
    expect(niceTicks(-3, 7, 4)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(0, 0.3, 4)).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);
  });

  it('stands bars on zero and lets a line sit on its own range', () => {
    const line = spec({
      type: 'Chart',
      data: [{ v: 100 }, { v: 120 }],
      series: [{ type: 'line', dataKey: 'v' }],
    });
    expect(chartModel(line).min).toBeGreaterThan(0);
    const bar = spec({
      type: 'Chart',
      data: [{ v: 100 }, { v: 120 }],
      series: [{ type: 'bar', dataKey: 'v' }],
    });
    expect(chartModel(bar).min).toBe(0);
  });

  it('stacks series that share a stack, and windows the last points', () => {
    const s = spec({
      type: 'Chart',
      data: [
        { d: 'a', x: 1, y: 2 },
        { d: 'b', x: 3, y: 4 },
        { d: 'c', x: 5, y: 6 },
      ],
      series: [
        { type: 'bar', dataKey: 'x', stack: 's' },
        { type: 'bar', dataKey: 'y', stack: 's' },
      ],
      xAxis: 'd',
      ranges: [2, 5],
    });
    const m = chartModel(s, 2);
    expect(m.labels).toEqual(['b', 'c']);
    expect(m.series[1]!.from).toEqual([3, 5]);
    expect(m.series[1]!.to).toEqual([7, 11]);
    expect(chartRanges(s)).toEqual([2]);
  });

  it('draws every mark as a path and breaks a line at a gap', () => {
    const s = spec({
      type: 'Chart',
      data: [{ v: 1 }, { v: null }, { v: 3 }, { v: 4 }],
      series: [{ type: 'line', dataKey: 'v' }],
    });
    const geo = chartGeometry(chartModel(s), {
      width: 300,
      height: 100,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
    });
    const line = geo.marks[0]!.line!;
    expect(line.match(/M/g)).toHaveLength(2);
    expect(geo.xs).toEqual([0, 100, 200, 300]);
    expect(geo.nearest(140)).toBe(1);
  });

  it('labels as many points across as fit', () => {
    expect(chartLabelSteps(30, 300, 6)).toEqual([0, 6, 12, 18, 24, 29]);
    expect(chartLabelSteps(31, 300, 6)).toEqual([0, 7, 14, 21, 30]);
    expect(chartLabelSteps(27, 300, 6)).toEqual([0, 6, 12, 18, 26]);
    expect(chartLabelSteps(3, 300, 4)).toEqual([0, 1, 2]);
  });
});

describe('meters', () => {
  it('counts out of max, or as a percentage', () => {
    expect(progressShare({ value: 9, max: 10 })).toBe(0.9);
    expect(progressShare({ value: 140 })).toBe(1);
    expect(progressText({ value: 3, max: 8 }, 'en-US')).toEqual({ value: '3', of: '8' });
    expect(progressText({ value: 45 }, 'en-US')).toEqual({ value: '45%' });
  });

  it('draws a ring arc from the top, clockwise', () => {
    expect(ringArc(50, 50, 40, 0)).toBe('');
    expect(ringArc(50, 50, 40, 0.25)).toBe('M50 10A40 40 0 0 1 90 50');
    expect(ringArc(50, 50, 40, 0.75)).toContain(' 0 1 1 ');
  });
});
