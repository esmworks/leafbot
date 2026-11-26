import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Thread } from '@leafbot/shared';
import { saidNothing } from '../src/channels/common';
import type { Ctx } from '../src/context';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('sohbet uygulamasında "cevap yok" notu', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('iş başka bota devredilip cevabı beklenirken boş tur "cevap yok" sayılmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, '[boş] bir şey');
    await t.services.turns.idle();
    const ctx = { db: t.db.db } as unknown as Ctx;
    expect(await saidNothing(ctx, thread.id)).toBe(true);

    const [turn] = await t.db.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.threadId, thread.id))
      .orderBy(desc(schema.turns.createdAt))
      .limit(1);
    const job = {
      id: 'job-1',
      rootId: 'job-1',
      depth: 1,
      kind: 'ask' as const,
      fromBotId: a.id,
      toBotId: b.id,
      fromThreadId: thread.id,
      fromTurnId: turn!.id,
      toThreadId: thread.id,
      request: 'hesapla',
      status: 'pending' as const,
    };
    await t.db.db.insert(schema.jobs).values(job);
    expect(await saidNothing(ctx, thread.id)).toBe(false);

    // A notice the sender expects no answer to leaves nothing to wait for.
    await t.db.db.update(schema.jobs).set({ kind: 'notify' }).where(eq(schema.jobs.id, 'job-1'));
    expect(await saidNothing(ctx, thread.id)).toBe(true);
  });
});
