import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { wallClock, type Bot } from '@leafbot/shared';
import type { CaptureState } from '../browser/call-capture';
import type { Ctx } from '../context';
import { translator } from '../i18n';
import { HttpError } from '../util';
import { workspacePaths } from '../workspace';
import type { Services } from './index';

/** The longest a call is listened to; listening then stops on its own. */
export const CALL_MAX_MS = 3 * 60 * 60_000;
/** A call in which nobody was heard for this long is taken as over. */
export const CALL_QUIET_MS = 15 * 60_000;
/** A recording larger than this is not the page's: 30 seconds of speech is about 100 KB. */
export const CALL_MAX_SEGMENT_BYTES = 5 * 1024 * 1024;
const SWEEP_MS = 30_000;
/** What of the transcript the bot reads while the call goes on, and at its end. */
const STATUS_LINES = 40;
const MAX_TRANSCRIPT_CHARS = 40_000;

/** Why listening stopped: the bot stopped it, the page left the call, or one of the limits above. */
export type CallEnd = 'bot' | 'left' | 'quiet' | 'long';

interface Listening {
  bot: Bot;
  threadId: string;
  userId: string;
  timezone: string;
  /** Where the transcript is written, and that path as the bot names it in its conversation folder. */
  file: string;
  name: string;
  startedAt: number;
  lastHeard: number;
  lines: number;
  /** Recordings not turned into text, for the bot to tell the person. */
  missed: number;
  /** The recordings are written in the order they were heard. */
  chain: Promise<void>;
  /** Set once stopping began; a second stop waits for the first. */
  stopping?: Promise<CallSummary>;
  /** Someone was heard in the page; then checks in a row with nobody, which end the call. */
  voices: boolean;
  empty: number;
}

export interface CallSummary {
  file: string;
  lines: number;
  missed: number;
  minutes: number;
  /** The transcript's lines: the last ones while listening, all that fit once it stopped. */
  text: string;
  /** While listening: the people heard in the page now, and whether its sound runs. */
  state?: CaptureState | null;
  /** Earlier lines left out of `text`; they are in the file. */
  cut: boolean;
}

/**
 * Listening to a call the bot joined in its browser: the page's audio comes in short recordings
 * (see `browser/call-capture.ts`), each goes to the speech-to-text service and its words are added
 * to a transcript in the conversation's folder. No audio is kept. When the call ends on its own the
 * bot is started again in the same conversation to write up the call from the transcript.
 */
export class CallService {
  private calls = new Map<string, Listening>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  listening(botId: string): boolean {
    const c = this.calls.get(botId);
    return !!c && !c.stopping;
  }

