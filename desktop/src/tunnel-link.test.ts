import { TunnelError } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountError, type AccountClient, type ServerEntry } from './account';
import { passing, reconnectDelay, ServerLink, type Live } from './tunnel-link';

const server: ServerEntry = { id: 's1', name: 'Ofis', role: 'owner', publicKey: 'k', seenAt: 1 };

describe('hangi hatalar tekrar denenir', () => {
  it('geçici bağlantı hataları denenir, ret kararları denenmez', () => {
    expect(passing(new TunnelError('closed'))).toBe(true);
    expect(passing(new ConnectError('offline'))).toBe(true);
    expect(passing(new AccountError(0, 'unreachable'))).toBe(true);
    expect(passing(new AccountError(503, 'down'))).toBe(true);
    expect(passing(new AccountError(429, 'rate_limited'))).toBe(true);
    expect(passing(new TunnelError('host-proof'))).toBe(false);
    expect(passing(new ConnectError('revoked'))).toBe(false);
    expect(passing(new AccountError(403, 'forbidden'))).toBe(false);
  });

  it('bekleme 1 saniyeden başlar, 30 saniyeyi geçmez', () => {
    expect([0, 1, 2, 5, 9].map(reconnectDelay)).toEqual([1000, 2000, 4000, 30_000, 30_000]);
  });
});

describe('sunucuya açık tünel', () => {
  let cookie: string | null;
  let listed: ServerEntry[];
  let opens: { onEnd: (code: string) => void; live: Live & { closed: boolean } }[];
  let failures: unknown[];
  let seen: (boolean | 'x')[];
  let link: ServerLink;

  beforeEach(() => {
    vi.useFakeTimers();
    cookie = 'c=1';
    listed = [server];
    opens = [];
    failures = [];
    seen = [];
    link = new ServerLink({
      serverId: 's1',
      account: { servers: async () => listed } as unknown as AccountClient,
      cookie: async () => cookie,
      open: async (_s, onEnd) => {
        const failure = failures.shift();
        if (failure) throw failure;
        const live = { closed: false, realtime: () => ({}) as never, close: () => (live.closed = true) };
        opens.push({ onEnd, live });
        return live;
      },
      log: () => undefined,
    });
    link.subscribe((t) => seen.push(t ? true : 'x'));
  });
  afterEach(() => {
    link.stop();
    vi.useRealTimers();
  });

  const settle = () => vi.advanceTimersByTimeAsync(0);

  it('açılınca dinleyenlere tüneli verir, bitince boş verir', async () => {
    link.start();
    await settle();
    expect(seen).toEqual(['x', true]);
    opens[0]!.onEnd('closed');
    await settle();
    expect(seen).toEqual(['x', true, 'x']);
  });

  it('geçici hatadan sonra bekleyip yeniden dener', async () => {
    failures.push(new ConnectError('offline'));
    link.start();
    await settle();
    expect(opens).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toHaveLength(1);
  });

  it('ret kararından sonra bırakır', async () => {
    failures.push(new TunnelError('host-proof'));
    link.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opens).toHaveLength(0);
  });

  it('tünel koparsa yeniden açar', async () => {
    link.start();
    await settle();
    opens[0]!.onEnd('timeout');
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toHaveLength(2);
  });

  it('açılır açılmaz kopan tünelde bekleme uzar, bir süre açık kalandan sonra kısalır', async () => {
    link.start();
    await settle();
    opens[0]!.onEnd('closed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toHaveLength(2);
    opens[1]!.onEnd('closed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(30_000);
    opens[2]!.onEnd('closed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(opens).toHaveLength(4);
  });

  it('hesaptan düşen sunucu için tünel açmaz', async () => {
    listed = [];
    link.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opens).toHaveLength(0);
  });

  it('çıkış yapılınca tüneli kapatır ve başka biri girince yeniden açar', async () => {
    link.start();
    await settle();
    cookie = null;
    await link.signInChanged();
    await settle();
    expect(opens[0]!.live.closed).toBe(true);
    expect(opens).toHaveLength(1);
    cookie = 'c=2';
    await link.signInChanged();
    await settle();
    expect(opens).toHaveLength(2);
  });

  it('sitenin yenilediği aynı çerez tüneli kesmez', async () => {
    link.start();
    await settle();
    await link.signInChanged();
    await settle();
    expect(opens[0]!.live.closed).toBe(false);
    expect(opens).toHaveLength(1);
  });

  it('durdurulunca tüneli kapatır ve bir daha açmaz', async () => {
    link.start();
    await settle();
    link.stop();
    expect(opens[0]!.live.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opens).toHaveLength(1);
  });
});
