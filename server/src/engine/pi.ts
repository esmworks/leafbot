import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, ModelAuth } from '@earendil-works/pi-ai';
import { completeSimple, getModel, streamSimple } from '@earendil-works/pi-ai/compat';
import { clampThinkingLevel } from '@earendil-works/pi-ai/models';
import { estimateTextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import type { Locale } from '@leafbot/shared';
import { z } from 'zod';
import { translator, type T } from '../i18n';
import { failureStreak } from './failures';
import { fitResult } from './fit-image';
import {
  capText,
  COMPACT_AT,
  contextBudget,
  cutPoint,
  elideResults,
  excerptSummary,
  introTokens,
  KEEP_AFTER_COMPACT,
  NO_FOLD,
  resultChars,
  SUMMARY_SYSTEM,
  SUMMARY_TOKENS,
  CHARS_PER_TOKEN,
  summaryRequest,
  tokensOf,
  transcriptChunks,
  withoutPictures,
  withSummary,
  type Fold,
} from './pi-context';
import { fileTools, PathError, type FileTool } from './pi-files';
import { gatePrompt, parseGate } from './gate';
import { webTools, type WebToolOptions } from './pi-web';
import { shellRun, type ShellRun } from './pi-shell';
import { limiter, SUBAGENT_TOOL, SUBAGENTS_AT_ONCE, subagentTool, type HelperRun } from './pi-subagent';
import { asOutsideData } from '../runtime/outside';
import {
  providerTrouble,
  replyOf,
  withContext,
  resultImages,
  resultText,
  announcesAction,
  ENCRYPTED_REASONING,
  GO_ON,
  MAX_NUDGES,
  toolPermName,
  type AppTool,
  type CompleteRequest,
  type Completion,
  type Engine,
  type GateRequest,
  type GateVerdict,
  type ModelStep,
  type ModelTest,
  type ToolResult,
  type TurnOutcome,
  type TurnRequest,
} from './types';

export interface PiEngineOptions {
  /** Where conversation histories are kept, one JSON file per session. */
  sessionsDir: string;
  /** Stored API key for a provider; never read from the environment. */
  apiKey(provider: string): Promise<string | null>;
  /**
   * What requests to a provider carry, when it is more than a key: a sign-in with the person's
   * plan gives a token and, for Copilot, the address of that plan. Preferred over `apiKey`.
   */
  auth?(provider: string): Promise<ModelAuth | null>;
  /** Tests swap these for an offline provider. */
  resolveModel?: (provider: string, id: string) => Model<string> | undefined;
  /** A model on one of the person's own endpoints, which no built-in list holds. */
  customModel?: (provider: string, id: string) => Promise<Model<string> | undefined>;
  /** Whether a model on one of the person's endpoints takes tools; false runs it without any. */
  takesTools?: (provider: string, id: string) => Promise<boolean>;
  streamFn?: StreamFn;
  complete?: typeof completeSimple;
  /** A SearXNG address the server's environment names (`WEB_SEARCH_URL`); none, no web search. */
  webSearchUrl?: string | null;
  /** Tests swap reading a page and the search service for stand-ins. */
  web?: Pick<WebToolOptions, 'fetchPage' | 'fetchOptions' | 'searchFetch'>;
  /** Whether shell commands can be sandboxed here (see `probeShellSandbox`); no, no shell. */
  shellReady?: () => boolean;
  /** Folders commands may not read besides home: the server's data, the Claude login. */
  hidden?: string[];
  /** The home folder commands may not read; the server's own by default. */
  home?: string;
  /** Where turns keep their shell's settings, home and temporary files; a temporary folder by default. */
  shellDir?: string;
  /** Tests run a stand-in for the sandbox's program. */
  shellCli?: string;
}

const SESSION_ID = /^[0-9a-f-]{36}$/;
/** Model calls per user turn, as for Claude bots; stops a looping bot from spending the key. */
export const MAX_STEPS = 50;
/**
 * Messages sent to a model that names no context window; older ones stay on disk but are left out
 * of the request. A model with a window gets what fits it (see `pi-context`).
 */
export const MAX_CONTEXT_MESSAGES = 160;
/** A key test that takes longer than this counts as failed. */
const TEST_TIMEOUT = 30_000;
/** The longest and largest answer of a single request that belongs to no turn. */
const COMPLETE_TIMEOUT = 90_000;
const COMPLETE_TOKENS = 4_000;

/** Keeps the latest messages, starting at a user message so no tool result loses its call. */
export function trimHistory(messages: AgentMessage[], max = MAX_CONTEXT_MESSAGES): AgentMessage[] {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  if (rest.length <= max) return messages;
  let start = rest.length - max;
  while (start < rest.length && rest[start]!.role !== 'user') start++;
  // One long exchange with no user message inside the window: keep it whole.
  if (start >= rest.length) start = rest.findLastIndex((m) => m.role === 'user');
  return [...system, ...rest.slice(Math.max(start, 0))];
}

/** Pictures sent with a request; older screenshots are replaced by a note. */
export const MAX_CONTEXT_IMAGES = 3;

/**
 * Keeps only the latest `max` pictures in tool results; earlier ones become `note`. A bot that
 * takes a screenshot at every step would otherwise send every one of them with each request, past
 * what providers accept, though only the latest show the page as it is. The saved session keeps
 * them all.
 */
export function dropOldImages(
  messages: AgentMessage[],
  note: string,
  max = MAX_CONTEXT_IMAGES,
): AgentMessage[] {
  let kept = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]!;
    if (m.role !== 'toolResult' || !m.content.some((c) => c.type === 'image')) continue;
    const content = [...m.content].reverse().map((c) => {
      if (c.type !== 'image') return c;
      return kept++ < max ? c : { type: 'text' as const, text: note };
    });
    out[i] = { ...m, content: content.reverse() };
  }
  return out;
}

