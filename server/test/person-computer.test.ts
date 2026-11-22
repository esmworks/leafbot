import { writeFile } from 'node:fs/promises';
import type { Approval, Bot, Message, PersonComputerState, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  keyPresses,
  keysSubmit,
  PersonComputer,
  PersonComputerError,
  type PersonComputerDriver,
  shotSize,
  toScreen,
} from '../src/computer/person';
import { testServer, waitFor, type TestServer } from './helpers';

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Stands in for the helper: answers as macOS would and keeps what it was asked to do. */
class FakeHelper implements PersonComputerDriver {
  sent: Record<string, unknown>[] = [];
  accessibility = true;
  screen = true;
  async send(req: Record<string, unknown>) {
    this.sent.push(req);
    const status = { accessibility: this.accessibility, screen: this.screen, width: 1512, height: 982 };
    if (req.op === 'status' || req.op === 'request') return { ok: true, ...status };
    if (!this.accessibility) return { ok: false, error: 'accessibility' };
    return { ok: true };
  }
  close() {}
  ops() {
    return this.sent.filter((r) => r.op !== 'status');
  }
}

const fakeMac = (helper: FakeHelper) => {
  const scaled: { width: number; height: number }[] = [];
  const mac = new PersonComputer(helper, {
    capture: (file) => writeFile(file, PNG),
    scale: async (_file, size) => {
      scaled.push(size);
    },
  });
  return { mac, scaled };
};

