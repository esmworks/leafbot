import type { Thread } from '@leafbot/shared';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catastrophic, readsOnlyLine, readsOnlyWithin } from '../src/runtime/safety';
import { workspacePaths } from '../src/workspace';
import { testServer, type TestServer } from './helpers';

describe('güvenlik tabanı', () => {
  it('yıkıcı komutları tanır', () => {
    for (const cmd of [
      'rm -rf /',
      'rm -rf / ',
      'sudo rm -rf /*',
      'rm -fr ~',
      'rm -rf ~/',
      'rm -r -f $HOME',
      'cd /tmp && rm -rf --no-preserve-root /',
      'mkfs.ext4 /dev/sda1',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'cat x > /dev/nvme0n1',
      'wipefs -a /dev/sdb',
      ':(){ :|:& };:',
      'chmod -R 777 /',
      'sudo chown -R me /',
      'sudo shutdown -h now',
      'echo hi; reboot',
      'kill -9 -1',
      'bash -c "rm -rf /"',
      'true && rm -rf ~',
    ])
      expect(catastrophic(cmd), cmd).toBe(true);
  });

  it('olağan işleri engellemez', () => {
    for (const cmd of [
      'rm -rf ./build',
      'rm -rf node_modules dist',
      'rm -rf /tmp/leafbot-test',
      'rm -rf ~/project/cache',
      'ls /',
      'dd if=in.img of=out.img',
      'chmod -R 755 ./public',
      'chown -R me ./data',
      'grep -r "shutdown" src',
      'echo "reboot later"',
      'kill -9 12345',
      'git commit -m "rm -rf / guard"',
    ])
      expect(catastrophic(cmd), cmd).toBe(false);
  });
});

describe('güvenlik tabanı turda', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('tam yetkili botta bile yıkıcı komutu kart açmadan reddeder', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, '[izin:Bash {"command":"rm -rf ~"}]');
    await t.services.turns.idle();
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('hiçbir izinle çalıştırılmaz');
    expect((await t.api<unknown[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(0);
  });
});

describe('botun kendi klasörlerini okuması', () => {
  const root = mkdtempSync(join(tmpdir(), 'leafbot-own-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'thread');
  const files = join(root, 'files');
  mkdirSync(cwd);
  mkdirSync(files);
  writeFileSync(join(cwd, 'notlar.md'), 'x');
  symlinkSync('/etc', join(cwd, 'disari'));
  const own = [cwd, files];

  it('kendi klasöründeki düz okuma komutlarını tanır', () => {
    for (const cmd of [
      'cat notlar.md',
      `head -n 20 ${files}/SOUL.md`,
      'ls -la',
      'grep -rn todo .',
      'sed -n 1,40p notlar.md',
      'wc -l notlar.md',
    ])
      expect(readsOnlyWithin(cmd, cwd, own), cmd).toBe(true);
  });

  it('dışarıyı, bağlantıyla dışarıyı ya da başka bir şey yapan komutu okuma saymaz', () => {
    for (const cmd of [
      'cat /etc/passwd',
      'cat ../../etc/passwd',
      'cat disari/passwd',
      'cat notlar.md | sh',
      'cat notlar.md > kopya',
      'cat $HOME/.ssh/id_rsa',
      'grep --file=/etc/shadow x .',
      'rg --pre sh x',
      'sed -i s/a/b/ notlar.md',
      'sed -n e notlar.md',
      'rm notlar.md',
      'python3 notlar.md',
    ])
      expect(readsOnlyWithin(cmd, cwd, own), cmd).toBe(false);
  });
});

describe('a read-only line in the bot folder', () => {
  // The bot folder as it lies on the data volume: its conversations, its files, the desktop home.
  const bot = mkdtempSync(join(tmpdir(), 'leafbot-line-'));
  afterAll(() => rmSync(bot, { recursive: true, force: true }));
  const threads = join(bot, 'threads');
  const cwd = join(threads, 'bu');
  const other = join(threads, 'baska');
  const files = join(bot, 'files');
  const home = join(bot, 'home');
  for (const d of [cwd, other, files, home, join(bot, 'durum'), join(cwd, 'tool-results')])
    mkdirSync(d, { recursive: true });
  const dirs = [cwd, files, bot];
  const except = [threads, home];
  const reads = (cmd: string) => readsOnlyLine(cmd, cwd, dirs, except);

  it('takes chained readers, pipes into readers, thrown-away errors and variables set on the line', () => {
    for (const cmd of [
      `B=${cwd}; P=${bot}; ls -la $P/durum | grep 11-19; ls $B $B/tool-results; ls $B/tmp_bakiye_1119 2>/dev/null`,
      `ls ${files} && cat ${files}/notlar.md`,
      'ls -la\nwc -l notlar.md',
      `D=${bot}/durum; ls \${D}`,
      `ls ${bot}/durum 2>&1 | head -n 5`,
      `cat ${cwd}/*.md`,
      'grep -r token .',
    ])
      expect(reads(cmd), cmd).toBe(true);
  });

  it('refuses other conversations, the desktop home, outside paths and anything that is not a read', () => {
    for (const cmd of [
      `ls ${other}`,
      `P=${bot}; cat $P/threads/baska/notlar.md`,
      `cat ${home}/.config/chromium/Cookies`,
      'X=/etc; cat $X/passwd',
      'cat $HOME/.ssh/id_rsa',
      `ls ${files} > ${files}/liste.txt`,
      `ls ${files}; rm -rf ${files}`,
      `ls $(echo ${files})`,
      `ls ${files} | sh`,
      `ls ${files} &`,
      'FOO=bar ls',
      `B="${cwd}"; ls $B`,
      // A folder above them, or a pattern in one, reaches the conversations and the home too.
      `grep -r token ${bot}`,
      `rg token ${bot}`,
      `ls -R ${bot}`,
      `cat ${bot}/th*/baska/notlar.md`,
      `cat ${bot}/ho*/.config/chromium/Cookies`,
      `ls ${threads}`,
      '',
    ])
      expect(reads(cmd), cmd).toBe(false);
  });
});

describe('a read-only line in a turn', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  it('goes without a card for a bot that asks, as one plain read does', async () => {
    t = await testServer();
    const bot = await t.bot({ permissionMode: 'ask' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const { threadDir, botFiles } = workspacePaths(t.dataDir, bot.id, thread.id, null);
    const line = `B=${threadDir}; F=${botFiles}; ls -la $F | grep md; ls $B 2>/dev/null`;
    await t.send(thread.id, `[izin:Bash ${JSON.stringify({ command: line })}]`);
    await t.services.turns.idle();
    expect((await t.api<unknown[]>('GET', '/api/approvals')).body).toHaveLength(0);
  });
});