export function splitModel(model: string): { provider: string; id: string } | null {
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return null;
  return { provider: model.slice(0, i), id: model.slice(i + 1) };
}

function jsonSchema(shape: z.ZodRawShape) {
  const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(shape)) as Record<string, unknown>;
  return schema;
}

/**
 * The agent keeps the system prompt as the first history entry. It is rebuilt on every turn
 * (memory and time change), so stored histories never include it.
 */
function withoutSystem(messages: AgentMessage[]) {
  return messages.filter((m) => m.role !== 'system');
}

/** The most tools one request may list; OpenAI and many compatible providers refuse more. */
export const MAX_TOOLS = 128;
/** The tools that reach connected apps' tools left out of a full list. */
const FIND_TOOL = 'find_tool';
const USE_TOOL = 'use_tool';

/** The left-out tools that best match a search, with what each takes; at most ten. */
export function findTools(
  tools: AppTool[],
  query: string,
  nameOf: (t: AppTool) => string,
  none: string,
): string {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const scored = tools
    .map((tool) => {
      const params = Object.keys(
        (tool.jsonSchema?.properties as Record<string, unknown> | undefined) ?? tool.input,
      );
      const name = nameOf(tool).toLowerCase();
      const text = `${tool.description} ${params.join(' ')}`.toLowerCase();
      const score = words.reduce((n, w) => n + (name.includes(w) ? 3 : 0) + (text.includes(w) ? 1 : 0), 0);
      return { tool, score, params };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!scored.length) return none;
  return scored
    .map(({ tool, params }) => {
      const schema = tool.jsonSchema ? JSON.stringify(tool.jsonSchema).slice(0, 1500) : params.join(', ');
      return `- ${nameOf(tool)}: ${tool.description.slice(0, 300)}\n  arguments: ${schema}`;
    })
    .join('\n');
}

function textOf(m: AssistantMessage) {
  return m.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
}

/**
 * The reply of a run (see replyOf): the steps of its last stretch of assistant messages, up to the
 * last one, with the tool results between them.
 */
export function replyText(messages: AgentMessage[]): string {
  const end = messages.findLastIndex((m) => m.role === 'assistant');
  const steps: ModelStep[] = [];
  for (let i = end; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'toolResult') continue;
    if (m.role !== 'assistant') break;
    const tools = m.content.flatMap((c) => (c.type === 'toolCall' ? [c.name] : []));
    steps.unshift({ text: textOf(m), tools });
  }
  return replyOf(steps);
}

const fail = (
  kind: 'interrupted' | 'engine',
  message: string,
  text: string,
  sessionId: string | null,
  costUsd?: number,
): TurnOutcome => ({ ok: false, kind, message, text, sessionId, costUsd: costUsd || null });

export { announcesAction, providerTrouble };

/**
 * API-key models through pi-agent-core. File tools are limited to the bot's folders; shell commands
 * run in the OS sandbox and web reads go under Claude's tool names, so the same rules and cards apply.
 */
export class PiEngine implements Engine {
  readonly kind = 'pi';
  constructor(private opts: PiEngineOptions) {}

  private sessionFile(id: string) {
    return join(this.opts.sessionsDir, `${id}.json`);
  }

  /** A session's history and what of it is folded into a summary; files from before folding have none. */
  private async load(id: string): Promise<{ messages: AgentMessage[]; fold: Fold }> {
    try {
      const data = JSON.parse(await readFile(this.sessionFile(id), 'utf8')) as {
        messages?: AgentMessage[];
        summary?: unknown;
        folded?: unknown;
        lost?: unknown;
      };
      const messages = Array.isArray(data.messages) ? withoutSystem(data.messages) : [];
      const folded =
        typeof data.folded === 'number' ? Math.min(Math.max(0, data.folded), messages.length) : 0;
      return {
        messages,
        fold: {
          summary: typeof data.summary === 'string' && data.summary ? data.summary : null,
          folded,
          ...(data.lost === true && { lost: true }),
        },
      };
    } catch {
      return { messages: [], fold: NO_FOLD };
    }
  }

