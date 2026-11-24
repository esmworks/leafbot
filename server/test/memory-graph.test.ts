import type { Memory, MemoryGraph } from '@leafbot/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('the memory map', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const note = async (content: string, extra: Record<string, unknown> = {}) =>
    (await t.api<Memory>('POST', '/api/memory', { scope: 'user', content, ...extra })).body;

  it('links notes about one site and notes written in one conversation, one to the next', async () => {
    const bot = await t.bot();
    const a = await note('Logs in with the work account', { site: 'example.com' });
    const b = await note('Orders go under Account', { site: 'example.com' });
    const c = await note('Likes tea');
    const d = await note('Drinks it green');
    const e = await note('Has a cat');
    const thread = await t.services.threads.create(bot.id, { kind: 'user', userId: 'owner', title: 'x' });
    await t.services.ctx.db
      .update(schema.memories)
      .set({ threadId: thread.id })
      .where(inArray(schema.memories.id, [c.id, d.id]));
    const graph = (await t.api<MemoryGraph>('GET', '/api/memory/graph')).body;
    const pairs = graph.edges.map((x) => [x.kind, [x.a, x.b].sort().join(' ')]);
    expect(pairs).toContainEqual(['site', [a.id, b.id].sort().join(' ')]);
    expect(pairs).toContainEqual(['conversation', [c.id, d.id].sort().join(' ')]);
    expect(graph.edges.some((x) => x.a === e.id || x.b === e.id)).toBe(false);
    // Search by meaning is off: no note is linked by meaning, and the map says so.
    expect(graph.meaning).toBe(false);
    expect(graph.edges.every((x) => x.kind !== 'similar')).toBe(true);
    expect(graph.truncated).toBe(false);
  });

  it('shows another person none of the notes about the owner', async () => {
    const a = await note('Secret one', { site: 'bank.example' });
    const b = await note('Secret two', { site: 'bank.example' });
    const other = await t.person('someone-else');
    const theirs = (await other.api<MemoryGraph>('GET', '/api/memory/graph')).body;
    expect(JSON.stringify(theirs.edges)).not.toContain(a.id);
    expect(JSON.stringify(theirs.edges)).not.toContain(b.id);
    const rows = await t.services.ctx.db.select().from(schema.memories).where(eq(schema.memories.id, a.id));
    expect(rows).toHaveLength(1);
  });
});
