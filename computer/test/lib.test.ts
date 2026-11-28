import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopAction } from '@leafbot/shared';
import {
  allocateDisplay,
  bearerToken,
  CdpDecoder,
  checkToken,
  clearForeignProfileLock,
  encodeCdp,
  Jobs,
  isOpenableUrl,
  pngSize,
  TailBuffer,
  xdotoolArgs,
} from '../src/lib';

const args = (a: unknown) => xdotoolArgs(DesktopAction.parse(a));

describe('token', () => {
  const token = 'a'.repeat(40);
  it('accepts only the exact token', () => {
    expect(checkToken(token, token)).toBe(true);
    expect(checkToken('a'.repeat(39), token)).toBe(false);
    expect(checkToken(`${token}x`, token)).toBe(false);
    expect(checkToken('', token)).toBe(false);
    expect(checkToken(null, token)).toBe(false);
    expect(checkToken(undefined, token)).toBe(false);
  });
  it('reads the bearer header', () => {
    expect(bearerToken(`Bearer ${token}`)).toBe(token);
    expect(bearerToken(`Basic ${token}`)).toBeNull();
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('allocateDisplay', () => {
  it('takes the lowest free number', () => {
    expect(allocateDisplay([])).toBe(1);
    expect(allocateDisplay([1, 2, 4])).toBe(3);
    expect(allocateDisplay(new Set([2]))).toBe(1);
  });
  it('is null when every display is taken', () => {
    expect(allocateDisplay([1, 2, 3], 3)).toBeNull();
  });
});

describe('TailBuffer', () => {
  it('keeps everything below the limit', () => {
    const t = new TailBuffer(10);
    t.push('abc');
    t.push('def');
    expect(t.result()).toEqual({ output: 'abcdef', truncated: false });
  });
  it('keeps only the last characters above it', () => {
    const t = new TailBuffer(5);
    for (let i = 0; i < 100; i++) t.push('0123456789');
    t.push('XYZ');
    const r = t.result();
    expect(r.truncated).toBe(true);
    expect(r.output).toBe('789XYZ'.slice(1));
  });
  it('cuts to exactly the limit on the final result', () => {
    const t = new TailBuffer(4);
    t.push('abcdefg');
    expect(t.result()).toEqual({ output: 'defg', truncated: true });
  });
});

describe('CDP framing', () => {
  it('ends every message with a NUL byte', () => {
    expect([...encodeCdp('{"id":1}')].at(-1)).toBe(0);
    expect(encodeCdp('{"id":1}').toString('utf8', 0, 8)).toBe('{"id":1}');
  });
  it('splits a stream into messages however the chunks fall', () => {
    const d = new CdpDecoder();
    const all = Buffer.concat([encodeCdp('{"a":"ç"}'), encodeCdp('{"b":2}'), encodeCdp('{"c":3}')]);
    const out: string[] = [];
    // Byte by byte also cuts the two-byte character in half.
    for (const byte of all) out.push(...d.push(Buffer.from([byte])));
    expect(out).toEqual(['{"a":"ç"}', '{"b":2}', '{"c":3}']);
  });
  it('holds back an unfinished message', () => {
    const d = new CdpDecoder();
    expect(d.push(Buffer.from('{"a"'))).toEqual([]);
    expect(d.push(Buffer.from(':1}\0'))).toEqual(['{"a":1}']);
  });
  it('refuses a message that never ends', () => {
    const d = new CdpDecoder(8);
    expect(() => d.push(Buffer.from('123456789'))).toThrow();
  });
});

describe('xdotoolArgs', () => {
  it('click: defaults to one left click', () => {
    expect(args({ type: 'click', x: 10, y: 20 })).toEqual([
      'mousemove',
      '10',
      '20',
      'click',
      '--repeat',
      '1',
      '1',
    ]);
  });
  it('click: maps the buttons and the count', () => {
    expect(args({ type: 'click', x: 1, y: 2, button: 'right', count: 2 }).slice(-3)).toEqual([
      '--repeat',
      '2',
      '3',
    ]);
    expect(args({ type: 'click', x: 1, y: 2, button: 'middle', count: 3 }).slice(-3)).toEqual([
      '--repeat',
      '3',
      '2',
    ]);
  });
  it('move', () => {
    expect(args({ type: 'move', x: 5, y: 6 })).toEqual(['mousemove', '5', '6']);
  });
  it('drag: press at the start, release at the end', () => {
    expect(args({ type: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toEqual([
      'mousemove',
      '1',
      '2',
      'mousedown',
      '1',
      'mousemove',
      '3',
      '4',
      'mouseup',
      '1',
    ]);
  });
  it('type: the text is one argument after --, so it is never read as a flag', () => {
    expect(args({ type: 'type', text: '--clearmodifiers; rm -rf /' })).toEqual([
      'type',
      '--delay',
      '12',
      '--',
      '--clearmodifiers; rm -rf /',
    ]);
  });
  it('key: one argument per key', () => {
    expect(args({ type: 'key', keys: 'ctrl+s' })).toEqual(['key', '--', 'ctrl+s']);
    expect(args({ type: 'key', keys: 'ctrl+a  Delete' })).toEqual(['key', '--', 'ctrl+a', 'Delete']);
  });
  it('scroll: wheel buttons 4 to 7', () => {
    const dir = (direction: string) => args({ type: 'scroll', x: 1, y: 2, direction, amount: 5 });
    expect(dir('up')).toEqual(['mousemove', '1', '2', 'click', '--repeat', '5', '4']);
    expect(dir('down').at(-1)).toBe('5');
    expect(dir('left').at(-1)).toBe('6');
    expect(dir('right').at(-1)).toBe('7');
    expect(args({ type: 'scroll', x: 1, y: 2, direction: 'down' }).at(-2)).toBe('3');
  });
  it('the schema keeps shell characters out of key names', () => {
    expect(DesktopAction.safeParse({ type: 'key', keys: 'a; b' }).success).toBe(false);
  });
});

describe('pngSize and isOpenableUrl', () => {
  it('reads the size from the header', () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(1280, 16);
    png.writeUInt32BE(800, 20);
    expect(pngSize(png)).toEqual({ width: 1280, height: 800 });
    expect(pngSize(Buffer.from('nope'))).toBeNull();
  });
  it('lets only plain URLs through to the browser', () => {
    expect(isOpenableUrl('https://example.com/a?b=1')).toBe(true);
    expect(isOpenableUrl('')).toBe(true);
    expect(isOpenableUrl('--remote-debugging-port=1')).toBe(false);
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableUrl('https://a.b/\nx')).toBe(false);
  });
});

describe('arka plan komutları', () => {
  const jobs = () =>
    new Jobs((command, cwd) =>
      spawn('bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
    );

  it('komutu çağrıdan sonra da çalıştırır; durumu ve çıktısı sonra sorulur', async () => {
    const j = jobs();
    const id = j.run('echo başladı; sleep 0.3; echo bitti; exit 3', '/tmp');
    const first = await j.status(id);
    expect(first).toMatchObject({ id, running: true, exitCode: null });
    const end = await j.status(id, 5_000);
    expect(end).toMatchObject({ running: false, exitCode: 3 });
    expect(end!.output).toContain('başladı');
    expect(end!.output).toContain('bitti');
    expect(await j.status('yok')).toBeNull();
  });

  it('aynı anda çalışan komut sayısını sınırlar; kapanırken hepsini durdurur', async () => {
    const j = new Jobs(
      (command, cwd) =>
        spawn('bash', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }),
      1000,
      2,
    );
    const a = j.run('sleep 30', '/tmp');
    j.run('sleep 30', '/tmp');
    expect(() => j.run('sleep 30', '/tmp')).toThrow(/running already/);
    j.stopAll();
    expect(await j.status(a, 5_000)).toMatchObject({ running: false });
  });
});

describe('Chromium profile lock', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const profile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-profile-'));
    made.push(dir);
    symlinkSync('12345', join(dir, 'SingletonCookie'));
    symlinkSync('/tmp/org.chromium.Chromium.x/SingletonSocket', join(dir, 'SingletonSocket'));
    return dir;
  };
  const left = (dir: string) => readdirSync(dir).sort();

  it('removes a lock left by another host and keeps one from this host', () => {
    const other = profile();
    symlinkSync('71f2686f2dae-51', join(other, 'SingletonLock'));
    expect(clearForeignProfileLock(other, 'eadafa65883c')).toBe(true);
    expect(left(other)).toEqual([]);

    const own = profile();
    symlinkSync('my-host-name-51', join(own, 'SingletonLock'));
    expect(clearForeignProfileLock(own, 'my-host-name')).toBe(false);
    expect(left(own)).toEqual(['SingletonCookie', 'SingletonLock', 'SingletonSocket']);

    // No lock: nothing to do.
    const empty = mkdtempSync(join(tmpdir(), 'leafbot-profile-'));
    made.push(empty);
    expect(clearForeignProfileLock(empty, 'h')).toBe(false);
  });
});