  private async save(id: string, messages: AgentMessage[], fold: Fold) {
    await mkdir(this.opts.sessionsDir, { recursive: true, mode: 0o700 });
    const file = this.sessionFile(id);
    const tmp = `${file}.${process.pid}.tmp`;
    const kept = withoutSystem(messages);
    const folded = Math.min(fold.folded, kept.length);
    await writeFile(
      tmp,
      JSON.stringify({
        version: 2,
        messages: withoutPictures(kept, folded),
        summary: fold.summary,
        folded,
        ...(fold.lost && { lost: true }),
      }),
      { mode: 0o600 },
    );
    await rename(tmp, file);
  }

  /**
   * The summary that replaces `messages` (and `previous`, the one before), written by the bot's own
   * model in steps the window can take. Null when it could not be written: the turn goes on without.
   * `partial` when the oldest messages were too many to go into it.
   */
  private async summarize(
    model: Model<string>,
    apiKey: string,
    sessionId: string,
    previous: string | null,
    messages: AgentMessage[],
    signal: AbortSignal | undefined,
    onActivity?: () => void,
  ): Promise<{ summary: string | null; costUsd: number; partial?: boolean }> {
    const window = model.contextWindow || 32_000;
    // Each step's input stays well inside the window, with room for the summary it builds on.
    const chunkChars = Math.max(8_000, Math.floor(window * 0.5 * CHARS_PER_TOKEN) - (previous?.length ?? 0));
    let summary = previous;
    let costUsd = 0;
    const { chunks, dropped } = transcriptChunks(messages, chunkChars);
    try {
      for (const chunk of chunks) {
        if (signal?.aborted) return { summary: null, costUsd };
        const reply = await (this.opts.complete ?? completeSimple)(
          model,
          {
            systemPrompt: SUMMARY_SYSTEM,
            messages: [{ role: 'user', content: summaryRequest(summary, chunk), timestamp: Date.now() }],
          },
          {
            apiKey,
            maxTokens: Math.min(model.maxTokens || SUMMARY_TOKENS, SUMMARY_TOKENS),
            sessionId,
            ...(signal && { signal }),
          },
        );
        onActivity?.();
        costUsd += reply.usage?.cost?.total ?? 0;
        const text = textOf(reply).trim();
        if (reply.stopReason === 'error' || reply.stopReason === 'aborted' || !text) {
          return { summary: null, costUsd };
        }
        summary = text;
      }
      return { summary, costUsd, ...(dropped && { partial: true }) };
    } catch (err) {
      console.warn(`pi: could not summarise the conversation: ${(err as Error).message}`);
      return { summary: null, costUsd };
    }
  }

  /** The key for a provider's requests, and the model with the address and headers its sign-in gives. */
  private async authorize(
    provider: string,
    model: Model<string>,
  ): Promise<{ apiKey: string; model: Model<string> } | null> {
    const auth: ModelAuth | null = this.opts.auth
      ? await this.opts.auth(provider)
      : await this.opts.apiKey(provider).then((k) => (k ? { apiKey: k } : null));
    if (!auth?.apiKey) return null;
    return {
      apiKey: auth.apiKey,
      model: {
        ...model,
        ...(auth.baseUrl && { baseUrl: auth.baseUrl }),
        // A null header value means "leave it out".
        ...(auth.headers && {
          headers: Object.fromEntries(
            Object.entries({ ...model.headers, ...auth.headers }).filter(
              (e): e is [string, string] => typeof e[1] === 'string',
            ),
          ),
        }),
      },
    };
  }

  private async resolve(provider: string, id: string): Promise<Model<string> | undefined> {
    const resolveModel =
      this.opts.resolveModel ??
      ((p: string, m: string) => (getModel as (p: string, m: string) => Model<string> | undefined)(p, m));
    return resolveModel(provider, id) ?? (await this.opts.customModel?.(provider, id));
  }

