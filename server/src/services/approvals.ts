import {
  APPROVAL_TIMED_OUT,
  type Approver,
  commandRulePattern,
  hideSecretAnswers,
  PERSON_COMMAND,
  PERSON_COMMAND_RUN,
  PERSON_COMPUTER,
  PERSON_PHONE,
  questionItems,
  ROUTINE_APPROVAL_TOOL,
  type Approval,
  type ApprovalDecision,
  type PermissionMode,
  type PermissionRule,
  type PermissionSuggestions,
} from '@leafbot/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { PermissionAnswer } from '../engine/types';
import type { ServerKey, T } from '../i18n';
import { HttpError, newId, notFound, truncate } from '../util';
import { toApproval, toRule } from './mappers';
import { serverTranslator } from './settings';
import type { ThreadService } from './threads';
import type { VaultService } from './vault';
import { OWNER_ID } from '../users';
import { botLevel, managesServer } from './access';
import { commandParts, freePart } from './shell-parts';
import { redactSecrets } from './secrets';

/** Built-in tools that only read inside the allowed folders. */
export const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'NotebookRead']);

/** The string a rule's argument pattern is matched against. */
export function ruleSubject(toolName: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);
  return (
    pick('command') ??
    pick('file_path') ??
    pick('path') ??
    pick('url') ??
    pick('pattern') ??
    pick('query') ??
    (toolName.startsWith('mcp__') ? JSON.stringify(input) : '')
  );
}

const globBody = (glob: string) =>
  glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

/**
 * `glob` as a pattern for the whole text. `prefix:*` is a command and what follows it after a
 * space: `git status:*` covers `git status` and `git status --short`, not `git statusx`.
 */
function globToRegExp(glob: string): RegExp {
  if (glob.endsWith(':*')) return new RegExp(`^${globBody(glob.slice(0, -2))}(?: .*)?$`, 's');
  return new RegExp(`^${globBody(glob)}$`, 's');
}

/** `Tool`, `Tool(arg-glob)`, with `*` wildcards in either part, against the whole call. */
function patternMatches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  const m = /^([^()]+?)(?:\((.*)\))?$/s.exec(pattern.trim());
  if (!m) return false;
  const [, toolGlob, argGlob] = m;
  if (!globToRegExp(toolGlob!.trim()).test(toolName)) return false;
  if (argGlob === undefined) return true;
  return globToRegExp(argGlob).test(ruleSubject(toolName, input));
}

/**
 * Each command a shell line could run, cut wherever one might start: at a chain, a pipe, a
 * substitution or a group, quotes or not. More pieces than the shell runs, never fewer, so an
 * "always ask" or block rule cannot be stepped around by putting its command after another.
 */
