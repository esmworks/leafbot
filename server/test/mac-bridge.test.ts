import type { Approval, Bot, PersonComputerState, Thread } from '@leafbot/shared';
import { MAC_JOB_EVENT, MAC_JOBS_EVENT } from '@leafbot/shared/mac';
import { eq } from 'drizzle-orm';
import { schema } from '../src/db';
import { io, type Socket as IoSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MacBridge } from '../src/computer/bridge';
import { PersonComputerError } from '../src/computer/person';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

/** Stands in for a desktop app offering its Mac: answers as the app would and keeps the requests. */
class FakeDesktop {
  sent: Record<string, unknown>[] = [];
  begin: Record<string, unknown> = { ok: true };
  async handle(req: Record<string, unknown>): Promise<unknown> {
    this.sent.push(req);
    if (req.op === 'begin') return this.begin;
    if (req.op === 'status' || req.op === 'request')
      return { ok: true, accessibility: true, screen: true, width: 1512, height: 982 };
    if (req.op === 'screenshot') return { ok: true, data: '/9j/', mimeType: 'image/jpeg' };
    return { ok: true };
  }
  ops() {
    return this.sent.map((r) => r.op);
  }
}

const bridgeWith = (desktops: Record<string, FakeDesktop>) => {
  const macs = new MacBridge(200, 200);
  macs.attach(async (socketId, req) => {
    const d = desktops[socketId];
    if (!d) throw new Error('gone');
    return d.handle(req);
  });
  return macs;
};

describe('uzaktaki Mac: köprü', () => {
  it('kişinin en son bağlanan Mac’ini verir, başkasınınkini vermez', async () => {
    const a = new FakeDesktop();
    const b = new FakeDesktop();
    const macs = bridgeWith({ s1: a, s2: b });
    macs.offer('s1', 'ayse', 'Eski Mac');
    macs.offer('s2', 'ayse', 'Yeni Mac');
    expect(macs.device('ayse')).toBe('Yeni Mac');
    expect(macs.for('mehmet')).toBeNull();

    await macs.for('ayse')!.status();
    expect(a.sent).toEqual([]);
    expect(b.ops()).toEqual(['status']);

    macs.drop('s2');
    expect(macs.device('ayse')).toBe('Eski Mac');
    macs.drop('s1');
    expect(macs.for('ayse')).toBeNull();
  });

  it('bir tur başladığı Mac’te kalır; o giderse “bağlı değil” der, öbürüne geçmez', async () => {
    const a = new FakeDesktop();
    const b = new FakeDesktop();
    const macs = bridgeWith({ s1: a, s2: b });
    macs.offer('s1', 'ayse', 'A');
    const turnsMac = macs.for('ayse')!;
    macs.offer('s2', 'ayse', 'B');
    macs.drop('s1');
    await expect(turnsMac.status()).rejects.toMatchObject({ code: 'offline' });
    expect(b.sent).toEqual([]);
  });

  it('Mac giderse bekleyen adım süreyi beklemeden “bağlı değil” olur', async () => {
    const macs = new MacBridge(60_000, 60_000);
    macs.attach(() => new Promise(() => undefined));
    macs.offer('s1', 'ayse', 'A');
    const step = macs.for('ayse')!.status();
    macs.drop('s1');
    await expect(step).rejects.toMatchObject({ code: 'offline' });
  });

  it('yanıt gelmezse “bağlı değil”, bozuk yanıtta hata döner', async () => {
    const macs = new MacBridge(50, 50);
    macs.attach(() => new Promise(() => undefined));
    macs.offer('s1', 'ayse', 'A');
    await expect(macs.for('ayse')!.status()).rejects.toMatchObject({ code: 'offline' });

    macs.attach(async () => 'nonsense');
    await expect(macs.for('ayse')!.status()).rejects.toMatchObject({ code: 'failed' });
  });

  it('ekrana bakmadan ya da dokunmadan önce Mac’in kendisine bot adıyla sorar', async () => {
    const d = new FakeDesktop();
    const macs = bridgeWith({ s1: d });
    macs.offer('s1', 'ayse', 'A');
    const mac = macs.for('ayse')!;
    const shot = await mac.use('bot-1', () => mac.screenshot(), Date.now(), 'Muhasebe');
    expect(shot).toMatchObject({ data: '/9j/', mimeType: 'image/jpeg' });
    expect(d.sent[0]).toEqual({ op: 'begin', bot: 'Muhasebe' });
    expect(d.sent.at(-1)).toMatchObject({ op: 'screenshot', width: shot.width, height: shot.height });

    // A no on the Mac stops the step before anything is seen or touched.
    d.sent = [];
    d.begin = { ok: false, error: 'refused' };
    let ran = false;
    const refused = mac.use('bot-1', async () => {
      ran = true;
    });
    await expect(refused).rejects.toBeInstanceOf(PersonComputerError);
    await expect(refused).rejects.toMatchObject({ code: 'refused' });
    expect(ran).toBe(false);
    expect(d.ops()).toEqual(['begin']);
  });
});

