import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { T } from '../i18n';
import type { DialOptions } from '@leafbot/shared/egress';
import { startSandboxProxy, type SandboxProxy } from './sandbox-proxy';
import type { FileTool } from './pi-files';
import { RESULT_TOOL } from './pi-results';
import type { Sandbox, ToolResult } from './types';

/** As long as a Claude bot's command may run by default, and at most. */
const DEFAULT_SECONDS = 120;
const MAX_SECONDS = 600;
/** The most of a command's output handed back: its start and its end, the middle left out. */
const OUTPUT_MAX = 30_000;
/** What a command reads in a turn is held in memory up to this much; the rest is counted, not kept. */
const HELD_MAX = 4 * 1024 * 1024;

/** The sandbox's own command-line program, run once per command with the turn's settings. */
function sandboxCli(): string {
  return join(dirname(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime')), 'cli.js');
}

/**
 * On Linux the sandbox starts each command through a helper program of its own, inside the sandbox.
 * When the server is installed under the home folder, which commands may not read, the helper was
 * hidden too and every command failed with "No such file or directory"; its folder is read again.
 */
function sandboxHelpers(): string[] {
  if (process.platform !== 'linux') return [];
  return [join(dirname(sandboxCli()), '..', 'vendor', 'seccomp')];
}

/**
 * Variables a command keeps from the server's environment: none that holds a secret or an address.
 * In the desktop app the server runs on Electron's own binary as Node; without ELECTRON_RUN_AS_NODE
 * that binary, started again for the sandbox's program, would open the app instead.
 */
const KEPT_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'SHELL', 'ELECTRON_RUN_AS_NODE'];

export interface ShellRun {
  /** The tool the model sees, when the turn may run commands. */
  tool: FileTool;
  /** Ends the turn's way out and removes its settings; called once the turn is over. */
  close(): void;
}

export interface ShellOptions {
  /**
   * Where each turn keeps its settings, home and temporary files: inside the server's data, which
   * other bots' commands cannot read, and on disk rather than in a small /tmp.
   */
  dir: string;
  /** Folders commands may not read (home, the server's data, the Claude login); the bot's own reopen. */
  hidden: string[];
  /** A command reached a host on the internet: what came back is outside text. */
  onReach?: (host: string) => void;
  /** Tests run a stand-in for the sandbox's program. */
  cli?: string;
  /** Tests pass stand-ins for the way out's name lookup and connections. */
  dial?: DialOptions;
  /** Keeps a long output whole for the conversation; gives the name the bot reads it back by. */
  keep?: (text: string) => string;
}

/**
 * The shell for API-key models: each command runs in the OS sandbox (bubblewrap on Linux, Seatbelt
 * on macOS) that Claude bots' commands run in, kept to the bot's folders, with an environment built
 * from scratch. With the internet on it goes out through a way out of this turn's own, which reaches
 * public addresses only and tells the turn which hosts were reached; with it off nothing is reached.
 */
export function shellRun(sb: Sandbox, t: T, o: ShellOptions): ShellRun {
  // The turn's own folder for settings, a home and temporary files, gone when the turn ends.
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const own = mkdtempSync(join(o.dir, 'turn-'));
  const home = join(own, 'home');
  const temp = join(own, 'tmp');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(temp, { mode: 0o700 });
  let proxy: Promise<SandboxProxy> | null = null;
  let closed = false;

  const settings = async (): Promise<string> => {
    const network: Record<string, unknown> = { allowedDomains: [], deniedDomains: [] };
    if (sb.internet) {
      proxy ??= startSandboxProxy({ onReach: (host) => o.onReach?.(host), dial: o.dial });
      const p = await proxy;
      network.httpProxyPort = p.httpPort;
      network.socksProxyPort = p.socksPort;
    }
    const file = join(own, 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({
        network,
        filesystem: {
          denyRead: [...new Set(o.hidden)],
          allowRead: [sb.cwd, ...sb.additionalDirectories, own, ...sandboxHelpers()],
          allowWrite: [...sb.writable, home, temp],
          denyWrite: [],
        },
      }),
      { mode: 0o600 },
    );
    return file;
  };

  const tool: FileTool = {
    name: 'bash',
    permissionName: 'Bash',
    description: t('shell.tool'),
    input: {
      command: z.string().min(1).max(100_000).describe(t('shell.command')),
      timeout_seconds: z.number().int().min(1).max(MAX_SECONDS).optional().describe(t('shell.timeout')),
    },
    target: () => sb.cwd,
    cardInput: (a) => ({ command: String(a.command) }),
    async run(a, signal): Promise<ToolResult> {
      if (closed) return t('shell.failed');
      const seconds = (a.timeout_seconds as number | undefined) ?? DEFAULT_SECONDS;
      const env: Record<string, string> = {};
      for (const k of KEPT_ENV) {
        const v = process.env[k];
        if (v) env[k] = v;
      }
      Object.assign(env, { HOME: home, TERM: 'dumb', NO_COLOR: '1', CI: '1' });
      // The sandbox's program opens its sockets in the system's temporary folder, whose short path
      // fits a socket's; the command gets the turn's own, set ahead of what it runs.
      const command = `export TMPDIR=${quoted(temp)}\n${String(a.command)}`;
      const r = await runCommand(o.cli ?? sandboxCli(), ['--settings', await settings(), '-c', command], {
        cwd: sb.cwd,
        env,
        timeoutMs: seconds * 1000,
        signal,
      });
      if (r.failed) return t('shell.failed');
      const notes = [
        r.timedOut ? t('shell.timedOut', { seconds }) : null,
        r.stopped ? t('shell.stopped') : null,
      ].filter(Boolean);
      const output = r.dropped ? `${r.output}\n${t('shell.cut', { count: r.dropped })}` : r.output;
      return [
        t('shell.exitCode', { code: r.code ?? '-' }),
        ...notes,
        shorten(output, t, o.keep) || t('shell.noOutput'),
      ]
        .join('\n')
        .trim();
    },
  };

  return {
    tool,
    close() {
      if (closed) return;
      closed = true;
      void proxy?.then((p) => p.close()).catch(() => {});
      rmSync(own, { recursive: true, force: true });
    },
  };
}

/** A path as one shell word. */
const quoted = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The start and the end of a long output, with a line saying how much was left out; with `keep`,
 * the whole of it is kept and the line says where the left-out middle starts.
 */
function shorten(text: string, t: T, keep?: (text: string) => string): string {
  if (text.length <= OUTPUT_MAX) return text;
  const head = Math.floor(OUTPUT_MAX / 5);
  const tail = OUTPUT_MAX - head;
  const count = text.length - OUTPUT_MAX;
  const cut = keep
    ? t('shell.kept', { count, id: keep(text), offset: head, tool: RESULT_TOOL })
    : t('shell.cut', { count });
  return `${text.slice(0, head)}\n${cut}\n${text.slice(-tail)}`;
}

interface Ran {
  code: number | null;
  output: string;
  /** Bytes past what is held in memory. */
  dropped: number;
  timedOut: boolean;
  stopped: boolean;
  /** The sandbox could not be started at all. */
  failed: boolean;
}

/**
 * Runs the sandbox's program in a process group of its own, so a timeout or a stop ends the
 * command and everything it started.
 */
function runCommand(
  program: string,
  args: string[],
  o: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal },
): Promise<Ran> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let held = 0;
    let dropped = 0;
    let timedOut = false;
    let stopped = false;
    const child = spawn(process.execPath, [program, ...args], {
      cwd: o.cwd,
      env: o.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (b: Buffer) => {
      if (held + b.length <= HELD_MAX) {
        chunks.push(b);
        held += b.length;
      } else dropped += b.length;
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const onAbort = () => {
      stopped = true;
      kill();
    };
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
    const done = (code: number | null, failed: boolean) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      resolve({ code, output: Buffer.concat(chunks).toString('utf8'), dropped, timedOut, stopped, failed });
    };
    child.on('error', () => done(null, true));
    child.on('close', (code) => done(code, false));
  });
}
