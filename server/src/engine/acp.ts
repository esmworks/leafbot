import { execFile, spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import {
  client as acpClient,
  ndJsonStream,
  PROTOCOL_VERSION,
  type AgentApp,
  type ClientContext,
  type McpServer,
  type NewSessionResponse,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionUpdate,
  type Stream,
  type ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ACP_AGENTS, type AcpAgentId } from '@leafbot/shared';
import { z } from 'zod';
import { translator, type T } from '../i18n';
import {
  resultImages,
  resultText,
  toolPermName,
  withContext,
  type AppTool,
  type Engine,
  type PermissionAsk,
  type PlanItem,
  type TurnOutcome,
  type TurnRequest,
} from './types';

/**
 * Another coding agent's command-line tool (Gemini CLI, Codex, OpenCode…) as a bot's engine,
 * spoken to over the Agent Client Protocol: the app starts the tool for a turn, hands it the
 * message and shows what it writes back.
 *
 * Such a tool runs on the server's computer with its own login, its own file and shell tools and
 * its own rules for when to ask. The app cannot put it in the bot's sandbox: it only hears about a
 * step when the tool asks, or after the tool started it. So it is offered only where the server
 * runs on the owner's own computer, and runs only the owner's own messages (see `acpAllowed`).
 * What it does ask about goes through the same cards and rules as any other bot's steps, and the
 * app's own tools reach it through a local MCP server that asks the same way.
 */

/** How each agent's tool is started in its protocol mode. */
export const ACP_COMMANDS: Record<AcpAgentId, { command: string; args: string[] }> = {
  gemini: { command: 'gemini', args: ['--acp'] },
  codex: { command: 'codex-acp', args: [] },
  opencode: { command: 'opencode', args: ['acp'] },
  kimi: { command: 'kimi', args: ['acp'] },
};

/** Between these the shell prints its PATH, apart from whatever its start-up files print. */
const PATH_MARK = '__LEAFBOT_PATH__';
let shellPathOnce: Promise<string> | null = null;

/**
 * The PATH the person's own shell has. An app opened from the Dock starts with the system's short
 * one, where tools installed with Homebrew or a Node version manager are not found; the shell's
 * start-up files add them. Read once, and the server's own PATH stays when the shell does not answer.
 */
export function shellPath(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  shellPathOnce ??= new Promise((resolve) => {
    const fallback = env.PATH ?? '';
    if (process.platform === 'win32') return resolve(fallback);
    execFile(
      env.SHELL || '/bin/zsh',
      ['-ilc', `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`],
      { timeout: 5000, env, encoding: 'utf8' },
      (_err, stdout) => {
        const found = String(stdout ?? '').split(PATH_MARK)[1];
        resolve(
          found
            ? [...new Set([...found.split(delimiter), ...fallback.split(delimiter)])]
                .filter(Boolean)
                .join(delimiter)
            : fallback,
        );
      },
    ).stdin?.end();
  });
  return shellPathOnce;
}

/** Whether a command is found on a PATH, as the shell would find it. */
export async function onPath(command: string, path: string): Promise<boolean> {
  const candidates = isAbsolute(command)
    ? [command]
    : path
        .split(delimiter)
        .filter(Boolean)
        .map((d) => join(d, command));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return true;
    } catch {
      // Not here.
    }
  }
  return false;
}

/** A started agent: where to talk to it, and how to end it. */
export interface AcpProcess {
  target: Stream | AgentApp;
  /** Rejects once the tool exits by itself, with what it wrote to stderr last. */
  exited: Promise<never>;
  close(): void;
}

export interface AcpEngineOptions {
  /** Starts the agent for a turn; tests give an agent of their own. */
  start?(agent: AcpAgentId, cwd: string): AcpProcess;
  /** The variables the tool starts with; the server's own secrets are left out. */
  env?: NodeJS.ProcessEnv;
  /** How long a stopped agent has before it is ended; `CANCEL_GRACE_MS` unless a test says. */
  cancelGraceMs?: number;
  /** How each agent's tool starts, where it differs from `ACP_COMMANDS`; for tests. */
  commands?: Partial<typeof ACP_COMMANDS>;
  version: string;
}

/** Variables the server holds for itself, which no agent tool needs. */
const PRIVATE_ENV = /^(LEAFBOT_|DATABASE_URL$|PG|ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/;

export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !PRIVATE_ENV.test(k)));
}

