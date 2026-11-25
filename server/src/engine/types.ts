import type { ClaudeModel, Effort, Locale, PlanWindow } from '@leafbot/shared';
import type { z } from 'zod';
import type { T } from '../i18n';
import { readableError } from '../util';

/** An image a tool hands back to the model, e.g. a screenshot of the bot's browser. */
export interface ToolImage {
  /** Base64, without a data: prefix. */
  data: string;
  mimeType: string;
}

/**
 * What a tool returns: plain text, or text with images. `fromServer` marks text the server wrote
 * itself in a tool whose results otherwise come from outside (a stop it puts on the bot), so it
 * reaches the model as an instruction and not inside the outside-data block.
 */
export type ToolResult = string | { text: string; images: ToolImage[]; fromServer?: true };

/**
 * What a bot answers when a turn leaves it nothing to say, such as a reaction that needs no reply.
 * Such an answer is not shown and not saved.
 */
export const SILENT_REPLY = 'NO_REPLY';

/** True for an answer that is only the silent reply, give or take spaces and a full stop. */
export const isSilentReply = (text: string) => text.trim().replace(/\.$/, '') === SILENT_REPLY;

/**
 * True for an answer whose last line is the silent reply after something written above it, such as
 * "Nothing changed since the last run.\n\nNO_REPLY": the bot said why it has nothing to report and
 * then said so. Not true for an answer that is only the silent reply.
 */
export const endsSilent = (text: string) => {
  const lines = text.trimEnd().split('\n');
  return lines.length > 1 && isSilentReply(lines.at(-1)!) && lines.slice(0, -1).join('').trim() !== '';
};

/** The answer without a silent reply on its last line; any other answer as it is. */
export const withoutSilentEnd = (text: string) =>
  endsSilent(text) ? text.trimEnd().split('\n').slice(0, -1).join('\n').trimEnd() : text;

/** True while streamed text may still turn out to be the silent reply, so it is held back. */
export const maybeSilentReply = (text: string) => SILENT_REPLY.startsWith(text.trim());

export const resultText = (r: ToolResult) => (typeof r === 'string' ? r : r.text);
export const resultImages = (r: ToolResult) => (typeof r === 'string' ? [] : r.images);