  /** `segmentMs` shortens the recordings, for tests. */
  async start(o: {
    bot: Bot;
    threadId: string;
    userId: string;
    segmentMs?: number;
  }): Promise<{ file: string }> {
    if (this.calls.has(o.bot.id)) throw new HttpError(409, 'call.already');
    if (!(await this.services.transcribe.available())) throw new HttpError(409, 'call.noSpeech');
    const settings = await this.services.settings.all(o.userId);
    const now = this.clock();
    const w = wallClock(now, settings.timezone);
    const two = (n: number) => String(n).padStart(2, '0');
    const name = `calls/${w.year}-${two(w.month)}-${two(w.day)}-${two(w.hour)}${two(w.minute)}.md`;
    const dir = workspacePaths(this.ctx.config.dataDir, o.bot.id, o.threadId, o.bot.groupId).threadDir;
    const file = join(dir, name);
    const call: Listening = {
      bot: o.bot,
      threadId: o.threadId,
      userId: o.userId,
      voices: false,
      empty: 0,
      timezone: settings.timezone,
      file,
      name,
      startedAt: now.getTime(),
      lastHeard: now.getTime(),
      lines: 0,
      missed: 0,
      chain: Promise.resolve(),
    };
    this.calls.set(o.bot.id, call);
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const t = translator(settings.language ?? (await this.services.settings.locale()));
      await writeFile(
        file,
        `# ${t('call.transcriptTitle', { when: `${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}` })}\n\n`,
        { mode: 0o600 },
      );
      await this.ctx.browser.listen(o.bot.id, (audio) => this.heard(o.bot.id, audio), o.segmentMs);
    } catch (err) {
      this.calls.delete(o.bot.id);
      throw err;
    }
    this.startSweep();
    return { file: name };
  }

  /** What was written so far: the last lines of the transcript, for the bot to follow along. */
  async status(botId: string): Promise<CallSummary | null> {
    const c = this.calls.get(botId);
    if (!c || c.stopping) return null;
    // What was heard before asking is in the answer.
    await c.chain;
    const state = await this.ctx.browser.listenState(botId).catch(() => null);
    return { ...(await this.summary(c, 'last')), state };
  }

  /** Stops listening; once the last recording is written, says where the transcript is. */
  async stop(botId: string, why: CallEnd): Promise<CallSummary | null> {
    const c = this.calls.get(botId);
    if (!c) return null;
    c.stopping ??= (async () => {
      // The page hands over its last recording while it stops: the call is still known until then.
      await this.ctx.browser.unlisten(botId).catch(() => {});
      this.calls.delete(botId);
      if (!this.calls.size) this.stopSweep();
      await c.chain;
      const summary = await this.summary(c, 'all');
      if (why !== 'bot') await this.wakeBot(c, why, summary).catch(() => {});
      return summary;
    })();
    return c.stopping;
  }

  async shutdown() {
    this.stopSweep();
    for (const botId of [...this.calls.keys()]) {
      this.calls.delete(botId);
      await this.ctx.browser.unlisten(botId).catch(() => {});
    }
  }

  /** Each minute or so: a page that left the call, a call gone quiet, or one past the limit ends. */
  async check(now = this.clock().getTime()) {
    for (const [botId, c] of [...this.calls]) {
      if (c.stopping) continue;
      const state = await this.ctx.browser.listenState(botId).catch(() => null);
      if (state?.tracks) c.voices = true;
      // Nobody left in the call for two checks in a row, after someone was: the call is over.
      c.empty = c.voices && state && !state.tracks ? c.empty + 1 : 0;
      if (!state?.listening || c.empty >= 2) await this.stop(botId, 'left');
      else if (now - c.startedAt >= CALL_MAX_MS) await this.stop(botId, 'long');
      else if (now - c.lastHeard >= CALL_QUIET_MS) await this.stop(botId, 'quiet');
    }
  }

  private heard(botId: string, audio: Buffer) {
    const c = this.calls.get(botId);
    if (!c || !audio.length || audio.length > CALL_MAX_SEGMENT_BYTES) return;
    // A recording comes only with sound in it: someone is in the call.
    c.voices = true;
    const at = this.clock();
    c.chain = c.chain.then(async () => {
      try {
        // No language is given: people in a call may speak another one than the person's.
        const text = (await this.services.transcribe.transcribe(audio, 'audio/webm')).replace(/\s+/g, ' ');
        if (!text.trim()) return;
        const w = wallClock(at, c.timezone);
        const stamp = `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
        await appendFile(c.file, `[${stamp}] ${text.trim()}\n`);
        c.lines++;
        c.lastHeard = at.getTime();
      } catch {
        c.missed++;
      }
    });
  }

  private async summary(c: Listening, part: 'last' | 'all'): Promise<CallSummary> {
    const raw = await readFile(c.file, 'utf8').catch(() => '');
    const lines = raw.split('\n').filter((l) => l.startsWith('['));
    let kept = part === 'last' ? lines.slice(-STATUS_LINES) : lines;
    while (kept.length > 1 && kept.join('\n').length > MAX_TRANSCRIPT_CHARS) kept = kept.slice(1);
    return {
      file: c.name,
      lines: c.lines,
      missed: c.missed,
      minutes: Math.round((this.clock().getTime() - c.startedAt) / 60_000),
      text: kept.join('\n'),
      cut: kept.length < lines.length,
    };
  }

  /** The call ended without the bot: it is started again to write up the call for the person. */
  private async wakeBot(c: Listening, why: Exclude<CallEnd, 'bot'>, s: CallSummary) {
    const settings = await this.services.settings.all(c.userId);
    const t = translator(settings.language ?? (await this.services.settings.locale()));
    await this.services.turns.enqueue({
      threadId: c.threadId,
      botId: c.bot.id,
      source: 'followup',
      prompt: t('call.endedPrompt', {
        file: s.file,
        lines: s.lines,
        minutes: s.minutes,
        why: t(`call.end.${why}`),
      }),
      // The transcript is what other people in the call said.
      outside: 'web',
      userId: c.userId,
    });
  }

  private startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => void this.check(), SWEEP_MS);
    this.sweep.unref();
  }

  private stopSweep() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }
}
