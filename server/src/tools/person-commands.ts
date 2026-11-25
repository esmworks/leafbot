import { commandRulePattern, describeAction, PERSON_COMMAND_RUN } from '@leafbot/shared';
import { secretPlace } from '@leafbot/shared/mac';
import { z } from 'zod';
import type { CommandComputer } from '../computer/bridge';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import { catastrophic } from '../runtime/safety';
import { askRuleFor, blockRuleFor } from '../services/approvals';
import type { Services } from '../services';
import type { Define } from './index';

/** How much of a command's output a tool result carries: the end, where the result usually is. */
const OUTPUT_MAX = 20_000;
const WHERE_MS = 15_000;

/** The errors the computer answers with that have their own words. */
const KNOWN = new Set(['tooMany', 'refused', 'noFolder', 'commandsOff', 'offline', 'badRequest']);

/**
 * Commands on the person's own computer, through their desktop app with "Bots may run commands"
 * on. Each command asks on a card at every permission level, with the folder the computer resolved,
 * unless the person allowed that very command in that very folder before and it names no place
 * where keys are kept (those also ask on the computer, and are never remembered).
 */
export function personCommandTools(o: {
  def: Define;
  t: T;
  s: Services;
  bot: { id: string; name: string };
  threadId: string;
  turn: { id: string; rehearsalId: string | null };
  /** The person whose computer it is: whose message started the turn. */
  person: string;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Their computer that runs commands, looked up at each step; null when none is connected. */
  computer: () => CommandComputer | null;
}): AppTool[] {
  const { def, t, s } = o;
  const failed = (error: string) =>
    t(`personJob.error.${KNOWN.has(error) ? error : 'failed'}` as 'personJob.error.failed');
  const output = (text: string) =>
    text.length > OUTPUT_MAX
      ? `${t('personJob.cut')}\n${text.slice(-OUTPUT_MAX)}`
      : text || t('personJob.noOutput');

  /** Whether the person must say yes on a card first; a refusal's words when it may not run at all. */
  const mayRun = async (
    command: string,
    cwd: string,
    secret: string | null,
  ): Promise<{ card: boolean; refused?: string }> => {
    const input = { command, cwd };
    const rules = await s.approvals.rules(o.bot.id);
    const blocked = blockRuleFor(rules, PERSON_COMMAND_RUN, input);
    if (blocked) return { card: false, refused: t('turn.blocked', { rule: blocked.pattern }) };
    const ask = askRuleFor(rules, PERSON_COMMAND_RUN, input);
    // A step that wants two people's yes goes through the bot's own cards, not this one.
    if (ask?.secondPerson) return { card: false, refused: t('personJob.secondPerson') };
    if (ask || secret) return { card: true };
    // The person allowed this very command in this very folder: it runs even after outside text,
    // which can only make it run again what they already let run there. New rules wait for a turn
    // that read none (see the card below).
    const pattern = commandRulePattern(command, cwd);
    const allowed = rules.some(
      (r) =>
        r.list === 'allow' &&
        r.userId === o.person &&
        (r.botId === o.bot.id || !r.botId) &&
        r.pattern === pattern &&
        !r.field,
    );
    return { card: !allowed };
  };

  return [
    def(
      'person_command_run',
      {
        command: z.string().min(1).max(20_000),
        cwd: z.string().max(1000).optional(),
        wait_seconds: z.number().int().min(0).max(25).optional(),
      },
      async (a) => {
        // A rehearsal shows what would run; nothing runs on anyone's computer.
        if (o.turn.rehearsalId) return t('personJob.rehearsal');
        if (catastrophic(a.command)) return t('turn.safetyFloor');
        const computer = o.computer();
        if (!computer) return t('personJob.error.offline');
        // The folder as the computer resolves it: the card and any rule name that one.
        const at = await computer.ask({ op: 'where', cwd: a.cwd ?? '~' }, WHERE_MS);
        if (at.ok !== true || typeof at.cwd !== 'string')
          return failed(typeof at.error === 'string' ? at.error : 'failed');
        const cwd = at.cwd;
        const secret = secretPlace(a.command, cwd);
        const may = await mayRun(a.command, cwd, secret);
        if (may.refused) return may.refused;
        if (may.card) {
          const input = { command: a.command, cwd, device: computer.device };
          // A place keys are kept: this time only, no "always allow". After outside text it is still
          // offered: the card shows the very command and folder it would keep, nothing wider.
          const once = !!secret;
          const r = await s.approvals.ask({
            threadId: o.threadId,
            botId: o.bot.id,
            turnId: o.turn.id,
            kind: 'tool',
            toolName: PERSON_COMMAND_RUN,
            input,
            summary: describeAction(PERSON_COMMAND_RUN, input, {
              bot: o.bot.name,
              locale: await s.settings.locale(),
            }).want,
            signal: o.signal,
            timeoutMs: o.timeoutMs,
            outside: once,
            onCreated: async (card) => {
              await s.threads.addMessage({
                threadId: o.threadId,
                role: 'approval',
                author: `bot:${o.bot.id}`,
                text: card.summary,
                props: { approvalId: card.id, ...(once && { noAlways: true }) },
                turnId: o.turn.id,
              });
            },
          });
          if (r.status !== 'allowed') {
            const no = s.approvals.toAnswer(r, t);
            return no.behavior === 'deny' ? no.message : t('approval.denied');
          }
        }
        const job = await s.personJobs.start({
          computer: o.computer() ?? computer,
          userId: o.person,
          bot: o.bot,
          threadId: o.threadId,
          turnId: o.turn.id,
          command: a.command,
          cwd,
          waitMs: (a.wait_seconds ?? 20) * 1000,
        });
        if ('error' in job) return failed(job.error);
        if (job.running && job.unsure) return t('personJob.unsure', { id: job.id });
        if (job.running) return t('personJob.started', { id: job.id, output: output(job.output) });
        return t(job.stopped ? 'personJob.stoppedResult' : 'personJob.result', {
          id: job.id,
          code: String(job.exitCode ?? '?'),
          output: output(job.output),
        });
      },
      'internal',
    ),
    def(
      'person_command_status',
      { id: z.string().min(1).max(64), wait_seconds: z.number().int().min(0).max(60).optional() },
      async (a) => {
        const until = Date.now() + (a.wait_seconds ?? 0) * 1000;
        let row = await s.personJobs.get(a.id, o.person);
        while (row?.status === 'running' && Date.now() < until && !o.signal.aborted) {
          await new Promise((r) => setTimeout(r, 1_000));
          row = await s.personJobs.get(a.id, o.person);
        }
        if (!row) return t('personJob.unknown', { id: a.id });
        const how =
          row.status === 'done'
            ? t('personJob.exited', { code: String(row.exitCode ?? '?') })
            : t(`personJob.status.${row.status}`);
        return t('personJob.statusLine', { id: row.id, how, output: output(row.tail) });
      },
      'read',
    ),
    def(
      'person_command_stop',
      { id: z.string().min(1).max(64) },
      async (a) =>
        (await s.personJobs.stop(a.id, o.person))
          ? t('personJob.stopping', { id: a.id })
          : t('personJob.notRunning', { id: a.id }),
      'internal',
    ),
  ];
}
