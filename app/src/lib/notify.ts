import { cardPlace, type Approval, type Bot, type NoticeEvent } from '@leafbot/shared';
import type { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { getT } from '@/i18n';
import { useUi } from './store';

/** Which notices become notifications on this device. */
export type NotifyLevel = 'all' | 'needsYou' | 'off';
export const NOTIFY_LEVELS: NotifyLevel[] = ['all', 'needsYou', 'off'];

const KEY = 'leafbot.notify';
const SOUND_KEY = 'leafbot.notify.sound';
const MUTED_KEY = 'leafbot.notify.muted';

/** Muted bots and until when (ms since the epoch); null keeps a bot muted until unmuted. */
export type Mutes = Record<string, number | null>;

function readMutes(): Mutes {
  try {
    const v = JSON.parse(localStorage.getItem(MUTED_KEY) ?? '{}') as unknown;
    // Earlier versions kept a plain list of bots, each muted until unmuted.
    if (Array.isArray(v)) {
      return Object.fromEntries(v.filter((x): x is string => typeof x === 'string').map((id) => [id, null]));
    }
    if (!v || typeof v !== 'object') return {};
    return Object.fromEntries(
      Object.entries(v).filter(([, until]) => until === null || typeof until === 'number'),
    ) as Mutes;
  } catch {
    return {};
  }
}

/** Whether the bot is muted now; a mute whose time has passed no longer counts. */
export function isMuted(mutes: Mutes, botId: string, now = Date.now()): boolean {
  if (!(botId in mutes)) return false;
  const until = mutes[botId];
  return until === null || until === undefined || until > now;
}

/** The end of a mute for the choices the menu offers. */
export function muteUntil(choice: 'hour' | 'morning' | 'always', now = new Date()): number | null {
  if (choice === 'always') return null;
  if (choice === 'hour') return now.getTime() + 3_600_000;
  const morning = new Date(now);
  morning.setHours(8, 0, 0, 0);
  if (morning <= now) morning.setDate(morning.getDate() + 1);
  return morning.getTime();
}

function readLevel(): NotifyLevel {
  try {
    const v = localStorage.getItem(KEY);
    return NOTIFY_LEVELS.includes(v as NotifyLevel) ? (v as NotifyLevel) : 'all';
  } catch {
    return 'all';
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse; the choice holds for this page.
  }
}

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === '1';
  } catch {
    return false;
  }
}

/** The person's choice is kept per device: a phone and a desktop may want different things. */
export const useNotify = create<{
  level: NotifyLevel;
  /** A short chime with each notice that passes the level, notification or not. */
  sound: boolean;
  /** Bots that make no notification or sound on this device, and until when. */
  mutes: Mutes;
  setLevel(l: NotifyLevel): void;
  setSound(on: boolean): void;
  mute(botId: string, until: number | null): void;
  unmute(botId: string): void;
}>((set, get) => ({
  level: readLevel(),
  sound: readSound(),
  mutes: readMutes(),
  mute: (botId, until) => {
    const now = Date.now();
    // Mutes that ran out are dropped as the list is written again.
    const kept = Object.fromEntries(
      Object.entries(get().mutes).filter(([id]) => isMuted(get().mutes, id, now)),
    );
    const mutes = { ...kept, [botId]: until };
    save(MUTED_KEY, JSON.stringify(mutes));
    set({ mutes });
  },
  unmute: (botId) => {
    const { [botId]: _gone, ...mutes } = get().mutes;
    save(MUTED_KEY, JSON.stringify(mutes));
    set({ mutes });
  },
  setLevel: (level) => {
    save(KEY, level);
    set({ level });
  },
  setSound: (sound) => {
    save(SOUND_KEY, sound ? '1' : '0');
    set({ sound });
  },
}));

/** What a notice sounds like: each kind its own, so it can be told apart without looking. */
export type SoundKind = 'reply' | 'question' | 'approval' | 'error';
export const SOUND_KINDS: SoundKind[] = ['reply', 'question', 'approval', 'error'];

/** One note: its pitch (Hz), when it starts and how long it rings (s), and a pitch it slides to. */
export interface Note {
  freq: number;
  at: number;
  length: number;
  slideTo?: number;
}

/**
 * The notes of each sound, made on the spot: no sound file to load. A reply is two soft rising
 * notes; a question slides up, as a voice does when it asks; a permission request rings like a
 * small bell; an error steps down.
 */
export const SOUNDS: Record<SoundKind, { wave: OscillatorType; volume: number; notes: Note[] }> = {
  reply: {
    wave: 'sine',
    volume: 0.15,
    notes: [
      { freq: 660, at: 0, length: 0.35 },
      { freq: 880, at: 0.12, length: 0.35 },
    ],
  },
  question: {
    wave: 'sine',
    volume: 0.14,
    notes: [
      { freq: 523, at: 0, length: 0.18 },
      { freq: 587, at: 0.16, length: 0.32, slideTo: 880 },
    ],
  },
  approval: {
    wave: 'sine',
    volume: 0.13,
    notes: [
      { freq: 1319, at: 0, length: 0.9 },
      { freq: 2637, at: 0, length: 0.45 },
      { freq: 1319, at: 0.22, length: 0.9 },
    ],
  },
  error: {
    wave: 'triangle',
    volume: 0.16,
    notes: [
      { freq: 494, at: 0, length: 0.22 },
      { freq: 370, at: 0.18, length: 0.4 },
    ],
  },
};

