import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createSdkMcpServer,
  query,
  tool,
  type McpSdkServerConfigWithInstance,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { EFFORTS, type ClaudeModel, type Effort, type PlanWindow } from '@leafbot/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { translator } from '../i18n';
import { BASH_MAX_TIMEOUT_MS } from '../runtime/watchdog';
import { readableError } from '../util';
import { failureStreak } from './failures';
import { fitResult } from './fit-image';
import { gatePrompt, parseGate } from './gate';
import { LoadedTools } from './loaded-tools';
import { startSandboxProxy } from './sandbox-proxy';
import {
  announcesAction,
  GO_ON,
  MAX_NUDGES,
  APP_SERVER,
  planItems,
  replyOf,
  resultImages,
  resultText,
  type AccountStatus,
  type AppTool,
  type CompactOutcome,
  type CompactRequest,
  type CompleteRequest,
  type Completion,
  type Engine,
  type GateRequest,
  type GateVerdict,
  type ModelStep,
  type Sandbox,
  type SubagentState,
  subagentAnswer,
  type TurnOutcome,
  type TurnRequest,
  MODEL_GONE,
  OVERLOADED,
  providerTrouble,
  runCost,
  withContext,
} from './types';

/** How full a model call left the context: what it read, cached or not, and what it wrote. */
export function contextOf(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  const total =
    n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
  return total > 0 ? total : null;
}

/** The most model steps one turn may take. */
const MAX_TURNS = 50;

/** What the CLI says when asked to resume a session it has no transcript for. */
const LOST_SESSION = /No conversation found with session ID/i;

/**
 * Settings every CLI run gets. Transcripts are what a thread resumes from, so the CLI keeps them
 * instead of deleting them after its default 30 days.
 */
const CLI_SETTINGS = { disableClaudeAiConnectors: true, cleanupPeriodDays: 3650 } as const;

/**
 * The conversation size at which the CLI folds a session into a summary, when the person set none.
 * Left to the CLI, a model with a million-token window folds only near the million: every turn
 * before then sends the whole conversation, slow and costly, and the first fold makes the person
 * wait a minute. A model whose window is this size folds as it would anyway; the CLI never takes a
 * size past the model's own window.
 */
export const AUTO_COMPACT_WINDOW = 200_000;

/** A run's CLI settings with the size it folds at; 0 leaves the size to the CLI. */
export function withCompactWindow<S extends object>(settings: S, window = AUTO_COMPACT_WINDOW) {
  return window > 0 ? { ...settings, autoCompactWindow: window } : settings;
}

/**
 * The CLI settings a session's runs share: the size it folds at and the advisor it may consult.
 * The CLI itself leaves the advisor out when the bot's model outranks it.
 */
export function sessionSettings(
  settings: Record<string, unknown>,
  req: { compactWindow?: number; advisorModel?: string },
) {
  const folded = withCompactWindow(settings, req.compactWindow);
  return req.advisorModel ? { ...folded, advisorModel: req.advisorModel } : folded;
}

export { BASH_MAX_TIMEOUT_MS };

/** How long a stopped turn's CLI gets to answer the interrupt before it is closed. */
export const STOP_GRACE_MS = 3_000;

const TIMED_OUT = /\bCommand timed out after\b/;
/** `find /`, `sudo find / -name …`: a search rooted at the disk root. */
const DISK_SCAN = /(?:^|[;&|(]\s*|\bsudo\s+)find\s+\/(?:\s|$)/m;

/**
 * What the bot is told after a shell command was stopped at its time limit, or null for any other
 * failure: the command's output is lost, and without a word the model runs it again into the same
 * wall.
 */
export function shellTimeoutHint(toolName: string, toolInput: unknown, error: string): string | null {
  if (toolName !== 'Bash' || !TIMED_OUT.test(error)) return null;
  const command =
    toolInput && typeof toolInput === 'object' ? (toolInput as { command?: unknown }).command : undefined;
  const scan = typeof command === 'string' && DISK_SCAN.test(command);
  return [
    'That command hit the shell time limit and its output was lost. Do not rerun it the same way.',
    scan
      ? 'Do not search the whole disk: search a specific folder (your workspace, home) with -maxdepth, or by name with mdfind on macOS.'
      : `If it needs longer, rerun it with a larger \`timeout\` (in milliseconds, up to ${BASH_MAX_TIMEOUT_MS}) and keep it in the foreground until it exits, or split the work into shorter pieces: a detached job may be stopped when the call ends.`,
  ].join(' ');
}

/** The plan windows asked of the CLI, in the order they are shown. */
const PLAN_KINDS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

/** How often a turn asks the CLI for the plan's usage, so it does not slow every turn. */
const PLAN_USAGE_EVERY_MS = 5 * 60_000;
let planUsageAskedAt = 0;

/**
 * The plan's usage windows from the CLI's usage answer (percentages there, 0–1 here); empty for
 * an answer of another shape, since the CLI marks this answer as one that may still change.
 */
export function planWindows(raw: unknown): PlanWindow[] {
  const limits = (raw as { rate_limits?: unknown } | null)?.rate_limits;
  if (!limits || typeof limits !== 'object') return [];
  const one = (v: unknown) => {
    const o = (v ?? {}) as { utilization?: unknown; resets_at?: unknown };
    const used = typeof o.utilization === 'number' && Number.isFinite(o.utilization) ? o.utilization : null;
    const at =
      typeof o.resets_at === 'string' && Number.isFinite(Date.parse(o.resets_at)) ? o.resets_at : null;
    return { used: used === null ? null : Math.min(1, Math.max(0, used / 100)), resetsAt: at };
  };
  const out: PlanWindow[] = [];
  const l = limits as Record<string, unknown>;
  for (const kind of PLAN_KINDS) {
    if (l[kind] && typeof l[kind] === 'object') out.push({ kind, ...one(l[kind]) });
  }
  if (Array.isArray(l.model_scoped)) {
    for (const m of l.model_scoped.slice(0, 6)) {
      const name = (m as { display_name?: unknown } | null)?.display_name;
      if (typeof name !== 'string' || !name.trim()) continue;
      out.push({ kind: `model:${name.trim().slice(0, 50)}`, label: name.trim().slice(0, 60), ...one(m) });
    }
  }
  return out;
}

/**
 * Asks the running CLI for the plan's usage, within a few seconds; nothing when it cannot say
 * (an API key, a CLI without the question, no answer in time).
 */
async function askPlanUsage(q: unknown): Promise<PlanWindow[]> {
  const ask = (q as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: unknown })
    .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof ask !== 'function') return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      (ask as (o: { skipBehaviors: boolean }) => Promise<unknown>).call(q, { skipBehaviors: true }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 3000);
      }),
    ]);
    return planWindows(answer);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** A window from a rate-limit event of the CLI, whose `utilization` runs from 0 to 1. */
