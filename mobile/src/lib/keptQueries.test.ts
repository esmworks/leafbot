import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEPT_KEY,
  KEPT_MAX_CHARS,
  KEPT_MESSAGES,
  KEPT_THREADS,
  keepQueries,
  pickKept,
  readKept,
  restoreKept,
  serializeKept,
  type KeptStorage,
} from './keptQueries';

const O = 'leafbot:s1';
const who = { user: 'u1', origin: O, version: '0.10.0' };

function memoryStorage(): KeptStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: async (k) => items.get(k) ?? null,
    setItem: async (k, v) => void items.set(k, v),
    removeItem: async (k) => void items.delete(k),
  };
}

const keys = (qc: QueryClient) => pickKept(qc, O).queries.map((q) => q.queryKey[0]);

describe('what is kept', () => {
  it('keeps the first screens of this server and never secrets or another server', () => {
    const qc = new QueryClient();
    qc.setQueryData(['bots', O], [{ id: 'b1' }]);
    qc.setQueryData(['session', O], { authenticated: true });
    qc.setQueryData(['vault', O], [{ name: 'token' }]);
    qc.setQueryData(['memory', O], []);
    qc.setQueryData(['bots', 'leafbot:other'], [{ id: 'x' }]);
    expect(keys(qc).sort()).toEqual(['bots', 'session']);
  });

  it('keeps the latest messages of the conversations read last', () => {
    const qc = new QueryClient();
    const now = Date.now();
    for (let i = 0; i < KEPT_THREADS + 2; i++) {
      qc.setQueryData(
        ['messages', O, `t${i}`],
        Array.from({ length: 100 }, (_, n) => n),
        {
          updatedAt: now + i,
        },
      );
    }
    const kept = pickKept(qc, O).queries;
    expect(kept).toHaveLength(KEPT_THREADS);
    // The two read longest ago go.
    expect(kept.map((q) => q.queryKey[2])).not.toContain('t0');
    expect(kept.map((q) => q.queryKey[2])).not.toContain('t1');
    const words = kept[0]!.state.data as number[];
    expect(words).toHaveLength(KEPT_MESSAGES);
    expect(words.at(-1)).toBe(99);
  });

  it('drops the messages, not the lists, when the copy would be too large', () => {
    const qc = new QueryClient();
    qc.setQueryData(['bots', O], [{ id: 'b1' }]);
    qc.setQueryData(['messages', O, 't1'], ['x'.repeat(KEPT_MAX_CHARS)]);
    const raw = serializeKept(pickKept(qc, O), who);
    expect(raw).not.toBeNull();
    expect(readKept(raw, who)!.queries.map((q) => q.queryKey[0])).toEqual(['bots']);
  });
});

describe('reading it back', () => {
  const raw = () => {
    const qc = new QueryClient();
    qc.setQueryData(['bots', O], [{ id: 'b1' }]);
    return serializeKept(pickKept(qc, O), who);
  };

  it('is for the same person, server and app version only', () => {
    expect(readKept(raw(), who)).not.toBeNull();
    expect(readKept(raw(), { ...who, user: 'u2' })).toBeNull();
    expect(readKept(raw(), { ...who, origin: 'leafbot:s2' })).toBeNull();
    expect(readKept(raw(), { ...who, version: '0.11.0' })).toBeNull();
    expect(readKept('{broken', who)).toBeNull();
  });

  it('fills the cache with the kept lists, marked as needing a fresh read', async () => {
    const storage = memoryStorage();
    storage.items.set(KEPT_KEY, raw()!);
    const qc = new QueryClient();
    expect(await restoreKept(qc, storage, who)).toBe(true);
    expect(qc.getQueryData(['bots', O])).toEqual([{ id: 'b1' }]);
    expect(qc.getQueryState(['bots', O])!.dataUpdatedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('keeping', () => {
  afterEach(() => vi.useRealTimers());

  it('writes once after a burst of answers, and nothing after it is stopped', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const set = vi.spyOn(storage, 'setItem');
    const qc = new QueryClient();
    const stop = keepQueries(qc, storage, who, 1000);
    qc.setQueryData(['bots', O], [{ id: 'b1' }]);
    qc.setQueryData(['rooms', O], []);
    vi.advanceTimersByTime(1000);
    expect(set).toHaveBeenCalledTimes(1);
    qc.setQueryData(['bots', O], [{ id: 'b2' }]);
    stop();
    vi.advanceTimersByTime(1000);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('does not write for what is never kept', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const set = vi.spyOn(storage, 'setItem');
    const qc = new QueryClient();
    const stop = keepQueries(qc, storage, who, 1000);
    qc.setQueryData(['vault', O], [{ name: 'token' }]);
    vi.advanceTimersByTime(1000);
    stop();
    expect(set).not.toHaveBeenCalled();
  });
});
