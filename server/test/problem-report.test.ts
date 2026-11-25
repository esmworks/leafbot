import type { Message, Routine, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('problem reports', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const call = (args: Record<string, unknown>) => `[araç:report_problem ${JSON.stringify(args)}]`;
  const cardIn = async (threadId: string) => (await t.messages(threadId)).find((m) => m.props.card);
  const linkOf = (card: Message) => {
    const found = JSON.stringify(card.props.card).match(/"url":"([^"]+)"/);
    return new URL(found![1]!);
  };
  const failed = (threadId: string, text: string, kind: string) =>
    t.services.threads.addMessage({ threadId, role: 'error', author: 'system', text, props: { kind } });

  it('shows the draft with a link to the filled-in issue form, keeping secrets and names out', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await failed(th.id, 'Görsel üretimi düştü: Invalid credential', 'engine');
    await t.send(
      th.id,
      call({
        title: 'Image generation fails',
        what_happened:
          'The job fails with "Invalid credential" for me@example.com, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789.',
        steps: '1. Ask @someone for an image.',
        asked: true,
      }),
    );
    await t.services.turns.idle();
    const card = (await cardIn(th.id))!;
    expect(card.text).toContain('Image generation fails');
    const link = linkOf(card);
    expect(link.origin + link.pathname).toBe('https://github.com/esmworks/leafbot/issues/new');
    const q = link.searchParams;
    expect(q.get('template')).toBe('bug_report.yml');
    expect(q.get('title')).toBe('Image generation fails');
    expect(q.get('version')).toMatch(/^\d+\.\d+\.\d+$/);
    expect(q.get('errors')).toBe('Görsel üretimi düştü: Invalid credential');
    expect(q.get('reproduction')).toBe('1. Ask @\u200bsomeone for an image.');
    const description = q.get('description')!;
    expect(description).not.toContain('me@example.com');
    expect(description).not.toContain('sk-ant-api03');
    // What the card shows is what the form gets.
    expect(card.text).toContain(description);
    // The bot is told the person sends it, not that it was sent.
    expect((await t.messages(th.id)).at(-1)!.text).toContain('GitHub');
  });

  it("drafts nothing in a routine's run, where nobody wrote and the server's details would go unseen", async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Gece',
        prompt: call({ title: 'Something fails', what_happened: 'It fails.', asked: true }),
        schedule: { type: 'weekly', days: [0], time: '18:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${routine.id}/run`);
    await t.services.turns.idle();
    const threads = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body;
    const all = (await Promise.all(threads.map((th) => t.messages(th.id)))).flat();
    expect(all.some((m) => m.props.card)).toBe(false);
    expect(all.some((m) => m.text.includes('yalnızca kişinin kendi konuşmasındaki'))).toBe(true);
  });

  it('turns a sign-in or limit failure back to the bot unless the person asked', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await failed(th.id, 'Claude oturumu yok.', 'auth');
    await t.send(th.id, call({ title: 'Login fails', what_happened: 'No login.' }));
    await t.services.turns.idle();
    expect(await cardIn(th.id)).toBeUndefined();
    expect((await t.messages(th.id)).at(-1)!.text).toContain('Ayarlar');
    await t.send(th.id, call({ title: 'Login fails', what_happened: 'No login.', asked: true }));
    await t.services.turns.idle();
    const card = (await cardIn(th.id))!;
    // A sign-in failure is the person's to fix, so it is not listed as an error of Leaf Bot.
    expect(linkOf(card).searchParams.has('errors')).toBe(false);
  });
});