export function eventWindow(info: { rateLimitType?: string; utilization?: number; resetsAt?: number }) {
  if (!info.rateLimitType || info.rateLimitType === 'overage') return null;
  const at = resetTime(info.resetsAt);
  return {
    kind: info.rateLimitType,
    used:
      typeof info.utilization === 'number' && Number.isFinite(info.utilization)
        ? Math.min(1, Math.max(0, info.utilization))
        : null,
    resetsAt: at ? at.toISOString() : null,
  } satisfies PlanWindow;
}

/**
 * The plan's windows a rate-limit event of the CLI tells, those with a known use. The event's own
 * window says its use only near a limit; `unifiedWindows` carries the five-hour and weekly windows
 * on every event, read from the headers of the API's answer, so a subscription token that may not
 * ask for the usage itself still shows how much is left.
 */
export function eventWindows(info: {
  rateLimitType?: string;
  utilization?: number;
  resetsAt?: number;
}): PlanWindow[] {
  const byKind = new Map<string, PlanWindow>();
  const unified = (info as { unifiedWindows?: unknown }).unifiedWindows;
  if (unified && typeof unified === 'object') {
    const u = unified as Record<string, unknown>;
    for (const kind of PLAN_KINDS) {
      const v = u[kind];
      if (!v || typeof v !== 'object') continue;
      const o = v as { utilization?: unknown; resetsAt?: unknown };
      const w = eventWindow({
        rateLimitType: kind,
        utilization: typeof o.utilization === 'number' ? o.utilization : undefined,
        resetsAt: typeof o.resetsAt === 'number' ? o.resetsAt : undefined,
      });
      if (w) byKind.set(kind, w);
    }
  }
  const own = eventWindow(info);
  if (own && own.used !== null) byKind.set(own.kind, own);
  return [...byKind.values()].filter((w) => w.used !== null);
}

/** How the SDK words a Claude Code process that died: it exited with a code or was killed by a signal. */
const CLI_CRASH = /^Claude Code process (exited with code|terminated by signal)\b/;

/**
 * A rejected event whose overage is still allowed does not stop the run: the CLI carries on with
 * the extra usage, so a later, unrelated error is not the plan's limit.
 */
function overageCarries(info: { overageStatus?: string; isUsingOverage?: boolean }): boolean {
  return (
    info.isUsingOverage === true ||
    info.overageStatus === 'allowed' ||
    info.overageStatus === 'allowed_warning'
  );
}

/** What was last kept from the events, so the same windows are not written after every call. */
let lastEventPlan = '';

/**
 * Environment for the Claude Code process, built from scratch: nothing from the server's own
 * environment leaks in. An ANTHROPIC_API_KEY of the server's would switch to pay-per-use billing
 * without anyone choosing it; a key chosen in Settings comes in through `extra` instead.
 */
export function engineEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'TZ'];
  const env: Record<string, string> = {};
  for (const k of keep) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'leafbot/0.10.2';
  for (const [k, v] of Object.entries(extra)) if (v) env[k] = v;
  return env;
}

/**
 * Folder limits: file tools stay in the working directories; Bash runs in the OS sandbox.
 * `hidden` are folders shell commands may not read (home, the server's data, the Claude login);
 * the bot's own folders inside them are opened again by `allowRead`. `proxy`: the ports of the
 * way out that reaches public addresses only (see `startSandboxProxy`), for a bot with internet.
 */
