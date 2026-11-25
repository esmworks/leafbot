import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MacJobEvent } from '@leafbot/shared/mac';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandJobs } from './commands';
import { MacGate, readCommandsOn, readMacOn, writeCommandsOn, writeMacOn } from './mac-bridge';

const posix = process.platform !== 'win32';
const sh = (command: string) => ({ file: '/bin/sh', args: ['-c', command] });

describe.runIf(posix)('commands a bot runs on this computer', () => {
  let events: MacJobEvent[];
  let asked: string[];
  let answer: boolean;
  let jobs: CommandJobs;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'leafbot-cmd-')));
  const run = (id: string, command: string, waitMs = 5_000, cwd = dir) =>
    jobs.handle({ op: 'run', id, command, cwd, bot: 'Yazar', waitMs });
  const until = async (fn: () => boolean) => {
    for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
  };

  beforeEach(() => {
    events = [];
    asked = [];
    answer = false;
    jobs = new CommandJobs({
      shell: sh,
      ask: async (_bot, command, place) => {
        asked.push(`${place}: ${command}`);
        return answer;
      },
    });
    jobs.attach((e) => {
      events.push(e);
      return true;
    });
  });
  afterEach(async () => {
    jobs.stopAll();
    await until(() => jobs.running().length === 0);
  });

  it('runs a short command in the folder and answers with its output and exit code', async () => {
    const r = await run('j1', 'pwd; echo hi; exit 3');
    expect(r).toMatchObject({ ok: true, running: false, exitCode: 3, cwd: dir });
    expect(r.output).toContain(dir);
    expect(r.output).toContain('hi');
    expect(events.at(-1)).toMatchObject({ id: 'j1', running: false, exitCode: 3 });
  });

  it('goes on in the background past the wait, and Stop ends it', async () => {
    const r = await run('j2', 'echo start; sleep 30', 200);
    expect(r).toMatchObject({ ok: true, running: true, exitCode: null });
    expect(jobs.running()).toEqual([{ id: 'j2' }]);
    expect(await jobs.handle({ op: 'stop', id: 'j2' })).toEqual({ ok: true, stopped: true });
    await until(() => events.some((e) => !e.running));
    expect(events.find((e) => !e.running)).toMatchObject({ id: 'j2', stopped: true });
    expect(jobs.running()).toEqual([]);
  });

  it('runs at most four at once', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await run(id, 'sleep 30', 0);
    expect(await run('e', 'echo no', 0)).toEqual({ ok: false, error: 'tooMany' });
  });

  it('asks on this computer before a command that names a place keys are kept, and a no runs nothing', async () => {
    expect(await run('s1', 'cat ~/.ssh/config')).toEqual({ ok: false, error: 'refused' });
    expect(asked).toEqual(['.ssh: cat ~/.ssh/config']);
    expect(events).toEqual([]);
    answer = true;
    expect(await run('s2', 'echo ok > /dev/null; echo .env')).toMatchObject({ ok: true, exitCode: 0 });
  });

  it('keeps an end that happened while the server was away and tells it on return', async () => {
    jobs.attach(null);
    await run('k1', 'echo gone', 5_000);
    expect(events).toEqual([]);
    jobs.attach((e) => {
      events.push(e);
      return true;
    });
    expect(events).toEqual([expect.objectContaining({ id: 'k1', running: false, exitCode: 0 })]);
  });

  it('resolves the folder from the home folder and refuses one that is not there', async () => {
    expect(await jobs.handle({ op: 'where', cwd: '~' })).toMatchObject({
      ok: true,
      cwd: realpathSync(homedir()),
    });
    expect(await jobs.handle({ op: 'where', cwd: join(dir, 'nope') })).toEqual({
      ok: false,
      error: 'noFolder',
    });
  });

  it('keeps the app’s own settings out of a command’s environment', async () => {
    process.env.LEAFBOT_ACCESS_KEY = 'secret-key';
    try {
      const r = await run('e1', 'echo "[$LEAFBOT_ACCESS_KEY]"');
      expect(r.output).toContain('[]');
    } finally {
      delete process.env.LEAFBOT_ACCESS_KEY;
    }
  });
});

describe('the gate in front of commands', () => {
  const helper = {
    sent: [] as unknown[],
    send: async (r: Record<string, unknown>) => (helper.sent.push(r), { ok: true }),
    close: () => undefined,
  };
  const gate = (commands: CommandJobs | null) =>
    new MacGate({
      driver: helper,
      shot: async () => ({ data: '', mimeType: 'image/jpeg' }),
      ask: async () => true,
      commands,
    });

  it('runs no command with the switch off, and never hands one to the helper', async () => {
    const g = gate(null);
    expect(await g.handle({ op: 'run', id: 'x', command: 'ls', cwd: '/', bot: 'B', waitMs: 0 })).toEqual({
      ok: false,
      error: 'commandsOff',
    });
    expect(await g.handle({ op: 'jobs' })).toEqual({ ok: false, error: 'commandsOff' });
    expect(helper.sent).toEqual([]);
  });

  it('keeps the commands switch beside the Mac switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-mac-'));
    expect(readCommandsOn(dir)).toBe(false);
    writeMacOn(dir, true);
    writeCommandsOn(dir, true);
    expect(readMacOn(dir)).toBe(true);
    expect(readCommandsOn(dir)).toBe(true);
    writeMacOn(dir, false);
    expect(readCommandsOn(dir)).toBe(true);
  });
});