function commandPieces(command: string): string[] {
  const rough = command.replace(/\\\n/g, ' ').split(/&&|\|\||[;&|\n`(){}]|\$\(/);
  return [
    ...new Set(
      [...rough, ...(commandParts(command) ?? [])].map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean),
    ),
  ];
}

/**
 * `Tool`, `Tool(arg-glob)`, with `*` wildcards in either part. A command rule also covers a line
 * that runs that command among others (`cd repo && git push` for `Bash(git push*)`).
 */
export function ruleMatches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  if (patternMatches(pattern, toolName, input)) return true;
  if (toolName !== 'Bash') return false;
  return commandPieces(ruleSubject(toolName, input)).some((command) =>
    patternMatches(pattern, toolName, { command }),
  );
}

/** What chains, pipes, redirects or substitutes in a shell command line. */
const SHELL_JOIN = /[;&|<>`\n]|\$\(/;

/**
 * Whether an "always allow" rule lets this call through. A rule for a command (`Bash(npm test*)`)
 * means that command: one with another command chained, piped or substituted after it
 * (`npm test && curl …`) is not covered unless the rule itself spells that out.
 */
export function allowRuleMatches(pattern: string, toolName: string, input: Record<string, unknown>): boolean {
  if (!patternMatches(pattern, toolName, input)) return false;
  if (toolName !== 'Bash') return true;
  const arg = /\((.*)\)$/s.exec(pattern.trim())?.[1];
  if (arg === undefined) return true;
  return !SHELL_JOIN.test(ruleSubject(toolName, input)) || SHELL_JOIN.test(arg);
}

/**
 * Programs whose words say little about what they do, or that can do anything they are told: an
 * "always allow" from a card for one of these covers that exact command only.
 */
const EXACT_ONLY = new Set([
  ...['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh', 'pwsh', 'powershell', 'cmd'],
  ...['python', 'python2', 'python3', 'node', 'nodejs', 'deno', 'bun', 'perl', 'ruby', 'php', 'lua'],
  ...['osascript', 'awk', 'gawk', 'sed', 'find', 'xargs', 'env', 'sudo', 'doas', 'su', 'exec', 'eval'],
  ...['nohup', 'time', 'timeout', 'nice', 'watch', 'npx', 'pnpx', 'bunx', 'uvx', 'source', '.'],
  ...['rm', 'rmdir', 'mv', 'dd', 'shred', 'truncate', 'chmod', 'chown', 'tee', 'kill', 'pkill'],
  ...['killall', 'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'ssh', 'scp', 'sftp', 'rsync'],
  ...['ftp', 'telnet', 'crontab', 'launchctl', 'systemctl', 'open', 'xdg-open', 'install'],
]);

/** File tools whose path an "always allow" keeps to the folder of the file on the card. */
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * The "always allow" rule a card's step becomes: as narrow as the step. A command keeps its first
 * word and subcommand (`Bash(git status:*)`), or itself when its program can do anything; a file
 * change keeps its folder; a page its site. Null when the step cannot be written as a rule that
 * covers no more than it (a pattern character in it): the answer then counts for this time only.
 */
export function rememberedPattern(toolName: string, input: Record<string, unknown>): string | null {
  const pattern = widestPattern(toolName, input);
  return pattern && !holdsSecret(pattern) ? pattern : null;
}

/**
 * Whether a rule would keep a key, token or password: rules are listed in the settings and kept as
 * they are, so a step that carries one counts for this time only.
 */
const holdsSecret = (pattern: string) => redactSecrets(pattern, '').redacted;

function widestPattern(toolName: string, input: Record<string, unknown>): string | null {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim() : '');
  const plain = (s: string) => !!s && !/[*?]/.test(s);
  if (toolName === 'Bash') {
    const command = pick('command');
    if (!plain(command)) return null;
    const words = command.split(/\s+/);
    const program = words[0]!.replace(/^.*\//, '');
    if (SHELL_JOIN.test(command) || /["'\\$]/.test(command) || EXACT_ONLY.has(program)) {
      return `Bash(${command})`;
    }
    const sub = words[1] && /^[a-z][\w.-]*$/i.test(words[1]) ? ` ${words[1]}` : '';
    return `Bash(${words[0]}${sub}:*)`;
  }
  // A path given from the working folder stays in the bot's folders anyway: the bot alone is
  // the scope then.
  if (FILE_TOOLS.has(toolName)) {
    const path = pick('file_path') || pick('notebook_path') || pick('path');
    if (!path.startsWith('/')) return toolName;
    const dir = path.replace(/\/[^/]*$/, '');
    if (!plain(path) || !dir) return null;
    return `${toolName}(${dir}/*)`;
  }
  if (toolName === 'WebFetch') {
    try {
      const url = new URL(pick('url'));
      return /^https?:$/.test(url.protocol) && plain(url.origin) ? `WebFetch(${url.origin}/*)` : null;
    } catch {
      return null;
    }
  }
  return toolName;
}

/**
 * The block rule a card's "never allow" keeps: the command as "always allow" would keep it
 * (`Bash(git push:*)`), the very file, or the step's own words. Never null: a pattern character
 * left in it, or a secret turned into one, only blocks more, which a block may.
 */
export function blockedPattern(toolName: string, input: Record<string, unknown>): string {
  const subject = ruleSubject(toolName, input).trim();
  const pattern = FILE_TOOLS.has(toolName)
    ? subject && `${toolName}(${subject})`
    : (widestPattern(toolName, input) ?? (subject && `${toolName}(${subject})`));
  return redactSecrets(pattern || toolName, '*').text;
}

/** A step an "always allow" keeps: the rule's pattern, and the call it covers. */
export interface RememberedStep {
  pattern: string;
  input: Record<string, unknown>;
}

/**
 * The rule for one command of a shell line, as narrow as it: its first word and subcommand
 * (`Bash(gh run:*)`), or the command itself when its program can do anything (`EXACT_ONLY`) or
 * those words are quoted. Null when it cannot be written without a pattern character.
 */
function partPattern(part: string): string | null {
  const words = part.split(' ');
  const first = words[0]!;
  const program = first.replace(/^.*\//, '');
  // A program named by its path is another program in another folder (`./run.sh`); quoted words
  // may not be what they look like.
  const exact = EXACT_ONLY.has(program) || first.includes('/') || /["'\\]/.test(words.slice(0, 2).join(' '));
  if (exact) return /[*?]/.test(part) ? null : `Bash(${part})`;
  if (/[*?]/.test(first)) return null;
  const sub = words[1] && /^[a-z][\w.-]*$/i.test(words[1]) ? ` ${words[1]}` : '';
  return `Bash(${first}${sub}:*)`;
}

/**
 * The rules a card's "always allow" keeps, each as narrow as its step (see `rememberedPattern`).
 * A shell line of commands run in a row or piped keeps one for each command that needs one, so
 * the same work tomorrow, in another folder or on other lines, is covered as well; `cd` and the
 * like need none. Null when a step cannot be written that narrowly: the answer then counts for
 * this time only.
 */
export function rememberedSteps(toolName: string, input: Record<string, unknown>): RememberedStep[] | null {
  const parts = toolName === 'Bash' ? commandParts(ruleSubject(toolName, input)) : null;
  const needed = parts?.filter((p) => !freePart(p)) ?? [];
  if (needed.length) {
    const steps = new Map<string, RememberedStep>();
    for (const command of needed) {
      const pattern = partPattern(command);
      if (!pattern || holdsSecret(pattern)) return null;
      if (!steps.has(pattern)) steps.set(pattern, { pattern, input: { command } });
    }
    return [...steps.values()];
  }
  const pattern = rememberedPattern(toolName, input);
  return pattern ? [{ pattern, input }] : null;
}

/** A plain decimal number as text: `1500`, `-20`, `99.95`; no thousands marks, no exponent. */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * The size of the number at `field` (a dotted path, `refund.amount`) in a call's input, without
 * its sign, since a refund written as -500 moves as much money as 500. Null when the field is
 * missing or is not a plain number: `1.000,50` or `1,000` could be read more than one way, so it
 * is not read at all.
 */
export function limitValue(input: Record<string, unknown>, field: string): number | null {
  let value: unknown = input;
  for (const key of field.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key))
      return null;
    value = (value as Record<string, unknown>)[key];
  }
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && PLAIN_NUMBER.test(value.trim())
        ? Number(value.trim())
        : NaN;
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/**
 * Whether a rule's amount limit lets it cover this call; a rule without one always does. Each list
 * fails closed: an allow rule covers only a number it can read at or under the limit, while an ask
 * or block rule covers anything over it and anything it cannot read.
 */
export function withinLimit(rule: PermissionRule, input: Record<string, unknown>): boolean {
  if (!rule.field || rule.limit === null || rule.limit === undefined) return true;
  const value = limitValue(input, rule.field);
  if (rule.list === 'allow') return value !== null && value <= rule.limit;
  return value === null || value > rule.limit;
}

/** Whether this rule covers the call: its pattern matches and its amount limit lets it. */
export function ruleCovers(rule: PermissionRule, toolName: string, input: Record<string, unknown>): boolean {
  if (!withinLimit(rule, input)) return false;
  return rule.list === 'allow'
    ? allowRuleMatches(rule.pattern, toolName, input)
    : ruleMatches(rule.pattern, toolName, input);
}

/** `block`: a block rule covers the call; it is refused in every mode, without a card. */
export type Verdict = 'allow' | 'ask' | 'deny' | 'block';

/** An "always ask" rule covers this request: no one but the person may let it through. */
export function askRuleMatches(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  return !!askRuleFor(rules, toolName, input);
}

/**
 * The "always ask" rule that covers this call, if one does. One that wants a second person's yes
 * comes first: a plainer rule covering the same step must not hide it.
 */
export function askRuleFor(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  const covering = rules.filter((r) => r.list === 'ask' && ruleCovers(r, toolName, input));
  return covering.find((r) => r.secondPerson) ?? covering[0] ?? null;
}

/** The block rule that covers this call, if one does. */
export function blockRuleFor(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  return rules.find((r) => r.list === 'block' && ruleCovers(r, toolName, input)) ?? null;
}

/**
 * The allow rules that let this call through: one for the whole step, or, for a shell line of
 * commands run in a row or piped, one for each command in it that needs one (see `freePart`).
 * Null when they do not, or when the line cannot be cut into its commands (`commandParts`).
 */
export function allowRulesFor(
  rules: PermissionRule[],
  toolName: string,
  input: Record<string, unknown>,
): PermissionRule[] | null {
  const allow = rules.filter((r) => r.list === 'allow');
  const whole = allow.find((r) => ruleCovers(r, toolName, input));
  if (whole) return [whole];
  if (toolName !== 'Bash') return null;
  const parts = commandParts(ruleSubject(toolName, input));
  if (!parts) return null;
  const used = new Set<PermissionRule>();
  for (const command of parts) {
    if (freePart(command)) continue;
    // The part is one command: what its quotes hold is not a chain.
    const rule = allow.find(
      (r) => withinLimit(r, { command }) && patternMatches(r.pattern, 'Bash', { command }),
    );
    if (!rule) return null;
    used.add(rule);
  }
  return used.size ? [...used] : null;
}

/** The allow rule that lets this call through, if one does (the first, for a chained command). */
export function allowRuleFor(rules: PermissionRule[], toolName: string, input: Record<string, unknown>) {
  return allowRulesFor(rules, toolName, input)?.[0] ?? null;
}

/** From the strictest level to the freest. The retired "review" counts as full access (see `modeFor`). */
export const STRICTNESS: Record<PermissionMode, number> = { readonly: 0, ask: 1, review: 2, auto: 2 };

/** The bot's level, held to `cap` when a stricter bot started the turn. */
/** An input written the same way whatever order its keys came in, to compare two steps. */
function sameShape(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** Steps whose card stays with the person even when they tell a manager what to answer. */
const PERSON_ONLY_TOOLS: Record<string, ServerKey> = {
  browser_card: 'cards.keep.payment',
  browser_login: 'cards.keep.secret',
  browser_code: 'cards.keep.secret',
  browser_email_code: 'cards.keep.secret',
  credential_request: 'cards.keep.secret',
  call_listen: 'cards.keep.device',
};

/**
 * Why a manager may not answer a card for the person, as a catalog key; null when it may. What
 * hands over a secret or money, works on the person's own computer or phone, wants a second
 * person, or comes from a site that imitates another stays theirs; so does a manager's own card,
 * which asks the person about what that manager wants to do.
 */
export function managerMayNotAnswer(
  card: Pick<Approval, 'kind' | 'toolName' | 'input' | 'options' | 'summary' | 'needsSecond' | 'botId'>,
  line: Record<string, unknown>,
  manager: string,
  managers: ReadonlySet<string> = new Set([manager]),
): ServerKey | null {
  if (card.kind === 'login') return 'cards.keep.secret';
  if (card.needsSecond) return 'cards.keep.second';
  if (card.botId === manager || managers.has(card.botId)) return 'cards.keep.manager';
  if (card.kind === 'question' && questionItems(card).items.some((q) => q.secret)) return 'cards.keep.secret';
  if (
    card.toolName.startsWith(PERSON_COMPUTER) ||
    card.toolName.startsWith(PERSON_COMMAND) ||
    card.toolName.startsWith(PERSON_PHONE)
  )
    return 'cards.keep.device';
  if (typeof line.resembles === 'string') return 'cards.keep.lookalike';
  return PERSON_ONLY_TOOLS[card.toolName] ?? null;
}

/**
 * A turn of a run that only looks and reports (a report-only routine's, or its rehearsal's, or a
 * check-in, which is a follow-up held to reading). Other turns held to reading, a read-only bot's
 * room round for one, are held by the cap alone; this one is also built as for a bot that may only
 * read, and kept apart from the person's own words.
 */
export const reportOnlyTurn = (turn: { source: string; modeCap?: PermissionMode | null }) =>
  (turn.source === 'routine' || turn.source === 'followup') && turn.modeCap === 'readonly';

export function cappedMode(mode: PermissionMode, cap: PermissionMode | null | undefined): PermissionMode {
  return cap && STRICTNESS[cap] < STRICTNESS[mode] ? cap : mode;
}

/**
 * The level a step is decided at: the bot's own. Reading text someone else wrote does not lower it;
 * that text reaches the bot marked as data, and the steps that matter ask at every level ("always
 * ask" rules, a copy of a site, a saved card, a sign-in). The retired "review" level, a model judging
 * each step, counts as going ahead by itself: it handed the person more cards than it saved.
 */
export function modeFor(mode: PermissionMode): PermissionMode {
  return mode === 'review' ? 'auto' : mode;
}

export function decide(opts: {
  /** The level the step is decided at, as `modeFor` gives it. */
  mode: PermissionMode;
  toolName: string;
  input: Record<string, unknown>;
  rules: PermissionRule[];
  readOnlyTools: Set<string>;
  /** Someone with no account here asked: "always allow" rules, given for the person's own work, do not count. */
  guest?: boolean;
}): Verdict {
  const { mode, toolName, input, rules } = opts;
  const isRead = READ_ONLY_TOOLS.has(toolName) || opts.readOnlyTools.has(toolName);
  if (blockRuleFor(rules, toolName, input)) return 'block';
  if (mode === 'readonly') return isRead ? 'allow' : 'deny';
  if (askRuleMatches(rules, toolName, input)) return 'ask';
  if (mode === 'auto' || isRead) return 'allow';
  if (opts.guest) return 'ask';
  if (allowRuleFor(rules, toolName, input)) return 'allow';
  return 'ask';
}

/** How far back the person's answers on a bot's cards are read for ways to ask less. */
export const SUGGEST_DAYS = 30;
/** How many times the person must have allowed a step, and never refused it, before it is suggested. */
export const SUGGEST_RULE_MIN = 5;
/** How many answered cards a bot in `ask` needs before going ahead by itself is suggested. */
export const SUGGEST_MODE_MIN = 20;
/** The most refusals, as a share of those cards, that still suggest going ahead by itself. */
export const SUGGEST_MODE_DENIED = 0.05;
/** The most "always allow" suggestions shown at once. */
const SUGGEST_RULES_MAX = 5;

/** A card the person answered with a button, as suggestions read it. */
export interface AnsweredCard {
  toolName: string;
  input: Record<string, unknown>;
  summary: string;
  status: 'allowed' | 'denied';
}

/**
 * Ways to ask less, from the person's own answers on a bot's cards (newest first): each step they
 * allowed every time, at least `SUGGEST_RULE_MIN` times, as the "always allow" rule a card would
 * write; and for a bot in `ask`, going ahead by itself, when they allowed nearly every card it
 * would spare. A step an "always ask" rule covers still asks at full access, so it does not count
 * toward it; a step whose tool has an amount limit is never offered a plain rule, which would
 * outrank the limit.
 */
export function permissionSuggestions(o: {
  mode: PermissionMode;
  cards: AnsweredCard[];
  rules: PermissionRule[];
  dismissed: ReadonlySet<string>;
  /** What the rule would let the bot do, in words; the latest card's own words without it. */
  describe?: (c: AnsweredCard, pattern: string) => string;
}): PermissionSuggestions {
  // A bot that never asks, or may only read, has no cards a rule or full access would spare.
  if (modeFor(o.mode) !== 'ask') return { rules: [], mode: null };
  const steps = new Map<string, { latest: AnsweredCard; allowed: number; denied: number }>();
  for (const c of o.cards) {
    // A chained command counts toward a rule for each command in it.
    for (const { pattern, input } of rememberedSteps(c.toolName, c.input) ?? []) {
      const step = steps.get(pattern) ?? { latest: { ...c, input }, allowed: 0, denied: 0 };
      if (c.status === 'allowed') step.allowed++;
      else step.denied++;
      steps.set(pattern, step);
    }
  }
  const rules = [...steps]
    .filter(
      ([pattern, s]) =>
        s.allowed >= SUGGEST_RULE_MIN &&
        s.denied === 0 &&
        !o.dismissed.has(pattern) &&
        !askRuleMatches(o.rules, s.latest.toolName, s.latest.input) &&
        !allowRuleFor(o.rules, s.latest.toolName, s.latest.input) &&
        // A plain "always allow" would outrank an amount limit the person set for the tool.
        !o.rules.some((r) => r.field && ruleMatches(r.pattern, s.latest.toolName, s.latest.input)),
    )
    .sort((a, b) => b[1].allowed - a[1].allowed)
    .slice(0, SUGGEST_RULES_MAX)
    .map(([pattern, s]) => ({
      pattern,
      summary: o.describe?.(s.latest, pattern) ?? s.latest.summary,
      allowed: s.allowed,
    }));
  let mode: PermissionSuggestions['mode'] = null;
  if (o.mode === 'ask' && !o.dismissed.has('mode')) {
    const passable = o.cards.filter((c) => !askRuleMatches(o.rules, c.toolName, c.input));
    const denied = passable.filter((c) => c.status === 'denied').length;
    if (passable.length >= SUGGEST_MODE_MIN && denied <= passable.length * SUGGEST_MODE_DENIED) {
      mode = { to: 'auto', allowed: passable.length - denied, denied };
    }
  }
  return { rules, mode };
}

/** Where a bot's turned-down suggestions are kept. */
const dismissedKey = (botId: string) => `suggestions.dismissed.${botId}`;
/** The most turned-down suggestions kept for a bot; the oldest go first. */
const DISMISSED_MAX = 200;

export function summarize(toolName: string, input: Record<string, unknown>): string {
  const subject = ruleSubject(toolName, input);
  const name = toolName.startsWith('mcp__leafbot__') ? toolName.slice('mcp__leafbot__'.length) : toolName;
  return subject ? `${name}: ${truncate(subject, 200)}` : name;
}

/** What a person typed into a sign-in card. Kept in memory only, never in the approvals table. */
export interface LoginAnswer {
  username: string;
  password: string;
  /** The vault entry, when they chose to save it. */
  savedId: string | null;
}

type Outcome = {
  status: 'allowed' | 'denied' | 'expired';
  answer: string | null;
  login?: LoginAnswer;
  /** Closed unanswered after the unattended wait (see `timeoutMs`). */
  timedOut?: boolean;
  /** The person wrote in the chat instead of answering; `answer` holds their words. */
  typed?: boolean;
  /** The manager bot that answered for the person, by name. */
  via?: string;
};

interface Waiter {
  resolve(d: Outcome): void;
  turnId: string | null;
}

/** The tools whose cards hold a WhatsApp draft; see `expireAllPending`. */
export const WHATSAPP_DRAFT_TOOLS = ['whatsapp_send', 'whatsapp_status'] as const;

/** A person who may sign in, as `approvers` reads them. */
interface SignedIn {
  id: string;
  role: (typeof schema.users.$inferSelect)['role'];
  displayName: string | null;
  username: string | null;
}

export class ApprovalService {
  private waiters = new Map<string, Waiter>();

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private threads: ThreadService,
  ) {}

  /**
   * Cards, newest first; with `seen`, only those in conversations it lets through. A card asked in
   * an exchange between bots says where it is shown instead.
   */
  async list(opts: { status?: Approval['status']; seen?: SQL; answerable?: SQL } = {}): Promise<Approval[]> {
    const rows = await this.ctx.db
      .select({ approval: schema.approvals })
      .from(schema.approvals)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.approvals.threadId))
      .where(
        and(opts.status ? eq(schema.approvals.status, opts.status) : undefined, opts.seen, opts.answerable),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(200);
    const cards = rows.map((r) => r.approval);
    const places = await this.threads.answerPlaces(cards);
    // A waiting card may be answered outside its conversation too (the bot's main chat shows those
    // of its other conversations), so it brings its line's props, as a card there would carry them.
    const lines = await this.threads.cardLines(
      cards.filter((c) => places.has(c.id) || c.status === 'pending'),
    );
    return cards.map((c) => {
      const place = places.get(c.id);
      const line = lines.get(c.id);
      return {
        ...toApproval(c),
        ...(place && { answerIn: { ...place, props: line ?? { approvalId: c.id } } }),
        ...(c.status === 'pending' && line && { line }),
      };
    });
  }

  /**
   * The open question card a bot is waiting on in a conversation. A typed message answers it in
   * words when it asks one thing and no secret (`typedAnswerable`); otherwise the card steps aside
   * (`stepAside`) and the bot reads the message.
   */
  async waitingQuestion(threadId: string): Promise<Approval | null> {
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.threadId, threadId),
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.kind, 'question'),
          eq(schema.approvals.toolName, 'ask_user'),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(1);
    const card = rows[0] ? toApproval(rows[0]) : null;
    return card && this.waiters.has(card.id) ? card : null;
  }

  /** Whether a typed message can be the answer to a question card: one question, no secret. */
  typedAnswerable(card: Approval): boolean {
    const { items } = questionItems(card);
    return items.length === 1 && !items[0]!.secret;
  }

  /**
   * Closes a question card the person wrote in the chat beside instead of answering: the bot stops
   * waiting on it and reads their message. Their words are not kept on the card, which may have
   * asked for a secret.
   */
  async stepAside(id: string, by: string | null = null) {
    const [row] = await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'denied', answer: null, decidedBy: 'typed', decidedByUserId: by, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending')))
      .returning();
    if (!row) return;
    this.waiters.get(id)?.resolve({ status: 'denied', answer: null, typed: true });
    this.waiters.delete(id);
    this.ctx.bus.refresh({ scope: 'approvals' });
  }

  /**
   * The open step and sign-in cards a running turn of this conversation waits on. A person who
   * writes in the chat instead of pressing a button has redirected the bot, and these give way.
   */
  async redirectable(threadId: string): Promise<Approval[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.threadId, threadId),
          eq(schema.approvals.status, 'pending'),
          inArray(schema.approvals.kind, ['tool', 'login']),
        ),
      );
    return rows.filter((r) => this.waiters.has(r.id)).map(toApproval);
  }

  /** Closes a card with the words the person wrote in the chat instead; the bot goes on with them. */
  async redirect(id: string, text: string, by: string | null = null) {
    const [row] = await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'denied', answer: text, decidedBy: 'typed', decidedByUserId: by, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending')))
      .returning();
    if (!row) return;
    this.waiters.get(id)?.resolve({ status: 'denied', answer: text, typed: true });
    this.waiters.delete(id);
    this.ctx.bus.refresh({ scope: 'approvals' });
  }

  /** True while a card of this turn waits for the person's answer. */
  waitingOn(turnId: string): boolean {
    for (const w of this.waiters.values()) if (w.turnId === turnId) return true;
    return false;
  }

  async get(id: string): Promise<Approval> {
    return toApproval(await this.row(id));
  }

  /**
   * Whether `by` may answer a card. In a team conversation a card is the one who asked: only they,
   * or someone who may change the bot, answer it; anyone else in the team only sees it.
   */
  async mayAnswer(card: { id: string }, by: string | null): Promise<boolean> {
    if (!by) return true;
    const [row] = await this.ctx.db
      .select({ kind: schema.threads.kind, turnId: schema.approvals.turnId, botId: schema.approvals.botId })
      .from(schema.approvals)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.approvals.threadId))
      .where(eq(schema.approvals.id, card.id))
      .limit(1);
    if (row?.kind !== 'team') return true;
    if (row.turnId) {
      const [turn] = await this.ctx.db
        .select({ userId: schema.turns.userId })
        .from(schema.turns)
        .where(eq(schema.turns.id, row.turnId))
        .limit(1);
      if (turn?.userId === by) return true;
    }
    return this.mayChangeBot(row.botId, by);
  }

  /**
   * Whether `by` may change the bot, its level among the rest: its owner, an admin, or someone it
   * is shared with to change. A caller with no person (the app itself) may.
   */
  private async mayChangeBot(botId: string, by: string | null): Promise<boolean> {
    if (!by) return true;
    const [user] = await this.ctx.db
      .select({ role: schema.users.role, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, by))
      .limit(1);
    const [bot] = await this.ctx.db
      .select({ ownerUserId: schema.bots.ownerUserId, access: schema.bots.access })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId))
      .limit(1);
    return !!user && !user.disabledAt && !!bot && botLevel({ userId: by, role: user.role }, bot) === 'edit';
  }

  private async row(id: string) {
    const [row] = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.id, id))
      .limit(1);
    if (!row) throw notFound('approval');
    return row;
  }

  /**
   * Create a pending card and wait for the user's answer.
   * The card also shows in the thread as an `approval` message.
   */
  async ask(opts: {
    threadId: string;
    botId: string;
    turnId: string | null;
    kind: 'tool' | 'question' | 'login';
    toolName: string;
    input: Record<string, unknown>;
    summary?: string;
    options?: string[];
    signal?: AbortSignal;
    /** Close the card unanswered after this long (turns nobody watches). */
    timeoutMs?: number;
    onCreated?: (a: Approval) => Promise<void>;
    /** Asked in a run outside text started; see `answer`. */
    outside?: boolean;
    /** An "always ask" rule wants two people's yes; `named` is the second one it names, if any. */
    second?: { named: string | null };
  }): Promise<Outcome & { approvalId: string }> {
    const id = newId();
    const [row] = await this.ctx.db
      .insert(schema.approvals)
      .values({
        id,
        threadId: opts.threadId,
        botId: opts.botId,
        turnId: opts.turnId,
        kind: opts.kind,
        toolName: opts.toolName,
        summary: opts.summary ?? summarize(opts.toolName, opts.input),
        input: opts.input,
        options: opts.options ?? [],
        status: 'pending',
        outside: !!opts.outside,
        needsSecond: !!opts.second,
        secondUserId: opts.second?.named ?? null,
      })
      .returning();
    const result = new Promise<Outcome>((resolve) => {
      this.waiters.set(id, { resolve, turnId: opts.turnId });
    });
    if (opts.signal) {
      const onAbort = () => void this.expire(id);
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = opts.timeoutMs ? setTimeout(() => void this.expire(id, true), opts.timeoutMs) : null;
    timer?.unref();
    await opts.onCreated?.(toApproval(row!));
    this.ctx.bus.refresh({ scope: 'approvals' });
    // A card asked between bots is shown where the work began; the notice leads there.
    const place = (await this.threads.answerPlaces([row!]).catch(() => null))?.get(id);
    this.ctx.bus.notice({
      kind: 'needsYou',
      need: row!.kind,
      botId: place?.botId ?? opts.botId,
      threadId: place?.threadId ?? opts.threadId,
      text: truncate(row!.summary, 200),
    });
    try {
      return { ...(await result), approvalId: id };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * `fromList`: the answer comes from the list of steps waiting for a second yes, whose person
   * does not see the conversation; it only ever reaches a card that waits for that second yes.
   */
  async answer(
    id: string,
    d: ApprovalDecision,
    by: string | null = null,
    opts: {
      fromList?: boolean;
      /** A manager bot answers for `by`, in their words: never what `managerMayNotAnswer` keeps. */
      via?: { botId: string; name: string };
    } = {},
  ): Promise<Approval> {
    const stored = await this.row(id);
    const current = toApproval(stored);
    // A card that wants two people's yes (see `needsSecond`) is answered by the rules below.
    const twoKeys = stored.needsSecond && current.kind === 'tool';
    if (opts.via) {
      const line = (await this.threads.cardLines([stored])).get(stored.id) ?? {};
      // Every manager's own card stays with the person, not only the answering manager's.
      const managers = await this.ctx.db
        .select({ id: schema.bots.id })
        .from(schema.bots)
        .where(eq(schema.bots.isManager, true));
      const ids = new Set(managers.map((m) => m.id));
      if (current.status === 'pending' && managerMayNotAnswer(current, line, opts.via.botId, ids))
        throw new HttpError(403, 'error.cardNotYours');
      // What a manager answers counts for this time only.
      d = { ...d, remember: false };
    }
    if (opts.fromList && !(twoKeys && stored.firstAt)) throw notFound('approval');
    if (current.status !== 'pending') throw new HttpError(409, 'error.cardAnswered');
    if (twoKeys) {
      const first = await this.checkTwoKeys(stored, d, by, !!opts.fromList);
      if (first) return first;
    } else if (!(await this.mayAnswer(stored, by))) throw new HttpError(403, 'error.cardNotYours');
    const status = d.decision === 'allow' ? 'allowed' : 'denied';
    const botRules = await this.rules(stored.botId);
    // "Always allow" lets the bot go ahead by itself from now on, at full access, not only for
    // this step: a rule per command kept the person answering cards for the next one. Not from a
    // card that offers no such button (an "always ask" rule, a copy of a site), nor from someone
    // who may only talk with the bot, whose answer counts for this time.
    // A command on the person's own computer is remembered as itself, in its folder, for them
    // alone: never as full access, which would let the bot run anything there.
    const command = current.toolName === PERSON_COMMAND_RUN;
    const remembered =
      !!d.remember &&
      d.decision === 'allow' &&
      current.kind === 'tool' &&
      !twoKeys &&
      !stored.outside &&
      !askRuleMatches(botRules, current.toolName, current.input) &&
      (command ? !!by : await this.mayChangeBot(stored.botId, by));
    let answer = d.answers ? JSON.stringify(d.answers) : (d.answer ?? null);
    /** What the waiting bot gets, when it differs from what the card keeps. */
    let given: string | null | undefined;
    if (current.kind === 'question' && status === 'allowed') {
      const { items } = questionItems(current);
      if (items.some((q) => q.secret)) {
        // A secret answer reaches the waiting bot and nothing else: the card, the database and
        // every screen that shows the card keep it blank.
        if (!this.waiters.has(id)) throw new HttpError(409, 'error.cardAnswered');
        given = answer;
        answer = hideSecretAnswers(items, d.answers ?? (d.answer !== undefined ? [d.answer] : []));
      }
    }
    let login: LoginAnswer | undefined;
    if (current.kind === 'login' && d.decision === 'allow') {
      if (!d.login) throw new HttpError(400, 'error.loginRequired');
      // Nobody else may be waiting on this card any more (e.g. after a restart).
      if (!this.waiters.has(id)) throw new HttpError(409, 'error.cardAnswered');
      // Kept for the whole site, unless the person chose the exact address the card names.
      const exact = d.login.exact && typeof current.input.host === 'string' ? current.input.host : null;
      const site = exact ?? (typeof current.input.site === 'string' ? current.input.site : '');
      const saved = d.login.save
        ? // Kept as the person who typed it: their own, typed only when a bot works for them.
          await this.vault.save(
            { site, username: d.login.username, password: d.login.password },
            by ?? OWNER_ID,
          )
        : null;
      login = { username: d.login.username, password: d.login.password, savedId: saved?.id ?? null };
      // Only the username is kept on the card.
      answer = d.login.username || null;
    }
    const [row] = await this.ctx.db
      .update(schema.approvals)
      .set({
        status,
        answer,
        remembered,
        decidedBy: 'person',
        decidedByUserId: by ?? (twoKeys ? OWNER_ID : null),
        decidedAt: new Date(),
        answeredViaBotId: opts.via?.botId ?? null,
      })
      .where(
        and(
          eq(schema.approvals.id, id),
          eq(schema.approvals.status, 'pending'),
          // The second yes only counts after a first one: not if this card is answered at once.
          twoKeys && status === 'allowed' ? isNotNull(schema.approvals.firstAt) : undefined,
        ),
      )
      .returning();
    if (!row) throw new HttpError(409, 'error.cardAnswered');
    if (remembered && command) {
      const t = await serverTranslator(this.ctx);
      await this.addRule({
        list: 'allow',
        pattern: commandRulePattern(String(current.input.command ?? ''), String(current.input.cwd ?? '')),
        note: t('approval.commandRuleNote'),
        botId: stored.botId,
        userId: by,
      });
    } else if (remembered) await this.goFullAccess(stored.botId, by);
    // "Never allow": the step is refused from now on, in every mode, without a card. As narrow as
    // the step, and for the bot that asked: one refused command does not take the whole tool from
    // every bot.
    const blocked =
      d.remember && d.decision === 'deny' && current.kind === 'tool'
        ? blockedPattern(current.toolName, current.input)
        : null;
    if (blocked) {
      const t = await serverTranslator(this.ctx);
      await this.addRule({
        list: 'block',
        pattern: blocked,
        note: t('approval.blockNote'),
        botId: stored.botId,
      });
    }
    // The waiting bot hears that a manager answered, beside the answer, which stays as given: an
    // option's label is compared as it is.
    this.waiters.get(id)?.resolve({
      status,
      answer: given ?? answer,
      ...(login && { login }),
      ...(opts.via && { via: opts.via.name }),
    });
    this.waiters.delete(id);
    if (remembered && !command) await this.allowAllWaiting(stored.botId, id, by);
    this.ctx.bus.refresh({ scope: 'approvals' });
    return toApproval(row);
  }

  /**
   * The people who may give a bot's steps a second yes: those who may change it (a person it is
   * shared with to talk with only does not), or, for a rule on every bot, those who look after
   * the server. Not people who may no longer sign in.
   */
  async approvers(botId: string | null, people?: SignedIn[]): Promise<Approver[]> {
    people ??= await this.signedIn();
    const [bot] = botId
      ? await this.ctx.db
          .select({ ownerUserId: schema.bots.ownerUserId, access: schema.bots.access })
          .from(schema.bots)
          .where(eq(schema.bots.id, botId))
          .limit(1)
      : [];
    return people
      .filter((u) =>
        botId ? !!bot && botLevel({ userId: u.id, role: u.role }, bot) === 'edit' : managesServer(u.role),
      )
      .map((u) => ({ id: u.id, name: u.displayName || u.username || '' }));
  }

  /** The people who may sign in, oldest first: those `approvers` picks from. */
  private signedIn(): Promise<SignedIn[]> {
    return this.ctx.db
      .select({
        id: schema.users.id,
        role: schema.users.role,
        displayName: schema.users.displayName,
        username: schema.users.username,
      })
      .from(schema.users)
      .where(isNull(schema.users.disabledAt))
      .orderBy(asc(schema.users.createdAt));
  }

  /** Whether anyone could give a card's second yes at all: someone who may change the bot, or the one named. */
  async hasSecond(botId: string, named: string | null): Promise<boolean> {
    return (await this.secondApprovers(botId, named)).length > 0;
  }

  /** Who may give the second yes of a card: the person its rule named, or any of `approvers`. */
  private async secondApprovers(
    botId: string,
    named: string | null,
    people?: SignedIn[],
  ): Promise<Approver[]> {
    const all = await this.approvers(botId, people);
    return named ? all.filter((p) => p.id === named) : all;
  }

  /**
   * What a rule that wants a second person needs: someone other than the one who makes it could
   * give that yes, and a named person may do so. A rule nobody else could answer would only ever
   * refuse its steps.
   */
  private async checkSecondRule(
    r: { botId?: string | null; secondUserId?: string | null },
    by: string | null,
  ) {
    const pool = await this.approvers(r.botId ?? null);
    if (r.secondUserId && !pool.some((p) => p.id === r.secondUserId)) {
      throw new HttpError(400, 'error.secondNamedInvalid');
    }
    if (!pool.some((p) => p.id !== (by ?? OWNER_ID))) throw new HttpError(409, 'error.secondNobody');
  }

  /**
   * The rules of an answer to a card that wants two people's yes. Null when the answer goes on
   * like any other (a "no" from either person, the second yes); otherwise the first yes, kept
   * here: the card stays pending and those who may give the second are told.
   */
  private async checkTwoKeys(
    stored: typeof schema.approvals.$inferSelect,
    d: ApprovalDecision,
    by: string | null,
    fromList: boolean,
  ): Promise<Approval | null> {
    // A caller with no person (the app itself) is the owner.
    const who = by ?? OWNER_ID;
    const waiting = !!stored.firstAt;
    const pool = await this.secondApprovers(stored.botId, stored.secondUserId);
    const isSecond = pool.some((p) => p.id === who) && who !== stored.firstByUserId;
    // The list of steps waiting for a second yes is for those who could give it, and the first person.
    if (fromList && !isSecond && who !== stored.firstByUserId) throw notFound('approval');
    if (d.decision === 'deny') {
      // Either person may refuse; so may anyone who could answer an ordinary card.
      if (waiting && (who === stored.firstByUserId || isSecond)) return null;
      if (await this.mayAnswer(stored, by)) return null;
      throw new HttpError(403, 'error.cardNotYours');
    }
    if (waiting) {
      if (isSecond) return null;
      throw new HttpError(403, who === stored.firstByUserId ? 'error.secondSame' : 'error.secondNotYou');
    }
    if (!(await this.mayAnswer(stored, by))) throw new HttpError(403, 'error.cardNotYours');
    // The person named for the second yes cannot also give the first.
    if (stored.secondUserId === who) throw new HttpError(403, 'error.secondNamedFirst');
    const others = pool.filter((p) => p.id !== who);
    if (!others.length) throw new HttpError(409, 'error.secondNobody');
    const [row] = await this.ctx.db
      .update(schema.approvals)
      .set({ firstByUserId: who, firstAt: new Date() })
      .where(
        and(
          eq(schema.approvals.id, stored.id),
          eq(schema.approvals.status, 'pending'),
          isNull(schema.approvals.firstAt),
        ),
      )
      .returning();
    if (!row) throw new HttpError(409, 'error.cardAnswered');
    this.ctx.bus.refresh({ scope: 'approvals' });
    this.ctx.bus.notice({
      kind: 'needsYou',
      need: 'tool',
      botId: stored.botId,
      // The second person does not see the conversation.
      threadId: '',
      text: truncate(stored.summary, 200),
      to: others.map((p) => p.id),
    });
    return toApproval(row);
  }

  /**
   * The steps waiting for this person's second yes, newest first, with whose request each is: the
   * ones whose first yes came from someone else, which they could give. The conversation they
   * come from is not part of it.
   */
  async waitingForSecond(who: string): Promise<{ card: Approval; askedBy: string | null }[]> {
    const rows = await this.ctx.db
      .select({ approval: schema.approvals, askedBy: schema.turns.userId })
      .from(schema.approvals)
      .leftJoin(schema.turns, eq(schema.turns.id, schema.approvals.turnId))
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.kind, 'tool'),
          eq(schema.approvals.needsSecond, true),
          isNotNull(schema.approvals.firstAt),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt))
      .limit(200);
    const out: { card: Approval; askedBy: string | null }[] = [];
    // Read once for the whole list, and each bot's pool once: many cards share a bot.
    const people = await this.signedIn();
    const pools = new Map<string, Promise<Approver[]>>();
    for (const r of rows) {
      if (!this.waiters.has(r.approval.id) || r.approval.firstByUserId === who) continue;
      const key = `${r.approval.botId}\n${r.approval.secondUserId ?? ''}`;
      if (!pools.has(key))
        pools.set(key, this.secondApprovers(r.approval.botId, r.approval.secondUserId, people));
      if (!(await pools.get(key)!).some((p) => p.id === who)) continue;
      out.push({ card: toApproval(r.approval), askedBy: r.askedBy });
    }
    return out;
  }

  /**
   * Refuses the cards waiting for a second yes that nobody could give any more: the person named
   * is gone or lost the bot, or no one who may change it is left. Run whenever people or a bot's
   * sharing change, so the bot is told and does not wait for a yes that cannot come.
   */
  async refuseUnanswerable(): Promise<void> {
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.kind, 'tool'),
          eq(schema.approvals.needsSecond, true),
        ),
      );
    if (!rows.length) return;
    const t = await serverTranslator(this.ctx);
    const people = await this.signedIn();
    for (const r of rows) {
      const pool = (await this.secondApprovers(r.botId, r.secondUserId, people)).filter(
        (p) => p.id !== r.firstByUserId,
      );
      if (pool.length) continue;
      const reason = t('approval.secondGone');
      const [done] = await this.ctx.db
        .update(schema.approvals)
        .set({ status: 'denied', answer: reason, decidedBy: 'rule', decidedAt: new Date() })
        .where(and(eq(schema.approvals.id, r.id), eq(schema.approvals.status, 'pending')))
        .returning();
      if (!done) continue;
      this.waiters.get(r.id)?.resolve({ status: 'denied', answer: reason });
      this.waiters.delete(r.id);
    }
    this.ctx.bus.refresh({ scope: 'approvals' });
  }

  /**
   * "Always allow": the bot goes ahead by itself from now on. A read-only bot stays read-only, and
   * one already at full access is left as it is. The change is kept in the bot's history, as one
   * the person made in its settings would be.
   */
  private async goFullAccess(botId: string, by: string | null) {
    const changed = await this.ctx.db.transaction(async (tx) => {
      const [before] = await tx
        .select({ permissionMode: schema.bots.permissionMode })
        .from(schema.bots)
        .where(eq(schema.bots.id, botId))
        .limit(1);
      if (!before || before.permissionMode === 'readonly' || before.permissionMode === 'auto') return false;
      await tx
        .update(schema.bots)
        .set({ permissionMode: 'auto', updatedAt: new Date() })
        .where(eq(schema.bots.id, botId));
      await tx.insert(schema.auditLog).values({
        id: newId(),
        actor: by ? `user:${by}` : 'card',
        action: 'update',
        targetType: 'bot',
        targetId: botId,
        before: { permissionMode: before.permissionMode },
        after: { permissionMode: 'auto' },
      });
      return true;
    });
    if (changed) this.ctx.bus.refresh({ scope: 'bots' });
  }

  /**
   * After "always allow", the same bot's other cards still waiting are answered too, as the bot
   * would now go ahead with them by itself: the person's answer, given once for all of them. Not
   * one an "always ask" rule covers, nor one that offers no "always allow" (a copy of a site, a
   * guest's request, a turn a stricter bot holds to its level).
   */
  private async allowAllWaiting(botId: string, except: string, by: string | null) {
    const rules = await this.rules(botId);
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          eq(schema.approvals.kind, 'tool'),
          eq(schema.approvals.botId, botId),
        ),
      );
    for (const r of rows) {
      if (r.id === except || r.outside || r.needsSecond || !this.waiters.has(r.id)) continue;
      if (askRuleMatches(rules, r.toolName, r.input)) continue;
      const [done] = await this.ctx.db
        .update(schema.approvals)
        .set({ status: 'allowed', decidedBy: 'person', decidedByUserId: by, decidedAt: new Date() })
        .where(and(eq(schema.approvals.id, r.id), eq(schema.approvals.status, 'pending')))
        .returning();
      if (!done) continue;
      this.waiters.get(r.id)?.resolve({ status: 'allowed', answer: null });
      this.waiters.delete(r.id);
    }
  }

  async expire(id: string, timedOut = false) {
    const answer = timedOut ? APPROVAL_TIMED_OUT : null;
    await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'expired', answer, decidedAt: new Date() })
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, 'pending')));
    this.waiters.get(id)?.resolve({ status: 'expired', answer, ...(timedOut && { timedOut }) });
    this.waiters.delete(id);
    this.ctx.bus.refresh({ scope: 'approvals' });
  }

  /**
   * On boot nothing is waiting any more, except the cards whose answer is read from the card
   * whenever it comes: a WhatsApp draft's, which goes out then, and a routine's approval step,
   * whose run goes on then.
   */
  async expireAllPending() {
    await this.ctx.db
      .update(schema.approvals)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          notInArray(schema.approvals.toolName, [...WHATSAPP_DRAFT_TOOLS, ROUTINE_APPROVAL_TOOL]),
        ),
      );
  }

  /** A user-approved record, for carrying approval to another bot. */
  async verifiedApproval(id: string): Promise<Approval | null> {
    try {
      const a = await this.get(id);
      return a.status === 'allowed' ? a : null;
    } catch {
      return null;
    }
  }

  toAnswer(
    r: { status: string; answer: string | null; timedOut?: boolean; typed?: boolean; via?: string },
    t: T,
  ): PermissionAnswer {
    if (r.status === 'allowed') return { behavior: 'allow' };
    if (r.via) {
      const why = r.answer ? t('approval.deniedWith', { answer: r.answer }) : t('approval.denied');
      return { behavior: 'deny', message: `${why}\n${t('approval.viaManager', { manager: r.via })}` };
    }
    if (r.typed) return { behavior: 'deny', message: t('approval.typedInstead', { text: r.answer ?? '' }) };
    if (r.timedOut) return { behavior: 'deny', message: t('approval.timedOut') };
    if (r.status === 'expired') return { behavior: 'deny', message: t('approval.expired') };
    return {
      behavior: 'deny',
      message: r.answer ? t('approval.deniedWith', { answer: r.answer }) : t('approval.denied'),
    };
  }

  /**
   * Whether the person refused this very step of this bot (same tool, same input) since they last
   * wrote anything. Asked again before they say more, the answer would be the same, so the bot is
   * told so without another card; their next message, anywhere, lets it ask again.
   */
  async refusedLately(botId: string, toolName: string, input: Record<string, unknown>): Promise<boolean> {
    const [last] = await this.ctx.db
      .select({ at: schema.messages.createdAt })
      .from(schema.messages)
      .where(and(eq(schema.messages.role, 'user'), eq(schema.messages.author, 'user')))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    const rows = await this.ctx.db
      .select({ input: schema.approvals.input })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.botId, botId),
          eq(schema.approvals.kind, 'tool'),
          eq(schema.approvals.toolName, toolName),
          eq(schema.approvals.status, 'denied'),
          eq(schema.approvals.decidedBy, 'person'),
          ...(last ? [gt(schema.approvals.decidedAt, last.at)] : []),
        ),
      )
      .orderBy(desc(schema.approvals.decidedAt))
      .limit(50);
    const step = sameShape(input);
    return rows.some((r) => sameShape(r.input) === step);
  }

  /** Ways to ask less for a bot, from the cards the person answered with a button lately. */
  async suggestions(
    botId: string,
    mode: PermissionMode,
    describe?: (c: AnsweredCard, pattern: string) => string,
    now = new Date(),
  ): Promise<PermissionSuggestions> {
    const since = new Date(now.getTime() - SUGGEST_DAYS * 86_400_000);
    const rows = await this.ctx.db
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.botId, botId),
          eq(schema.approvals.kind, 'tool'),
          eq(schema.approvals.outside, false),
          eq(schema.approvals.decidedBy, 'person'),
          inArray(schema.approvals.status, ['allowed', 'denied']),
          gte(schema.approvals.decidedAt, since),
        ),
      )
      .orderBy(desc(schema.approvals.decidedAt))
      .limit(1000);
    return permissionSuggestions({
      mode,
      cards: rows.map((r) => ({
        toolName: r.toolName,
        input: r.input,
        summary: r.summary,
        status: r.status === 'allowed' ? 'allowed' : 'denied',
      })),
      rules: await this.rules(botId),
      dismissed: new Set(await this.dismissed(botId)),
      describe,
    });
  }

  private async dismissed(botId: string): Promise<string[]> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.kv)
      .where(eq(schema.kv.key, dismissedKey(botId)))
      .limit(1);
    return Array.isArray(row?.value) ? row.value.filter((x): x is string => typeof x === 'string') : [];
  }

  /** Turns a suggestion down for good: a rule's pattern, or `mode`. */
  async dismissSuggestion(botId: string, key: string): Promise<void> {
    const kept = [...(await this.dismissed(botId)).filter((k) => k !== key), key].slice(-DISMISSED_MAX);
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: dismissedKey(botId), value: kept })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: kept } });
    this.ctx.bus.refresh({ scope: 'rules' });
  }

  /** Every rule; with `botId`, the ones that apply to that bot: its own and those for every bot. */
  async rules(botId?: string | null): Promise<PermissionRule[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.permissionRules)
      .where(
        botId ? or(isNull(schema.permissionRules.botId), eq(schema.permissionRules.botId, botId)) : undefined,
      )
      .orderBy(asc(schema.permissionRules.createdAt));
    return rows.map(toRule);
  }

  async addRule(
    r: {
      list: 'ask' | 'allow' | 'block';
      pattern: string;
      note: string;
      botId?: string | null;
      /** An amount limit: both or neither (see `withinLimit`). */
      field?: string | null;
      limit?: number | null;
      /** An ask rule that wants a second person's yes, and who gives it (anyone who may change the bot when null). */
      secondPerson?: boolean;
      secondUserId?: string | null;
      /** The one person the rule is for (see the column). */
      userId?: string | null;
    },
    by: string | null = null,
  ): Promise<PermissionRule> {
    const limited = !!r.field && typeof r.limit === 'number';
    const second = r.list === 'ask' && !!r.secondPerson;
    if (second) await this.checkSecondRule(r, by);
    const [row] = await this.ctx.db
      .insert(schema.permissionRules)
      .values({
        id: newId(),
        list: r.list,
        pattern: r.pattern,
        note: r.note,
        botId: r.botId ?? null,
        field: limited ? r.field : null,
        limit: limited ? r.limit : null,
        secondPerson: second,
        secondUserId: second ? (r.secondUserId ?? null) : null,
        userId: r.userId ?? null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'rules' });
    return toRule(row!);
  }

  async removeRule(id: string) {
    await this.ctx.db.delete(schema.permissionRules).where(eq(schema.permissionRules.id, id));
    this.ctx.bus.refresh({ scope: 'rules' });
  }
}