export function sandboxOptions(
  sb: Sandbox,
  hidden: string[],
  proxy?: { httpPort: number; socksPort: number } | null,
): Pick<Options, 'settings' | 'sandbox' | 'additionalDirectories' | 'cwd'> {
  return {
    cwd: sb.cwd,
    additionalDirectories: sb.additionalDirectories,
    settings: {
      ...CLI_SETTINGS,
      permissions: {
        blockReadsOutsideWorkingDirectories: true,
        blockWritesOutsideWorkingDirectories: true,
      },
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      // Sandboxed Bash still goes through canUseTool so "Her zaman sor" rules apply.
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: [...new Set(hidden)],
        allowRead: [sb.cwd, ...sb.additionalDirectories],
        allowWrite: sb.writable,
      },
      // No host is let through ahead. With the internet off, each one a command reaches comes to
      // canUseTool as SandboxNetworkAccess and is refused there. With it on, commands go out
      // through this server's own proxy instead of Claude Code's: that one would let a host
      // through by its name and look the name up again as it connects, so a name that changes
      // its answer (to 169.254.169.254, this machine or the private network) in between got
      // through. Ours connects to the address it checked. What remains: WebFetch runs in the
      // CLI itself, outside the sandbox and this proxy; its address is checked as the call is
      // allowed, and the CLI looks the name up again when it fetches.
      network: {
        allowedDomains: [],
        ...(proxy && { httpProxyPort: proxy.httpPort, socksProxyPort: proxy.socksPort }),
      },
    },
  };
}

function inbox() {
  const queue: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  return {
    push(text: string) {
      queue.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      } as SDKUserMessage);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
    },
  };
}

const toContent = (r: Awaited<ReturnType<AppTool['handler']>>) => [
  { type: 'text' as const, text: resultText(r) },
  ...resultImages(r).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
];

/**
 * A connection's tools as an in-process MCP server named after the connection. Their input comes
 * as the JSON Schema the connection's server gave, so this answers the listing itself instead of
 * describing each input in Zod.
 */
function connectionServer(name: string, tools: AppTool[]): McpSdkServerConfigWithInstance {
  const server = new McpServer({ name, version: '0.10.2' }, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((t) => [t.name, t]));
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: { type: 'object' as const, ...(t.jsonSchema ?? {}) },
      annotations: { readOnlyHint: t.readOnly },
    })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const t = byName.get(req.params.name);
    if (!t) return { content: [{ type: 'text' as const, text: req.params.name }], isError: true };
    return {
      content: toContent(
        await fitResult(await t.handler((req.params.arguments ?? {}) as Record<string, unknown>)),
      ),
    };
  });
  // The SDK only connects the instance to its transport; the two packages' types differ in name only.
  return { type: 'sdk', name, instance: server as unknown as McpSdkServerConfigWithInstance['instance'] };
}