  async testModel(ref: string, locale: Locale): Promise<ModelTest> {
    const t = translator(locale);
    const target = splitModel(ref);
    const found = target && (await this.resolve(target.provider, target.id));
    if (!target || !found) return { ok: false, detail: t('engine.modelNotFound', { model: ref }) };
    const authorized = await this.authorize(target.provider, found);
    if (!authorized) return { ok: false, detail: t('engine.noApiKey', { provider: target.provider }) };
    const { apiKey, model } = authorized;
    try {
      const reply = await (this.opts.complete ?? completeSimple)(
        model,
        { messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }] },
        // A session of its own: some providers (OpenCode) turn away a request that names none.
        { apiKey, maxTokens: 64, signal: AbortSignal.timeout(TEST_TIMEOUT), sessionId: randomUUID() },
      );
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        return { ok: false, detail: reply.errorMessage || t('engine.testFailed') };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: (e as Error).message || t('engine.testFailed') };
    }
  }

  /**
   * One answer from the bot's own model, without tools or a session. No smaller model is picked:
   * a key may reach only the one the person chose. Throws when the model cannot answer.
   */
  async complete(req: CompleteRequest): Promise<Completion> {
    const t = translator(req.locale);
    const target = splitModel(req.model);
    const found = target && (await this.resolve(target.provider, target.id));
    if (!target || !found) throw new Error(t('engine.modelNotFound', { model: req.model }));
    const authorized = await this.authorize(target.provider, found);
    if (!authorized) throw new Error(t('engine.noApiKey', { provider: target.provider }));
    const { apiKey, model } = authorized;
    const reply = await (this.opts.complete ?? completeSimple)(
      model,
      {
        systemPrompt: req.system,
        messages: [{ role: 'user', content: req.user, timestamp: Date.now() }],
      },
      {
        apiKey,
        maxTokens: Math.min(model.maxTokens || COMPLETE_TOKENS, COMPLETE_TOKENS),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(COMPLETE_TIMEOUT)]),
        sessionId: randomUUID(),
      },
    );
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
      throw new Error(reply.errorMessage || t('engine.testFailed'));
    }
    return { text: textOf(reply), costUsd: reply.usage?.cost?.total ?? null };
  }

  /**
   * The routine pre-check: the bot's own model, without tools, says whether a run has anything to
   * work on. A failure throws, and the caller lets the run go ahead.
   */
  async gate(req: GateRequest): Promise<GateVerdict> {
    if (!req.model) throw new Error('no model');
    const { system, user } = gatePrompt(req);
    const { text, costUsd } = await this.complete({
      model: req.model,
      system,
      user,
      signal: req.signal,
      locale: req.locale,
    });
    if (req.signal.aborted) throw new Error('aborted');
    return parseGate(text, costUsd);
  }

  async run(req: TurnRequest): Promise<TurnOutcome> {
    // The turn's shell, when it gets one: its way out and settings go when the turn ends.
    const shell: { run: ShellRun | null } = { run: null };
    try {
      return await this.turn(req, shell);
    } finally {
      shell.run?.close();
    }
  }

  private async turn(req: TurnRequest, shell: { run: ShellRun | null }): Promise<TurnOutcome> {
    const t = translator(req.locale);
    const target = splitModel(req.model);
    if (!target) return fail('engine', t('engine.modelFormat', { model: req.model }), '', req.sessionId);
    const found = await this.resolve(target.provider, target.id);
    if (!found) return fail('engine', t('engine.modelNotFound', { model: req.model }), '', req.sessionId);
    const authorized = await this.authorize(target.provider, found);
    if (!authorized) {
      return fail('engine', t('engine.noApiKey', { provider: target.provider }), '', req.sessionId);
    }
    const { apiKey, model } = authorized;

    const resumed = req.sessionId && SESSION_ID.test(req.sessionId) ? req.sessionId : null;
    const sessionId = resumed ?? randomUUID();
    const saved = resumed ? await this.load(resumed) : { messages: [], fold: NO_FOLD };
    const history = saved.messages;
    let fold = saved.fold;
    if (!resumed) req.onSession(sessionId);

    // A local model built without tool use refuses any request that lists tools: it only talks.
    const toolless = (await this.opts.takesTools?.(target.provider, target.id)) === false;
    // With the internet on, the bot reads pages and searches the web as a Claude bot does, under the
    // same names (WebFetch, WebSearch), so the same rules and cards apply.
    const web = req.sandbox.internet
      ? webTools(t, {
          searchUrl: this.opts.webSearchUrl,
          mark: (source, text) => asOutsideData(source, text, t),
          ...this.opts.web,
        })
      : [];
    // Commands run in this server's OS sandbox, as a Claude bot's do. A bot with a desktop runs
    // them there (run_command) instead, and where the sandbox cannot start there is no shell.
    if (!toolless && req.shell === 'sandbox' && (this.opts.shellReady?.() ?? false))
      shell.run = shellRun(req.sandbox, t, {
        hidden: [this.opts.home ?? homedir(), ...(this.opts.hidden ?? [])],
        onReach: (host) => req.onReach?.(host),
        cli: this.opts.shellCli,
        dir: this.opts.shellDir ?? join(tmpdir(), 'leafbot-shell'),
      });
    const files = toolless
      ? []
      : [
          ...fileTools(req.sandbox, t, { seesImages: model.input.includes('image') }),
          ...(shell.run ? [shell.run.tool] : []),
          ...web,
        ].filter((f) => req.pickTool?.(f.permissionName) ?? true);
    const byName = new Map<string, { perm: string; file?: FileTool; app?: AppTool }>();
    const tools: AgentTool[] = [];
    // Set once the tool list is known; read when a tool's result comes back.
    let maxResult = resultChars(null);
    const cap = (text: string) =>
      capText(text, maxResult, (shown, total) => t('engine.resultCut', { shown, total }));
    for (const f of files) {
      byName.set(f.name, { perm: f.permissionName, file: f });
      tools.push(
        this.agentTool(t, cap, f.name, f.description, f.input, (args, signal) => f.run(args, signal)),
      );
    }
    // A helper takes a self-contained part of the work in a conversation of its own, with the bot's
    // tools but no helpers of its own; several started together work side by side.
    if (!toolless && (req.pickTool?.(SUBAGENT_TOOL) ?? true)) {
      byName.set(SUBAGENT_TOOL, { perm: SUBAGENT_TOOL });
      tools.push(
        subagentTool({
          t,
          cap,
          slots: limiter(SUBAGENTS_AT_ONCE),
          run: (task, signal, onStep) => runHelper(task, signal, onStep),
          ...(req.onSubagent && { onSubagent: req.onSubagent }),
        }),
      );
    }
    // Providers refuse a request listing more than MAX_TOOLS tools. The bot's own tools go first;
    // connected apps follow whole, smallest first, so a small app is never cut for a big one. What
    // does not fit stays in reach through find_tool and use_tool.
    const offered = toolless ? [] : req.tools;
    const own = offered.filter((x) => !x.server);
    const apps = new Map<string, AppTool[]>();
    for (const x of offered.filter((x) => x.server)) apps.set(x.server!, [...(apps.get(x.server!) ?? []), x]);
    const room = Math.max(0, MAX_TOOLS - tools.length);
    const listed = [...own];
    const left: AppTool[] = [];
    const total = own.length + [...apps.values()].reduce((n, l) => n + l.length, 0);
    // With some left out, two places go to the tools that reach them.
    const space = total > room ? room - 2 : room;
    for (const list of [...apps.values()].sort((a, b) => a.length - b.length)) {
      if (listed.length + list.length <= space) listed.push(...list);
      else left.push(...list);
    }
    if (left.length)
      console.warn(`pi: ${left.length} tools over the ${MAX_TOOLS}-tool limit reached by search`);
    const nameOf = (tool: AppTool) => (tool.server ? `${tool.server}__${tool.name}` : tool.name);
    for (const tool of listed) {
      // A connection's tools go under its name, so two connections' tools of one name stay apart.
      const name = nameOf(tool);
      byName.set(name, { perm: toolPermName(tool), app: tool });
      tools.push(
        this.agentTool(
          t,
          cap,
          name,
          tool.description,
          tool.input,
          (args) => tool.handler(args),
          tool.jsonSchema,
        ),
      );
    }
    const unlisted = new Map(left.map((x) => [nameOf(x), x]));
    if (left.length) {
      byName.set(FIND_TOOL, { perm: FIND_TOOL });
      tools.push(
        this.agentTool(
          t,
          cap,
          FIND_TOOL,
          t('engine.findTool'),
          { query: z.string().min(1).max(200) },
          async (a) => findTools(left, String(a.query), nameOf, t('engine.findToolNone')),
        ),
      );
      byName.set(USE_TOOL, { perm: USE_TOOL });
      tools.push(
        this.agentTool(
          t,
          cap,
          USE_TOOL,
          t('engine.useTool'),
          { name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}) },
          async (a) => {
            const tool = unlisted.get(String(a.name));
            if (!tool) return t('engine.unknownTool', { name: String(a.name) });
            return tool.handler((a.arguments ?? {}) as Record<string, unknown>);
          },
        ),
      );
    }

    /**
     * A tool that counts its failures in `failures`: the same call failing the same way is pointed out
     * after a few. Each conversation (the bot's, each helper's) keeps a count of its own. Calls take
     * turns unless the tool says it may run beside others, as helpers do.
     */
    const counted = (tool: AgentTool, failures: ReturnType<typeof failureStreak>): AgentTool => ({
      ...tool,
      executionMode: tool.executionMode ?? 'sequential',
      execute: async (...args) => {
        const r = await tool.execute(...args);
        if (!r.isError) {
          failures.reset();
          return r;
        }
        const error = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        const hint = failures.note(byName.get(tool.name)?.perm ?? tool.name, args[1], error);
        return hint ? { ...r, content: [...r.content, { type: 'text' as const, text: hint }] } : r;
      },
    });
    const plain = tools.slice();
    // For the bot's own calls the turn ends after more of the same failure.
    const failures = failureStreak((tool, count) => req.onRepeatedFailure?.(tool, count));
    tools.splice(0, tools.length, ...plain.map((tool) => counted(tool, failures)));

    const systemPrompt = left.length
      ? `${req.systemPrompt}\n\n${t('engine.toolsSearch', { count: left.length, apps: [...new Set(left.map((x) => x.server))].join(', ') })}`
      : req.systemPrompt;
    // The conversation's room: the window less the reply and what goes with every request. Taken
    // from the model of this run, since a session may go on with a model of a smaller window.
    const budget = contextBudget(
      model,
      estimateTextTokens(
        systemPrompt +
          JSON.stringify(
            tools.map((x) => ({ name: x.name, description: x.description, parameters: x.parameters })),
          ),
      ),
    );
    maxResult = resultChars(budget);
    // A part left out without a summary stays so: the bot is told to look it up when it can.
    const recall = offered.some((x) => !x.server && x.name === 'conversations_search');
    const intro = (f: Fold) => {
      const parts = [
        f.summary && t('engine.summary', { summary: f.summary }),
        f.lost && t('engine.historyLeftOut'),
      ].filter(Boolean);
      if (parts.length && recall) parts.push(t('engine.recall'));
      return parts.join('\n\n') || null;
    };
    /**
     * The fold a turn that ends without its reply keeps: the latest one with a real summary, not one
     * that stood in for a summary that failed, which a later turn may yet write.
     */
    let good = saved.fold;
    let costUsd = 0;
    /**
     * What one request carries. Past the room's limit the older part is folded into a summary,
     * once: later requests and turns reuse it until the recent part outgrows the room again.
     */
    const fitted = async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
      const system = messages.filter((m) => m.role === 'system');
      if (!budget) return dropOldImages(trimHistory(messages), t('engine.imageDropped'));
      const rest = withoutSystem(messages);
      // Measured as sent: pictures past the latest few go as a note, so they take no room.
      const light = dropOldImages(rest, t('engine.imageDropped'));
      if (tokensOf(light.slice(fold.folded)) + introTokens(intro(fold)) > budget * COMPACT_AT) {
        const cut = cutPoint(light, fold.folded, budget * KEEP_AFTER_COMPACT);
        if (cut > fold.folded) {
          // The summary call is silent until it ends; the turn must not be taken for stalled meanwhile.
          req.onCompacting?.(true);
          req.onActivity?.();
          const made = await this.summarize(
            model,
            apiKey,
            sessionId,
            fold.summary,
            rest.slice(fold.folded, cut),
            signal ?? req.signal,
            () => req.onActivity?.(),
          ).finally(() => {
            req.onCompacting?.(false);
            req.onActivity?.();
          });
          costUsd += made.costUsd;
          // Without a summary the older part is still left out, since a request that does not fit
          // fails; its newest messages stay word for word in place of the summary.
          fold = made.summary
            ? { summary: made.summary, folded: cut, ...((fold.lost || made.partial) && { lost: true }) }
            : {
                summary: excerptSummary(fold.summary, rest.slice(fold.folded, cut)) || null,
                folded: cut,
                lost: true,
              };
          if (made.summary) {
            good = fold;
            req.onCompacted?.();
          }
        }
      }
      const shown = elideResults(
        withSummary(light.slice(fold.folded), intro(fold)),
        budget,
        t('engine.resultLeftOut'),
      );
      return [...system, ...shown];
    };

    /** Looks at every call before it runs, the bot's and its helpers' alike: trip-wires, then approval. */
    const gate = async ({
      toolCall,
      args,
    }: Pick<BeforeToolCallContext, 'toolCall' | 'args'>): Promise<BeforeToolCallResult | undefined> => {
      // Looking tools up only reads the list.
      if (toolCall.name === FIND_TOOL) return undefined;
      // Starting a helper changes nothing by itself: each of its own calls is looked at and asked for.
      if (toolCall.name === SUBAGENT_TOOL) {
        const refused = await req.screen?.({
          toolName: SUBAGENT_TOOL,
          input: (args ?? {}) as Record<string, unknown>,
        });
        return refused ? { block: true, reason: refused } : undefined;
      }
      // A tool reached through use_tool asks as that tool, with its own arguments: same card, rules.
      const via =
        toolCall.name === USE_TOOL
          ? (args as { name?: unknown; arguments?: unknown } | undefined)
          : undefined;
      const reached = via ? unlisted.get(String(via.name)) : undefined;
      if (via && !reached)
        return { block: true, reason: t('engine.unknownTool', { name: String(via.name) }) };
      const entry = reached ? { perm: toolPermName(reached) } : byName.get(toolCall.name);
      if (!entry) return { block: true, reason: t('engine.unknownTool', { name: toolCall.name }) };
      const input = ((reached ? via!.arguments : args) ?? {}) as Record<string, unknown>;
      // Looked at as the model wrote it, before a file tool's card shortens it.
      const refused = await req.screen?.({ toolName: entry.perm, input });
      if (refused) return { block: true, reason: refused };
      let cardInput = input;
      if (entry.file) {
        try {
          await entry.file.check?.(input);
          cardInput = entry.file.cardInput(input, entry.file.target(input));
        } catch (err) {
          return { block: true, reason: (err as Error).message };
        }
      }
      if (req.signal.aborted) return { block: true, reason: t('engine.stopped') };
      const answer = await req.canUseTool({ toolName: entry.perm, input: cardInput });
      return answer.behavior === 'allow' ? undefined : { block: true, reason: answer.message };
    };
    const streamFn = this.opts.streamFn ?? (streamSimple as unknown as StreamFn);
    const getApiKey = (provider: string) => (provider === target.provider ? apiKey : undefined);
    // A model that reasons thinks as hard as the bot asks; others ignore it.
    const thinking = req.effort &&
      model.reasoning && { thinkingLevel: clampThinkingLevel(model, req.effort) };
    /** A helper's own conversation, cut to the same room; it is short-lived, so it gets no summary. */
    const helperContext = async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
      if (!budget) return dropOldImages(trimHistory(messages), t('engine.imageDropped'));
      const system = messages.filter((m) => m.role === 'system');
      const rest = dropOldImages(withoutSystem(messages), t('engine.imageDropped'));
      return [...system, ...elideResults(rest, budget, t('engine.resultLeftOut'))];
    };
    /**
     * One helper's task, in a conversation of its own: the bot's tools without the helper tool, the
     * same checks before each call, a step limit and a failure count of its own. Its words stay out of
     * the chat; what it spends counts toward the turn.
     */
    const runHelper: HelperRun = async (task, signal, onStep) => {
      let keptFailing = false;
      const failures = failureStreak(() => {
        keptFailing = true;
        helper.abort();
      });
      const helper = new Agent({
        initialState: {
          systemPrompt: `${systemPrompt}\n\n${t('engine.subagentSystem')}`,
          model,
          tools: plain.filter((tool) => tool.name !== SUBAGENT_TOOL).map((tool) => counted(tool, failures)),
          messages: [],
          ...thinking,
        },
        // Its requests end with the turn, even one sent before its own run could hear the stop.
        streamFn: (m, context, options) =>
          streamFn(m, context, {
            ...options,
            signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal,
          }),
        getApiKey,
        sessionId: randomUUID(),
        toolExecution: 'sequential',
        transformContext: helperContext,
        beforeToolCall: gate,
      });
      let steps = 0;
      let capped = false;
      helper.subscribe((event) => {
        if (signal.aborted) helper.abort();
        if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
          const name = byName.get(event.toolName)?.perm ?? event.toolName;
          const running = event.type === 'tool_execution_start';
          req.onActivity?.({ id: event.toolCallId, name, running });
          if (running) onStep(name);
        } else req.onActivity?.();
        if (event.type === 'turn_end' && ++steps >= MAX_STEPS && !capped) {
          capped = true;
          helper.abort();
        } else if (event.type === 'message_end' && event.message.role === 'assistant') {
          costUsd += (event.message as AssistantMessage).usage?.cost?.total ?? 0;
        }
      });
      // A stop that came before this listener is not heard by it.
      if (signal.aborted) return { text: '', stopped: true };
      const onAbort = () => helper.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await helper.prompt(task);
        await helper.waitForIdle();
      } catch (err) {
        return { text: '', failed: (err as Error).message };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
      const last = [...helper.state.messages]
        .reverse()
        .find((m): m is AssistantMessage => m.role === 'assistant');
      const text = last ? textOf(last) : '';
      if (capped) return { text, failed: t('engine.stepLimit', { max: MAX_STEPS }) };
      if (keptFailing) return { text, failed: t('engine.subagentKeptFailing') };
      if (signal.aborted || last?.stopReason === 'aborted') return { text, stopped: true };
      if (!last || last.stopReason === 'error') {
        return { text, failed: last?.errorMessage ?? t('engine.modelError') };
      }
      return { text };
    };

    const agent = new Agent({
      initialState: { systemPrompt, model, tools, messages: history, ...thinking },
      streamFn,
      getApiKey,
      sessionId,
      // Each tool says whether its calls may run side by side; only helpers do.
      toolExecution: 'parallel',
      transformContext: fitted,
      beforeToolCall: gate,
    });

    let steps = 0;
    let capped = false;
    agent.subscribe((event) => {
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        req.onActivity?.({
          id: event.toolCallId,
          // Named as permission rules and Claude bots name it (`Read`, `mcp__notion__search`).
          name: byName.get(event.toolName)?.perm ?? event.toolName,
          running: event.type === 'tool_execution_start',
        });
      } else req.onActivity?.();
      if (event.type === 'turn_end' && ++steps >= MAX_STEPS && !capped) {
        capped = true;
        agent.abort();
      } else if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        req.onText(event.assistantMessageEvent.delta);
      } else if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message as AssistantMessage;
        costUsd += message.usage?.cost?.total ?? 0;
        // Taken only when tools follow, so the agent reads it before its next step.
        if (req.steering && message.content.some((c) => c.type === 'toolCall')) {
          for (const text of req.steering())
            agent.steer({ role: 'user', content: text, timestamp: Date.now() });
        }
      }
    });
    const onAbort = () => agent.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });

    let thrown: string | null = null;
    try {
      await agent.prompt(withContext(req));
      await agent.waitForIdle();
      // A model that says what it is about to do ("Let me check the file:") and stops there, with no
      // call, is told to go on; a few times at most.
      for (let n = 0; n < MAX_NUDGES && tools.length && !capped && !req.signal.aborted; n++) {
        const said = [...agent.state.messages]
          .reverse()
          .find((m): m is AssistantMessage => m.role === 'assistant');
        if (said?.stopReason !== 'stop' || !announcesAction(textOf(said)) || (await req.awaitsAnswers?.()))
          break;
        await agent.prompt(GO_ON);
        await agent.waitForIdle();
      }
    } catch (err) {
      thrown = (err as Error).message;
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }

    const messages = agent.state.messages;
    const last = [...messages].reverse().find((m): m is AssistantMessage => m.role === 'assistant');
    const failed =
      last?.stopReason === 'error' && messages.indexOf(last) >= history.length ? last : undefined;
    const text = replyText(messages);
    /**
     * Saves the history as it was before this turn: a broken exchange would poison the next turn.
     * A summary made on the way stays when it covers only that history, so it is not paid for again.
     */
    const keepHistory = async (always: boolean) => {
      const keep = good.folded <= history.length ? good : saved.fold;
      if (always || keep !== saved.fold) await this.save(sessionId, history, keep);
    };
    if (capped) {
      await keepHistory(false);
      return {
        ok: false,
        kind: 'engine',
        message: t('engine.stepLimit', { max: MAX_STEPS }),
        text,
        sessionId,
        costUsd: costUsd || null,
        stepLimit: true,
      };
    }
    if (req.signal.aborted || last?.stopReason === 'aborted') {
      await keepHistory(false);
      return fail('interrupted', t('engine.stopped'), text, sessionId, costUsd);
    }
    const error =
      thrown ?? (last?.stopReason === 'error' ? (last.errorMessage ?? t('engine.modelError')) : null);
    if (error || !last) {
      await keepHistory(!resumed);
      if (!error) return fail('engine', t('engine.noResponse'), text, sessionId, costUsd);
      // A replayed reasoning item the provider cannot verify fails every later turn the same way:
      // a new session carries on with the recent exchange instead.
      if (resumed && ENCRYPTED_REASONING.test(error)) {
        return { ok: false, kind: 'lostSession', message: '', text: '', sessionId: null };
      }
      const why = providerTrouble(error, target.provider, t);
      return {
        ok: false,
        kind: why.kind,
        message: why.message,
        text,
        sessionId,
        ...(why.kind === 'limit' && { provider: target.provider }),
        ...(why.transient && { transient: true }),
        ...(why.cut && { cut: true }),
        ...(why.billing && { billing: true }),
        ...(why.modelGone && { modelGone: true }),
        ...(why.refused && { refused: true }),
        // Only this run's own failed reply tells: an earlier one, or a reply that went through, does not.
        // With the summary of what came before, which the new session that carries on is handed.
        ...(failed &&
          isContextOverflow(failed) && { contextFull: true, ...(fold.summary && { summary: fold.summary }) }),
        costUsd: costUsd || null,
      };
    }
    await this.save(sessionId, messages, fold);
    return { ok: true, text, sessionId, costUsd: costUsd || null };
  }

  private agentTool(
    t: T,
    /** Cuts a result's text to what the conversation's room allows. */
    cap: (text: string) => string,
    name: string,
    description: string,
    input: z.ZodRawShape,
    run: (args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolResult>,
    /** JSON Schema another server gave; its input is checked there, not here. */
    raw?: Record<string, unknown>,
  ): AgentTool {
    const schema = raw ? z.record(z.string(), z.unknown()) : z.object(input);
    return {
      name,
      label: name,
      description,
      parameters: raw ? { type: 'object', ...raw } : jsonSchema(input),
      execute: async (_id, params, signal) => {
        const parsed = schema.safeParse(params ?? {});
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: t('tool.invalidInput', { issues: parsed.error.message }) }],
            details: undefined,
            isError: true,
          };
        }
        try {
          const r = await fitResult(await run(parsed.data, signal ?? new AbortController().signal));
          return {
            content: [
              { type: 'text', text: cap(resultText(r)) },
              ...resultImages(r).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mimeType })),
            ],
            details: undefined,
          };
        } catch (err) {
          const message =
            err instanceof PathError ? err.message : t('tool.error', { message: (err as Error).message });
          return { content: [{ type: 'text', text: message }], details: undefined, isError: true };
        }
      },
    };
  }
}
