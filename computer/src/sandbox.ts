import { posix } from 'node:path';
import { DESKTOP_SIZE, type DesktopStart, type GitAuthor } from '@leafbot/shared';

/** Where a session sees its own control directory. */
export const CTL_IN_SANDBOX = '/run/ctl';

export interface SandboxOptions {
  start: DesktopStart;
  display: number;
  /** The session's control directory on the controller side (cookie, sockets, logs). */
  ctlDir: string;
  workspacesRoot: string;
  stateRoot: string;
  /** node binary, helper bundle and session script, as seen inside the sandbox (rootfs is shared). */
  node: string;
  helperScript: string;
  sessionScript: string;
  /** The proxy the session's browser goes through (`socks5://…`); none when unset. */
  proxy?: string;
  /** This session's address on the git relay (`http://127.0.0.1:…/<key>/`); none when unset. */
  gitRelay?: string;
}

const isInside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}/`);

/** A path the session may be given: normalized, absolute and inside the workspaces root. */
export function checkSessionPath(path: string, workspacesRoot: string): string | null {
  if (path.includes('\0') || path.endsWith('/') || posix.normalize(path) !== path) return null;
  if (path === workspacesRoot || !isInside(path, workspacesRoot)) return null;
  return path;
}

export interface Bind {
  path: string;
  writable: boolean;
}

/**
 * Every path the sandbox gets, parents first. Home is always writable; the workdir is bound only
 * when no other bind already covers it (so a read-only folder is never made writable by it).
 */
export function collectBinds(start: DesktopStart): Bind[] {
  const binds = new Map<string, boolean>();
  for (const f of start.folders) binds.set(f.path, (binds.get(f.path) ?? false) || f.writable);
  binds.set(start.home, true);
  const covered = [...binds.keys()].some((p) => isInside(start.workdir, p));
  if (!covered) binds.set(start.workdir, true);
  return [...binds.entries()]
    .map(([path, writable]) => ({ path, writable }))
    .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
}

/**
 * Git settings that send GitHub through the relay (see git-relay.ts), in every way a repository is
 * named: https, scp-like ssh and ssh URLs. Given as `GIT_CONFIG_*` so they hold for every git the
 * session starts (commands, the terminal) without a file the bot could edit. Git never prompts:
 * a session has nobody at its terminal to answer, so a missing key ends the command instead.
 */
export function gitEnv(relay: string | undefined): Record<string, string> {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
  if (!relay) return env;
  const from = ['https://github.com/', 'git@github.com:', 'ssh://git@github.com/'];
  env.GIT_CONFIG_COUNT = String(from.length);
  from.forEach((f, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${relay}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = f;
  });
  return env;
}

/**
 * The git settings of one command that brings its own GitHub key: the session's, sent to the
 * command's own relay address. Null for anything that is not such an address.
 */
export function commandGitEnv(relay: unknown): Record<string, string> | null {
  if (typeof relay !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/[a-f0-9]{64}\/$/.test(relay))
    return null;
  return gitEnv(relay);
}

/**
 * Who one command's commits are written by, as git's own variables: they hold over the user.name
 * and user.email of any configuration, `git -c` included, so a bot's commits carry the account
 * whose key pushes them and not a name the bot made up. None when the server sent no author.
 */
export function authorEnv(author: GitAuthor | undefined): Record<string, string> {
  if (!author) return {};
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

/** The environment of everything in the session. Nothing else from the controller leaks in. */
export function sessionEnv(o: SandboxOptions): Record<string, string> {
  const { home, workdir, locale } = o.start;
  const lang = locale === 'tr' ? 'tr_TR.UTF-8' : 'en_US.UTF-8';
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: home,
    USER: 'leafbot',
    LOGNAME: 'leafbot',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    LANG: lang,
    LC_ALL: lang,
    LANGUAGE: locale === 'tr' ? 'tr_TR:tr' : 'en_US:en',
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_RUNTIME_DIR: '/run/xdg',
    DISPLAY: `:${o.display}`,
    XAUTHORITY: `${CTL_IN_SANDBOX}/xauth`,
    LEAFBOT_WORKDIR: workdir,
    LEAFBOT_DISPLAY: `:${o.display}`,
    LEAFBOT_GEOMETRY: `${DESKTOP_SIZE.width}x${DESKTOP_SIZE.height}`,
    LEAFBOT_NODE: o.node,
    LEAFBOT_HELPER: o.helperScript,
    ...(o.proxy && o.start.internet ? { LEAFBOT_PROXY: o.proxy } : {}),
    // pnpm and yarn come through corepack, which would otherwise stop to ask before its first download.
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    // Without internet the session has its own network, where the relay cannot be reached.
    ...gitEnv(o.start.internet ? o.gitRelay : undefined),
  };
}

/**
 * The bubblewrap arguments for one bot's session. The root filesystem is read-only; the
 * workspaces root is hidden under an empty tmpfs and only this bot's folders are bound back at
 * their own absolute paths. Without internet the session gets an empty network namespace.
 */
export function bwrapArgs(o: SandboxOptions): string[] {
  const args = [
    '--clearenv',
    '--unshare-pid',
    '--unshare-ipc',
    '--die-with-parent',
    ...(o.start.internet ? [] : ['--unshare-net']),
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/home',
    '--tmpfs',
    '/run',
    // Hides every other bot's files: the bound folders below need a mountpoint inside a tmpfs.
    '--tmpfs',
    o.workspacesRoot,
  ];
  if (!['/tmp', '/home', '/run'].some((r) => isInside(o.stateRoot, r)) && o.stateRoot !== o.workspacesRoot) {
    args.push('--tmpfs', o.stateRoot);
  }
  for (const b of collectBinds(o.start)) args.push(b.writable ? '--bind' : '--ro-bind', b.path, b.path);
  args.push('--bind', o.ctlDir, CTL_IN_SANDBOX);
  for (const [k, v] of Object.entries(sessionEnv(o))) args.push('--setenv', k, v);
  args.push('--chdir', o.start.workdir, '--', '/bin/sh', o.sessionScript);
  return args;
}