function startProcess(
  { command, args }: { command: string; args: string[] },
  cwd: string,
  env: NodeJS.ProcessEnv,
): AcpProcess {
  // A group of its own, so ending it also ends the commands it started.
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  // A broken pipe after the tool exited is told by `exited`, not thrown.
  child.stdin.on('error', () => {});
  const exited = new Promise<never>((_, reject) => {
    child.once('error', (err) => reject(err));
    child.once('exit', (code, signal) =>
      reject(Object.assign(new Error(stderr.trim() || `exit ${code ?? signal}`), { exit: true })),
    );
  });
  exited.catch(() => {});
  return {
    target: ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    exited,
    close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000).unref();
    },
  };
}

/**
 * The name cards and permission rules use for one of the agent's own steps: what the same kind of
 * step is called for Claude bots, so "read files", "run commands" and the like mean the same here.
 * A step of a kind the protocol leaves open keeps the agent's own title.
 */
export function stepAsk(call: ToolCallUpdate): PermissionAsk {
  const raw = (call.rawInput && typeof call.rawInput === 'object' ? call.rawInput : {}) as Record<
    string,
    unknown
  >;
  const path = call.locations?.[0]?.path;
  const title = call.title ?? '';
  switch (call.kind) {
    case 'read':
      return { toolName: 'Read', input: { ...raw, ...(path && { file_path: path }) } };
    case 'search':
      return { toolName: 'Grep', input: { ...raw, ...(path && { path }) } };
    case 'edit':
    case 'delete':
    case 'move':
      return { toolName: 'Edit', input: { ...raw, ...(path && { file_path: path }) } };
    case 'execute':
      return {
        toolName: 'Bash',
        input: { ...raw, command: typeof raw.command === 'string' ? raw.command : title },
      };
    case 'fetch':
      return { toolName: 'WebFetch', input: { ...raw, ...(!raw.url && title && { url: title }) } };
    default:
      return { toolName: `acp:${call.name ?? title ?? 'step'}`.slice(0, 120), input: raw };
  }
}

/** The answer to an agent's question that matches ours: once, never "always", so it asks again. */
export function pickOption(options: PermissionOption[], allow: boolean): RequestPermissionResponse {
  const kinds = allow ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of kinds) {
    const o = options.find((x) => x.kind === kind);
    if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  return { outcome: { outcome: 'cancelled' } };
}

