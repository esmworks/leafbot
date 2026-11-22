import type { PhoneContact, PhoneEvent, PhoneKind } from '@leafbot/shared';
import { describe, expect, it, vi } from 'vitest';
import type { PhoneDevice as Device } from './phone';

const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => store.get(k) ?? null,
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

const { answerPhone, offeredKinds, sharedKinds, shareKey } = await import('./phone');
const { writeStored } = await import('./stored');

const event = (i: number): PhoneEvent => ({
  title: `Toplantı ${i}`.padEnd(i === 0 ? 600 : 1, 'x'),
  start: new Date(Date.UTC(2026, 10, 20, 9, 60 - i)).toISOString(),
  end: new Date(Date.UTC(2026, 10, 20, 11)).toISOString(),
  allDay: false,
  location: null,
  calendar: 'İş',
});

function device(
  over: Partial<Device> = {},
  allowed: PhoneKind[] = ['calendar', 'contacts', 'location'],
): Device {
  return {
    permission: async (k) => (allowed.includes(k) ? 'granted' : 'denied'),
    request: async () => true,
    calendar: async () => Array.from({ length: 60 }, (_, i) => event(i)),
    contacts: async (): Promise<PhoneContact[]> => [
      { name: 'Ayşe Yılmaz', phones: ['+90 555 000 00 00'], emails: ['ayse@example.com'], company: null },
    ],
    location: async () => ({
      latitude: 41.0,
      longitude: 29.0,
      accuracy: 12,
      place: 'Kadıköy, İstanbul',
      at: '2026-11-20T09:00:00.000Z',
    }),
    ...over,
  };
}

const range = { kind: 'calendar', from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' } as const;

describe('telefonun botlara verdiği', () => {
  it('yalnız burada açılan ve telefonun izin verdiği türleri sunucuya sunar', async () => {
    expect(await offeredKinds(['calendar', 'location'], device({}, ['calendar']))).toEqual(['calendar']);
    const broken = device({ permission: async () => Promise.reject(new Error('x')) });
    expect(await offeredKinds(['contacts'], broken)).toEqual([]);
  });

  it('kapalı türü ya da izni olmayanı cevaplamaz; cihazı hiç okumaz', async () => {
    const calendar = vi.fn(async () => []);
    expect(await answerPhone(range, ['contacts'], device({ calendar }))).toEqual({
      ok: false,
      reason: 'off',
    });
    expect(await answerPhone(range, ['calendar'], device({ calendar }, []))).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(await answerPhone({ kind: 'camera' } as never, ['calendar'], device())).toEqual({
      ok: false,
      reason: 'off',
    });
    expect(calendar).not.toHaveBeenCalled();
  });

  it('takvimi sıralar, sunucunun aldığı kadarla keser', async () => {
    const a = await answerPhone(range, ['calendar'], device());
    if (!a.ok || a.kind !== 'calendar') throw new Error('takvim gelmedi');
    expect(a.events).toHaveLength(50);
    expect(a.events[0]!.start <= a.events[1]!.start).toBe(true);
    expect(a.events.every((e) => e.title.length <= 500)).toBe(true);
    expect(await answerPhone({ ...range, to: range.from }, ['calendar'], device())).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('rehberi ve konumu verir; okuma hatası “okuyamadı” olur', async () => {
    const c = await answerPhone({ kind: 'contacts', query: 'ayşe' }, ['contacts'], device());
    expect(c).toMatchObject({ ok: true, kind: 'contacts', contacts: [{ name: 'Ayşe Yılmaz' }] });
    const l = await answerPhone({ kind: 'location' }, ['location'], device());
    expect(l).toMatchObject({ ok: true, kind: 'location', location: { place: 'Kadıköy, İstanbul' } });
    const failing = device({ location: async () => Promise.reject(new Error('timeout')) });
    expect(await answerPhone({ kind: 'location' }, ['location'], failing)).toEqual({
      ok: false,
      reason: 'failed',
    });
  });

  it('ayar sunucuya göre tutulur ve yüklenmeden okunmaz', async () => {
    store.set(shareKey('https://a.example'), JSON.stringify(['calendar', 'bilinmeyen']));
    expect(await sharedKinds('https://a.example')).toEqual(['calendar']);
    expect(await sharedKinds('https://b.example')).toEqual([]);
    writeStored(shareKey('https://b.example'), ['location']);
    expect(await sharedKinds('https://b.example')).toEqual(['location']);
  });
});
