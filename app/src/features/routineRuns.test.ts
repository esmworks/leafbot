import type { Message } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { foldedRuns, foldRoutineRuns, isRoutineRunLine } from './routineRuns';

let n = 0;
const msg = (over: Partial<Message> & { props?: Record<string, unknown> }): Message =>
  ({
    id: `m${++n}`,
    threadId: 't',
    role: 'user',
    author: 'user',
    text: '',
    props: {},
    createdAt: '2026-11-24T06:00:00.000Z',
    turnId: null,
    ...over,
  }) as Message;

const run = (
  routine: string,
  runId: string,
  at: string,
  status = 'done',
  extra: Record<string, unknown> = {},
) =>
  msg({
    author: `routine:${routine}`,
    text: 'Mailleri kontrol et',
    createdAt: at,
    props: { routineRunId: runId, routineName: routine, routineRunStatus: status, ...extra },
  });

describe('rutin çalışma satırları', () => {
  it('aynı rutinin art arda biten çalışmalarını tek satırda toplar', () => {
    const a = run('r1', 'x1', '2026-11-24T06:00:00.000Z', 'done', { routineQuiet: true });
    const b = run('r1', 'x2', '2026-11-24T10:00:00.000Z', 'done', { routineQuiet: true });
    const c = run('r1', 'x3', '2026-11-24T14:00:00.000Z', 'done', { routineQuiet: true });
    const rows = foldRoutineRuns([a, b, c]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(a.id);
    expect(foldedRuns(rows[0]!)?.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
  });

  it('araya mesaj giren, başka rutinin, başka günün ya da süren çalışmayı toplamaz', () => {
    const a = run('r1', 'x1', '2026-11-24T06:00:00.000Z');
    const reply = msg({ role: 'assistant', author: 'bot:b', createdAt: '2026-11-24T06:01:00.000Z' });
    const b = run('r1', 'x2', '2026-11-24T10:00:00.000Z');
    const other = run('r2', 'y1', '2026-11-24T11:00:00.000Z');
    const c = run('r2', 'y2', '2026-11-25T06:00:00.000Z');
    const going = run('r2', 'y3', '2026-11-25T07:00:00.000Z', 'running');
    const rows = foldRoutineRuns([a, reply, b, other, c, going]);
    expect(rows.map((m) => m.id)).toEqual([a.id, reply.id, b.id, other.id, c.id, going.id]);
    expect(rows.every((m) => !foldedRuns(m))).toBe(true);
  });

  it('bir çalışmanın adımlarını ayrı çalışma saymaz, yeni mesaj çizgisinde ayırır', () => {
    const s1 = run('r1', 'x1', '2026-11-24T06:00:00.000Z', 'done', { routineStep: 1 });
    const s2 = run('r1', 'x1', '2026-11-24T06:01:00.000Z', 'done', { routineStep: 2 });
    expect(foldRoutineRuns([s1, s2]).map((m) => m.id)).toEqual([s1.id, s2.id]);

    const a = run('r1', 'x2', '2026-11-24T08:00:00.000Z');
    const b = run('r1', 'x3', '2026-11-24T09:00:00.000Z');
    expect(foldRoutineRuns([a, b], b.id).map((m) => m.id)).toEqual([a.id, b.id]);
  });

  it('dışarıdan gelen metni taşıyan talimat mesaj olarak kalır', () => {
    expect(isRoutineRunLine(run('r1', 'x1', '2026-11-24T06:00:00.000Z'))).toBe(true);
    expect(isRoutineRunLine(run('r1', 'x1', '2026-11-24T06:00:00.000Z', 'done', { payload: true }))).toBe(
      false,
    );
    expect(isRoutineRunLine(msg({}))).toBe(false);
  });

  it('raporu, çalışma satırı hemen üstündeyse başlıksız, araya bir şey girdiyse başlıklı gösterir', () => {
    const line = run('r1', 'x1', '2026-11-24T06:00:00.000Z');
    const report = msg({
      role: 'assistant',
      author: 'bot:b',
      createdAt: '2026-11-24T06:01:00.000Z',
      props: { routineInMain: true, routineRunId: 'x1' },
    });
    expect(foldRoutineRuns([line, report]).at(-1)!.props.underRunLine).toBe(true);
    const between = msg({ role: 'marker', author: 'bot:b', createdAt: '2026-11-24T06:00:30.000Z' });
    expect(foldRoutineRuns([line, between, report]).at(-1)!.props.underRunLine).toBeUndefined();
  });
});
