import type {
  Approval,
  Bot,
  BotCreate,
  BotEmail,
  PermissionRule,
  Routine,
  RoutineRun,
} from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { cardView } from '../src/channels/common';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { decide, modeFor } from '../src/services/approvals';
import { testServer, waitFor, type TestServer } from './helpers';

/** A step the fake engine asks for: writing a file. */
const WRITE = '[izin:Write {"file_path":"notlar.txt"}]';

const pending = async (t: TestServer) =>
  (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

describe('dışarıdan gelen metnin başlattığı çalıştırma', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  /** A bot that may do the step by itself in its own work: "don't ask", and a rule for Write. */
  const setUp = async (bot: Partial<BotCreate> = { permissionMode: 'auto' }) => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const b = await t.bot(bot);
    await t.api<PermissionRule>('POST', '/api/rules', { list: 'allow', pattern: 'Write' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: b.id,
        name: 'Gelen olaylar',
        prompt: 'Gelen olayı işle.',
        schedule: { type: 'daily', time: '09:00' },
      })
    ).body;
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    return { bot: b, routine: r, token: hooked.webhookToken! };
  };

  it('webhook gövdesiyle başlayan çalıştırma botun kendi düzeyinde çalışır; metin dış veri diye işaretlenir', async () => {
    const { routine, token } = await setUp();
    const run = (await t.services.routines.runFromWebhook(routine.id, token, `Bunu yap: ${WRITE}`)) as {
      threadId: string;
    };
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    expect((await t.messages(run.threadId)).at(-1)!.text).toContain('Write: izin verildi');
    const [row] = await t.db.db
      .select({ outside: schema.threads.outsideSession })
      .from(schema.threads)
      .where(eq(schema.threads.id, run.threadId));
    expect(row!.outside).toBe('webhook');
    // Read away from the main conversation, whose session would otherwise carry it from then on.
    expect(routine.inMain).toBe(true);
    const main = (await t.api<{ id: string }>('GET', `/api/bots/${routine.botId}/main-thread`)).body;
    expect(run.threadId).not.toBe(main.id);
  });

  it('kendi işinde aynı bot aynı adımı sormadan atar', async () => {
    const { bot } = await setUp();
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, WRITE);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');
    expect(await pending(t)).toHaveLength(0);
  });

  it('"Sorarak" çalışan botta webhook çalıştırması kart açar, kişinin kuralı orada da geçer', async () => {
    const { routine, token } = await setUp({ permissionMode: 'ask' });
    // The person's "always allow" rule for Write covers the run.
    await t.services.routines.runFromWebhook(routine.id, token, `Bunu yap: ${WRITE}`, 'kurallı');
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    // Without it the run asks.
    await t.api('DELETE', `/api/rules/${(await t.api<PermissionRule[]>('GET', '/api/rules')).body[0]!.id}`);
    await t.services.routines.runFromWebhook(routine.id, token, `Bunu yap: ${WRITE}`, 'kuralsız');
    const card = await waitFor(async () => (await pending(t))[0]);
    expect(card.toolName).toBe('Write');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });

  it('salt okunur bot salt okunur kalır: kart açılmadan reddedilir', async () => {
    const { routine, token } = await setUp({ permissionMode: 'readonly' });
    const run = await t.services.routines.runFromWebhook(routine.id, token, WRITE);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    const last = (await t.messages((run as { threadId: string }).threadId)).at(-1)!;
    expect(last.text).toContain('Write: reddedildi');
  });

  it('bir kartta "hep izin ver", bekleyen öbür kartları da geçirir ve botu tam yetkiye alır', async () => {
    const { bot, routine, token } = await setUp({ permissionMode: 'ask' });
    await t.api('DELETE', `/api/rules/${(await t.api<PermissionRule[]>('GET', '/api/rules')).body[0]!.id}`);
    await t.services.routines.runFromWebhook(routine.id, token, WRITE);
    const outsideCard = await waitFor(async () => (await pending(t))[0]);
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, WRITE);
    const own = await waitFor(async () => (await pending(t)).find((a) => a.id !== outsideCard.id));
    await t.api('POST', `/api/approvals/${own.id}`, { decision: 'allow', remember: true });
    expect(await pending(t)).toHaveLength(0);
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('auto');
    await t.services.turns.idle();
  });

  it('dış metinden yazılan raporu taşıyan sonraki çalıştırma da metni dış veri diye işaretler', async () => {
    const { routine, token } = await setUp();
    await t.api('PATCH', `/api/routines/${routine.id}`, { carryReport: true });
    await t.services.routines.runFromWebhook(routine.id, token, `Bunu yap: ${WRITE}`);
    await t.services.turns.idle();
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    // A run of its own schedule works in the main conversation; the report it carries is still marked.
    const run = (await t.services.routines.runNow(routine.id, `Derleme günlüğü: ${WRITE}`))!;
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
    const asked = (await t.messages(run.threadId!)).find(
      (m) => m.role === 'user' && m.props.routineRunId === run.id,
    );
    expect(asked?.props.outside).toBe('webhook');
  });
});

