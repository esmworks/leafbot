import { describe, expect, it } from 'vitest';
import { BotCreate, BotUpdate } from './schemas';
import {
  cronTooOften,
  describeSchedule,
  localStamp,
  nextRun,
  nextRunBefore,
  occurrenceKey,
  routineEnded,
  RoutineUpdate,
  Schedule,
  zonedTime,
} from './schedule';

const at = (iso: string) => new Date(iso);
const next = (s: Schedule, tz: string, after: string, last?: string) =>
  nextRun(s, tz, at(after), last ? at(last) : null)?.toISOString() ?? null;

describe('nextRun', () => {
  it('zamanlamasız rutinin saati yoktur', () => {
    expect(next({ type: 'unscheduled' }, 'Europe/Istanbul', '2026-11-16T05:30:00Z')).toBeNull();
    expect(describeSchedule({ type: 'unscheduled' }, 'en')).toBe('No schedule: by an event or by hand');
    expect(Schedule.safeParse({ type: 'unscheduled' }).success).toBe(true);
  });

  it('günlük, saat dilimine göre', () => {
    // Istanbul is UTC+3 all year.
    expect(next({ type: 'daily', time: '09:00' }, 'Europe/Istanbul', '2026-11-16T05:30:00Z')).toBe(
      '2026-11-16T06:00:00.000Z',
    );
    expect(next({ type: 'daily', time: '09:00' }, 'Europe/Istanbul', '2026-11-16T06:00:00Z')).toBe(
      '2026-11-17T06:00:00.000Z',
    );
  });

  it('hafta içi cumartesi ve pazarı atlar', () => {
    // 2026-11-20 is a Friday.
    expect(next({ type: 'weekdays', time: '08:00' }, 'UTC', '2026-11-20T09:00:00Z')).toBe(
      '2026-11-23T08:00:00.000Z',
    );
  });

  it('haftalık, seçili günler', () => {
    expect(next({ type: 'weekly', days: [3, 5], time: '18:30' }, 'UTC', '2026-11-16T00:00:00Z')).toBe(
      '2026-11-18T18:30:00.000Z',
    );
  });

  it('aylık 31: o günü olmayan ayları atlar', () => {
    expect(next({ type: 'monthly', day: 31, time: '10:00' }, 'UTC', '2026-11-01T00:00:00Z')).toBe(
      '2026-12-31T10:00:00.000Z',
    );
  });

  it('saatlik', () => {
    expect(next({ type: 'hourly', minute: 15 }, 'Asia/Kolkata', '2026-11-16T10:00:00Z')).toBe(
      '2026-11-16T10:45:00.000Z',
    );
  });

  it('aralık: son çalıştırmaya göre, kaçırılanları tek seferde atlar', () => {
    const s: Schedule = { type: 'interval', minutes: 30 };
    expect(next(s, 'UTC', '2026-11-16T10:05:00Z', '2026-11-16T10:00:00Z')).toBe('2026-11-16T10:30:00.000Z');
    expect(next(s, 'UTC', '2026-11-16T13:10:00Z', '2026-11-16T10:00:00Z')).toBe('2026-11-16T13:30:00.000Z');
  });

  it('aralık günler ve saatlerle sınırlanabilir; dışarıda kalan çalışma bir sonraki izinli başa kayar', () => {
    // 2026-11-16 is a Monday. Weekdays, 09:00–18:00 Istanbul (UTC+3).
    const s: Schedule = { type: 'interval', minutes: 60, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00' };
    const tz = 'Europe/Istanbul';
    // Inside the window: an hour after the last run.
    expect(next(s, tz, '2026-11-16T08:05:00Z', '2026-11-16T08:00:00Z')).toBe('2026-11-16T09:00:00.000Z');
    // 18:00 is the last run of the day; the next is 09:00 tomorrow.
    expect(next(s, tz, '2026-11-16T15:00:00Z', '2026-11-16T15:00:00Z')).toBe('2026-11-17T06:00:00.000Z');
    // Before the window opens: at its start.
    expect(next(s, tz, '2026-11-16T03:00:00Z')).toBe('2026-11-16T06:00:00.000Z');
    // Friday evening: Monday morning.
    expect(next(s, tz, '2026-11-20T16:00:00Z', '2026-11-20T15:00:00Z')).toBe('2026-11-23T06:00:00.000Z');
    // Days alone, all day long.
    const weekend: Schedule = { type: 'interval', minutes: 30, days: [0, 6] };
    expect(next(weekend, 'UTC', '2026-11-20T10:05:00Z', '2026-11-20T10:00:00Z')).toBe(
      '2026-11-21T00:00:00.000Z',
    );
    expect(next(weekend, 'UTC', '2026-11-21T00:05:00Z', '2026-11-21T00:00:00Z')).toBe(
      '2026-11-21T00:30:00.000Z',
    );
  });

  it('saat aralığının iki ucu birlikte ve sıralı olmalı', () => {
    expect(Schedule.safeParse({ type: 'interval', minutes: 30, from: '09:00' }).success).toBe(false);
    expect(Schedule.safeParse({ type: 'interval', minutes: 30, from: '18:00', to: '09:00' }).success).toBe(
      false,
    );
    expect(Schedule.safeParse({ type: 'interval', minutes: 30, from: '09:00', to: '18:00' }).success).toBe(
      true,
    );
    expect(
      describeSchedule({ type: 'interval', minutes: 30, days: [5, 1], from: '09:00', to: '18:00' }, 'en'),
    ).toBe('Every 30 minutes, Mon, Fri, between 09:00 and 18:00');
  });

  it('yaz saati: ileri alınan günde kaybolan saat bir sonraki güne kayar, geri alınan saat bir kez çalışır', () => {
    // US spring forward: 2026-03-08 02:00 -> 03:00 in New York.
    expect(next({ type: 'daily', time: '02:30' }, 'America/New_York', '2026-03-08T05:00:00Z')).toBe(
      '2026-03-09T06:30:00.000Z',
    );
    // US fall back: 2026-11-01 01:30 happens twice (05:30Z and 06:30Z).
    const s: Schedule = { type: 'daily', time: '01:30' };
    const first = next(s, 'America/New_York', '2026-11-01T04:00:00Z');
    expect(first).toBe('2026-11-01T05:30:00.000Z');
    expect(next(s, 'America/New_York', first!, first!)).toBe('2026-11-02T06:30:00.000Z');
  });

  it('beş dakikadan sık çalışan cron ifadesi fark edilir', () => {
    expect(cronTooOften('* * * * *')).toBe(true);
    expect(cronTooOften('*/2 9 * * *')).toBe(true);
    expect(cronTooOften('0,3 * * * *')).toBe(true);
    expect(cronTooOften('*/5 * * * *')).toBe(false);
    expect(cronTooOften('0 9 * * 1-5')).toBe(false);
    expect(cronTooOften('0,30 8-17 * * *')).toBe(false);
  });

  it('anahtar dakikaya yuvarlanır', () => {
    expect(occurrenceKey(at('2026-11-16T10:00:42.123Z'))).toBe('2026-11-16T10:00:00.000Z');
  });

  it('Türkçe açıklama', () => {
    expect(describeSchedule({ type: 'weekly', days: [5, 1], time: '09:00' })).toBe('Pazartesi, Cuma 09:00');
    expect(describeSchedule({ type: 'interval', minutes: 120 })).toBe('2 saatte bir');
  });

  it('İngilizce açıklama', () => {
    expect(describeSchedule({ type: 'weekly', days: [5, 1], time: '09:00' }, 'en')).toBe(
      'Monday, Friday at 09:00',
    );
    expect(describeSchedule({ type: 'interval', minutes: 120 }, 'en')).toBe('Every 2 hours');
    expect(describeSchedule({ type: 'interval', minutes: 60 }, 'en')).toBe('Every hour');
    expect(describeSchedule({ type: 'hourly', minute: 5 }, 'en')).toBe('Every hour at :05');
  });
});

describe('PATCH şemaları', () => {
  it('gönderilmeyen alanlara varsayılan yazmaz', () => {
    expect(BotUpdate.parse({ name: 'x' })).toEqual({ name: 'x' });
    expect(RoutineUpdate.parse({ enabled: false })).toEqual({ enabled: false });
    expect(BotCreate.parse({ name: 'x' }).permissionMode).toBe('auto');
  });

  it('tek seferlik zamanı saat diliminde bir kez verir; çalıştıktan sonra boş döner', () => {
    const once = { type: 'once', date: '2026-11-20', time: '09:30' } as const;
    expect(zonedTime('2026-11-20', '09:30', 'Europe/Istanbul').toISOString()).toBe(
      '2026-11-20T06:30:00.000Z',
    );
    expect(zonedTime('2026-07-01', '12:00', 'Europe/Berlin').toISOString()).toBe('2026-07-01T10:00:00.000Z');
    const at = nextRun(once, 'Europe/Istanbul', new Date('2026-11-16T00:00:00Z'));
    expect(at?.toISOString()).toBe('2026-11-20T06:30:00.000Z');
    expect(nextRun(once, 'Europe/Istanbul', new Date('2026-11-21T00:00:00Z'), at)).toBeNull();
    expect(describeSchedule(once, 'en')).toBe('Once, on Nov 20, 2026 at 09:30');
    expect(Schedule.safeParse({ type: 'once', date: '20.11.2026', time: '09:30' }).success).toBe(false);
  });
});

describe('localStamp', () => {
  it('anı saat dilimindeki duvar saatiyle ve ofsetiyle yazar', () => {
    // A bot shown 12:13Z repeated it as the local time; Istanbul read it at 15:13.
    expect(localStamp(new Date('2026-11-24T12:13:56Z'), 'Europe/Istanbul')).toBe('2026-11-24T15:13:56+03:00');
    // Past midnight UTC-wise the local day is the next one.
    expect(localStamp(new Date('2026-11-24T22:30:05Z'), 'Europe/Istanbul')).toBe('2026-11-25T01:30:05+03:00');
    expect(localStamp(new Date('2026-01-10T15:00:00Z'), 'America/New_York')).toBe(
      '2026-01-10T10:00:00-05:00',
    );
    expect(localStamp(new Date('2026-07-01T10:00:00Z'), 'Asia/Kolkata')).toBe('2026-07-01T15:30:00+05:30');
    expect(localStamp(new Date('2026-07-01T10:00:00Z'), 'UTC')).toBe('2026-07-01T10:00:00+00:00');
  });
});

describe('every few weeks', () => {
  const tz = 'Europe/Istanbul';
  const fortnightly = (anchor: string, days = [5]): Schedule => ({
    type: 'weekly',
    days,
    time: '09:00',
    weeks: 2,
    anchor,
  });

  it('runs in the anchor week and skips the week between', () => {
    expect(next(fortnightly('2026-11-23'), tz, '2026-11-25T00:00:00Z')).toBe('2026-11-27T06:00:00.000Z');
    expect(next(fortnightly('2026-11-23'), tz, '2026-11-27T07:00:00Z')).toBe('2026-12-11T06:00:00.000Z');
  });

  it('counts the weeks both ways from the anchor', () => {
    expect(next(fortnightly('2026-12-07'), tz, '2026-11-25T00:00:00Z')).toBe('2026-11-27T06:00:00.000Z');
    expect(next(fortnightly('2026-11-30'), tz, '2026-11-25T00:00:00Z')).toBe('2026-12-04T06:00:00.000Z');
  });

  it('takes a week from Monday to Sunday', () => {
    expect(next(fortnightly('2026-11-23', [0]), tz, '2026-11-28T00:00:00Z')).toBe('2026-11-29T06:00:00.000Z');
    expect(next(fortnightly('2026-11-23', [0]), tz, '2026-11-29T07:00:00Z')).toBe('2026-12-13T06:00:00.000Z');
  });

  it('needs a day to count from, and at most four weeks apart', () => {
    expect(Schedule.safeParse({ type: 'weekly', days: [5], time: '09:00', weeks: 2 }).success).toBe(false);
    expect(Schedule.safeParse({ ...fortnightly('2026-11-23'), weeks: 5 }).success).toBe(false);
    expect(Schedule.safeParse({ type: 'weekly', days: [5], time: '09:00', weeks: 1 }).success).toBe(true);
  });

  it('says how many weeks apart', () => {
    expect(describeSchedule(fortnightly('2026-11-23'), 'en')).toMatch(/^Every 2 weeks: .*09:00$/);
    expect(describeSchedule({ type: 'weekly', days: [5], time: '09:00' }, 'en')).not.toMatch(/weeks/);
  });
});

describe('last day', () => {
  const tz = 'Europe/Istanbul';
  const daily: Schedule = { type: 'daily', time: '09:00' };

  it('has no slot after its last day', () => {
    const before = (after: string) =>
      nextRunBefore(daily, tz, at(after), null, '2026-11-28')?.toISOString() ?? null;
    expect(before('2026-11-27T07:00:00Z')).toBe('2026-11-28T06:00:00.000Z');
    expect(before('2026-11-28T07:00:00Z')).toBeNull();
    expect(nextRunBefore(daily, tz, at('2026-11-28T07:00:00Z'), null, null)?.toISOString()).toBe(
      '2026-11-29T06:00:00.000Z',
    );
  });

  it('ends at midnight after the day, in its time zone', () => {
    expect(routineEnded('2026-11-28', tz, at('2026-11-28T20:59:00Z'))).toBe(false);
    expect(routineEnded('2026-11-28', tz, at('2026-11-28T21:00:00Z'))).toBe(true);
    expect(routineEnded(null, tz, at('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('can be set and removed', () => {
    expect(RoutineUpdate.parse({ endsOn: '2026-12-15' })).toEqual({ endsOn: '2026-12-15' });
    expect(RoutineUpdate.parse({ endsOn: null })).toEqual({ endsOn: null });
    expect(RoutineUpdate.safeParse({ endsOn: '15.12.2026' }).success).toBe(false);
  });
});