describe('uzaktaki Mac: botlar', () => {
  let t: TestServer;
  let desk: FakeDesktop;
  let ayse: Person;
  let bot: Bot;
  beforeEach(async () => {
    // The server runs elsewhere than anyone's Mac: no Mac of its own.
    t = await testServer();
    desk = new FakeDesktop();
    t.services.ctx.macs!.attach(async (_socketId, req) => desk.handle(req));
    ayse = await t.person('ayse');
    bot = await t.bot({ permissionMode: 'auto' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'edit', people: {} });
  });
  afterEach(() => t.dispose());

  const toolNames = () => t.engine.requests.at(-1)!.tools.map((x) => x.name);
  const thread = async (who: { api: TestServer['api'] }) =>
    (await who.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
  const sendAs = async (who: Person, threadId: string, text: string) => {
    const r = await who.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random()}`,
      text,
    });
    expect(r.status).toBeLessThan(300);
  };

  it('kişi kendi Mac’inin durumunu görür; bağlı değilken uzaktan sunulacağını söyler', async () => {
    expect((await ayse.api<PersonComputerState>('GET', '/api/person-computer')).body).toMatchObject({
      available: false,
      remote: true,
    });
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin MacBook’u');
    expect((await ayse.api<PersonComputerState>('GET', '/api/person-computer')).body).toEqual({
      available: true,
      accessibility: true,
      screen: true,
      os: 'macos',
      remote: true,
      device: 'Ayşe’nin MacBook’u',
    });
    // The status opens nothing on the Mac.
    expect(desk.ops()).toEqual(['status']);
    // Someone else sees only their own.
    expect((await t.api<PersonComputerState>('GET', '/api/person-computer')).body.available).toBe(false);
  });

  it('botu değiştirebilen kişi izni açabilir, çünkü her Mac kendisi sorar', async () => {
    const r = await ayse.api<Bot>('PATCH', `/api/bots/${bot.id}`, { personComputer: true });
    expect(r.status).toBe(200);
    expect(r.body.personComputer).toBe(true);
  });

  it('araçlar yalnızca kişinin Mac’i bağlıyken ve kendi konuşmasında açılır', async () => {
    await t.api('PATCH', `/api/bots/${bot.id}`, { personComputer: true });
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_computer_screenshot');

    t.services.ctx.macs!.offer('s1', 'ayse', 'A');
    await sendAs(ayse, mine.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).toContain('person_computer_screenshot');

    // The owner has no Mac connected: Ayşe's is not theirs to use.
    const owners = await thread(t);
    await t.send(owners.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_computer_screenshot');
  });

  it('kartta evet sonrası Mac’in kendi sorusu gelir; orada hayır denirse hiçbir şey yapılmaz', async () => {
    await t.api('PATCH', `/api/bots/${bot.id}`, { personComputer: true });
    t.services.ctx.macs!.offer('s1', 'ayse', 'A');
    const mine = await thread(ayse);
    const pending = async () => (await ayse.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

    desk.begin = { ok: false, error: 'refused' };
    await sendAs(ayse, mine.id, '[araç:person_computer_click {"x":10,"y":20}]');
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('mcp__leafbot__person_computer_click');
    expect(desk.sent).toEqual([]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(desk.ops()).toEqual(['begin']);
    expect(desk.sent[0]).toEqual({ op: 'begin', bot: bot.name });

    desk.sent = [];
    desk.begin = { ok: true };
    await sendAs(ayse, mine.id, '[araç:person_computer_click {"x":10,"y":20}]');
    const again = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${again.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    // One question on the Mac covers the step and the look at the screen after it.
    expect(desk.ops()).toEqual(['begin', 'status', 'click', 'status', 'screenshot']);
  });
});

describe('uzaktaki Mac: masaüstü bağlantısı', () => {
  it('oturum açmış kişinin Mac’i olarak bağlanır ve istekleri yanıtlar; oturumsuz bağlanamaz', async () => {
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    const ayse = await t.person('ayse');
    const open = (headers: Record<string, string>) =>
      io(`${url}/mac`, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: headers,
        auth: { device: 'Ayşe Mac' },
      });
    const connected = (s: IoSocket) =>
      new Promise<void>((resolve, reject) => {
        s.on('connect', resolve);
        s.on('connect_error', reject);
      });
    // Listened for at once: the connection may be made before the test gets to wait for it.
    const stranger = open({});
    const strangerIn = connected(stranger);
    const socket = open({ cookie: ayse.cookie });
    const socketIn = connected(socket);
    socket.on('do', (req: Record<string, unknown>, ack: (r: unknown) => void) =>
      ack(
        req.op === 'status'
          ? { ok: true, accessibility: true, screen: false, width: 800, height: 600 }
          : { ok: false },
      ),
    );
    try {
      await expect(strangerIn).rejects.toBeTruthy();
      await socketIn;
      const state = await waitFor(async () => {
        const r = (await ayse.api<PersonComputerState>('GET', '/api/person-computer')).body;
        return r.available ? r : null;
      });
      expect(state).toMatchObject({ remote: true, device: 'Ayşe Mac', accessibility: true, screen: false });

      socket.close();
      await waitFor(
        async () => !(await ayse.api<PersonComputerState>('GET', '/api/person-computer')).body.available,
      );
    } finally {
      stranger.close();
      socket.close();
      await t.dispose();
    }
  });

  it('a computer that runs commands tells over its socket how its jobs end, and which it still runs', async () => {
    const t = await testServer({ onUserComputer: false });
    const url = await t.listen();
    const ayse = await t.person('ayse');
    const bot = await t.bot({ name: 'Kurucu' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'edit', people: {} });
    const thread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const socket = io(`${url}/mac`, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie: ayse.cookie },
      auth: { device: 'Ayşe Mac', commands: true },
    });
    const socketIn = new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
    });
    socket.on('do', (req: Record<string, unknown>, ack: (r: unknown) => void) =>
      ack(req.op === 'run' ? { ok: true, running: true, exitCode: null, output: '' } : { ok: true }),
    );
    const job = (id: string) =>
      t.db.db
        .select()
        .from(schema.personJobs)
        .where(eq(schema.personJobs.id, id))
        .then((r) => r[0]!);
    try {
      await socketIn;
      const computer = await waitFor(async () => t.services.ctx.macs!.commandsFor('ayse'));
      const start = () =>
        t.services.personJobs.start({
          computer,
          userId: 'ayse',
          bot,
          threadId: thread.id,
          turnId: null,
          command: 'npm run build',
          cwd: '/Users/ayse/shop',
          waitMs: 0,
        });
      const first = await start();
      const second = await start();
      if (!('id' in first) || !('id' in second)) throw new Error('not started');

      socket.emit(MAC_JOB_EVENT, { id: first.id, running: false, tail: 'bitti', exitCode: 0 });
      await waitFor(async () => (await job(first.id)).status === 'done');
      expect(await job(first.id)).toMatchObject({ exitCode: 0, tail: 'bitti', wake: true });

      // Back without the second one: it ended while nobody heard.
      socket.emit(MAC_JOBS_EVENT, { running: [] });
      await waitFor(async () => (await job(second.id)).status === 'lost');
    } finally {
      socket.close();
      await t.services.turns.idle();
      await t.dispose();
    }
  });
});