describe('kişinin Mac’i: tuşlar ve koordinatlar', () => {
  it('tuş adlarını macOS tuş kodlarına çevirir', () => {
    expect(keyPresses('cmd+s')).toEqual([{ code: 1, modifiers: ['command'] }]);
    expect(keyPresses('Return')).toEqual([{ code: 36, modifiers: [] }]);
    expect(keyPresses('ctrl+alt+Delete Tab')).toEqual([
      { code: 117, modifiers: ['control', 'option'] },
      { code: 48, modifiers: [] },
    ]);
    expect(keyPresses('super+space')).toEqual([{ code: 49, modifiers: ['command'] }]);
    expect(keyPresses('Escape')).toEqual([{ code: 53, modifiers: [] }]);
    expect(keyPresses('cmd+')).toBeNull();
    expect(keyPresses('cmd+nope')).toBeNull();
    expect(keyPresses('s+cmd')).toBeNull();
    expect(keyPresses('   ')).toBeNull();
  });

  it('Return ve kısayolları gönderebilen tuşlar sayar; düz harf ve Shift sayılmaz', () => {
    expect(keysSubmit(keyPresses('Return')!)).toBe(true);
    expect(keysSubmit(keyPresses('cmd+v')!)).toBe(true);
    expect(keysSubmit(keyPresses('shift+a')!)).toBe(false);
    expect(keysSubmit(keyPresses('Tab')!)).toBe(false);
  });

  it('ekranı şeklini koruyarak küçültür ve görüntüdeki noktayı ekrana geri çevirir', () => {
    const screen = { width: 1512, height: 982 };
    const shot = shotSize(screen);
    expect(shot.width).toBeLessThanOrEqual(1280);
    expect(shot.height).toBeLessThanOrEqual(800);
    expect(shot.width / shot.height).toBeCloseTo(1512 / 982, 2);
    expect(toScreen({ x: 0, y: 0 }, screen)).toEqual({ x: 0, y: 0 });
    expect(toScreen({ x: shot.width, y: shot.height }, screen)).toEqual({ x: 1511, y: 981 });
    expect(toScreen({ x: shot.width / 2, y: shot.height / 2 }, screen)).toEqual({ x: 756, y: 491 });
    // A small screen is not made bigger.
    expect(shotSize({ width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 });
  });
});

describe('kişinin Mac’i: kullanım', () => {
  it('görüntüyü küçültüp verir; ekran izni yoksa almaz', async () => {
    const helper = new FakeHelper();
    const { mac, scaled } = fakeMac(helper);
    const shot = await mac.screenshot();
    expect(shot.png).toBe(PNG.toString('base64'));
    expect(scaled).toEqual([shotSize({ width: 1512, height: 982 })]);
    helper.screen = false;
    await expect(mac.screenshot()).rejects.toMatchObject({ code: 'screen' });
  });

  it('tıklamayı ekran noktasına çevirir; erişilebilirlik izni yoksa hiçbir şey göndermez', async () => {
    const helper = new FakeHelper();
    const { mac } = fakeMac(helper);
    const shot = shotSize({ width: 1512, height: 982 });
    await mac.act({ type: 'click', x: shot.width / 2, y: shot.height / 2, button: 'left', count: 2 });
    expect(helper.ops()).toEqual([{ op: 'click', x: 756, y: 491, button: 'left', count: 2 }]);
    await mac.act({ type: 'key', presses: keyPresses('cmd+s')! });
    expect(helper.ops().at(-1)).toEqual({ op: 'key', code: 1, modifiers: ['command'] });
    await mac.act({ type: 'scroll', x: 0, y: 0, direction: 'down', amount: 3 });
    expect(helper.ops().at(-1)).toMatchObject({ op: 'scroll', dx: 0, dy: -3 });

    helper.accessibility = false;
    const before = helper.ops().length;
    await expect(mac.act({ type: 'type', text: 'merhaba' })).rejects.toBeInstanceOf(PersonComputerError);
    expect(helper.ops()).toHaveLength(before);
  });

  it('aynı anda tek bot kullanır; öbürü bir süre bekletilir', async () => {
    const { mac } = fakeMac(new FakeHelper());
    const now = Date.now();
    await mac.use('a', async () => 1, now);
    await expect(mac.use('b', async () => 1, now + 1000)).rejects.toMatchObject({ code: 'busy' });
    await expect(mac.use('a', async () => 2, now + 1000)).resolves.toBe(2);
    await expect(mac.use('b', async () => 3, Date.now() + 3 * 60_000)).resolves.toBe(3);
  });
});

describe('kişinin Mac’i: botlar ve onay', () => {
  let t: TestServer;
  let helper: FakeHelper;
  beforeEach(async () => {
    // The path is never started: the test puts its own stand-in in its place.
    t = await testServer({ personComputer: '/nonexistent/person-computer' });
    helper = new FakeHelper();
    t.services.ctx.personComputer = fakeMac(helper).mac;
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const toolNames = () => t.engine.requests.at(-1)!.tools.map((x) => x.name);
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('yalnız izin verilen bota ve yalnız sahibin işinde açılır', async () => {
    expect((await t.api<PersonComputerState>('GET', '/api/person-computer')).body).toEqual({
      available: true,
      accessibility: true,
      screen: true,
    });
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_computer_screenshot');

    await t.api<Bot>('PATCH', `/api/bots/${bot.id}`, { personComputer: true });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).toContain('person_computer_screenshot');

    // A bot that may only read gets none of them.
    await t.api<Bot>('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'readonly' });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_computer_click');
  });

  it('tam izinli botta bile işin ilk adımında bir kez sorar, “hep izin ver” sunmaz', async () => {
    const bot = await t.bot({ permissionMode: 'auto', personComputer: true });
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[araç:person_computer_screenshot] [araç:person_computer_click {"x":10,"y":20}] [araç:person_computer_type {"text":"şğü"}]',
    );
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('mcp__leafbot__person_computer_screenshot');
    const asked = (await t.messages(thread.id)).find((m: Message) => m.role === 'approval')!;
    expect(asked.text).toContain("Mac'ini kullanmak istiyor");
    expect(asked.props.noAlways).toBe(true);
    // Nothing was seen or touched before the yes.
    expect(helper.ops()).toEqual([]);

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect(helper.ops().map((o) => o.op)).toEqual(['click', 'type']);
    expect(helper.ops().at(-1)).toMatchObject({ text: 'şğü' });
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('person_computer_screenshot');
    expect(reply).toContain('[1 görüntü]');

    // The next piece of work asks again.
    await t.send(thread.id, '[araç:person_computer_screenshot]');
    const again = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${again.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('reddedildi');
  });

  it('izni yalnızca sahip açar', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const member = await t.person('ayse');
    const shared = await t.api('PUT', `/api/bots/${bot.id}/access`, {
      everyone: 'edit',
      people: {},
    });
    expect(shared.status).toBe(200);
    const r = await member.api('PATCH', `/api/bots/${bot.id}`, { personComputer: true });
    expect(r.status).toBe(403);
  });
});