/** A tool the app gives to a bot, independent of the engine that runs it. */
export interface AppTool {
  name: string;
  description: string;
  input: z.ZodRawShape;
  /** Tools that only read state may run without asking. */
  readOnly: boolean;
  /** Only touches LeafBot's own data (memory, bot messages); never asks in `ask` mode. */
  internal: boolean;
  /** Per-call override: some inputs of an internal tool still need a card. */
  gated?: (args: Record<string, unknown>) => Promise<boolean>;
  /**
   * The MCP server the tool is shown under (`mcp__<server>__<name>`): a connection's own name for
   * its tools; unset for the app's own tools (`leafbot`).
   */
  server?: string;
  /**
   * Shown to the model with its whole description from the start, never only by name behind a
   * tool search: a tool the bot should reach for unasked, which it would not look up by itself.
   */
  alwaysLoad?: boolean;
  /** The input as JSON Schema, for tools another server describes; `input` is then unused. */
  jsonSchema?: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

export const APP_SERVER = 'leafbot';

/** Tools that only add something under the reply; what is written with them is the reply. */
const REPLY_TOOLS = new Set(['quick_replies', 'show_card']);
const isReplyTool = (name: string) => REPLY_TOOLS.has(name.replace(`mcp__${APP_SERVER}__`, ''));

/** One answer of the model in a run: its text and the tools it called. */
export interface ModelStep {
  text: string;
  tools: string[];
}

/**
 * The reply of a run: its last step, and before it the steps that called only reply tools. A model
 * often writes its answer together with quick_replies and closes with a short line after the call;
 * that line alone would lose the answer. Text before any other tool stays an interim step.
 */
export function replyOf(steps: ModelStep[]): string {
  const last = steps.at(-1);
  if (!last) return '';
  const before: string[] = [];
  for (let i = steps.length - 2; i >= 0; i--) {
    const step = steps[i]!;
    if (!step.tools.length || !step.tools.every(isReplyTool)) break;
    before.unshift(step.text.trim());
  }
  return before.some(Boolean) ? [...before, last.text.trim()].filter(Boolean).join('\n\n') : last.text;
}

/** How many times one turn tells the model to do what it announced. */
export const MAX_NUDGES = 2;
export const GO_ON =
  'You said what you would do next but made no tool call. Do it now with your tools, or say why you cannot.';

/**
 * A reply that only announces the next step and stops: short, no question, and ending on a colon,
 * a dash or an ellipsis, or opening with "Let me", "I'll", "Şimdi bakıyorum" and the like.
 */
export function announcesAction(text: string): boolean {
  const reply = text.trim();
  if (!reply || reply.length > 400 || /[?\uff1f]/.test(reply)) return false;
  return (
    /(?:[:\uff1a\u2014\u2013]|\.\.\.|\u2026)$/.test(reply) ||
    /^(?:checking|let me|i'll|i will|i'm going to|i am going to|opening|looking|searching|reading|fetching|now (?:i'll|let me))\b/i.test(
      reply,
    ) ||
    /^(?:şimdi|hemen|önce)\s+(?:\S+\s+)?\S+(?:yorum|acağım|eceğim|ayım|eyim)\b/i.test(reply)
  );
}

/** The name permission rules and cards use for a tool. */
export const toolPermName = (t: Pick<AppTool, 'name' | 'server'>) =>
  `mcp__${t.server ?? APP_SERVER}__${t.name}`;

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
}

export type PermissionAnswer =
  { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string };

export interface Sandbox {
  cwd: string;
  /** Extra readable/writable folders (bot files, group files). */
  additionalDirectories: string[];
  /** Folders sandboxed shell commands may write. */
  writable: string[];
  /**
   * Whether the bot may reach the internet. Off, its web tools are withheld; either way a
   * sandboxed command asks (SandboxNetworkAccess) before each host, and the turn answers.
   */
  internet: boolean;
  readOnly: boolean;
}

export interface TurnRequest {
  turnId: string;
  threadId: string;
  botId: string;
  model: string;
  /** How hard the model thinks; unset leaves it to the model. API-key models use it when they reason. */
  effort?: Effort;
  /**
   * For Claude: the conversation size, in tokens, at which the session folds into a summary; 0
   * leaves it to the CLI. Unset takes the app's own default.
   */
  compactWindow?: number;
  prompt: string;
  /**
   * What changes on every turn, such as the time now, sent before the prompt. It stays out of the
   * system prompt, which then reads the same turn after turn and keeps the model's prompt cache.
   */
  context?: string;
  /** Engine session to resume, if the thread has one. */
  sessionId: string | null;
  /**
   * What the resumed session had cost by the end of its last run, as the engine reported it. An
   * engine whose cost figure runs on across a resumed session subtracts it to price this run alone.
   */
  sessionCostUsd?: number | null;
  systemPrompt: string;
  /** Language for messages the engine writes (errors, tool texts). */
  locale: Locale;
  sandbox: Sandbox;
  /** Where shell commands run: this server's OS sandbox, or the bot's desktop (an app tool). */
  shell: 'sandbox' | 'computer';
  tools: AppTool[];
  /**
   * Which of the engine's own tools (`Read`, `Bash`…) the bot gets, by the names cards use; left
   * out when it gets every one. App tools come already narrowed in `tools`.
   */
  pickTool?: (name: string) => boolean;
  canUseTool(ask: PermissionAsk): Promise<PermissionAnswer>;
  /**
   * Looks at a step before it runs, whether or not it would ask: the reason to refuse it (a
   * trip-wire was touched), or null. An engine calls it for every tool call it can see, so a call
   * the engine would run without asking is looked at too.
   */
  screen?(ask: PermissionAsk): Promise<string | null>;
  /** A shell command reached a host on the internet: what came back is outside text. */
  onReach?(host: string): void;
  onText(delta: string): void;
  /**
   * A helper the bot started for part of the work (a subagent): when it starts, each step it takes
   * and how it ended. `id` stays the same from start to end.
   */
  onSubagent?(e: SubagentState): void;
  /** The bot's plan for the task, each time it changes. */
  onPlan?(items: PlanItem[]): void;
  /**
   * What the person added while the turn runs, taken once: the engine calls it after each round of
   * tool calls and gives the texts to the model before its next step. A message it never takes
   * (the bot answered without another tool call) gets a turn of its own afterwards.
   */
  steering?(): string[];
  /**
   * Work this turn handed to other bots is still out: ending without a tool call is waiting for
   * their answers, not stopping after an announcement.
   */
  awaitsAnswers?(): Promise<boolean>;
  /** How much of the Claude plan's usage windows is used, as the engine last heard. */
  onPlanUsage?(windows: PlanWindow[]): void;
  /** The account is close to its usage limit: how much is used (0–1) and when it resets. */
  onLimitNear?(info: { used: number | null; resetsAt: Date | null }): void;
  onSession(sessionId: string): void;
  /** The engine condensed the conversation into a summary of its own to make room. */
  onCompacted?(): void;
  /**
   * A sign of life, on every event the engine sees; with `tool`, a tool call started (`running`)
   * or ended. A turn silent for too long is stopped as stalled.
   */
  onActivity?(tool?: { id: string; name: string; running: boolean }): void;
  /** The engine started (`true`) or finished folding the conversation into a summary, which is quiet meanwhile. */
  onCompacting?(on: boolean): void;
  /**
   * The same tool call failed the same way `count` times in a row, past the point where the bot
   * was told to stop: the turn ends instead of spending more on it.
   */
  onRepeatedFailure?(toolName: string, count: number): void;
  /** Aborted when the user stops the turn. */
  signal: AbortSignal;
}

/** A subagent as the chat shows it. */
export interface SubagentState {
  id: string;
  description: string;
  /** `waiting` until a free place lets it start, when the bot started more than run at once. */
  state: 'waiting' | 'running' | 'done' | 'failed' | 'stopped';
  /** Tool calls it has made so far. */
  steps: number;
  /** The tool it called last, by the name cards use (`Bash`, `mcp__notion__search`). */
  tool?: string;
  /** What it handed back to the bot, cut short; once it has ended. */
  result?: string;
}

/**
 * A subagent's answer as its card shows it: the engine follows the answer with the helper's id
 * (`agentId: …`) and its usage (`<usage>…</usage>`) for the model, which are not the answer. Only
 * that closing part is left out; the answer's own lines stay.
 */
export function subagentAnswer(content: unknown): string {
  const lines = toolResultText(content)
    .replace(/<usage>[\s\S]*?<\/usage>/g, '')
    .trimEnd()
    .split('\n');
  while (lines.length && /^\s*agentId:/.test(lines.at(-1)!)) lines.pop();
  return lines.join('\n').trim().slice(0, SUBAGENT_RESULT_MAX);
}

/** The most of a subagent's answer its card keeps. */
export const SUBAGENT_RESULT_MAX = 2000;

/** A tool result's text, whether it came as a string or as content blocks. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((c) => {
      const o = (c ?? {}) as { type?: unknown; text?: unknown };
      return o.type === 'text' && typeof o.text === 'string' ? [o.text] : [];
    })
    .join('\n');
}

/** One step of a bot's plan. */
export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** A plan as an engine's to-do tool writes it; null when it is not one. */
export function planItems(raw: unknown): PlanItem[] | null {
  const todos = (raw as { todos?: unknown } | null)?.todos;
  if (!Array.isArray(todos)) return null;
  const items: PlanItem[] = [];
  for (const t of todos.slice(0, 50)) {
    const o = (t ?? {}) as { content?: unknown; status?: unknown; activeForm?: unknown };
    const text = typeof o.content === 'string' ? o.content : '';
    if (!text.trim()) continue;
    const status =
      o.status === 'in_progress' || o.status === 'completed' ? (o.status as PlanItem['status']) : 'pending';
    items.push({ text: text.trim().slice(0, 300), status });
  }
  return items;
}

/**
 * What one run cost, from the running total the engine reported for its session and the total the
 * session had before it. A total below the earlier one means the count started over (a new session,
 * a transcript that kept no total): it is then this run's alone. A total within rounding of the
 * earlier one, as a stored copy of it reads back, is a run that spent nothing.
 */
export function runCost(total: number | null, before: number | null | undefined): number | null {
  if (total === null) return null;
  if (before == null) return total;
  if (total >= before) return total - before;
  return before - total <= before * 1e-6 ? 0 : total;
}

/** `sessionCostUsd`: the session's running total after this run, when the engine keeps one. */
export type TurnOutcome = (
  | {
      ok: true;
      text: string;
      sessionId: string | null;
      costUsd: number | null;
      /** How much of the model's context the session fills after this run, in tokens, when known. */
      contextTokens?: number | null;
      /**
       * A routine's turn ended its answer with the silent reply under some text: there is nothing
       * to report, and `text` holds what it wrote above, for the run's own record.
       */
      quiet?: boolean;
      /**
       * A routine's turn in the person's own conversation ended with the silent reply under some
       * text: `text` is the silent reply alone, and this holds what it wrote above, which the run's
       * line there shows when opened.
       */
      quietNote?: string;
    }
  | {
      ok: false;
      /**
       * `lostSession`: the session to resume no longer exists; a new one has to take over.
       * `limit`: the account's usage limit is spent until `resetsAt`.
       * `stalled`: nothing came from the engine for too long, and the turn was stopped.
       */
      kind: 'auth' | 'interrupted' | 'engine' | 'lostSession' | 'limit' | 'stalled';
      message: string;
      text: string;
      sessionId: string | null;
      /** For `limit`: when the account may be used again, if the engine said. */
      resetsAt?: Date | null;
      /** For `limit`: the provider whose limit it is, when it is not Claude's. */
      provider?: string;
      /** The model is busy or down for now; another model may do the work. */
      transient?: boolean;
      /** For `lostSession`: the tools the session held an out-of-date definition of. */
      staleTools?: string[];
      /**
       * The reply broke off midway: the provider closed the stream before saying it was done. The
       * same request may well go through on a second try.
       */
      cut?: boolean;
      /**
       * The engine's own process died mid-turn (it exited or was killed), not for a reason the
       * provider gave. The same request may well go through on a second try.
       */
      crashed?: boolean;
      /** The provider's balance is spent or its billing failed: another provider's model may carry the turn. */
      billing?: boolean;
      /**
       * The provider no longer offers the model or does not know its name: it will not come back by
       * waiting, and another model may carry the turn.
       */
      modelGone?: boolean;
      /** For `interrupted`: the person stopped it, an ending they chose rather than a failure. */
      byPerson?: boolean;
      /** For `interrupted`: the server stopped while the turn ran, not the person or the bot. */
      restarted?: boolean;
      /** What the turn spent before it failed, when the engine knows: it counts toward the limit. */
      costUsd?: number | null;
      /**
       * The provider refused the request on content or safety grounds. The same model would refuse
       * again, so it is never retried; another model may carry the turn.
       */
      refused?: boolean;
      /** It ran out of steps mid-task; the session holds the work so far, and the person may go on. */
      stepLimit?: boolean;
      /** It was stopped because its bot was paused, not by the person's Stop. */
      paused?: boolean;
      /**
       * The conversation no longer fits the model's context window, as the engine itself tells: a
       * new session may carry on with the recent exchange.
       */
      contextFull?: boolean;
      /** With `contextFull`: the summary of the conversation's older part, for the session that carries on. */
      summary?: string;
    }
) & { sessionCostUsd?: number | null };

/** How model servers say they are overloaded or briefly down. */
/** The prompt with the turn's changing context before it. */
export const withContext = (req: Pick<TurnRequest, 'prompt' | 'context'>) =>
  req.context ? `${req.context}\n\n${req.prompt}` : req.prompt;

/**
 * A provider that is down or busy for now. 503 and 529 mean only that; 500, 502 and 504 count
 * when they stand as a status (first, or after "status", "code", "HTTP" or "API Error"), since the
 * same numbers appear in other errors ("max_tokens: 500").
 */
export const OVERLOADED =
  /overloaded|\b(503|529)\b|(?:^|api error|status(?: code)?|\bcode|\bhttp(?:\/[\d.]+)?)\W{0,3}50[024]\b|service unavailable|temporarily unavailable|internal server error|bad gateway|gateway time-?out|"api_error"/i;
/** A reply the provider closed before its end, as the client libraries word it. */
const CUT =
  /stream ended without finish_reason|premature close|other side closed|\bECONNRESET\b|^(TypeError:\s*)?terminated$/i;
/**
 * A model the provider retired or never had, as providers word it: a 410 status, a not-found
 * error that names the model, or the model said to be missing, retired or unknown. A bare 404 is
 * left out: a wrong address answers with one too.
 */
export const MODEL_GONE =
  /(?:^|api error|status(?: code)?|\bcode|\bhttp(?:\/[\d.]+)?)\W{0,3}410\b|not_found_error[^\n]{0,200}\bmodel\b|model_not_found|\bmodels?\b[^\n]{0,80}?\b(?:not found|does not exist|doesn't exist|no longer (?:available|supported|offered)|(?:has been|was|is) (?:deprecated|retired|removed|decommissioned)|is unknown)|unknown model|invalid model(?: name| id)?\b|not a valid model|no endpoints found for|issue with the selected model/i;

/**
 * A refusal on content or safety grounds, as the providers' client libraries word it: Anthropic's
 * "refusal" stop, an OpenAI-style `content_filter` finish and Gemini's safety, blocklist and
 * prohibited-content finishes.
 */
export const REFUSED =
  /refused to (?:complete|answer|do)|\brefusal\b|finish_reason: content_filter|content[_ ]filter|stopped with: (?:sensitive|safety|blocklist|prohibited_content|spii|image_safety|image_prohibited_content|recitation)\b|violates? (?:our )?(?:usage|content) polic/i;

/**
 * OpenAI's Responses API rejects a replayed reasoning item it cannot verify (another key, another
 * organization, or a model that reasons differently now). Every later turn of that session would
 * send the same item again and fail the same way.
 */
export const ENCRYPTED_REASONING =
  /invalid_encrypted_content|encrypted content[^\n]{0,160}(?:could not be|cannot be|can't be|unable to be) (?:verified|decrypted)|could not be verified|failed to (?:verify|decrypt) (?:the )?encrypted/i;

/**
 * A provider's error in words the person can act on: a refused key, an empty balance, a rate
 * limit, an overloaded or unreachable server. The provider's own text follows as the detail.
 */
export function providerTrouble(
  raw: string,
  provider: string,
  t: T,
): {
  kind: 'limit' | 'engine';
  message: string;
  transient?: boolean;
  cut?: boolean;
  billing?: boolean;
  modelGone?: boolean;
  refused?: boolean;
} {
  const detail = readableError(raw.trim(), 300);
  const said = (key: Parameters<T>[0]) => `${t(key, { provider })} (${detail})`;
  if (/\b401\b|unauthori[sz]ed|invalid.{0,20}(api[ _-]?)?key|incorrect api key|authentication/i.test(raw)) {
    return { kind: 'engine', message: said('engine.providerKey') };
  }
  if (
    /\b402\b|insufficient (credits|balance|funds|quota)|billing|payment required|credit balance/i.test(raw)
  ) {
    return { kind: 'engine', message: said('engine.providerBilling'), billing: true };
  }
  if (REFUSED.test(raw)) return { kind: 'engine', message: said('engine.providerRefused'), refused: true };
  if (MODEL_GONE.test(raw)) {
    return { kind: 'engine', message: said('engine.providerModelGone'), modelGone: true };
  }
  if (/\b413\b|(request|payload|entity) too large/i.test(raw)) {
    return { kind: 'engine', message: said('engine.providerTooLarge') };
  }
  if (/\b429\b|rate.?limit|too many requests|quota/i.test(raw)) {
    return { kind: 'limit', message: said('engine.providerLimit') };
  }
  if (OVERLOADED.test(raw)) return { kind: 'engine', message: said('engine.providerBusy'), transient: true };
  if (CUT.test(raw.trim())) {
    return { kind: 'engine', message: said('engine.providerCut'), transient: true, cut: true };
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket hang up/i.test(raw)) {
    return { kind: 'engine', message: said('engine.providerUnreachable'), transient: true };
  }
  return { kind: 'engine', message: raw };
}

export interface AccountStatus {
  status: 'ok' | 'logged-out' | 'error';
  /** A known cause the app words itself; `detail` then holds the specifics. */
  reason?: 'api-key' | 'timeout';
  detail: string | null;
}

/**
 * One routine run a small model looks at before the bot starts on it (the routine pre-check): a
 * watched page or app check that changed, what a webhook call carried, a mail, or new messages in a
 * WhatsApp group.
 */
export interface GateRequest {
  routine: { name: string; prompt: string };
  trigger: 'watch' | 'webhook' | 'email' | 'whatsapp';
  /** What changed on the page or in the app's answer, or the webhook body. */
  input: string;
  /** What the routine's previous run reported, when it has one. */
  lastReport: string | null;
  /**
   * The bot's model. An engine on API keys checks with it, since a key may reach no other; an
   * engine on a login may pick a cheaper one of its own.
   */
  model?: string;
  /** Language of the reason the person reads. */
  locale: Locale;
  signal: AbortSignal;
}

/** `skip`: nothing in the input needs the bot's work. `run`: anything else, and every doubt. */
export interface GateVerdict {
  decision: 'run' | 'skip';
  reason: string;
  /** What the check cost in US dollars; null when the engine did not say. */
  costUsd: number | null;
}

/**
 * One answer from a model without tools, for work that belongs to no turn (the memory review): it
 * has no session, shows nothing in a conversation and reaches no chat app.
 */
export interface CompleteRequest {
  /** The bot's own model; an engine may answer with a smaller one of the same account. */
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
  locale: Locale;
}

export interface Completion {
  text: string;
  /** What it cost in US dollars; null when the engine did not say. */
  costUsd: number | null;
}

/** Folding a session's conversation into a summary while nobody waits on it. */
export interface CompactRequest {
  threadId: string;
  botId: string;
  model: string;
  sessionId: string;
  /** What the session had cost by its last run, so this run is priced as what it adds. */
  sessionCostUsd: number | null;
  compactWindow?: number;
  /** The same folders the session's turns run in: a session is found by where it ran. */
  sandbox: Sandbox;
  locale: Locale;
  signal: AbortSignal;
}

export type CompactOutcome =
  | {
      ok: true;
      sessionId: string;
      /** The session's size once folded, when the engine says. */
      contextTokens: number | null;
      costUsd: number | null;
      sessionCostUsd: number | null;
    }
  | { ok: false; message: string; costUsd: number | null; sessionCostUsd: number | null };

export interface Engine {
  readonly kind: string;
  run(req: TurnRequest): Promise<TurnOutcome>;
  account?(): Promise<AccountStatus>;
  /** The login check plus one real request, after the credential changed. */
  probe?(): Promise<AccountStatus>;
  models?(): Promise<ClaudeModel[]>;
  /** One short request to a `provider/model` with its stored key, before a bot uses it. */
  testModel?(model: string, locale: Locale): Promise<ModelTest>;
  /** Looks at one routine run with a small model before the bot starts on it. */
  gate?(req: GateRequest): Promise<GateVerdict>;
  /** One answer without tools or a session; throws when the model cannot answer. */
  complete?(req: CompleteRequest): Promise<Completion>;
  /** Folds the session into a summary now, so the next message does not wait for it. */
  compact?(req: CompactRequest): Promise<CompactOutcome>;
}

export type ModelTest = { ok: true } | { ok: false; detail: string };