/** The sound of a notice: its card's kind when something waits on the person. */
export function soundFor(e: Pick<NoticeEvent, 'kind' | 'need'>): SoundKind {
  if (e.kind === 'error') return 'error';
  if (e.kind === 'reply') return 'reply';
  return e.need === 'question' ? 'question' : 'approval';
}

let audio: AudioContext | null = null;
/** Plays the sound of one kind of notice; a reply's by default. */
export function chime(kind: SoundKind = 'reply') {
  try {
    audio ??= new AudioContext();
    const now = audio.currentTime;
    const sound = SOUNDS[kind];
    for (const note of sound.notes) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = sound.wave;
      const at = now + note.at;
      osc.frequency.setValueAtTime(note.freq, at);
      if (note.slideTo) osc.frequency.exponentialRampToValueAtTime(note.slideTo, at + note.length * 0.8);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(sound.volume, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + note.length);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + note.length + 0.05);
    }
  } catch {
    // No sound output on this device.
  }
}

export const notificationsSupported = () => typeof Notification !== 'undefined';

/** Asks the browser for permission when it has not been asked; true when notifications may show. */
export async function allowNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === 'default') await Notification.requestPermission();
  return Notification.permission === 'granted';
}

/** Whether a notice is worth a notification at this level, with the page in this state. */
export function wanted(
  e: Pick<NoticeEvent, 'kind' | 'botId'>,
  level: NotifyLevel,
  view: { focused: boolean; botId: string | null },
  muted: readonly string[] = [],
): boolean {
  if (level === 'off' || muted.includes(e.botId)) return false;
  if (level === 'needsYou' && e.kind === 'reply') return false;
  // Someone looking at that bot sees it already.
  return !(view.focused && view.botId === e.botId);
}

/** Notifications still on screen, by tag, so the ones about an answered card can be taken down. */
const open = new Map<string, Notification>();

function show(title: string, body: string, tag: string, onClick?: () => void) {
  const n = new Notification(title, { body, tag, icon: '/logo.png' });
  open.get(tag)?.close();
  open.set(tag, n);
  n.onclose = () => {
    if (open.get(tag) === n) open.delete(tag);
  };
  n.onclick = () => {
    window.focus();
    onClick?.();
    n.close();
  };
}

/**
 * Takes down "waiting for you" notifications of conversations with no card left to answer, so a
 * card answered here or on another device does not keep calling.
 */
export function closeAnswered(waitingThreads: ReadonlySet<string>) {
  for (const [tag, n] of open) {
    const threadId = tag.startsWith('needsYou:') ? tag.slice('needsYou:'.length) : null;
    if (threadId && !waitingThreads.has(threadId)) n.close();
  }
}

/** Follows the cards the app knows about and closes notifications whose card was answered. */
export function watchAnswered(qc: QueryClient): () => void {
  return qc.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.query.queryKey[0] !== 'approvals') return;
    const list = event.query.state.data as Approval[] | undefined;
    if (!Array.isArray(list)) return;
    // A card asked between bots was told of where it is shown.
    closeAnswered(new Set(list.filter((a) => a.status === 'pending').map((a) => cardPlace(a).threadId)));
  });
}

/** Shows a server notice as a system notification when the person wants it and is elsewhere. */
export function notice(qc: QueryClient, e: NoticeEvent) {
  const ui = useUi.getState();
  const focused = document.visibilityState === 'visible' && document.hasFocus();
  // With a room open, the bot's own chat is not on screen; the room is.
  if (focused && ui.roomId === e.threadId) return;
  const view = { focused, botId: ui.roomId ? null : ui.botId };
  const prefs = useNotify.getState();
  if (
    !wanted(
      e,
      prefs.level,
      view,
      Object.keys(prefs.mutes).filter((id) => isMuted(prefs.mutes, id)),
    )
  )
    return;
  if (prefs.sound) chime(soundFor(e));
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  const t = getT();
  const bot = qc.getQueryData<Bot[]>(['bots'])?.find((b) => b.id === e.botId);
  const name = bot?.name ?? t('common.bot');
  const title =
    e.kind === 'needsYou'
      ? t('notify.needsYou', { name })
      : e.kind === 'error'
        ? t('notify.error', { name })
        : name;
  show(title, e.text, `${e.kind}:${e.threadId}`, () => openNotice(qc, e));
}

/** Opens the conversation a notice is about: a room, or the bot's chat at that thread. */
export function openNotice(qc: QueryClient, e: Pick<NoticeEvent, 'botId' | 'threadId'>) {
  if (qc.getQueryData<{ id: string }[]>(['rooms'])?.some((r) => r.id === e.threadId))
    return useUi.getState().openRoom(e.threadId);
  useUi.getState().openChat(e.botId);
  useUi.getState().selectThread(e.threadId);
}

/** A notification right now, so the person sees what they will get. */
export function testNotification() {
  const t = getT();
  show(t('notify.testTitle'), t('notify.testBody'), 'test');
}