/** The app's own tools under `leafbot`, and each connection's under its own name. */
export function mcpServers(tools: AppTool[]): Record<string, McpSdkServerConfigWithInstance> {
  const groups = new Map<string, AppTool[]>();
  for (const t of tools) {
    const key = t.server ?? APP_SERVER;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: Record<string, McpSdkServerConfigWithInstance> = {
    [APP_SERVER]: mcpServer(groups.get(APP_SERVER) ?? []),
  };
  for (const [name, list] of groups) if (name !== APP_SERVER) out[name] = connectionServer(name, list);
  return out;
}

function mcpServer(tools: AppTool[]) {
  return createSdkMcpServer({
    name: APP_SERVER,
    version: '0.10.2',
    tools: tools.map((t) =>
      tool(
        t.name,
        t.description,
        t.input,
        async (args) => ({
          content: toContent(await fitResult(await t.handler(args as Record<string, unknown>))),
        }),
        t.alwaysLoad ? { alwaysLoad: true } : undefined,
      ),
    ),
  });
}

/** A subscription token from `claude setup-token`, or an Anthropic API key. */
export interface ClaudeCredential {
  kind: 'token' | 'apiKey';
  value: string;
  /** With an API key: the Anthropic-compatible gateway it goes to instead of Anthropic. */
  baseUrl?: string;
}

export interface ClaudeEngineOptions {
  /** Per-account Claude config dir; unset = the default ~/.claude login. */
  configDir?: string | null;
  /** The token or key saved in Settings, read for every run; null uses the machine's login. */
  credential?: () => Promise<ClaudeCredential | null>;
  /** Further variables for the CLI process. */
  env?: Record<string, string>;
  executable?: string | null;
  home?: string;
  /** Further folders shell commands may not read, e.g. the server's data folder. */
  hidden?: string[];
}

/** A limit's reset time as the CLI reports it: seconds since the epoch (milliseconds tolerated). */
export function resetTime(at: number | undefined): Date | null {
  if (!at || !Number.isFinite(at)) return null;
  return new Date(at < 1e12 ? at * 1000 : at);
}

/** The host of the gateway an API key goes to instead of Anthropic, when it has one. */
export function gatewayName(credential: ClaudeCredential | null): string | null {
  if (credential?.kind !== 'apiKey' || !credential.baseUrl) return null;
  try {
    const host = new URL(credential.baseUrl).hostname;
    return host === 'api.anthropic.com' ? null : host;
  } catch {
    return null;
  }
}

export class ClaudeEngine implements Engine {
  readonly kind = 'claude';
  private loaded = new LoadedTools();
  constructor(private opts: ClaudeEngineOptions = {}) {}

  private async baseOptions(): Promise<{ options: Partial<Options>; credential: ClaudeCredential | null }> {
    const credential = (await this.opts.credential?.()) ?? null;
    const options: Partial<Options> = {
      settingSources: [],
      env: engineEnv({
        ...this.opts.env,
        CLAUDE_CONFIG_DIR: this.opts.configDir ?? undefined,
        // The CLI then removes Anthropic credentials from the environment of every command it
        // starts, so a bot's shell cannot read the token or key below.
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
        // A bot's memory is the app's. The CLI's own, one folder per working folder, would split notes
        // by conversation and put a per-conversation path in the prompt, voiding its cache.
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
        // A command or helper agent sent to the background would die quietly when the turn ends and
        // closes the CLI; each step's work stays inside its turn instead.
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
        // A bot may raise a long command's own timeout up to ten minutes; the default stays two.
        BASH_MAX_TIMEOUT_MS: String(BASH_MAX_TIMEOUT_MS),
        CLAUDE_CODE_OAUTH_TOKEN: credential?.kind === 'token' ? credential.value : undefined,
        ANTHROPIC_API_KEY: credential?.kind === 'apiKey' ? credential.value : undefined,
        ANTHROPIC_BASE_URL: credential?.kind === 'apiKey' ? credential.baseUrl : undefined,
      }),
      ...(this.opts.executable ? { pathToClaudeCodeExecutable: this.opts.executable } : {}),
    };
    return { options, credential };
  }

  async run(req: TurnRequest): Promise<TurnOutcome> {
    const t = translator(req.locale);
    const input = inbox();
    const home = this.opts.home ?? homedir();
    if (req.sessionId) {
      // A tool the session loaded before the server was updated keeps its old definition there,
      // and the bot works by it; a new session that takes the recent exchange sees the new one.
      const stale = await this.loaded.changed(
        this.opts.configDir ?? join(home, '.claude'),
        req.sandbox.cwd,
        req.sessionId,
        req.tools,
      );
      if (stale.length)
        return { ok: false, kind: 'lostSession', message: '', text: '', sessionId: null, staleTools: stale };
    }
    const hidden = [home, ...(this.opts.hidden ?? [])];
    if (this.opts.configDir) hidden.push(this.opts.configDir);
    const failures = failureStreak((tool, count) => req.onRepeatedFailure?.(tool, count));
    const { options: base, credential } = await this.baseOptions();
    // A key sent to another Anthropic-compatible service: its errors name that service, not Claude,
    // so an empty balance there is not looked for in Claude's own account.
    const provider = gatewayName(credential) ?? 'Claude';
    // A bot with internet reaches the web from its commands through a proxy of this run's own.
    const proxy =
      req.sandbox.internet && req.shell !== 'computer'
        ? await startSandboxProxy({ onReach: (host) => req.onReach?.(host) })
        : null;
    const sandboxed = sandboxOptions(req.sandbox, hidden, proxy);
    const options: Options = {
      ...base,
      ...sandboxed,
      settings: sessionSettings(sandboxed.settings as Record<string, unknown>, req),
      ...(req.model ? { model: req.model } : {}),
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.sessionId ? { resume: req.sessionId } : {}),
      // Not snapshotted: memory and routines in the prompt must be current on every resume.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt, snapshot: false },
      includePartialMessages: true,
      permissionMode: 'default',
      disallowedTools: [
        'AskUserQuestion',
        'EnterWorktree',
        'ExitWorktree',
        'CronCreate',
        'CronDelete',
        'CronList',
        // They work only in Claude Code's own terminal or app, and their descriptions ride every call.
        'Workflow',
        'ScheduleWakeup',
        'ReportFindings',
        'ListAgents',
        // Plan mode would end in an approval the app has no card for, only a bare "ExitPlanMode"
        // ask; a bot shows its plan with TodoWrite instead.
        'EnterPlanMode',
        'ExitPlanMode',
        // Commands go to the bot's desktop through run_command.
        ...(req.shell === 'computer' ? ['Bash', 'BashOutput', 'KillShell', 'KillBash'] : []),
        ...(req.sandbox.internet ? [] : ['WebFetch', 'WebSearch']),
      ],
      // A bot's tool selection lists the built-in tools it keeps; without one it gets them all.
      ...(req.pickTool && { tools: CLAUDE_BUILTIN_TOOLS.filter(req.pickTool) }),
      mcpServers: mcpServers(req.tools),
      maxTurns: req.maxSteps ?? MAX_TURNS,
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'PreToolUse') {
                  const refused = await req.screen?.({
                    toolName: input.tool_name,
                    input: (input.tool_input ?? {}) as Record<string, unknown>,
                  });
                  if (refused) {
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: refused,
                      },
                    };
                  }
                  req.onActivity?.({ id: input.tool_use_id, name: input.tool_name, running: true });
                }
                return {};
              },
            ],
          },
        ],
        PostToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'PostToolUse') {
                  req.onActivity?.({ id: input.tool_use_id, name: input.tool_name, running: false });
                }
                // Any call that works ends a run of identical failures.
                failures.reset();
                return {};
              },
            ],
          },
        ],
        PostToolUseFailure: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name === 'PostToolUseFailure') {
                  req.onActivity?.({ id: input.tool_use_id, name: input.tool_name, running: false });
                }
                const hint =
                  input.hook_event_name === 'PostToolUseFailure'
                    ? [
                        shellTimeoutHint(input.tool_name, input.tool_input, input.error),
                        failures.note(input.tool_name, input.tool_input, input.error),
                      ]
                        .filter(Boolean)
                        .join(' ') || null
                    : null;
                return hint
                  ? {
                      hookSpecificOutput: {
                        hookEventName: 'PostToolUseFailure' as const,
                        additionalContext: hint,
                      },
                    }
                  : {};
              },
            ],
          },
        ],
        ...(req.steering && {
          PostToolBatch: [
            {
              hooks: [
                async () => {
                  const added = req.steering?.() ?? [];
                  return added.length
                    ? {
                        hookSpecificOutput: {
                          hookEventName: 'PostToolBatch' as const,
                          additionalContext: added.join('\n\n'),
                        },
                      }
                    : {};
                },
              ],
            },
          ],
        }),
      },
      canUseTool: async (toolName, toolInput, { signal }) => {
        if (signal.aborted) return { behavior: 'deny', message: t('engine.stopped') };
        const answer = await req.canUseTool({ toolName, input: toolInput });
        return answer.behavior === 'allow'
          ? { behavior: 'allow', updatedInput: answer.updatedInput ?? toolInput }
          : { behavior: 'deny', message: answer.message };
      },
    };

    const q = query({ prompt: input, options });
    // A CLI that does not answer the interrupt is closed after a moment, so a stopped turn ends.
    let closer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      void q.interrupt().catch(() => {});
      closer = setTimeout(() => q.close?.(), STOP_GRACE_MS);
      closer.unref?.();
    };
    req.signal.addEventListener('abort', onAbort, { once: true });
    input.push(withContext(req));

    let text = '';
    // The model's answers so far, one per API message: the CLI sends each block of one apart.
    const steps: (ModelStep & { id: string })[] = [];
    let sessionId: string | null = req.sessionId;
    // The session's running cost: a resumed session goes on from the total its transcript kept.
    let total: number | null = null;
    let authFailed = false;
    let errorMessage: string | null = null;
    let finished = false;
    let outOfSteps = false;
    // Set once the account's usage limit refuses the turn: when it lifts, or null when unknown.
    let limited: { resetsAt: Date | null } | null = null;
    // What a failed API call said, when the CLI reported one.
    let apiError: string | null = null;
    // How full the session was after the model's last answer, for folding it while idle.
    let contextTokens: number | null = null;
    // The CLI named a billing failure itself, whatever words its text used.
    let billingFailed = false;
    // The provider refused on content or safety grounds, with what it said about it.
    let refused: string | null = null;
    // How many times the turn told the model to do what it announced.
    let nudges = 0;
    const hasTools = req.tools.length > 0 || !req.pickTool || CLAUDE_BUILTIN_TOOLS.some(req.pickTool);
    // Subagents the bot started this run, by the id of the call that started each.
    const subagents = new Map<string, SubagentState>();
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        req.onActivity?.();
        // Anything a subagent sends says it has started: the CLI may hold some back while others run.
        const from = (m as { parent_tool_use_id?: string | null }).parent_tool_use_id;
        const started = from ? subagents.get(from) : undefined;
        if (started?.state === 'waiting') {
          started.state = 'running';
          req.onSubagent?.({ ...started });
        }
        if (m.type === 'rate_limit_event') {
          const info = m.rate_limit_info;
          const windows = eventWindows(info);
          const seen = JSON.stringify(windows);
          if (windows.length && seen !== lastEventPlan && req.onPlanUsage) {
            lastEventPlan = seen;
            req.onPlanUsage(windows);
          }
          if (info.status === 'rejected' && !overageCarries(info))
            limited = { resetsAt: resetTime(info.resetsAt) };
          else if (info.status === 'allowed_warning') {
            req.onLimitNear?.({ used: info.utilization ?? null, resetsAt: resetTime(info.resetsAt) });
          }
        } else if (m.type === 'system' && m.subtype === 'model_refusal_no_fallback') {
          refused = m.api_refusal_explanation || m.content || 'refusal';
        } else if (m.type === 'system' && m.subtype === 'status') {
          // The CLI folds a long session in silence until the boundary arrives; it gets the time a tool does.
          req.onCompacting?.(m.status === 'compacting');
        } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
          req.onCompacting?.(false);
          req.onCompacted?.();
        } else if (m.type === 'system' && m.subtype === 'init') {
          sessionId = m.session_id;
          req.onSession(m.session_id);
          // Asked while the turn runs, so its end never waits for the answer.
          const onPlanUsage = req.onPlanUsage;
          if (onPlanUsage && Date.now() - planUsageAskedAt > PLAN_USAGE_EVERY_MS) {
            planUsageAskedAt = Date.now();
            void askPlanUsage(q).then((windows) => {
              if (windows.length) onPlanUsage(windows);
            });
          }
        } else if (m.type === 'stream_event') {
          // A subagent's words are its own work, not the reply: they stay out of the chat as the
          // finished text does.
          if (m.parent_tool_use_id) continue;
          const ev = m.event as { type: string; delta?: { type: string; text?: string } };
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            req.onText(ev.delta.text);
          }
        } else if (m.type === 'user' && Array.isArray(m.message.content)) {
          // A tool's result, a refused call's too, ends that call.
          for (const c of m.message.content) {
            if (c.type !== 'tool_result') continue;
            req.onActivity?.({ id: c.tool_use_id, name: '', running: false });
            const sub = subagents.get(c.tool_use_id);
            if (sub && (sub.state === 'running' || sub.state === 'waiting')) {
              sub.state = c.is_error ? 'failed' : 'done';
              const result = subagentAnswer(c.content);
              if (result) sub.result = result;
              req.onSubagent?.({ ...sub });
            }
          }
        } else if (m.type === 'assistant') {
          const err = (m as { error?: string }).error;
          if (err === 'authentication_failed') authFailed = true;
          if (err === 'rate_limit') limited ??= { resetsAt: null };
          if (err === 'billing_error') billingFailed = true;
          // The CLI reports a failed API call as an assistant message carrying the error's text:
          // that text is the cause of the failure, not the bot's reply.
          if (err) {
            apiError = m.message.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('') || err;
            continue;
          }
          // What the session's own model call read and wrote is how full its context is now.
          if (!m.parent_tool_use_id) contextTokens = contextOf(m.message.usage) ?? contextTokens;
          // A subagent's own steps come with the id of the call that started it.
          const parent = m.parent_tool_use_id ? subagents.get(m.parent_tool_use_id) : undefined;
          for (const c of m.message.content) {
            if (c.type !== 'tool_use') continue;
            if (parent) {
              parent.steps += 1;
              parent.tool = c.name;
              req.onSubagent?.({ ...parent });
            } else if (c.name === 'Task' || c.name === 'Agent') {
              const input = (c.input ?? {}) as { description?: unknown; subagent_type?: unknown };
              const description =
                typeof input.description === 'string'
                  ? input.description
                  : typeof input.subagent_type === 'string'
                    ? input.subagent_type
                    : '';
              // Waiting until it sends anything of its own (see the top of the loop).
              const sub: SubagentState = {
                id: c.id,
                description: description.slice(0, 200),
                state: 'waiting',
                steps: 0,
              };
              subagents.set(c.id, sub);
              req.onSubagent?.({ ...sub });
            }
          }
          if (parent) continue;
          for (const c of m.message.content) {
            if (c.type === 'tool_use' && c.name === 'TodoWrite') {
              const plan = planItems(c.input);
              if (plan) req.onPlan?.(plan);
            }
          }
          // Keep the text of the last assistant message; earlier ones were interim steps.
          const parts = m.message.content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
          if (parts.length) text = parts.join('');
          const id = m.message.id;
          let step = steps.at(-1);
          if (!step || step.id !== id) steps.push((step = { id, text: '', tools: [] }));
          step.text += parts.join('');
          for (const c of m.message.content) if (c.type === 'tool_use') step.tools.push(c.name);
        } else if (m.type === 'result') {
          finished = true;
          total = m.total_cost_usd ?? null;
          if (m.subtype === 'error_max_turns') outOfSteps = true;
          if (m.stop_reason === 'refusal') refused ??= 'refusal';
          if (refused && m.subtype === 'success' && !m.is_error) {
            // The turn ended on the refusal: what it wrote before is not an answer.
            errorMessage = m.result || apiError || refused;
          } else if (m.subtype === 'success' && !m.is_error) {
            if (m.result) text = m.result;
          } else {
            errorMessage =
              m.subtype === 'success'
                ? m.result || apiError || t('engine.error')
                : m.errors?.length
                  ? m.errors.join('; ')
                  : m.subtype === 'error_max_turns'
                    ? t('engine.stepLimit', { max: req.maxSteps ?? MAX_TURNS })
                    : apiError || t('engine.unfinished');
          }
          // A model that says what it is about to do ("Let me check the file:") and stops there, with
          // no call, is told to go on in the same session; a few times at most. Not while work it
          // handed to other bots is out: stopping there is waiting for their answers.
          const last = steps.at(-1);
          if (
            nudges < MAX_NUDGES &&
            hasTools &&
            !errorMessage &&
            !refused &&
            !req.signal.aborted &&
            m.subtype === 'success' &&
            last &&
            !last.tools.length &&
            announcesAction(last.text) &&
            !(await req.awaitsAnswers?.())
          ) {
            nudges++;
            finished = false;
            input.push(GO_ON);
            continue;
          }
          input.close();
        }
      }
    } catch (err) {
      errorMessage = errorMessage ?? apiError ?? (err as Error).message;
      if (/not logged in|\/login/i.test(errorMessage)) authFailed = true;
    } finally {
      req.onCompacting?.(false);
      // A subagent the run left behind did not finish.
      for (const sub of subagents.values()) {
        if (sub.state !== 'running' && sub.state !== 'waiting') continue;
        sub.state = 'stopped';
        req.onSubagent?.({ ...sub });
      }
      clearTimeout(closer);
      req.signal.removeEventListener('abort', onAbort);
      input.close();
      proxy?.close();
    }
    // A reply the last message only closes keeps what was written with its quick replies.
    if (steps.length > 1 && !steps.at(-1)!.tools.length) {
      const reply = replyOf(steps);
      if (reply !== steps.at(-1)!.text) text = reply;
    }
    const costUsd = runCost(total, req.sessionId ? req.sessionCostUsd : null);
    const sessionCostUsd = total;
    if (req.signal.aborted) {
      return {
        ok: false,
        kind: 'interrupted',
        message: t('engine.stopped'),
        text,
        sessionId,
        costUsd,
        sessionCostUsd,
      };
    }
    if (authFailed) {
      return { ok: false, kind: 'auth', message: t('engine.noClaudeLogin'), text: '', sessionId };
    }
    // The CLI deletes old transcripts after a while; the thread's session may have gone with them.
    if (req.sessionId && errorMessage && LOST_SESSION.test(errorMessage)) {
      return { ok: false, kind: 'lostSession', message: errorMessage, text: '', sessionId: null };
    }
    if (limited && (errorMessage || !finished)) {
      return {
        ok: false,
        kind: 'limit',
        message: errorMessage ?? t('engine.unfinished'),
        text,
        sessionId,
        resetsAt: limited.resetsAt,
        costUsd,
        sessionCostUsd,
      };
    }
    if (errorMessage || !finished) {
      // An API failure in words the person can act on: an empty balance, an overloaded server.
      const cause = errorMessage ?? apiError;
      // The CLI words a model it cannot use on its own, with no API error before it.
      const said = cause && (apiError || MODEL_GONE.test(cause)) ? providerTrouble(cause, provider, t) : null;
      const billing = billingFailed || said?.billing === true;
      if (refused) {
        return {
          ok: false,
          kind: 'engine',
          message: `${t('engine.providerRefused', { provider })} (${readableError(refused.trim(), 300)})`,
          text,
          sessionId,
          refused: true,
          costUsd,
          sessionCostUsd,
        };
      }
      // The CLI's own words for a crash: its process exited or was killed, with nothing from the API.
      const crashed = !apiError && !!cause && CLI_CRASH.test(cause);
      return {
        ok: false,
        kind: 'engine',
        message:
          billingFailed && cause && !said?.billing
            ? `${t('engine.providerBilling', { provider })} (${readableError(cause.trim(), 300)})`
            : (said?.message ?? cause ?? t('engine.unfinished')),
        text,
        sessionId,
        ...(((cause && OVERLOADED.test(cause)) || said?.transient || crashed) && { transient: true }),
        ...(crashed && { crashed: true }),
        ...(billing && { billing: true }),
        ...(said?.modelGone && { modelGone: true }),
        ...(outOfSteps && { stepLimit: true }),
        costUsd,
        sessionCostUsd,
      };
    }
    return { ok: true, text, sessionId, costUsd, sessionCostUsd, contextTokens };
  }

  /**
   * Folds the session into a summary with the CLI's own /compact, resumed where its turns ran, so
   * the session found is the same one. No tool runs: the CLI only writes the summary.
   */
  async compact(req: CompactRequest): Promise<CompactOutcome> {
    const t = translator(req.locale);
    const home = this.opts.home ?? homedir();
    const hidden = [home, ...(this.opts.hidden ?? [])];
    if (this.opts.configDir) hidden.push(this.opts.configDir);
    const base = (await this.baseOptions()).options;
    const sandboxed = sandboxOptions(req.sandbox, hidden, null);
    const q = query({
      prompt: '/compact',
      options: {
        ...base,
        ...sandboxed,
        settings: sessionSettings(sandboxed.settings as Record<string, unknown>, req),
        ...(req.model ? { model: req.model } : {}),
        resume: req.sessionId,
        permissionMode: 'default',
        maxTurns: 1,
        canUseTool: async () => ({ behavior: 'deny', message: t('engine.stopped') }),
      },
    });
    const onAbort = () => void q.interrupt().catch(() => {});
    req.signal.addEventListener('abort', onAbort, { once: true });
    let sessionId = req.sessionId;
    let folded = false;
    let after: number | null = null;
    let total: number | null = null;
    let error: string | null = null;
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
        else if (m.type === 'system' && m.subtype === 'compact_boundary') {
          folded = true;
          after = m.compact_metadata.post_tokens ?? null;
        } else if (m.type === 'result') {
          total = m.total_cost_usd ?? null;
          if (m.subtype !== 'success' || m.is_error) {
            error = m.subtype === 'success' ? m.result : m.errors?.join('; ') || t('engine.unfinished');
          }
        }
      }
    } catch (err) {
      error ??= (err as Error).message;
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
    const costUsd = runCost(total, req.sessionCostUsd);
    if (req.signal.aborted)
      return { ok: false, message: t('engine.stopped'), costUsd, sessionCostUsd: total };
    if (error || !folded) {
      return { ok: false, message: error ?? t('engine.unfinished'), costUsd, sessionCostUsd: total };
    }
    return { ok: true, sessionId, contextTokens: after, costUsd, sessionCostUsd: total };
  }

  /** Starts a CLI without tools, runs `ask` against it and closes it. */
  private async withCli<T>(ask: (q: ReturnType<typeof query>) => Promise<T>, ms = 20_000): Promise<T> {
    const input = inbox();
    const { options } = await this.baseOptions();
    const q = query({
      prompt: input,
      options: { ...options, settings: CLI_SETTINGS, tools: [] },
    });
    try {
      return await Promise.race([ask(q), new Promise<never>((_, rej) => setTimeout(() => rej(TIMEOUT), ms))]);
    } finally {
      input.close();
      q.close?.();
    }
  }

  /** Login check without reading tokens: ask the CLI who is signed in. */
  async account(): Promise<AccountStatus> {
    const credential = (await this.opts.credential?.()) ?? null;
    try {
      const info = await this.withCli((q) => q.accountInfo());
      if (info.tokenSource === 'none' && !info.apiKeySource?.length)
        return { status: 'logged-out', detail: null };
      if (info.apiKeySource && info.apiKeySource !== 'none') {
        // A key chosen in Settings is expected; any other key would bill per use unasked.
        if (credential?.kind === 'apiKey' && info.apiKeySource === 'ANTHROPIC_API_KEY')
          return { status: 'ok', detail: null };
        return { status: 'error', reason: 'api-key', detail: info.apiKeySource };
      }
      return { status: 'ok', detail: info.subscriptionType ?? null };
    } catch (err) {
      if (err === TIMEOUT) return { status: 'error', reason: 'timeout', detail: null };
      return { status: 'error', detail: (err as Error).message };
    }
  }

  /**
   * The login check, then one short reply from the cheapest model: a token or key the CLI accepts
   * locally can still be refused by Anthropic, and only a request shows that.
   */
  async probe(): Promise<AccountStatus> {
    const account = await this.account();
    if (account.status !== 'ok') return account;
    const input = inbox();
    const { options } = await this.baseOptions();
    const q = query({
      prompt: input,
      options: {
        ...options,
        settings: CLI_SETTINGS,
        tools: [],
        model: 'haiku',
        maxTurns: 1,
      },
    });
    input.push('Reply with the single word: ok');
    let error: string | null = null;
    let auth = false;
    const run = async () => {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'assistant') {
          const e = (m as { error?: string }).error;
          if (e) {
            error = e;
            if (e === 'authentication_failed') auth = true;
          }
        } else if (m.type === 'result') {
          if (m.is_error || m.subtype !== 'success')
            error = error ?? (m.subtype === 'success' ? (m.result ?? 'error') : m.subtype);
          break;
        }
      }
    };
    try {
      await Promise.race([run(), new Promise<never>((_, rej) => setTimeout(() => rej(TIMEOUT), 60_000))]);
    } catch (err) {
      if (err === TIMEOUT) return { status: 'error', reason: 'timeout', detail: null };
      error = (err as Error).message;
    } finally {
      input.close();
      q.close?.();
    }
    if (auth) return { status: 'logged-out', detail: null };
    return error ? { status: 'error', detail: error } : account;
  }

  /**
   * One answer from the cheapest model, without tools, for a small decision. Returns the text and
   * what it cost; throws on a failure or after 30 seconds.
   */
  private async quick(
    system: string,
    user: string,
    signal: AbortSignal,
  ): Promise<{ text: string; costUsd: number | null }> {
    const input = inbox();
    const { options } = await this.baseOptions();
    const q = query({
      prompt: input,
      options: {
        ...options,
        settings: CLI_SETTINGS,
        tools: [],
        model: 'haiku',
        maxTurns: 1,
        systemPrompt: system,
      },
    });
    const onAbort = () => void q.interrupt().catch(() => {});
    signal.addEventListener('abort', onAbort, { once: true });
    input.push(user);
    let text = '';
    let costUsd: number | null = null;
    const run = async () => {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === 'assistant') {
          const parts = m.message.content.flatMap((c) => (c.type === 'text' ? [c.text] : []));
          if (parts.length) text = parts.join('');
        } else if (m.type === 'result') {
          if (typeof m.total_cost_usd === 'number') costUsd = m.total_cost_usd;
          if (m.subtype === 'success' && !m.is_error && m.result) text = m.result;
          break;
        }
      }
    };
    try {
      await Promise.race([run(), new Promise<never>((_, rej) => setTimeout(() => rej(TIMEOUT), 30_000))]);
    } catch (err) {
      throw err === TIMEOUT ? new Error('timeout') : err;
    } finally {
      signal.removeEventListener('abort', onAbort);
      input.close();
      q.close?.();
    }
    return { text, costUsd };
  }

  /**
   * The routine pre-check: the cheapest model, without tools, says whether a run has anything to
   * work on. A failure throws, and the caller lets the run go ahead.
   */
  async gate(req: GateRequest): Promise<GateVerdict> {
    const { system, user } = gatePrompt(req);
    const { text, costUsd } = await this.quick(system, user, req.signal);
    if (req.signal.aborted) throw new Error('aborted');
    return parseGate(text, costUsd);
  }

  /**
   * One answer without tools or a session, from the cheapest model: the memory review reads a
   * conversation this way, so it neither starts a turn nor reaches a chat app.
   */
  async complete(req: CompleteRequest): Promise<Completion> {
    return this.quick(req.system, req.user, req.signal);
  }

  /** The models this login can use and their effort levels. */
  async models(): Promise<ClaudeModel[]> {
    const list = await this.withCli((q) => q.supportedModels());
    return list.map((m) => ({
      value: m.value,
      name: m.displayName,
      description: m.description,
      efforts: m.supportsEffort
        ? (m.supportedEffortLevels ?? []).filter((e): e is Effort => EFFORTS.includes(e))
        : [],
    }));
  }
}

const TIMEOUT = new Error('timeout');

/** Shown when the CLI cannot list models, e.g. before any login works. */
/**
 * Claude Code's own tools, by name, for a bot whose tool selection keeps only some of them. A
 * tool missing here is left out for such a bot, and also refused if Claude offers it anyway.
 */
export const CLAUDE_BUILTIN_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'Task',
  'Agent',
  'Skill',
  'ToolSearch',
];

export const FALLBACK_MODELS: ClaudeModel[] = [
  { value: 'sonnet', name: 'Sonnet', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', name: 'Opus', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', name: 'Haiku', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