/** The host a fetch step reaches, when it says. */
function hostOf(call: ToolCallUpdate): string | null {
  const raw = (call.rawInput ?? {}) as { url?: unknown };
  const url = typeof raw.url === 'string' ? raw.url : (call.title ?? '');
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** A tool's name as the agent sees it: a connection's tools keep their connection's name before it. */
const exposedName = (tool: AppTool) => (tool.server ? `${tool.server}__${tool.name}` : tool.name);

/**
 * Whether an agent's question is about calling one of the app's tools on the app's MCP server:
 * agents name such a step by the tool, often with the server's name (`memory_save (leafbot MCP
 * Server)`, `mcp__leafbot__memory_save`), and do not call it a read, edit or command.
 */
export function appToolCall(call: ToolCallUpdate, exposed: ReadonlySet<string>): boolean {
  if (call.kind && call.kind !== 'other') return false;
  const label = `${call.name ?? ''} ${call.title ?? ''}`;
  if (!/leafbot/i.test(label)) return false;
  return label
    .split(/[^A-Za-z0-9_]+/)
    .some((word) => [...exposed].some((name) => word === name || word.endsWith(`__${name}`)));
}

/**
 * The app's tools as an MCP server on this computer alone, for one turn: its address carries a
 * secret made for the turn, and every call asks, or is let through, exactly as it would for any
 * other engine before it runs.
 */
export async function serveTools(req: TurnRequest, t: T): Promise<{ url: string; close(): Promise<void> }> {
  const byName = new Map(req.tools.map((tool) => [exposedName(tool), tool]));
  const secret = randomBytes(24).toString('base64url');
  const mcp = () => {
    const server = new Server({ name: 'leafbot', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...byName].map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: (tool.jsonSchema ?? z.toJSONSchema(z.object(tool.input))) as {
          type: 'object';
          [k: string]: unknown;
        },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
      const tool = byName.get(params.name);
      if (!tool) return fail(t('engine.unknownTool', { name: params.name }));
      let input = (params.arguments ?? {}) as Record<string, unknown>;
      if (!tool.jsonSchema) {
        const parsed = z.object(tool.input).safeParse(input);
        if (!parsed.success) return fail(z.prettifyError(parsed.error));
        input = parsed.data as Record<string, unknown>;
      }
      const perm = toolPermName(tool);
      const refused = await req.screen?.({ toolName: perm, input });
      if (refused) return fail(refused);
      if (req.signal.aborted) return fail(t('engine.stopped'));
      const answer = await req.canUseTool({ toolName: perm, input });
      if (answer.behavior !== 'allow') return fail(answer.message);
      const id = randomBytes(6).toString('hex');
      req.onActivity?.({ id, name: perm, running: true });
      try {
        const result = await tool.handler(answer.updatedInput ?? input);
        return {
          content: [
            { type: 'text' as const, text: resultText(result) },
            ...resultImages(result).map((i) => ({
              type: 'image' as const,
              data: i.data,
              mimeType: i.mimeType,
            })),
          ],
        };
      } catch (err) {
        return fail((err as Error).message);
      } finally {
        req.onActivity?.({ id, name: perm, running: false });
      }
    });
    return server;
  };
  const http: HttpServer = createServer((request, response) => {
    if (request.url !== `/${secret}/mcp`) {
      response.writeHead(404).end();
      return;
    }
    // Each request on its own, so nothing lingers between them.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = mcp();
    response.on('close', () => {
      void transport.close();
      void server.close();
    });
    void server.connect(transport).then(() => transport.handleRequest(request, response));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${secret}/mcp`,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** An engine that runs nothing and says why: a coding agent bot asked to work where it may not. */
export const refusingEngine = (
  why: 'engine.acpOff' | 'engine.acpOwnerOnly' | 'engine.acpReadOnly',
): Engine => ({
  kind: 'acp',
  run: async (req) => ({
    ok: false,
    kind: 'engine',
    message: translator(req.locale)(why),
    text: '',
    sessionId: req.sessionId,
  }),
});

/** How long an agent has to stop after it was told to, before it is ended. */
export const CANCEL_GRACE_MS = 5000;

/** The agent says it needs its own login (the protocol's "auth required"). */
const AUTH_REQUIRED = -32000;

export class AcpEngine implements Engine {
  readonly kind = 'acp';

  constructor(private opts: AcpEngineOptions) {}

  private command(agent: AcpAgentId) {
    return this.opts.commands?.[agent] ?? ACP_COMMANDS[agent];
  }

  async run(req: TurnRequest): Promise<TurnOutcome> {
    const t = translator(req.locale);
    const agent = ACP_AGENTS.find((a) => a.id === req.model);
    type Failed = Extract<TurnOutcome, { ok: false }>;
    const fail = (message: string, extra: Partial<Failed> = {}): Failed => ({
      ok: false,
      kind: 'engine',
      message,
      text,
      sessionId,
      ...extra,
    });
    let text = '';
    let sessionId: string | null = req.sessionId;
    if (!agent) return fail(t('engine.acpUnknown', { agent: req.model }));

    let proc: AcpProcess;
    try {
      const env = this.opts.env ?? { ...process.env, PATH: await shellPath() };
      proc = this.opts.start
        ? this.opts.start(agent.id, req.sandbox.cwd)
        : startProcess(this.command(agent.id), req.sandbox.cwd, agentEnv(env));
    } catch (err) {
      return fail(t('engine.acpMissing', { agent: agent.name, detail: (err as Error).message }));
    }
    let tools: Awaited<ReturnType<typeof serveTools>> | null = null;
    // Updates count once the session is ours: a loaded session first replays its past.
    let live = false;
    const running = new Set<string>();

    const update = (u: SessionUpdate) => {
      req.onActivity?.();
      if (!live) return;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          if (u.content.type === 'text') {
            text += u.content.text;
            req.onText(u.content.text);
          }
          return;
        case 'tool_call': {
          const { toolName } = stepAsk(u);
          running.add(u.toolCallId);
          req.onActivity?.({ id: u.toolCallId, name: toolName, running: true });
          // What a fetch brings back is outside text, as a command reaching a host would be.
          if (u.kind === 'fetch') {
            const host = hostOf(u);
            if (host) req.onReach?.(host);
          }
          return;
        }
        case 'tool_call_update':
          if ((u.status === 'completed' || u.status === 'failed') && running.delete(u.toolCallId))
            req.onActivity?.({ id: u.toolCallId, name: stepAsk(u).toolName, running: false });
          return;
        case 'plan':
          req.onPlan?.(
            u.entries.slice(0, 50).map((e): PlanItem => ({
              text: e.content.slice(0, 300),
              status: e.status === 'in_progress' || e.status === 'completed' ? e.status : 'pending',
            })),
          );
          return;
        default:
          return;
      }
    };

    const exposed = new Set(req.tools.map(exposedName));
    const ask = async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      if (req.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      // Some agents ask before calling an MCP tool. A call to the app's own tools is asked about,
      // or let through, where it lands (see `serveTools`), so it is not asked about twice.
      if (appToolCall(params.toolCall, exposed)) return pickOption(params.options, true);
      const step = stepAsk(params.toolCall);
      const refused = await req.screen?.(step);
      if (refused) return pickOption(params.options, false);
      const answer = await req.canUseTool(step);
      return pickOption(params.options, answer.behavior === 'allow');
    };

    const app = acpClient({ name: 'leafbot' })
      .onRequest('session/request_permission', ({ params }) => ask(params))
      .onNotification('session/update', ({ params }) => {
        if (params.sessionId === sessionId) update(params.update);
      });

    const work = async (peer: ClientContext): Promise<TurnOutcome> => {
      const init = await peer.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        // Files and commands stay the agent's own: the app lends it neither.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'leafbot', version: this.opts.version },
      });
      const caps = init.agentCapabilities ?? {};
      // The app's tools reach an agent that takes MCP servers over HTTP; others go without them.
      if (req.tools.length && caps.mcpCapabilities?.http) tools = await serveTools(req, t);
      const mcpServers: McpServer[] = tools
        ? [{ type: 'http', name: 'leafbot', url: tools.url, headers: [] }]
        : [];
      const base = { cwd: req.sandbox.cwd, mcpServers };
      let fresh = false;
      if (sessionId && caps.loadSession) {
        try {
          await peer.request('session/load', { ...base, sessionId });
        } catch (err) {
          // A missing login is told as such; anything else means the session is gone.
          if ((err as { code?: unknown }).code === AUTH_REQUIRED) throw err;
          return { ok: false, kind: 'lostSession', message: '', text: '', sessionId: null };
        }
      } else {
        // An agent that cannot load a past session starts over: the turn hands the recent exchange
        // over as it does when a session is lost.
        if (sessionId) return { ok: false, kind: 'lostSession', message: '', text: '', sessionId: null };
        const created: NewSessionResponse = await peer.request('session/new', base);
        sessionId = created.sessionId;
        req.onSession(created.sessionId);
        fresh = true;
      }
      live = true;
      const sid = sessionId!;
      // Told to stop; an agent that does not is ended, along with what it started.
      let grace: NodeJS.Timeout | undefined;
      const onAbort = () => {
        void peer.notify('session/cancel', { sessionId: sid }).catch(() => {});
        grace = setTimeout(() => proc.close(), this.opts.cancelGraceMs ?? CANCEL_GRACE_MS);
        grace.unref();
      };
      req.signal.addEventListener('abort', onAbort, { once: true });
      try {
        // The protocol has no place for instructions: a new session reads them before the first message.
        const prompt = fresh
          ? `<instructions>\n${req.systemPrompt}\n</instructions>\n\n${withContext(req)}`
          : withContext(req);
        const { stopReason } = await peer.request('session/prompt', {
          sessionId: sid,
          prompt: [{ type: 'text', text: prompt }],
        });
        if (stopReason === 'cancelled' || req.signal.aborted)
          return { ok: false, kind: 'interrupted', message: t('engine.stopped'), text, sessionId };
        if (stopReason === 'max_tokens' || stopReason === 'max_turn_requests')
          return fail(t('engine.acpLimit', { agent: agent.name }), { stepLimit: true });
        if (stopReason === 'refusal') return fail(t('engine.acpRefused', { agent: agent.name }));
        return { ok: true, text, sessionId, costUsd: null };
      } finally {
        clearTimeout(grace);
        req.signal.removeEventListener('abort', onAbort);
      }
    };

    try {
      return await Promise.race([app.connectWith(proc.target, work), proc.exited]);
    } catch (thrown) {
      let err = thrown as Error & { code?: unknown; exit?: boolean };
      // A tool that dies closes its output before its exit is told: that exit says what went wrong.
      if (!err.exit && err.code !== AUTH_REQUIRED) {
        const exit = await Promise.race([
          proc.exited.catch((x: Error & { exit?: boolean }) => x),
          new Promise<null>((r) => setTimeout(() => r(null), 500).unref()),
        ]);
        if (exit) err = exit;
      }
      const e = err;
      if (e.code === 'ENOENT')
        return fail(t('engine.acpMissing', { agent: agent.name, detail: this.command(agent.id).command }));
      // Not `auth`: that is Claude's own login, which this says nothing about.
      if (e.code === AUTH_REQUIRED) return fail(t('engine.acpLogin', { agent: agent.name }));
      if (req.signal.aborted)
        return { ok: false, kind: 'interrupted', message: t('engine.stopped'), text, sessionId };
      return fail(t('engine.acpFailed', { agent: agent.name, detail: e.message.slice(0, 500) }), {
        ...(e.exit && { crashed: true }),
      });
    } finally {
      proc.close();
      await (tools as { close(): Promise<void> } | null)?.close();
    }
  }
}