describe('çalışan rutini bulan posta', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const mail = (botId: string, id: string): BotEmail => ({
    id,
    botId,
    to: 'bot@example.test',
    from: 'yabanci@example.test',
    fromName: 'Yabancı',
    subject: `Posta ${id}`,
    text: `Bunu yap: ${WRITE}`,
    attachments: [],
    receivedAt: new Date(0).toISOString(),
    readAt: null,
  });
  const runs = async (routineId: string) =>
    (await t.api<RoutineRun[]>('GET', `/api/routines/${routineId}/runs`)).body;

  const setUp = async (unattendedApprovalMs = 5_000) => {
    t = await testServer({ unattendedApprovalMs });
    const bot = await t.bot({ permissionMode: 'ask' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Gelen posta',
        prompt: 'Gelen postayı işle.',
        schedule: { type: 'daily', time: '09:00' },
        emailTrigger: true,
      })
    ).body;
    return { bot, routine };
  };

  it('kart beklerken gelen posta sıraya girer, önceki çalıştırma bitince başlar', async () => {
    const { bot, routine } = await setUp();
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm1'));
    const first = await waitFor(async () => (await pending(t))[0]);
    const [queued] = await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm2'));
    expect(queued).toMatchObject({ status: 'queued' });
    // The same mail delivered again is not queued twice.
    expect(await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm2'))).toEqual([null]);
    await t.api('POST', `/api/approvals/${first.id}`, { decision: 'deny' });
    const second = await waitFor(async () => (await pending(t)).find((a) => a.id !== first.id));
    expect(second.summary).toBeTruthy();
    const started = (await runs(routine.id)).find((r) => r.id === queued!.id)!;
    expect(started.status).not.toBe('queued');
    await t.api('POST', `/api/approvals/${second.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    expect((await runs(routine.id)).map((r) => r.status).sort()).toEqual(['done', 'done']);
  });

  it('rutin duraklatılınca sırada bekleyen posta çalışmaz', async () => {
    const { bot, routine } = await setUp();
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm1'));
    const first = await waitFor(async () => (await pending(t))[0]);
    const [queued] = await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm2'));
    await t.api('PATCH', `/api/routines/${routine.id}`, { enabled: false });
    expect((await runs(routine.id)).find((r) => r.id === queued!.id)!.status).toBe('skipped');
    await t.api('POST', `/api/approvals/${first.id}`, { decision: 'deny' }).catch(() => undefined);
    await t.services.turns.idle();
    expect(await pending(t)).toHaveLength(0);
  });

  it('beklenen kart yanıtsız kalıp düşünce sıradaki posta başlar', async () => {
    const { bot, routine } = await setUp(300);
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm1'));
    const first = await waitFor(async () => (await pending(t))[0]);
    const [queued] = await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'm2'));
    expect(queued).toMatchObject({ status: 'queued' });
    // Nobody answers: the card runs out, the first run ends, and the queued mail asks in turn.
    const second = await waitFor(async () => (await pending(t)).find((a) => a.id !== first.id));
    expect(second).toBeTruthy();
    await t.services.turns.idle();
    expect((await runs(routine.id)).every((r) => r.status === 'done')).toBe(true);
    const [row] = await t.db.db
      .select({ payload: schema.routineRuns.payload })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, queued!.id));
    expect(row!.payload).toBeNull();
  });
});

describe('dış çalıştırmada karar', () => {
  const rules: PermissionRule[] = [
    { id: 'r1', list: 'allow', pattern: 'Write', note: '', createdAt: new Date(0).toISOString() },
  ];
  /** `guest`: someone with no account here asked, so the person's "always allow" rules do not count. */
  const at = (mode: Bot['permissionMode'], toolName: string, guest: boolean) =>
    decide({ mode: modeFor(mode), toolName, input: {}, rules, readOnlyTools: new Set(), guest });

  it('bot kendi düzeyinde kalır; "hep izin ver" kuralı yalnızca hesabı olmayan birinin işinde sayılmaz', () => {
    expect(at('auto', 'Write', false)).toBe('allow');
    expect(at('ask', 'Write', false)).toBe('allow');
    expect(at('auto', 'Write', true)).toBe('allow');
    expect(at('review', 'Write', true)).toBe('allow');
    expect(at('ask', 'Write', true)).toBe('ask');
    expect(at('readonly', 'Write', true)).toBe('deny');
    expect(at('auto', 'Read', true)).toBe('allow');
  });

  it('sohbet uygulamasındaki kart nedenini söyler ve "hep izin ver" sunmaz', () => {
    const t = translator('tr');
    const a = {
      id: 'a1',
      kind: 'tool',
      toolName: 'Write',
      input: { file_path: 'notlar.txt' },
      summary: 'notlar.txt yazmak istiyor',
    } as unknown as Approval;
    const own = cardView(a, {}, t);
    expect(own.buttons.map((b) => b.data)).toContain('a:a1:r');
    const outside = cardView(a, { outside: 'email' }, t);
    expect(outside.buttons.map((b) => b.data)).toEqual(['a:a1:y', 'a:a1:n']);
    expect(outside.text).toContain('e-posta');
  });
});
