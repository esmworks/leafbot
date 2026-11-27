import { randomUUID } from 'node:crypto';
import { DEFAULT_LOCALE, type Locale, type Params } from '@leafbot/shared';
import { translator, type ServerKey, type T } from './i18n';

export const newId = () => randomUUID();
export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
export const isoNow = () => new Date().toISOString();

/**
 * An error the client sees. It carries a message key, so the response can be written in the
 * language of the request; `message` is the default-language text, for logs and tests.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public key: ServerKey,
    public params?: Params,
  ) {
    super(translator(DEFAULT_LOCALE)(key, params));
  }

  localized(t: T): string {
    return t(this.key, this.params);
  }
}

export type NotFoundKind =
  | 'bot'
  | 'group'
  | 'thread'
  | 'room'
  | 'message'
  | 'memory'
  | 'memoryFlag'
  | 'routine'
  | 'approval'
  | 'job'
  | 'vault'
  | 'skill'
  | 'apiKey'
  | 'canaryAlarm'
  | 'apiSource'
  | 'ticket'
  | 'table'
  | 'tableRow'
  | 'dashboard'
  | 'dashboardTile'
  | 'person'
  | 'meeting'
  | 'promise'
  | 'routineSuggestion'
  | 'skillSuggestion'
  | 'followUp'
  | 'routineRun'
  | 'rehearsal'
  | 'turn'
  | 'spaceRequest';
export const notFound = (what: NotFoundKind) => new HttpError(404, `error.notFound.${what}`);

/** An error's text in the given language: translated when it is ours, as thrown otherwise. */
export function errorText(err: unknown, t: T): string {
  return err instanceof HttpError ? err.localized(t) : (err as Error).message;
}

/** Postgres unique-violation, from either driver. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * The first `n` code units of `s`, backed off so the cut does not split a character: half of an
 * emoji's surrogate pair, or a joined emoji left ending in its joiner or a variation selector.
 */
export function cutAt(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = s.slice(0, Math.max(0, n));
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.replace(/(?:\u200d|\ufe0e|\ufe0f)+$/u, '');
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${cutAt(s, n - 1)}…` : s;
}

/** An error envelope's machine code ("invalid_api_key"), never a sentence. */
const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * What a failed model call says, for the person: when the message carries a provider's JSON error
 * envelope (`API Error: 402 {"error":{"message":"…"}}`), the envelope's own sentence takes its
 * place, its machine code after it; any other message stays as it is.
 */
export function readableError(message: string, limit = 500): string {
  const at = message.indexOf('{');
  if (at < 0) return message;
  let json: unknown;
  try {
    json = JSON.parse(message.slice(at, message.lastIndexOf('}') + 1));
  } catch {
    return message;
  }
  const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
  const env = obj(json);
  const inner = obj(env?.error);
  const said = [inner?.message, env?.message, typeof env?.error === 'string' ? env.error : null].find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (!said) return message;
  const code = [inner?.code, inner?.type].find(
    (v): v is string => typeof v === 'string' && MACHINE_CODE.test(v),
  );
  const head = message
    .slice(0, at)
    .trim()
    .replace(/[:\s]+$/, '');
  return `${head ? `${head}: ` : ''}${truncate(said.trim(), limit)}${code ? ` (${code})` : ''}`;
}

/** Words that ask a working bot to stop, and words that may come with them, in each language. */
const STOP: Record<'words' | 'fillers', Record<Locale, string[]>> = {
  words: {
    en: ['stop', 'halt', 'cancel', 'abort'],
    tr: ['dur', 'durdur', 'iptal', 'vazgeç', 'kes', 'bırak'],
    de: ['stopp', 'stop', 'halt', 'abbrechen', 'aufhören', 'anhalten'],
    ar: ['توقف', 'توقفي', 'إيقاف', 'إلغاء', 'أوقف'],
    es: ['detente', 'detener', 'cancela', 'cancelar', 'aborta', 'basta'],
    fr: ['stop', 'arrête', 'arrêter', 'annule', 'annuler', 'abandonne'],
    hi: ['रुको', 'रोको', 'बंद', 'रद्द'],
    id: ['stop', 'berhenti', 'batalkan', 'batal', 'hentikan'],
    it: ['stop', 'ferma', 'fermati', 'annulla', 'interrompi', 'basta'],
    pl: ['stop', 'zatrzymaj', 'anuluj', 'przerwij'],
    pt: ['pare', 'parar', 'cancele', 'cancelar', 'aborte'],
    ru: ['стоп', 'остановись', 'остановить', 'отмена', 'отмени', 'прекрати'],
    uk: ['стоп', 'зупинись', 'зупинити', 'скасувати', 'скасуй', 'припини'],
    vi: ['dừng', 'hủy'],
    zh: ['停止', '停下', '取消', '终止'],
  },
  fillers: {
    en: ['now', 'please', 'it', 'that'],
    tr: ['şimdi', 'lütfen', 'hemen', 'artık', 'et', 'yeter'],
    de: ['jetzt', 'bitte', 'sofort', 'das', 'es'],
    ar: ['الآن', 'رجاءً', 'من فضلك', 'هذا', 'هذه'],
    es: ['ahora', 'por favor', 'esto', 'eso', 'ya'],
    fr: ['maintenant', 'svp', 'stp', 'ça', 'cela'],
    hi: ['अभी', 'कृपया', 'यह', 'बस'],
    id: ['sekarang', 'tolong', 'itu', 'ini'],
    it: ['ora', 'adesso', 'per favore', 'questo', 'subito'],
    pl: ['teraz', 'proszę', 'to', 'już'],
    pt: ['agora', 'por favor', 'isso', 'isto', 'já'],
    ru: ['сейчас', 'пожалуйста', 'это', 'уже'],
    uk: ['зараз', 'будь ласка', 'це', 'вже'],
    vi: ['ngay', 'làm', 'ơn', 'đó', 'này'],
    zh: ['现在', '请', '一下'],
  },
};
// A message may mix languages ("stop lütfen"), so every language's words count.
const STOP_WORDS = new Set(Object.values(STOP.words).flat());
const STOP_FILLERS = new Set(Object.values(STOP.fillers).flat());

/**
 * A message made only of stop words ("stop", "dur", "iptal et lütfen"): sent while the bot works, it
 * stops the turn as the Stop button does instead of waiting behind it. "stop using tabs" is not one.
 */
export function isStopRequest(text: string): boolean {
  // Turkish casing turns I into ı, so both casings are tried: the message may be Turkish or not.
  return [text.toLocaleLowerCase('tr'), text.toLowerCase()].some((lowered) => {
    const words = lowered
      .replace(/[^\p{L}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean);
    return (
      words.length > 0 &&
      words.length <= 4 &&
      words.some((w) => STOP_WORDS.has(w)) &&
      words.every((w) => STOP_WORDS.has(w) || STOP_FILLERS.has(w))
    );
  });
}

/** ı and İ, which a search reads as i: the database folds I to i, never to the dotless ı. */
export const DOTTED_AND_DOTLESS_I = String.fromCharCode(0x131, 0x130);

/**
 * Text as a search compares it in the server: spaces and line breaks closed up, case folded, and
 * ı and İ read as i, as the database search reads them.
 */
export const foldText = (v: string) => v.replace(/\s+/g, ' ').replace(/[ıİ]/g, 'i').toLowerCase();
