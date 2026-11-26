import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Bot } from '@leafbot/shared';
import { BrowserError } from '../browser/manager';
import type { ElementHandle, Frame, Page, Route } from 'playwright-core';
import { z } from 'zod';
import {
  MAX_DOWNLOAD_BYTES,
  MAX_TABS,
  VIEWPORT,
  webUrl,
  type BrowserManager,
  type PageDownload,
} from '../browser/manager';
import {
  formatMessages,
  formatRequests,
  MASK,
  requestFailed,
  safeUrl,
  type PageLog,
  SHOWN_MESSAGES,
  SHOWN_REQUESTS,
} from '../browser/logs';
import { browserErrorText } from '../browser/text';
import { waitOutWall, type WallState } from '../browser/wall';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import type { LoginAnswer } from '../services/approvals';
import type { OpenCard, PaymentCardService } from '../services/payment-cards';
import type { ContactDetailsService, OpenContact } from '../services/contact-details';
import { registrableSite, siteMatches, siteOf, type VaultService } from '../services/vault';
import { maskCardNumbers } from '@leafbot/shared';
import { totp } from '../totp';
import { botFile } from './files';
import type { Define } from './index';
import { workspacePaths } from '../workspace';
import { HIDDEN_TEXT_SCRIPT, plantedIn } from '../runtime/hidden-text';

/** Longest page outline handed to the model; a long page is cut and the bot is told so. */
export const MAX_SNAPSHOT = 40_000;
/** Most lines a search of the outline gives back, besides the lines they sit under. */
const MAX_FOUND = 50;
/** How long a step waits for a download it set off before answering. */
const DOWNLOAD_WAIT_MS = 15_000;

/**
 * An outline cut into parts of at most `max` characters, at line ends. The outline covers the
 * whole page, not only what is on screen, so scrolling does not bring the rest into it: the bot
 * reads on by part.
 */
export function outlineParts(raw: string, max = MAX_SNAPSHOT): string[] {
  const parts: string[] = [];
  let part = '';
  for (const line of raw.split('\n')) {
    // A single line longer than a part (a page's one huge paragraph) is cut on its own.
    for (let i = 0; i < Math.max(line.length, 1); i += max) {
      const piece = line.slice(i, i + max);
      if (part && part.length + 1 + piece.length > max) {
        parts.push(part);
        part = '';
      }
      part = part ? `${part}\n${piece}` : piece;
    }
  }
  if (part || !parts.length) parts.push(part);
  return parts;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** The line with this ref and every line under it, by indentation; null when no line has it. */
export function outlineSection(raw: string, ref: string): string | null {
  const lines = raw.split('\n');
  const at = lines.findIndex((l) => l.includes(`[ref=${ref}]`));
  if (at < 0) return null;
  const depth = indentOf(lines[at]!);
  let end = at + 1;
  while (end < lines.length && (lines[end]!.trim() === '' || indentOf(lines[end]!) > depth)) end++;
  return lines.slice(at, end).join('\n');
}

/** Letters folded so a search finds "İstanbul" with "istanbul" and "Kayıt" with "KAYIT". */
const fold = (s: string) => s.toLocaleLowerCase('tr').normalize('NFKD').replace(/\p{M}/gu, '');

/**
 * The outline's lines with these words, each with the lines it sits under (its list, its table
 * row, its section), in page order, with "…" where lines were left out.
 */
export function outlineFind(raw: string, words: string): { text: string; found: number } {
  const lines = raw.split('\n');
  const want = fold(words.trim());
  const keep = new Set<number>();
  let found = 0;
  for (let i = 0; i < lines.length && found < MAX_FOUND; i++) {
    if (!fold(lines[i]!).includes(want)) continue;
    found++;
    keep.add(i);
    let depth = indentOf(lines[i]!);
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (lines[j]!.trim() === '' || indentOf(lines[j]!) >= depth) continue;
      keep.add(j);
      depth = indentOf(lines[j]!);
    }
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) out.push('…');
    out.push(lines[i]!);
    last = i;
  }
  return { text: out.join('\n'), found };
}

const ref = z
  .string()
  .regex(/^[\w-]{1,32}$/)
  .describe('ref from browser_snapshot, e.g. e12');
const element = z.string().max(200).describe('What the element is, in a few words');
const sends = z
  .boolean()
  .default(false)
  .describe('true if this sends, posts, buys, books, deletes or shares something');

/** Most a single upload sends to a site, all files together. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
/** Types sites check for most often; anything else goes as plain bytes. */
const UPLOAD_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Shorter values are not masked in free text: they would hide ordinary letters and words. */
const MIN_MASKED = 4;

/** Every form a secret takes in what a page shows: as typed, in an address, in a form's body. */
function secretForms(secret: string): string[] {
  const forms = new Set([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams([['', secret]]).toString().slice(1),
    JSON.stringify(secret).slice(1, -1),
  ]);
  return [...forms];
}

/**
 * `text` with every secret taken out, also where an address or a title carries it encoded.
 * Longer ones go first, so one secret inside another is not left half shown.
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  const forms = [...new Set(secrets.filter((v) => v.length >= MIN_MASKED).flatMap(secretForms))].sort(
    (a, b) => b.length - a.length,
  );
  return forms.reduce((out, f) => out.replaceAll(f, MASK), text);
}

/**
 * Runs in each frame: what the page shows as text, its address and title, and the values of its
 * fields that are not password fields (a "show password" switch turns one into plain text).
 */
const SHOWN_TEXT = `(() => {
  const fields = [...document.querySelectorAll('input, textarea')]
    .filter((e) => (e.type || '').toLowerCase() !== 'password')
    .map((e) => e.value || '');
  return [location.href, document.title, document.body ? document.body.innerText : '', ...fields].join('\\n');
})()`;

/** Whether a vault secret is in plain sight on the page, where a picture of it would show it. */
async function secretShown(page: Page, secrets: readonly string[]): Promise<boolean> {
  const list = secrets.filter((v) => v.length >= MIN_MASKED);
  if (!list.length) return false;
  const shown = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(SHOWN_TEXT)
        .then((v) => `${f.url()}\n${typeof v === 'string' ? v : ''}`)
        .catch(() => f.url()),
    ),
  );
  const text = [page.url(), ...shown].join('\n');
  return list.some((secret) => secretForms(secret).some((f) => text.includes(f)));
}

/**
 * Words on a control that sends, posts, buys, books, deletes or shares something, matched on what
 * the page itself shows rather than on what the bot says the control is.
 */
const SEND_WORDS = {
  en: /\b(send|submit|post|publish|tweet|reply|comment|share|buy|purchase|order|checkout|check out|pay|book|reserve|confirm|delete|remove|transfer|donate|subscribe|unsubscribe|apply|invite|follow|like)\b/i,
  tr: /(?<!\p{L})(gönder|paylaş|yayınla|yayımla|sil|kaldır|satın al|öde|sipariş|onayla|rezervasyon|rezerve|yanıtla|cevapla|yorum yap|aktar|bağış|abone|başvur|davet|takip et|beğen)/iu,
};

/** Whether a control's words say it sends something. */
export function sendWords(label: string): boolean {
  return Object.values(SEND_WORDS).some((re) => re.test(label));
}

/** What a click on an element would set off, as far as the page shows it. */
export interface ControlInfo {
  /** The element is, or sits in, a button, link, field or other control. */
  control: boolean;
  /** It submits a form. */
  submits: boolean;
  /** How the form it submits, or the field is part of, is sent: get, post or dialog; '' for none. */
  method: string;
  /** Its words: label, text or value. */
  label: string;
  /** A field where Enter may send what was written: a text area or an editable area. */
  writes: boolean;
  /** A one-line field and whether it searches. */
  field: boolean;
  search: boolean;
}

/** Runs in the page, on the element itself; written as a function the page receives as text. */
const controlInfo = (node: unknown): ControlInfo => {
  type El = {
    tagName: string;
    type?: string;
    value?: unknown;
    innerText?: string;
    isContentEditable?: boolean;
    form?: { method: string } | null;
    getAttribute(name: string): string | null;
    closest(selector: string): El | null;
  };
  const el = node as El;
  const found = el.closest(
    'button,input,select,textarea,a[href],summary,[contenteditable=""],[contenteditable="true"],[role=button],[role=link],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=tab],[role=option],[role=switch],[role=checkbox],[role=textbox],[role=searchbox],[role=combobox]',
  );
  const c = found ?? el;
  const tag = c.tagName.toLowerCase();
  const attr = (n: string) => (c.getAttribute(n) || '').toLowerCase();
  const type = (typeof c.type === 'string' ? c.type : attr('type')).toLowerCase();
  const submitter =
    (tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image'));
  const field =
    tag === 'input' &&
    !submitter &&
    !['checkbox', 'radio', 'button', 'reset', 'file', 'hidden', 'range', 'color'].includes(type);
  const form = submitter || field ? (c.form ?? null) : null;
  const words = (
    c.getAttribute('aria-label') ||
    (tag === 'input' ? '' : c.innerText) ||
    (typeof c.value === 'string' ? c.value : '') ||
    c.getAttribute('title') ||
    ''
  )
    .trim()
    .replace(/\s+/g, ' ');
  const name = `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')}`;
  return {
    control: !!found,
    submits: submitter && !!form,
    method: form ? ((submitter && attr('formmethod')) || form.method || 'get').toLowerCase() : '',
    label: words.length > 80 ? '' : words,
    writes: tag === 'textarea' || !!c.isContentEditable,
    field,
    search:
      type === 'search' ||
      ['searchbox', 'combobox'].includes(attr('role')) ||
      !!c.closest('[role=search]') ||
      /search|query|\bara\b|^q\b|^s\b/.test(name),
  };
};

/** Whether a click on this control sends something: a form posted, or words that say so. */
export function clickSends(c: ControlInfo): boolean {
  if (!c.control) return false;
  if (c.submits && c.method === 'post') return true;
  return sendWords(c.label);
}

/**
 * Whether pressing Enter where this control has the focus sends something. A one-line field sends
 * its form; one that searches only reads. A text area or an editable area is where chats and mail
 * send on Enter. Null means nothing has the focus.
 */
export function enterSends(c: ControlInfo | null): boolean {
  if (!c) return false;
  if (c.writes) return true;
  // A form sent with get reads (a search, a filter); a field with no form is read by the page's
  // own script, which sends on Enter unless the field is plainly a search.
  if (c.field) return c.method ? c.method === 'post' : !c.search;
  return clickSends(c);
}

/** How long a sign-in with only the username waits for the password field the page shows next. */
const PASSWORD_WAIT_MS = 4_000;

/** Keys that paste: what is pasted may have been copied from another site's page. */
const PASTE = /^(control|meta|controlormeta)\+v$|^shift\+insert$/i;

/** Whether a key press sends something by the key alone, whatever has the focus. */
export function keySends(key: string): boolean | null {
  const keys = key.replace(/\s+/g, '');
  if (PASTE.test(keys)) return true;
  const parts = keys.toLowerCase().split('+');
  const main = parts.at(-1) ?? '';
  // Control+Enter and Command+Enter send a message or a mail in most sites that have them.
  if (main.endsWith('enter') && parts.slice(0, -1).some((m) => /^(control|meta|controlormeta)$/.test(m)))
    return true;
  // Enter and Space act on what has the focus: the page decides.
  if (main.endsWith('enter') || main === 'space' || key === ' ') return null;
  return false;
}

/** The kinds of field a vault secret may go into. */
type FieldKind = 'username' | 'password' | 'code';
/** Input types each kind of field may have; a password goes into a password field only. */
const FIELD_TYPES: Record<FieldKind, readonly string[]> = {
  username: ['text', 'email', 'tel'],
  password: ['password'],
  code: ['text', 'tel', 'number', 'password'],
};

/** Runs in the page, on a field: its kind, and every address its form may send it to. */
const fieldInfo = (node: unknown) => {
  type El = {
    tagName: string;
    type?: unknown;
    formAction?: unknown;
    form?: { action: string; elements: ArrayLike<El> } | null;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
    closest(selector: string): El | null;
  };
  const el = node as El;
  const attr = (n: string) => (el.getAttribute(n) || '').toLowerCase();
  const actions: string[] = [];
  if (el.form) {
    actions.push(el.form.action);
    // A button may send the form somewhere else than the form says.
    for (const c of Array.from(el.form.elements)) {
      if (c.hasAttribute('formaction') && typeof c.formAction === 'string') actions.push(c.formAction);
    }
  }
  const name = `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')}`;
  return {
    tag: el.tagName.toLowerCase(),
    type: typeof el.type === 'string' ? el.type.toLowerCase() : attr('type') || 'text',
    actions,
    search:
      attr('type') === 'search' ||
      attr('role') === 'searchbox' ||
      !!el.closest('[role=search]') ||
      /search|query|\bara\b|^q\b|^s\b/.test(name),
  };
};

/**
 * Runs in each frame: whether something in it has the focus. `frame` means the focus is in a
 * frame inside it.
 */
const FOCUS_STATE = `(() => {
  const a = document.activeElement;
  if (!document.hasFocus() || !a || a === document.body || a === document.documentElement) return 'none';
  return /^i?frame$/i.test(a.tagName) ? 'frame' : 'element';
})()`;

/**
 * What has the focus in the page, looked for in every frame. `unknown` when the focus is in a frame
 * that cannot be read: a key pressed there is taken as one that may send.
 */
async function focusInfo(page: Page): Promise<ControlInfo | null | 'unknown'> {
  let inFrame = false;
  for (const frame of page.frames()) {
    const state = await frame.evaluate(FOCUS_STATE).catch(() => 'none');
    if (state === 'frame') inFrame = true;
    if (state !== 'element') continue;
    const handle = await frame.evaluateHandle('document.activeElement').catch(() => null);
    const el = handle?.asElement() ?? null;
    if (!el) {
      await handle?.dispose().catch(() => {});
      continue;
    }
    try {
      return await el.evaluate(controlInfo);
    } catch {
      return 'unknown';
    } finally {
      await el.dispose().catch(() => {});
    }
  }
  return inFrame ? 'unknown' : null;
}

/** How long a step the server took as sending may send once it runs: the card may wait a while. */
const ALLOW_MS = 60 * 60_000;
/** A two-step code is good for a minute or two; it stays hidden from what the bot reads this long. */
const CODE_HIDDEN_MS = 10 * 60_000;

/** Values of password fields on the page, in every frame. */
async function passwordValues(page: Page): Promise<string[]> {
  const perFrame = await Promise.all(
    page
      .frames()
      .map((f) =>
        f
          .$$eval('input[type=password]', (els) => els.map((e) => (e as unknown as { value: string }).value))
          .catch(() => [] as string[]),
      ),
  );
  return perFrame.flat();
}

export type AskLogin = (
  site: string,
  /** The exact host, when the person may want the login kept for it alone. */
  host?: string,
) => Promise<{ ok: true; login: LoginAnswer } | { ok: false; message: string }>;

/**
 * Asks the person whether a card may be filled on a site it was not used on before: `once`, or
 * `always` for that site from now on; otherwise what the bot is told. `frames` are the other sites
 * whose frames inside the page hold some of the fields (a payment provider's).
 */
export type AskCard = (o: {
  card: string;
  site: string;
  frames: string[];
  /** The card is the team's: only those who look after the server may allow it for good. */
  team: boolean;
}) => Promise<'once' | 'always' | { message: string }>;

/**
 * What an approval of a card is kept under: the page's site, and the other sites whose frames got
 * some of its values. A site allowed with its own fields does not let a frame of another site in.
 */
export const cardApproval = (site: string, frames: readonly string[]) =>
  frames.length ? `${site} (${[...frames].sort().join(', ')})` : site;

type CardPart = 'number' | 'expiry' | 'month' | 'year' | 'cvc' | 'name';

/**
 * Asks the person whether their contact details may be filled on a site they were not filled on
 * before, saying which of them: `once`, or `always` for that site from now on.
 */
export type AskContact = (o: {
  contact: string;
  site: string;
  frames: string[];
  /** What would be filled, as the person reads it (name, email, address). */
  parts: string[];
  /** The team's details: only those who look after the server may allow them for good. */
  team: boolean;
}) => Promise<'once' | 'always' | { message: string }>;

/** A field a bot may put contact details in; `name` and `address` are the parts joined. */
export const CONTACT_FIELDS = [
  'name',
  'given_name',
  'family_name',
  'email',
  'phone',
  'organization',
  'address',
  'address1',
  'address2',
  'city',
  'region',
  'postal_code',
  'country',
] as const;
type ContactField = (typeof CONTACT_FIELDS)[number];

/** The browser's own autofill names for each field; a field named for another part is refused. */
const CONTACT_AUTOCOMPLETE: Record<ContactField, string[]> = {
  name: ['name'],
  given_name: ['given-name'],
  family_name: ['family-name'],
  email: ['email'],
  phone: ['tel', 'tel-national'],
  organization: ['organization'],
  address: ['street-address', 'address-line1'],
  address1: ['address-line1', 'street-address'],
  address2: ['address-line2'],
  city: ['address-level2'],
  region: ['address-level1'],
  postal_code: ['postal-code'],
  country: ['country', 'country-name'],
};
/** Fields a list may stand for: the person's choice among cities, provinces or countries. */
const CONTACT_SELECT = new Set<ContactField>(['city', 'region', 'country']);

/**
 * What each part of a card form is called: its `autocomplete` value, or words in its name, id,
 * placeholder or label. A card value goes only into a field that says it is that part, never into a
 * comment box or a search field the bot names by mistake.
 */
const CARD_PARTS: Record<CardPart, { autocomplete: RegExp; words: RegExp; select?: boolean }> = {
  number: {
    autocomplete: /^cc-number$/,
    words: /(card|cc|kart)[\s_-]*(num|no\b|numara)|cardnumber|ccnum|\bpan\b/,
  },
  expiry: { autocomplete: /^cc-exp$/, words: /expir|exp[\s_-]*date|son[\s_-]*kullanma|\bskt\b|mm\s*\/\s*yy/ },
  month: { autocomplete: /^cc-exp-month$/, words: /month|exp[\s_-]*m|\bmm\b|\bay\b/, select: true },
  year: { autocomplete: /^cc-exp-year$/, words: /year|exp[\s_-]*y|\byy(yy)?\b|yil/, select: true },
  cvc: {
    autocomplete: /^cc-csc$/,
    words: /cvc|cvv|csc|cv2|security[\s_-]*code|card[\s_-]*code|g\u00fcvenlik/,
  },
  name: {
    autocomplete: /^cc-name$/,
    words: /holder|name[\s_-]*on|card[\s_-]*name|cc[\s_-]*name|sahib|ad[\s_-]*soyad/,
  },
};

/** Runs in the page, on a field: what it is and what it is called. */
const cardFieldInfo = (node: unknown) => {
  type El = {
    tagName: string;
    type?: unknown;
    labels?: ArrayLike<{ textContent: string | null }> | null;
    getAttribute(name: string): string | null;
    closest(selector: string): unknown;
    form?: { action: string } | null;
  };
  const el = node as El;
  // Lower case without the language's own rules: Turkish "YIL" and "y\u0131l" both become "yil",
  // and "\u0130" loses the dot the plain lower case gives it.
  const fold = (v: string) =>
    v
      .toLowerCase()
      .replace(/\u0131/g, 'i')
      .replace(/\u0307/g, '');
  const attr = (n: string) => fold(el.getAttribute(n) || '');
  const labels = fold(
    Array.from(el.labels ?? [])
      .map((l) => l.textContent ?? '')
      .join(' '),
  );
  return {
    tag: el.tagName.toLowerCase(),
    type: typeof el.type === 'string' ? el.type.toLowerCase() : attr('type') || 'text',
    autocomplete: attr('autocomplete'),
    words: `${attr('name')} ${attr('id')} ${attr('placeholder')} ${attr('aria-label')} ${attr('data-elements-stable-field-name')} ${labels}`,
    placeholder: attr('placeholder'),
    maxLength: Number(attr('maxlength')) || 0,
    search: attr('type') === 'search' || attr('role') === 'searchbox' || !!el.closest('[role=search]'),
    action: el.form?.action ?? '',
  };
};

/** The element that has focus in the page, as `tag "label"`; run in the page, so written as text. */
const FOCUSED = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return '';
  const label = el.getAttribute('aria-label') || el.getAttribute('name') || el.id || '';
  return el.tagName.toLowerCase() + (label ? ' "' + label + '"' : '');
})()`;

/**
 * Runs in the page, on an element a click could not reach: what lies over its middle, if a person
 * would see it there (a dialog, a banner, anything with text, controls or a background). Null for
 * a see-through empty layer a page leaves behind, which a person would click through.
 */
const coverInfo = (node: unknown): string | null => {
  type El = {
    tagName: string;
    innerText?: string;
    labels?: ArrayLike<El> | null;
    parentElement: El | null;
    getBoundingClientRect(): { left: number; top: number; width: number; height: number };
    contains(other: El): boolean;
    getAttribute(name: string): string | null;
    querySelector(selector: string): El | null;
  };
  const g = globalThis as unknown as {
    document: { elementFromPoint(x: number, y: number): El | null };
    getComputedStyle(e: El): { backgroundColor: string; backgroundImage: string };
  };
  const el = node as El;
  const box = el.getBoundingClientRect();
  const top = g.document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  if (!top || el.contains(top) || top.contains(el)) return null;
  // A styled box or text of the field's own label lies over a hidden checkbox or radio: a click
  // there is the person's click on the field.
  if (Array.from(el.labels ?? []).some((l) => l.contains(top))) return null;
  let seen = false;
  let outer = top;
  for (let c: El | null = top; c && !c.contains(el); c = c.parentElement) {
    outer = c;
    const role = (c.getAttribute('role') || '').toLowerCase();
    const style = g.getComputedStyle(c);
    const clear = style.backgroundColor === 'transparent' || /^rgba\(.*,\s*0\)$/.test(style.backgroundColor);
    if (
      c.tagName === 'DIALOG' ||
      role === 'dialog' ||
      role === 'alertdialog' ||
      c.getAttribute('aria-modal') === 'true' ||
      !clear ||
      style.backgroundImage !== 'none' ||
      (c.innerText || '').trim() !== '' ||
      c.querySelector('a[href],button,input,select,textarea,[role=button]')
    )
      seen = true;
  }
  if (!seen) return null;
  const label = (outer.getAttribute('aria-label') || outer.innerText || '').trim().replace(/\s+/g, ' ');
  return outer.tagName.toLowerCase() + (label ? ` "${label.slice(0, 80)}"` : '');
};

/** Lets the page settle after an action: navigation, scripts redrawing the page. */
async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(400);
  // A page still drawing its content (grey placeholder boxes, a region marked busy) would read as
  // nearly empty: give it a little longer, only when it shows it is loading. A page whose script
  // never comes back does not answer the look either, so the look itself is bounded.
  const loading = await Promise.race([
    page.evaluate(LOADING).catch(() => false),
    new Promise<false>((r) => setTimeout(() => r(false), 500)),
  ]);
  if (loading === true) {
    await page.waitForFunction(`!${LOADING}`, undefined, { timeout: 2_000, polling: 100 }).catch(() => {});
  }
}

/** Whether the page shows it is still loading its content; run in the page, so written as text. */
const LOADING = `(() => !!document.querySelector('[aria-busy="true"], [class*="skeleton" i], [class*="shimmer" i]'))()`;

/**
 * The bot's browser tools, given only to a bot with the internet on. Opening sites, reading and
 * moving around run without a card; a step marked as sending something asks the user first.
 */
export function browserTools(opts: {
  def: Define;
  bot: Bot;
  /** Where the bot's files are: an upload takes them from its own folders only. */
  dataDir: string;
  threadId: string;
  t: T;
  browser: BrowserManager;
  vault: VaultService;
  /** Whom the bot works for: only the team's sign-ins and theirs are typed; null for the team's alone. */
  person: string | null;
  askLogin: AskLogin;
  /** The person's payment cards; without them the bot has no card step. */
  cards?: PaymentCardService;
  askCard?: AskCard;
  /** The person's contact details; without them the bot has no contact step. */
  contacts?: ContactDetailsService;
  askContact?: AskContact;
  /** Whether the person is in the conversation, having started this turn: a card is filled only then. */
  attended?: boolean;
  /** The turn is a routine of the person's own: their contact details go only to sites agreed to. */
  ownRoutine?: boolean;
  /** What the bot noted earlier about how a site works. */
  siteNotes?: (host: string) => Promise<string[]>;
  /** A page of `site` hides text written to steer an agent; the person is told. */
  onPlanted?: (site: string) => Promise<void>;
  /** Where the browser's traffic now leaves, if that changed since the bot last heard. */
  exitNote?: () => 'computer' | 'server' | null;
  /**
   * A sign-in code from mail the site sent to the bot's own address, waited for up to `waitMs`;
   * only when a person let the bot take codes from that mailbox.
   */
  mailCode?: {
    address: string;
    wait(
      site: string,
      waitMs: number,
    ): Promise<{ id: string; code: string; from: string } | { unclear: true } | null>;
    /** Marks the mail used once its code is in the field, so a refused step leaves it for a retry. */
    used(id: string): Promise<void>;
  };
  /** The turn's own: a step waiting for the person to hand the browser back stops with it. */
  signal?: AbortSignal;
}): AppTool[] {
  const { def, bot, dataDir, threadId, t, browser, vault, person, askLogin, signal } = opts;
  /** Runs on the bot's page; waits while a person has the browser, until the turn stops. */
  const use = <R>(fn: (page: Page, waited: boolean) => Promise<R>) => browser.use(bot.id, fn, signal);
  /**
   * The page's outline for the bot. It is always read whole, so the refs of every part stay valid
   * (the page keeps only the refs of its last read); `view` picks what of it the bot gets: one part
   * of a long page, the section under one ref, or the lines with some words.
   */
  const outline = async (
    page: Page,
    view: { part?: number; find?: string; ref?: string } = {},
  ): Promise<string> => {
    const [title, raw, typed, hidden] = await Promise.all([
      page.title().catch(() => ''),
      page.ariaSnapshot({ mode: 'ai', timeout: 10_000 }).catch(() => ''),
      passwordValues(page),
      page.evaluate<string[]>(HIDDEN_TEXT_SCRIPT).catch(() => [] as string[]),
    ]);
    // Text the page hides from people but speaks to an agent: the bot is told it is data and to say
    // it was there, and the person is told in the conversation, whatever the bot then writes.
    const planted = plantedIn(Array.isArray(hidden) ? hidden : []);
    const site = (() => {
      try {
        return new URL(page.url()).hostname;
      } catch {
        return page.url();
      }
    })();
    if (planted.length) await opts.onPlanted?.(site).catch(() => undefined);
    const tabs = browser.pages(bot.id)?.pages.length ?? 1;
    let base = raw;
    if (view.ref) {
      const section = outlineSection(raw, view.ref);
      if (section === null) throw new BrowserError('staleRef', view.ref);
      base = section;
    }
    let body: string;
    if (view.find) {
      const { text, found } = outlineFind(base, view.find);
      body = found
        ? `${t('browser.found', { text: view.find, count: String(found) })}\n${outlineParts(text)[0]}`
        : t('browser.notFound', { text: view.find });
    } else {
      const parts = outlineParts(base);
      const n = Math.min(view.part ?? 1, parts.length);
      body = [
        ...(parts.length > 1 ? [t('browser.part', { part: String(n), parts: String(parts.length) })] : []),
        parts[n - 1]!,
        ...(n < parts.length ? [t('browser.cut', { next: String(n + 1) })] : []),
      ].join('\n');
    }
    // The outline shows what is typed in fields, password fields too, and a form sent with get
    // carries them in the address and the title: hide every password, wherever it shows.
    return maskCardFields(
      [
        t('browser.address', { url: page.url() }),
        t('browser.title', { title: title || '-' }),
        ...(tabs > 1 ? [t('browser.tabCount', { count: tabs })] : []),
        ...(planted.length
          ? ['', t('browser.planted', { site, quotes: planted.map((q) => `"${q}"`).join('; ') })]
          : []),
        '',
        body || t('browser.emptyPage'),
      ].join('\n'),
      [...typed, ...browser.secrets(bot.id)],
    );
  };
  /**
   * `text` with the secrets taken out, and the short values the server filled into fields (a
   * card's security code) hidden where the outline shows them as a field's value.
   */
  const maskCardFields = (text: string, secrets: string[]) => {
    let out = maskSecrets(text, secrets);
    for (const v of browser.fieldSecrets(bot.id)) {
      // The outline quotes a field's value, or leaves it bare.
      const value = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(
        new RegExp(`^(\\s*- (?:textbox|spinbutton)\\b[^\\n]*?: )("?)${value}\\2$`, 'gm'),
        `$1$2${MASK}$2`,
      );
    }
    return out;
  };
  /** Whether a short card value shows in a field of the page, where a picture would carry it. */
  const cardShortShown = async (page: Page) => {
    const short = new Set(browser.fieldSecrets(bot.id));
    if (!short.size) return false;
    const values = await Promise.all(
      page
        .frames()
        .map((f) =>
          f
            .$$eval('input', (els) => els.map((e) => (e as unknown as { value: string }).value))
            .catch(() => [] as string[]),
        ),
    );
    return values.flat().some((v) => short.has(v.trim()));
  };
  /** A step's result with every vault secret taken out, whatever part of the page carried it. */
  const hide = (r: ToolResult): ToolResult => {
    const secrets = browser.secrets(bot.id);
    // Any payment card number goes too, however the page groups its digits.
    const mask = (text: string) => maskCardNumbers(secrets.length ? maskSecrets(text, secrets) : text, MASK);
    return typeof r === 'string' ? mask(r) : { ...r, text: mask(r.text) };
  };

  /**
   * Moves a downloaded file into the conversation's folder, under the name the site gave it, or
   * that name numbered when the folder already has one. Returns where it went.
   */
  const keepDownload = async (from: string, name: string): Promise<string> => {
    const dir = workspacePaths(dataDir, bot.id, threadId, bot.groupId).threadDir;
    await mkdir(dir, { recursive: true });
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let i = 1; ; i++) {
      const to = join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
      try {
        await copyFile(from, to, constants.COPYFILE_EXCL);
        await rm(from, { force: true });
        return to;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || i >= 100) throw err;
      }
    }
  };
  const sizeText = (bytes: number) =>
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  const downloadNote = async (d: PageDownload): Promise<string> => {
    if (d.path) {
      try {
        const path = await keepDownload(d.path, d.name);
        return t('browser.downloaded', { name: d.name, size: sizeText(d.size ?? 0), path });
      } catch {
        return t('browser.downloadFailed', { name: d.name });
      }
    }
    switch (d.error) {
      case 'tooBig':
        return t('browser.downloadTooBig', { name: d.name, max: String(MAX_DOWNLOAD_BYTES / 1024 / 1024) });
      case 'tooMany':
        return t('browser.downloadTooMany', { name: d.name });
      case 'slow':
        return t('browser.downloadSlow', { name: d.name });
      default:
        return t('browser.downloadFailed', { name: d.name });
    }
  };
  /** What happened around the step that the bot should hear of, as lines; empty when nothing did. */
  const notes = async (mark: number): Promise<string[]> => {
    // A file the step set off is waited for a little, outside the step: the browser stays free.
    const running = await browser.downloadsSettled(bot.id, DOWNLOAD_WAIT_MS, mark);
    const downloads = await Promise.all(browser.takeDownloads(bot.id).map(downloadNote));
    // What the page asked meanwhile (a confirm before deleting, an alert), and how it was answered.
    const asked = browser.takeDialogs(bot.id);
    // Addresses on this computer or a private network the page tried to reach, which were refused.
    const refused = browser.takeRefused(bot.id);
    // The connection the sites see changed: the person's computer came or went.
    const exit = opts.exitNote?.() ?? null;
    // Tabs the site closed itself while the bot was on them, and tabs it opened past the limit.
    const closed = browser.takeClosedTabs(bot.id);
    const extraTabs = browser.takeRefusedTabs(bot.id);
    // Sites that asked for a passkey, which this browser cannot give.
    const passkeys = browser.takePasskeys(bot.id);
    // Sites that asked for their own HTTP sign-in.
    const httpAuth = browser.takeHttpAuth(bot.id);
    // File pickers a step opened, which were closed unseen: files go up with browser_upload.
    const pickers = browser.takePickers(bot.id);
    // The person had the browser while the step waited, and may have changed the page.
    const back = browser.takeHandedBack(bot.id);
    return [
      ...(back ? [t('browser.handedBack')] : []),
      ...(exit ? [t(exit === 'computer' ? 'browser.exitComputer' : 'browser.exitServer')] : []),
      ...closed.map((url) => t('browser.tabClosedBySite', { url: url || '-' })),
      ...(extraTabs ? [t('browser.tabsRefused', { count: String(extraTabs), max: String(MAX_TABS) })] : []),
      ...asked.map((d) =>
        t(d.accepted ? 'browser.dialogAccepted' : 'browser.dialogDismissed', {
          type: d.type,
          message: d.message,
        }),
      ),
      ...(refused.length ? [t('browser.refusedHosts', { hosts: refused.slice(0, 5).join(', ') })] : []),
      ...passkeys.map((site) => t('browser.passkeyRefused', { site: site || '-' })),
      ...httpAuth.map((site) => t('browser.httpAuthAsked', { site })),
      ...(pickers ? [t('browser.filePicker')] : []),
      ...downloads,
      ...(running.length ? [t('browser.downloadRunning', { names: running.join(', ') })] : []),
    ];
  };

  /** Runs one step in the bot's browser; browser problems come back as text the bot can act on. */
  const step = async (fn: (page: Page, waited: boolean) => Promise<ToolResult>): Promise<ToolResult> => {
    let r: ToolResult;
    const mark = browser.downloadMark(bot.id);
    try {
      r = await use(fn);
    } catch (err) {
      r = browserErrorText(err, t);
    }
    const note = (await notes(mark)).join('\n');
    // The page's own questions may quote what was typed into it.
    if (!note) return hide(r);
    return hide(typeof r === 'string' ? `${note}\n\n${r}` : { ...r, text: `${note}\n\n${r.text}` });
  };
  /**
   * Runs an input on the page. With `brief`, a step that left the page where it was answers with a
   * short status instead of the whole page again: the refs of the last read stay valid, and the bot
   * reads the page when it needs to. A step that moved to another address or tab reads it at once.
   */
  const act = (fn: (page: Page) => Promise<void>, brief = false, hold = false) =>
    step(async (page, waited) => {
      // The person had the browser meanwhile: what the step was to click or type into was chosen
      // on the page before, so it is not done, and the bot gets the page as it is now.
      if (waited) return `${t('browser.stepNotDone')}\n\n${await outline(page)}`;
      const before = { url: page.url(), title: await page.title().catch(() => '') };
      const held = await holding(page, hold, async () => {
        await fn(page);
        await settle(page);
      });
      const out = await (async () => {
        // A link may have opened a new tab, which is now the active one.
        const now = browser.pages(bot.id)?.active ?? page;
        if (!brief || now !== page || now.url() !== before.url) return outline(now);
        const title = await now.title().catch(() => '');
        if (title !== before.title) return outline(now);
        const focused = await now
          .evaluate(FOCUSED)
          .then((v) => (typeof v === 'string' ? v : ''))
          .catch(() => '');
        return [
          t('browser.address', { url: now.url() }),
          t('browser.title', { title: title || '-' }),
          ...(focused ? [t('browser.focused', { element: focused })] : []),
          t('browser.unchanged'),
        ].join('\n');
      })();
      return held ? `${t('browser.sendHeld')}\n\n${out}` : out;
    });
  /**
   * Runs a step that was not approved as one that sends. A form the page sends meanwhile (the step
   * pressed its button, or the page's script sent it on a change) is cancelled before it reaches
   * the site. A cancelled page load shows no error page, so the page stays as it was, with what was
   * typed in it. Says whether one was.
   */
  const holding = async (page: Page, hold: boolean, run: () => Promise<void>): Promise<boolean> => {
    if (!hold) {
      await run();
      return false;
    }
    let held = false;
    const context = page.context();
    const stop = (route: Route) => {
      const r = route.request();
      if (r.isNavigationRequest() && r.method() !== 'GET') {
        held = true;
        return route.abort('aborted');
      }
      return route.fallback();
    };
    await context.route('**/*', stop);
    try {
      await run();
    } finally {
      await context.unroute('**/*', stop).catch(() => {});
    }
    return held;
  };
  /** Steps the server took as sending, by their input, with when; their run may send. */
  const allowed = new Map<string, number>();
  const callKey = (name: string, a: unknown) => `${name} ${JSON.stringify(a)}`;
  /** Whether this run of a step was let through as one that sends; each approval is used once. */
  const maySend = (name: string, a: { sends?: boolean }) => {
    const key = callKey(name, a);
    const when = allowed.get(key);
    allowed.delete(key);
    return a.sends === true || (when !== undefined && Date.now() - when < ALLOW_MS);
  };
  /**
   * Looks at the page before a step. With no browser open there is nothing to send; a page that
   * cannot be read is taken as one that may send.
   */
  const looks = async (fn: (page: Page) => Promise<boolean>): Promise<boolean> => {
    if (!browser.pages(bot.id)) return false;
    try {
      return await use(fn);
    } catch (err) {
      return !(err instanceof BrowserError);
    }
  };
  /**
   * Whether a step needs the person's approval: the bot says it sends, or the page shows it does,
   * whatever the bot said (a form posted, a "Send" button, Enter in a message box). What the bot
   * read may steer it, so its own word cannot be the only gate.
   */
  const gate =
    <A extends { sends?: boolean }>(name: string, seen: (page: Page, a: A) => Promise<boolean>) =>
    async (a: A): Promise<boolean> => {
      const sends = a.sends === true || (await looks((page) => seen(page, a)));
      if (sends) {
        const now = Date.now();
        for (const [k, when] of allowed) if (now - when >= ALLOW_MS) allowed.delete(k);
        allowed.set(callKey(name, a), now);
      }
      return sends;
    };
  const at = (page: Page, r: string) => page.locator(`aria-ref=${r}`);
  /**
   * The element a ref names, checked at once. A ref of an element the page has since removed (or of
   * a frame that is gone) finds nothing, and Playwright would wait its whole timeout for it before
   * failing with a bare "Timeout": the bot is told straight away to read the page again.
   */
  const fresh = async (page: Page, r: string) => {
    const target = at(page, r);
    if (!(await target.count().catch(() => 0))) throw new BrowserError('staleRef', r);
    return target;
  };
  const control = async (page: Page, r: string) =>
    (await fresh(page, r)).evaluate(controlInfo, undefined, { timeout: 2_000 });
  /** Whether Enter pressed in this field, or where the focus is, sends something. */
  const enterSendsAt = async (page: Page, r?: string) => {
    if (r) return enterSends(await control(page, r));
    const focus = await focusInfo(page);
    return focus === 'unknown' || enterSends(focus);
  };
  /** Whether an address may carry sign-in details: https, or plain http on this computer. */
  const secure = (u: URL) =>
    u.protocol === 'https:' || (u.protocol === 'http:' && browser.localHost(u.hostname));
  const parsed = (raw: string): URL | null => {
    try {
      return new URL(raw);
    } catch {
      return null;
    }
  };
  /**
   * The field a vault secret goes into: the kind of field asked for, in a frame of the saved site
   * itself over https (not another site's frame inside its page), and in a form that sends to that
   * site. Otherwise the reason it is not, for the bot.
   */
  const secretField = async (
    page: Page,
    r: string,
    kind: FieldKind,
    site: string,
  ): Promise<{ field: ElementHandle } | { refused: string }> => {
    return vetField(await (await fresh(page, r)).elementHandle({ timeout: 5_000 }), kind, site);
  };
  /** The checks of `secretField` on a field already found, for one found by what it is rather than by a ref. */
  const vetField = async (
    field: ElementHandle,
    kind: FieldKind,
    site: string,
  ): Promise<{ field: ElementHandle } | { refused: string }> => {
    const refuse = async (refused: string) => {
      await field.dispose().catch(() => {});
      return { refused };
    };
    const info = await field.evaluate(fieldInfo);
    if (
      info.tag !== 'input' ||
      (kind !== 'password' && info.search) ||
      !FIELD_TYPES[kind].includes(info.type)
    ) {
      return refuse(
        t(
          kind === 'password'
            ? 'browser.loginNotPassword'
            : kind === 'username'
              ? 'browser.loginNotUsername'
              : 'browser.codeNotField',
        ),
      );
    }
    // The frame's address, from the browser itself: a page cannot make its frame look like another.
    const frame: Frame | null = await field.ownerFrame();
    const where = parsed(frame?.url() ?? '');
    if (!where || !secure(where) || !siteMatches(where.hostname, site)) {
      return refuse(t('browser.loginFrame', { origin: where?.origin ?? '-', site }));
    }
    for (const action of info.actions) {
      const to = parsed(action);
      // A form a script sends never goes to its action.
      if (to?.protocol === 'javascript:') continue;
      if (!to || !secure(to) || !siteMatches(to.hostname, site)) {
        return refuse(t('browser.loginAction', { target: to?.origin ?? action.slice(0, 100), site }));
      }
    }
    return { field };
  };
  /**
   * Tells the bot why the vault has no login for this page, in words that give nothing of the
   * vault away: a count of the person's own logins kept for other bots, or the sites of the same
   * name under another ending that this bot may use, or that none is saved.
   */
  const noLoginNote = async (host: string, site: string): Promise<string> => {
    const why = await vault.whyNone(host, bot.id, person).catch(() => null);
    const lines = [
      ...(why?.notShared ? [t('browser.noLoginNotShared', { count: String(why.notShared) })] : []),
      ...(why?.otherSites.length
        ? [t('browser.noLoginOtherSite', { sites: why.otherSites.join(', '), site })]
        : []),
    ];
    return lines.length ? lines.join('\n') : t('browser.noLoginNone', { site });
  };
  /**
   * The password field a two-step sign-in shows only once the username is sent: the page holds it
   * hidden until then, so the outline had no ref for it. Waits a few seconds for exactly one
   * visible password field in the page itself, and checks it like any other. Null when none shows
   * (or there is more than one, and the bot must say which).
   */
  const laterPassword = async (
    page: Page,
    site: string,
  ): Promise<{ field: ElementHandle } | { refused: string } | null> => {
    const visible = page.locator('input[type="password"]:visible');
    try {
      await visible.first().waitFor({ state: 'visible', timeout: PASSWORD_WAIT_MS });
      // The submit may have led to another site (a single sign-on page): nothing is typed there.
      const now = new URL(page.url());
      if (!siteMatches(now.hostname, site)) {
        return { refused: t('browser.loginMoved', { host: now.hostname, site }) };
      }
      if (!secure(now)) return { refused: t('browser.loginInsecure') };
      if ((await visible.count()) !== 1) return null;
      return await vetField(await visible.elementHandle({ timeout: 2_000 }), 'password', site);
    } catch {
      return null;
    }
  };
  /**
   * The field a part of a card goes into: an input (or, for the month and year, a list) that says
   * it is that part, in an https frame of the page. A payment provider's fields live in frames of
   * its own site inside the shop's page, so the frame may be another site's; the shop's site is the
   * one the person agreed to.
   */
  const cardField = async (
    page: Page,
    r: string,
    part: CardPart,
  ): Promise<
    { field: ElementHandle; info: ReturnType<typeof cardFieldInfo>; frameSite: string } | { refused: string }
  > => {
    const field = await (await fresh(page, r)).elementHandle({ timeout: 5_000 });
    const refuse = async (refused: string) => {
      await field.dispose().catch(() => {});
      return { refused };
    };
    const info = await field.evaluate(cardFieldInfo);
    const kind = CARD_PARTS[part];
    const tagOk =
      (info.tag === 'input' && ['text', 'tel', 'number', 'password', ''].includes(info.type)) ||
      (info.tag === 'select' && kind.select);
    const named = kind.autocomplete.test(info.autocomplete) || kind.words.test(info.words);
    if (!tagOk || info.search || !named)
      return refuse(t('browser.cardNotField', { part: t(`browser.cardPart.${part}`) }));
    const frame: Frame | null = await field.ownerFrame();
    const where = parsed(frame?.url() ?? '');
    if (!where || !secure(where)) return refuse(t('browser.cardFrame', { origin: where?.origin ?? '-' }));
    const to = info.action ? parsed(info.action) : null;
    if (info.action && to?.protocol !== 'javascript:' && (!to || !secure(to))) {
      return refuse(t('browser.cardFrame', { origin: to?.origin ?? info.action.slice(0, 100) }));
    }
    return { field, info, frameSite: registrableSite(where.hostname) };
  };
  /** A card as the bot and the person see it: its name, network and last four digits. */
  const cardName = (c: OpenCard) =>
    `${c.label ? `${c.label} · ` : ''}${t(`browser.cardBrand.${c.brand}`)} •••• ${c.last4}`;
  const fillCard = async (
    a: {
      number_ref: string;
      expiry_ref?: string;
      month_ref?: string;
      year_ref?: string;
      cvc_ref?: string;
      name_ref?: string;
      card?: string;
    },
    cards: PaymentCardService,
    askCard: AskCard,
  ): Promise<ToolResult> => {
    // Only for the person who owns the card, while they are there: never in a routine, for another
    // bot, or in a team conversation.
    if (!person) return t('browser.cardTeam');
    if (!opts.attended) return t('browser.cardUnattended');
    let host: string;
    try {
      const url = await use(async (page) => new URL(page.url()));
      if (!secure(url)) return t('browser.cardInsecure');
      host = url.hostname;
    } catch (err) {
      return browserErrorText(err, t);
    }
    const site = registrableSite(host);
    const all = await cards.forBot(bot.id, person);
    if (!all.length) return t('browser.cardNone');
    const wanted = a.card?.trim().toLowerCase();
    const matching = wanted ? all.filter((c) => c.last4 === wanted || c.label.toLowerCase() === wanted) : all;
    if (matching.length !== 1) {
      return t('browser.cardChoose', { cards: all.map(cardName).join(', ') });
    }
    const c = matching[0]!;
    const now = new Date();
    if (
      c.expYear < now.getFullYear() ||
      (c.expYear === now.getFullYear() && c.expMonth < now.getMonth() + 1)
    ) {
      return t('browser.cardExpired', { card: cardName(c) });
    }
    const mm = String(c.expMonth).padStart(2, '0');
    const yyyy = String(c.expYear);
    const yy = yyyy.slice(-2);
    const parts: [CardPart, string | undefined, string | null][] = [
      ['number', a.number_ref, c.number],
      ['expiry', a.expiry_ref, null],
      ['month', a.month_ref, mm],
      ['year', a.year_ref, null],
      ['cvc', a.cvc_ref, c.cvc],
      ['name', a.name_ref, c.holder],
    ];
    type Found = {
      part: CardPart;
      field: ElementHandle;
      info: ReturnType<typeof cardFieldInfo>;
      frameSite: string;
      value: string | null;
    };
    const keyOf = (fields: Found[]) =>
      cardApproval(site, [...new Set(fields.map((f) => f.frameSite).filter((x) => x !== site))]);
    /** The fields named, each checked to be the part it is given for; or why one is not. */
    const find = async (page: Page, fields: Found[]): Promise<string | null> => {
      // The page may have moved while the person answered: only fill on the site they agreed to.
      const here = new URL(page.url());
      if (!secure(here) || !siteMatches(here.hostname, site)) {
        return t('browser.loginMoved', { host: here.hostname, site });
      }
      for (const [part, r, value] of parts) {
        if (!r) continue;
        if ((part === 'cvc' || part === 'name') && !value) return t(`browser.cardMissing.${part}`);
        const f = await cardField(page, r, part);
        if ('refused' in f) return f.refused;
        fields.push({ part, field: f.field, info: f.info, frameSite: f.frameSite, value });
      }
      return null;
    };
    // The fields are checked before the person is asked, so a wrong one costs them no question.
    let checked: { wrong: string } | { key: string; frames: string[] };
    try {
      checked = await use(async (page) => {
        const fields: Found[] = [];
        try {
          const wrong = await find(page, fields);
          if (wrong) return { wrong };
          const frames = [...new Set(fields.map((f) => f.frameSite).filter((x) => x !== site))];
          return { key: keyOf(fields), frames };
        } finally {
          for (const f of fields) await f.field.dispose().catch(() => {});
        }
      });
    } catch (err) {
      return browserErrorText(err, t);
    }
    if ('wrong' in checked) return checked.wrong;
    const { key } = checked;
    if (!c.sites.includes(key)) {
      const answer = await askCard({ card: cardName(c), site, frames: checked.frames, team: c.team });
      if (typeof answer !== 'string') return answer.message;
      if (answer === 'always') await cards.allowSite(c.id, key);
    }
    return step(async (page) => {
      const fields: Found[] = [];
      try {
        const refused = await find(page, fields);
        if (refused) return refused;
        // Fields that moved to another site's frame while the person answered were not agreed to.
        if (keyOf(fields) !== key) return t('browser.cardFramesChanged', { site });
        // Kept out of what the bot reads of the page, however the page shows them.
        const groups = c.number.length === 15 ? [4, 6, 5] : [4, 4, 4, 4, 4];
        for (const sep of [' ', '-']) {
          let at = 0;
          const parts: string[] = [];
          for (const g of groups) {
            if (at >= c.number.length) break;
            parts.push(c.number.slice(at, at + g));
            at += g;
          }
          browser.rememberSecret(bot.id, parts.join(sep));
        }
        browser.rememberSecret(bot.id, c.number);
        if (c.cvc) browser.rememberFieldSecret(bot.id, c.cvc);
        for (const f of fields) {
          const { info } = f;
          const value =
            f.part === 'expiry'
              ? `${mm}/${/yyyy/.test(info.placeholder) ? yyyy : yy}`
              : f.part === 'year'
                ? info.maxLength === 2 || /\byy\b/.test(info.placeholder)
                  ? yy
                  : yyyy
                : f.value!;
          if (info.tag === 'select') {
            // The option is found first: asked for one the list does not have, Playwright would
            // wait its whole timeout for it to appear. "3", "03" and "March 03" all name month 3;
            // "2034" and "34" both name the year.
            const options = await f.field.evaluate((el) =>
              Array.from(
                (el as unknown as { options: ArrayLike<{ value: string; text: string }> }).options,
                (o) => ({
                  value: o.value,
                  text: o.text,
                }),
              ),
            );
            const wanted = f.part === 'month' ? [c.expMonth] : [c.expYear, c.expYear % 100];
            const names = (o: { value: string; text: string }) =>
              [o.value, o.text].flatMap((x) => x.match(/\d+/g) ?? []).map(Number);
            const hit = options.find((o) => names(o).some((n) => wanted.includes(n)));
            if (!hit) return t('browser.cardNotField', { part: t(`browser.cardPart.${f.part}`) });
            await f.field.selectOption({ value: hit.value });
          } else await f.field.fill(value);
        }
      } finally {
        for (const f of fields) await f.field.dispose().catch(() => {});
      }
      void cards.used(c.id).catch(() => {});
      await settle(page);
      const out = await outline(browser.pages(bot.id)?.active ?? page);
      return `${t('browser.cardFilled', { card: cardName(c), site })}\n\n${out}`;
    });
  };
  /** Contact details as the bot and the person see them: their name, or the person's name. */
  const contactName = (c: OpenContact) =>
    c.label || [c.givenName, c.familyName].filter(Boolean).join(' ') || t('browser.contactUnnamed');
  const contactValue = (c: OpenContact, f: ContactField): string => {
    switch (f) {
      case 'name':
        return [c.givenName, c.familyName].filter(Boolean).join(' ');
      case 'given_name':
        return c.givenName;
      case 'family_name':
        return c.familyName;
      case 'address':
        return [c.address1, c.address2].filter(Boolean).join(', ');
      case 'postal_code':
        return c.postalCode;
      default:
        return c[f];
    }
  };
  /**
   * The field a part of the details goes into: a text field (a list for a city, province or
   * country; a text box for the street) in an https frame of the page, not a password, a card's or
   * a code's, and not one the page names as another part.
   */
  const contactField = async (
    page: Page,
    r: string,
    part: ContactField,
  ): Promise<
    { field: ElementHandle; info: ReturnType<typeof cardFieldInfo>; frameSite: string } | { refused: string }
  > => {
    const field = await (await fresh(page, r)).elementHandle({ timeout: 5_000 });
    const refuse = async (refused: string) => {
      await field.dispose().catch(() => {});
      return { refused };
    };
    const info = await field.evaluate(cardFieldInfo);
    const what = t(`browser.contactPart.${part}`);
    const tagOk =
      (info.tag === 'input' && ['text', 'email', 'tel', 'number', ''].includes(info.type)) ||
      (info.tag === 'textarea' && (part === 'address' || part === 'address1')) ||
      (info.tag === 'select' && CONTACT_SELECT.has(part));
    // An autofill name the page gave the field that is not this part's: a card's, a password's,
    // a code's or another part of the address. A field with none or with "on" is the bot's call.
    const named = info.autocomplete
      .split(/\s+/)
      .filter((w) => w && !/^(section-.*|shipping|billing|home|work|mobile|on|off)$/.test(w));
    const other = named.length > 0 && !named.some((w) => CONTACT_AUTOCOMPLETE[part].includes(w));
    if (!tagOk || info.search || other) return refuse(t('browser.contactNotField', { part: what }));
    const frame: Frame | null = await field.ownerFrame();
    const where = parsed(frame?.url() ?? '');
    if (!where || !secure(where)) return refuse(t('browser.cardFrame', { origin: where?.origin ?? '-' }));
    const to = info.action ? parsed(info.action) : null;
    if (info.action && to?.protocol !== 'javascript:' && (!to || !secure(to))) {
      return refuse(t('browser.cardFrame', { origin: to?.origin ?? info.action.slice(0, 100) }));
    }
    return { field, info, frameSite: registrableSite(where.hostname) };
  };
  const fillContact = async (
    a: { fields: { ref: string; part: ContactField }[]; contact?: string },
    contacts: ContactDetailsService,
    askContact: AskContact,
  ): Promise<ToolResult> => {
    // A person's own details, or the team's while working for someone in it; never for a team
    // conversation or someone with no account here.
    if (!person) return t('browser.contactTeam');
    // Only the person's own work: a turn they started, or a routine of theirs. A message from a chat
    // app's unknown sender or another bot's request would read the details back from the page.
    if (!opts.attended && !opts.ownRoutine) return t('browser.contactNotOwn');
    let host: string;
    try {
      const url = await use(async (page) => new URL(page.url()));
      if (!secure(url)) return t('browser.contactInsecure');
      host = url.hostname;
    } catch (err) {
      return browserErrorText(err, t);
    }
    const site = registrableSite(host);
    const all = await contacts.forBot(bot.id, person);
    if (!all.length) return t('browser.contactNone');
    const wanted = a.contact?.trim().toLocaleLowerCase();
    const matching = wanted ? all.filter((c) => contactName(c).toLocaleLowerCase() === wanted) : all;
    if (matching.length !== 1) {
      return t('browser.contactChoose', { contacts: all.map(contactName).join(', ') });
    }
    const c = matching[0]!;
    // Parts with nothing saved are left for the person rather than failing the rest.
    const given = a.fields.filter((f) => contactValue(c, f.part));
    const missing = [...new Set(a.fields.filter((f) => !contactValue(c, f.part)).map((f) => f.part))];
    const missingNote = missing.length
      ? `\n${t('browser.contactMissing', { parts: missing.map((p) => t(`browser.contactPart.${p}`)).join(', ') })}`
      : '';
    if (!given.length)
      return t('browser.contactMissing', {
        parts: missing.map((p) => t(`browser.contactPart.${p}`)).join(', '),
      });
    type Found = {
      part: ContactField;
      field: ElementHandle;
      info: ReturnType<typeof cardFieldInfo>;
      frameSite: string;
    };
    const keyOf = (fields: Found[]) =>
      cardApproval(site, [...new Set(fields.map((f) => f.frameSite).filter((x) => x !== site))]);
    const find = async (page: Page, fields: Found[]): Promise<string | null> => {
      // The page may have moved while the person answered: only fill on the site they agreed to.
      const here = new URL(page.url());
      if (!secure(here) || !siteMatches(here.hostname, site)) {
        return t('browser.loginMoved', { host: here.hostname, site });
      }
      for (const { ref: r, part } of given) {
        const f = await contactField(page, r, part);
        if ('refused' in f) return f.refused;
        fields.push({ part, field: f.field, info: f.info, frameSite: f.frameSite });
      }
      return null;
    };
    // The fields are checked before the person is asked, so a wrong one costs them no question.
    let checked: { wrong: string } | { key: string; frames: string[] };
    try {
      checked = await use(async (page) => {
        const fields: Found[] = [];
        try {
          const wrong = await find(page, fields);
          if (wrong) return { wrong };
          const frames = [...new Set(fields.map((f) => f.frameSite).filter((x) => x !== site))];
          return { key: keyOf(fields), frames };
        } finally {
          for (const f of fields) await f.field.dispose().catch(() => {});
        }
      });
    } catch (err) {
      return browserErrorText(err, t);
    }
    if ('wrong' in checked) return checked.wrong;
    const { key } = checked;
    if (!c.sites.includes(key)) {
      // A site not agreed to before needs the person there to agree: not a routine's turn.
      if (!opts.attended) return t('browser.contactUnattended', { site });
      const parts = [...new Set(given.map((f) => t(`browser.contactPart.${f.part}`)))];
      const answer = await askContact({
        contact: contactName(c),
        site,
        frames: checked.frames,
        parts,
        team: c.team,
      });
      if (typeof answer !== 'string') return answer.message;
      if (answer === 'always') await contacts.allowSite(c.id, key);
    }
    return step(async (page) => {
      const fields: Found[] = [];
      try {
        const refused = await find(page, fields);
        if (refused) return refused;
        if (keyOf(fields) !== key) return t('browser.cardFramesChanged', { site });
        for (const f of fields) {
          const value = contactValue(c, f.part);
          if (f.info.tag === 'select') {
            // The option whose value or text is the saved one, ignoring case and Turkish dots.
            const fold = (v: string) =>
              v.toLocaleLowerCase('tr').normalize('NFKD').replace(/\p{M}/gu, '').trim();
            const options = await f.field.evaluate((el) =>
              Array.from(
                (el as unknown as { options: ArrayLike<{ value: string; text: string }> }).options,
                (o) => ({ value: o.value, text: o.text }),
              ),
            );
            const want = fold(value);
            const hit =
              options.find((o) => fold(o.text) === want || fold(o.value) === want) ??
              options.find((o) => o.value && fold(o.text).startsWith(want));
            if (!hit)
              return t('browser.contactNoOption', { part: t(`browser.contactPart.${f.part}`), value });
            await f.field.selectOption({ value: hit.value });
          } else await f.field.fill(value);
        }
      } finally {
        for (const f of fields) await f.field.dispose().catch(() => {});
      }
      void contacts.used(c.id).catch(() => {});
      await settle(page);
      const out = await outline(browser.pages(bot.id)?.active ?? page);
      return `${t('browser.contactFilled', { contact: contactName(c), site })}${missingNote}\n\n${out}`;
    });
  };
  /** What the bot is told when the page is still a bot check or a refusal after the wait. */
  const wallNote = (out: ToolResult, wall: WallState): ToolResult => {
    if (wall === 'clear') return out;
    const note = t(wall === 'blocked' ? 'browser.wallBlocked' : 'browser.wallCheck');
    return typeof out === 'string' ? `${note}\n\n${out}` : { ...out, text: `${note}\n\n${out.text}` };
  };
  const logTab = z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('tab number from browser_tabs; leave out for the active tab');
  const forget = z.boolean().default(false).describe('forget what was recorded so far, after reading it');
  /**
   * Reads one tab's record of requests or console messages. Never starts a browser: with none open
   * there is nothing recorded.
   */
  const readLog = (tab: number | undefined, read: (page: Page, log: PageLog) => string) => {
    if (!browser.pages(bot.id)) return Promise.resolve<ToolResult>(t('browser.noTabs'));
    return step(async (active) => {
      const page = tab ? browser.pages(bot.id)?.pages[tab - 1] : active;
      const log = page ? browser.log(bot.id, page) : null;
      if (!page || !log) return t('browser.noSuchTab');
      return `${t('browser.logTab', { url: safeUrl(page.url()) })}\n${read(page, log)}`;
    });
  };
  /** The lines of a log reply after its entries: what was left out, and whether it was forgotten. */
  const logNotes = (older: number, dropped: number, cleared: boolean) =>
    [
      ...(older > 0 ? [t('browser.logOlder', { count: older })] : []),
      ...(dropped > 0 ? [t('browser.logDropped', { count: dropped })] : []),
      ...(cleared ? [t('browser.logCleared')] : []),
    ]
      .map((line) => `\n${line}`)
      .join('');

  /**
   * Opens an address in a tab. An address that is a file starts a download instead of a page
   * (Playwright then fails the load): the page stays as it was and the download is reported.
   * Null when it was a download.
   */
  const goto = async (page: Page, url: string) => {
    try {
      return await page.goto(webUrl(url).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      if (/Download is starting/i.test((err as Error).message)) return null;
      throw err;
    }
  };

  return [
    def(
      'browser_open',
      { url: z.string().min(1).max(2000) },
      async ({ url }) => {
        let wall: WallState = 'clear';
        const opened = await act(async (page) => {
          const res = await goto(page, url);
          // A "Just a moment..." page clears by itself: wait it out here, so the bot sees the site.
          if (res !== null) wall = await waitOutWall(page, res?.status() ?? null);
        });
        const out = wallNote(opened, wall);
        // The bot's notes on this site come before the page, so it works the way that worked before.
        const host = (() => {
          try {
            return webUrl(url).hostname;
          } catch {
            return null;
          }
        })();
        const notes = host && opts.siteNotes ? await opts.siteNotes(host).catch(() => []) : [];
        if (!notes.length) return out;
        const head = `${t('browser.siteNotes', { site: host! })}\n${notes.map((n) => `- ${n}`).join('\n')}`;
        return typeof out === 'string' ? `${head}\n\n${out}` : { ...out, text: `${head}\n\n${out.text}` };
      },
      'internal',
    ),
    def(
      'browser_snapshot',
      {
        part: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('which part of a long page, from 1; the outline says when there is more'),
        find: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('words to look for: only the lines with them come back, with what they sit under'),
        ref: ref.optional().describe('ref of one section (a list, a table, a dialog) to read alone'),
      },
      async ({ part, find, ref: r }) => step((page) => outline(page, { part, find, ref: r })),
      'internal',
    ),
    def(
      'browser_click',
      { ref, element, sends, double: z.boolean().default(false) },
      async (a) => {
        const { ref: r, double } = a;
        const hold = !maySend('browser_click', a);
        return act(
          async (page) => {
            const target = await fresh(page, r);
            try {
              // A dry run first: a decorative layer over the element (a banner's shadow, an empty
              // overlay) makes a real click wait out its whole timeout and fail.
              await target.click({ trial: true, timeout: 3_000 });
            } catch (err) {
              if (/intercepts pointer events/i.test((err as Error).message)) {
                // Something a person would see lies over it (a dialog, a banner): they would not
                // reach the element either, so the bot is told what is in the way.
                const cover = await target.evaluate(coverInfo).catch(() => null);
                if (cover) throw new BrowserError('covered', cover);
                await target.evaluate(
                  (el, n) => {
                    for (let i = 0; i < n; i++) (el as { click(): void }).click();
                  },
                  double ? 2 : 1,
                );
                return;
              }
            }
            await target.click({ clickCount: double ? 2 : 1 });
          },
          false,
          hold,
        );
      },
      'internal',
      gate('browser_click', async (page, a) => clickSends(await control(page, a.ref))),
    ),
    // Saying yes to a page's confirm (delete, submit, leave) goes ahead like a click that sends, so
    // the person approves it.
    def(
      'browser_dialog',
      {
        accept: z.boolean(),
        text: z.string().max(1000).optional(),
        question: z.string().max(500).optional().describe('What the page asked, as the step result said'),
      },
      async ({ accept, text }) => {
        browser.answerNextDialog(bot.id, { accept, ...(text !== undefined && { text }) });
        return t(accept ? 'browser.dialogWillAccept' : 'browser.dialogWillDismiss');
      },
      'internal',
      async (a) => a.accept === true,
    ),
    // Menus, tooltips and row actions that only show under the pointer.
    def(
      'browser_hover',
      { ref, element },
      async ({ ref: r }) =>
        act(async (page) => (await fresh(page, r)).hover({ timeout: 5_000 }), false, true),
      'internal',
    ),
    def(
      'browser_type',
      {
        ref: ref.optional().describe('ref of the field; leave out to type where the page has focus'),
        element: element.optional(),
        text: z.string().max(10_000),
        submit: z.boolean().default(false),
        sends,
      },
      async (a) => {
        const { ref: r, text, submit } = a;
        const hold = !maySend('browser_type', a);
        return act(
          async (page) => {
            if (r) {
              const target = await fresh(page, r);
              try {
                await target.fill(text, { timeout: 5_000 });
              } catch {
                // Not a plain field (a canvas or script-drawn editor): click into it and type.
                await target.click({ timeout: 5_000 });
                await page.keyboard.type(text);
              }
            } else {
              await page.keyboard.type(text);
            }
            if (submit) await page.keyboard.press('Enter');
          },
          !submit,
          hold,
        );
      },
      'internal',
      // Typing alone sends nothing; Enter (asked for, or a line break typed as keys) may.
      gate('browser_type', async (page, a) =>
        a.submit || /[\r\n]/.test(a.text) ? enterSendsAt(page, a.ref) : false,
      ),
    ),
    def(
      'browser_fill',
      {
        fields: z
          .array(z.object({ ref, element: element.optional(), text: z.string().max(10_000) }))
          .min(1)
          .max(16),
      },
      async ({ fields }) => {
        const skipped: string[] = [];
        const out = await act(
          async (page) => {
            for (const f of fields) {
              const field = await fresh(page, f.ref);
              // Secrets are typed by the server from the vault, or by the person; never filled here.
              const secret = await field
                .evaluate((el) => {
                  const input = el as { type?: string; autocomplete?: string };
                  return (
                    input.type === 'password' ||
                    /one-time-code|cc-(number|csc|exp)/.test(input.autocomplete ?? '')
                  );
                })
                .catch(() => false);
              if (secret) {
                skipped.push(f.element ?? f.ref);
                continue;
              }
              await field.fill(f.text, { timeout: 5_000 });
            }
            // Filling sends nothing; a page that sends its form on a change waits for a step that does.
          },
          true,
          true,
        );
        if (!skipped.length) return out;
        const note = t('browser.fillSkipped', { fields: skipped.join(', ') });
        return typeof out === 'string' ? `${note}\n\n${out}` : { ...out, text: `${note}\n\n${out.text}` };
      },
      'internal',
    ),
    def(
      'browser_upload',
      {
        ref: ref.describe('ref of the file field, or of the button that opens the file picker'),
        element,
        paths: z
          .array(z.string().min(1).max(1000))
          .min(1)
          .max(10)
          .describe('Files from your folders, relative to the working folder or absolute'),
      },
      async ({ ref: r, paths }) => {
        let files;
        try {
          files = paths.map((p) => botFile(dataDir, bot, threadId, p, t));
        } catch (err) {
          return (err as Error).message;
        }
        if (files.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) {
          return t('browser.uploadTooBig', { max: String(MAX_UPLOAD_BYTES / 1024 / 1024) });
        }
        // Sent as bytes rather than paths: the browser may run on the bot's desktop, which cannot
        // see this server's folders.
        const payload = await Promise.all(
          files.map(async (f) => ({
            name: basename(f.full),
            mimeType: UPLOAD_TYPES[extname(f.full).toLowerCase()] ?? 'application/octet-stream',
            buffer: await readFile(f.full),
          })),
        );
        return act(async (page) => {
          const target = await fresh(page, r);
          const isField = await target
            .evaluate((e) => {
              const el = e as unknown as { tagName: string; type?: string };
              return el.tagName === 'INPUT' && el.type === 'file';
            })
            .catch(() => false);
          if (isField) return target.setInputFiles(payload);
          // Most sites hide the field behind a button that opens the file picker.
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10_000 }),
            target.click(),
          ]);
          await chooser.setFiles(payload);
          // This picker got its files: not one the bot should hear was closed.
          browser.takePickers(bot.id);
        });
      },
      'internal',
      // The files leave for the site: a card, as for any step that sends something.
      async () => true,
    ),
    def(
      'browser_login',
      {
        username_ref: ref.optional(),
        password_ref: ref.optional(),
        account: z.string().max(500).optional().describe('Which saved username, when there are several'),
        submit: z.boolean().default(true),
      },
      async ({ username_ref, password_ref, account, submit }) => {
        let host: string;
        let origin: string;
        try {
          const url = await use(async (page) => {
            // With no field, a tab held on a site's HTTP sign-in prompt counts as on that site.
            const at =
              (!username_ref && !password_ref && browser.httpAuthWaiting(bot.id, page)) || page.url();
            const url = new URL(at);
            if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BrowserError('badUrl', at);
            return url;
          });
          // No field: only a site that asked for its own HTTP sign-in is answered that way.
          if (!username_ref && !password_ref && !browser.askedHttpAuth(bot.id, url.origin)) {
            return t('browser.loginNoField');
          }
          // Over plain http anyone on the way reads the password: it is not typed, nor asked for.
          if (!secure(url)) return t('browser.loginInsecure');
          host = url.hostname;
          origin = url.origin;
        } catch (err) {
          return browserErrorText(err, t);
        }
        const saved = await vault.forHost(host, bot.id, person);
        let cred: { id: string | null; site: string; username: string; password: string } | undefined;
        if (account) {
          cred = saved.find((c) => c.username === account);
          if (!cred && saved.length) {
            return t('browser.loginChoose', { accounts: saved.map((c) => c.username).join(', ') });
          }
        } else if (saved.length > 1) {
          return t('browser.loginChoose', { accounts: saved.map((c) => c.username).join(', ') });
        } else cred = saved[0];
        // Why the vault had nothing for this page, for the bot; the card is offered all the same.
        let why = '';
        if (!cred) {
          const site = registrableSite(host);
          why = await noLoginNote(host, site);
          const r = await askLogin(site, siteOf(host));
          if (!r.ok) return `${why}\n${r.message}`;
          cred = { id: r.login.savedId, site, username: r.login.username, password: r.login.password };
        }
        const c = cred;
        if (!username_ref && !password_ref) {
          const signed = await step(async (page) => {
            const now = new URL(browser.httpAuthWaiting(bot.id, page) ?? page.url());
            if (now.origin !== origin) return t('browser.loginMoved', { host: now.hostname, site: c.site });
            await browser.signInHttp(bot.id, page, origin, c.username, c.password);
            if (c.id) void vault.used(c.id).catch(() => {});
            await settle(page);
            const out = await outline(browser.pages(bot.id)?.active ?? page);
            return `${t('browser.loggedIn', { site: c.site, username: c.username || '-' })}\n\n${out}`;
          });
          if (!why) return signed;
          return typeof signed === 'string'
            ? `${why}\n\n${signed}`
            : { ...signed, text: `${why}\n\n${signed.text}` };
        }
        let waiting = false;
        const result = await step(async (page) => {
          // The page may have moved while the user filled in the card: only type on the right site.
          const now = new URL(page.url());
          if (!siteMatches(now.hostname, c.site)) {
            return t('browser.loginMoved', { host: now.hostname, site: c.site });
          }
          if (!secure(now)) return t('browser.loginInsecure');
          // Each value goes only into a field of its own kind, on the saved site itself: a ref may
          // name a search box, a comment field, or a frame of another site inside the page.
          const fields: ElementHandle[] = [];
          try {
            let user: ElementHandle | null = null;
            let pass: ElementHandle | null = null;
            if (username_ref && c.username) {
              const f = await secretField(page, username_ref, 'username', c.site);
              if ('refused' in f) return f.refused;
              fields.push((user = f.field));
            }
            if (password_ref) {
              const f = await secretField(page, password_ref, 'password', c.site);
              if ('refused' in f) return f.refused;
              fields.push((pass = f.field));
            }
            browser.rememberSecret(bot.id, c.password);
            if (user) await user.fill(c.username);
            if (pass) await pass.fill(c.password);
            // A page that already shows a password field is not the two-step kind below.
            const hadPassword = await page
              .locator('input[type="password"]:visible')
              .count()
              .then((n) => n > 0)
              .catch(() => false);
            const last = pass ?? user;
            if (submit) await (last ? last.press('Enter') : at(page, username_ref!).press('Enter'));
            if (submit && user && !pass && !hadPassword) {
              const later = await laterPassword(page, c.site);
              if (later && 'refused' in later) return later.refused;
              if (later) {
                fields.push((pass = later.field));
                await pass.fill(c.password);
                await pass.press('Enter');
              } else waiting = true;
            }
          } finally {
            for (const f of fields) await f.dispose().catch(() => {});
          }
          if (c.id) void vault.used(c.id).catch(() => {});
          await settle(page);
          const out = await outline(browser.pages(bot.id)?.active ?? page);
          const said = waiting
            ? t('browser.loginPasswordPending', { site: c.site, username: c.username || '-' })
            : t('browser.loggedIn', { site: c.site, username: c.username || '-' });
          return `${said}\n\n${out}`;
        });
        if (!why) return result;
        return typeof result === 'string'
          ? `${why}\n\n${result}`
          : { ...result, text: `${why}\n\n${result.text}` };
      },
      'internal',
    ),
    def(
      'browser_code',
      {
        ref: ref.describe('ref of the field that asks for the code'),
        account: z.string().max(500).optional().describe('Which saved username, when there are several'),
        submit: z.boolean().default(true),
      },
      async ({ ref: r, account, submit }) => {
        let host: string;
        try {
          const url = await use(async (page) => new URL(page.url()));
          if (!secure(url)) return t('browser.loginInsecure');
          host = url.hostname;
        } catch (err) {
          return browserErrorText(err, t);
        }
        const withCode = (await vault.forHost(host, bot.id, person)).filter(
          (c) => c.totp && (!account || c.username === account),
        );
        if (!withCode.length) return t('browser.codeNone', { site: siteOf(host) });
        if (withCode.length > 1) {
          return t('browser.loginChoose', { accounts: withCode.map((c) => c.username).join(', ') });
        }
        const c = withCode[0]!;
        // Made on the server and typed into the page; the bot never sees it.
        const code = totp(c.totp!);
        return step(async (page) => {
          const now = new URL(page.url());
          if (!siteMatches(now.hostname, c.site)) {
            return t('browser.loginMoved', { host: now.hostname, site: c.site });
          }
          if (!secure(now)) return t('browser.loginInsecure');
          const f = await secretField(page, r, 'code', c.site);
          if ('refused' in f) return f.refused;
          try {
            browser.rememberSecret(bot.id, code, CODE_HIDDEN_MS);
            await f.field.fill(code);
            if (submit) await f.field.press('Enter');
          } finally {
            await f.field.dispose().catch(() => {});
          }
          void vault.used(c.id).catch(() => {});
          await settle(page);
          const out = await outline(browser.pages(bot.id)?.active ?? page);
          return `${t('browser.codeTyped', { site: c.site })}\n\n${out}`;
        });
      },
      'internal',
    ),
    ...(opts.mailCode
      ? [
          def(
            'browser_email_code',
            {
              ref: ref.describe('ref of the field that asks for the code'),
              wait_seconds: z.number().int().min(0).max(120).default(60),
              submit: z.boolean().default(true),
            },
            async ({ ref: r, wait_seconds, submit }) => {
              const mail = opts.mailCode!;
              let site: string;
              try {
                const url = await use(async (page) => new URL(page.url()));
                if (!secure(url)) return t('browser.loginInsecure');
                site = registrableSite(url.hostname);
              } catch (err) {
                return browserErrorText(err, t);
              }
              // Waited for outside the browser's queue, so the bot's other browser calls go on.
              const found = await mail.wait(site, wait_seconds * 1000);
              if (!found) return t('browser.emailCodeNone', { site, address: mail.address });
              if ('unclear' in found) return t('browser.emailCodeUnclear', { site });
              return step(async (page) => {
                const now = new URL(page.url());
                // The page moved on while the mail was awaited: the code is for the site it came from.
                if (!siteMatches(now.hostname, site)) {
                  return t('browser.loginMoved', { host: now.hostname, site });
                }
                if (!secure(now)) return t('browser.loginInsecure');
                const f = await secretField(page, r, 'code', site);
                if ('refused' in f) return f.refused;
                try {
                  browser.rememberSecret(bot.id, found.code, CODE_HIDDEN_MS);
                  await f.field.fill(found.code);
                  await mail.used(found.id);
                  if (submit) await f.field.press('Enter');
                } finally {
                  await f.field.dispose().catch(() => {});
                }
                await settle(page);
                const out = await outline(browser.pages(bot.id)?.active ?? page);
                return `${t('browser.emailCodeTyped', { site, from: found.from })}\n\n${out}`;
              });
            },
            'internal',
          ),
        ]
      : []),
    ...(opts.cards && opts.askCard
      ? [
          def(
            'browser_card',
            {
              number_ref: ref.describe('ref of the card number field'),
              expiry_ref: ref.optional().describe('ref of a single expiry field (MM/YY)'),
              month_ref: ref
                .optional()
                .describe('ref of the expiry month field, when month and year are apart'),
              year_ref: ref
                .optional()
                .describe('ref of the expiry year field, when month and year are apart'),
              cvc_ref: ref.optional().describe('ref of the security code field'),
              name_ref: ref.optional().describe('ref of the name on card field'),
              card: z
                .string()
                .max(100)
                .optional()
                .describe('which saved card, by its name or last four digits, when there are several'),
            },
            async (a) => fillCard(a, opts.cards!, opts.askCard!),
            'internal',
          ),
        ]
      : []),
    ...(opts.contacts && opts.askContact
      ? [
          def(
            'browser_contact',
            {
              fields: z
                .array(
                  z.object({
                    ref: ref.describe('ref of the field'),
                    part: z.enum(CONTACT_FIELDS).describe('which part of the saved details goes in it'),
                  }),
                )
                .min(1)
                .max(16),
              contact: z
                .string()
                .max(200)
                .optional()
                .describe('which saved details, by their name, when there are several'),
            },
            async (a) => fillContact(a, opts.contacts!, opts.askContact!),
            'internal',
          ),
        ]
      : []),
    def(
      'browser_select',
      { ref, element, values: z.array(z.string().max(500)).min(1).max(20) },
      async ({ ref: r, values }) =>
        act(
          async (page) => {
            await (await fresh(page, r)).selectOption(values);
          },
          true,
          // Choosing sends nothing; a page that sends its form on a change waits for a step that does.
          true,
        ),
      'internal',
    ),
    def(
      'browser_press',
      { key: z.string().min(1).max(40).describe('e.g. Enter, Escape, Tab, ArrowDown, Control+a'), sends },
      async (a) => {
        const hold = !maySend('browser_press', a);
        return act((page) => page.keyboard.press(a.key), true, hold);
      },
      'internal',
      gate('browser_press', async (page, a) => {
        const byKey = keySends(a.key);
        if (byKey !== null) return byKey;
        const focus = await focusInfo(page);
        if (focus === 'unknown') return true;
        // Enter sends what a field holds; Space presses the button that has the focus.
        return /enter$/i.test(a.key) ? enterSends(focus) : !!focus && clickSends(focus);
      }),
    ),
    def(
      'browser_scroll',
      { direction: z.enum(['up', 'down']), pages: z.number().min(0.25).max(10).default(1) },
      async ({ direction, pages }) =>
        act(async (page) => {
          await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
          await page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * pages * VIEWPORT.height * 0.8);
        }),
      'internal',
    ),
    def(
      'browser_history',
      { action: z.enum(['back', 'forward', 'reload']) },
      async ({ action }) =>
        act(async (page) => {
          if (action === 'back') await page.goBack();
          else if (action === 'forward') await page.goForward();
          else await page.reload();
        }),
      'internal',
    ),
    def(
      'browser_tabs',
      {
        action: z.enum(['list', 'select', 'new', 'close']),
        index: z.number().int().min(1).max(50).optional(),
        url: z.string().max(2000).optional(),
      },
      async ({ action, index, url }) =>
        step(async () => {
          const list = () => {
            const s = browser.pages(bot.id);
            if (!s) return t('browser.noTabs');
            return s.pages
              .map((p, i) => `${i + 1}. ${p.url()}${p === s.active ? ` ${t('browser.activeTab')}` : ''}`)
              .join('\n');
          };
          if (action === 'list') return list();
          if (action === 'new') {
            const page = await browser.newPage(bot.id);
            let wall: WallState = 'clear';
            if (url) {
              const res = await goto(page, url);
              if (res !== null) wall = await waitOutWall(page, res?.status() ?? null);
            }
            await settle(page);
            return wallNote(await outline(page), wall);
          }
          const target = index ? browser.pages(bot.id)?.pages[index - 1] : undefined;
          if (!target) return `${t('browser.noSuchTab')}\n${list()}`;
          if (action === 'close') {
            await browser.closePage(bot.id, target);
            return list();
          }
          browser.select(bot.id, target);
          await target.bringToFront().catch(() => {});
          return outline(target);
        }),
      'internal',
    ),
    def(
      'browser_screenshot',
      {
        ref: ref.optional().describe('ref of one element to picture alone; leave out for the whole view'),
        save_as: z
          .string()
          .regex(/^[\w .-]{1,80}\.jpe?g$/i)
          .optional()
          .describe('file name to also keep the picture in the conversation folder, e.g. "fiyatlar.jpg"'),
      },
      async ({ ref: r, save_as }) =>
        step(async (page) => {
          // Text can be masked, a picture cannot: none is taken while a vault secret shows in plain
          // text (a "show password" switch, a field it was typed into, the address).
          if ((await secretShown(page, browser.secrets(bot.id))) || (await cardShortShown(page))) {
            return t('browser.screenshotSecret');
          }
          // In page points: a sharper screen would only make the picture larger, not clearer to the bot.
          const options = { type: 'jpeg', quality: 70, timeout: 15_000, scale: 'css' } as const;
          const shot = r ? await (await fresh(page, r)).screenshot(options) : await page.screenshot(options);
          let saved = '';
          if (save_as) {
            // Into the conversation folder, where send_file and the person's library find it.
            const dir = workspacePaths(dataDir, bot.id, threadId, bot.groupId).threadDir;
            const file = join(dir, basename(save_as));
            await writeFile(file, shot);
            saved = `\n${t('browser.screenshotSaved', { path: file })}`;
          }
          return {
            text: `${t('browser.screenshot', { url: page.url() })}${saved}`,
            images: [{ data: shot.toString('base64'), mimeType: 'image/jpeg' }],
          };
        }),
      'internal',
    ),
    def(
      'browser_wait',
      {
        text: z.string().max(200).optional().describe('wait until this text shows'),
        gone: z.string().max(200).optional().describe('wait until this text is gone, e.g. "Loading"'),
        url: z.string().max(2000).optional().describe('wait until the address contains this'),
        seconds: z.number().min(0.5).max(30).optional(),
      },
      async ({ text, gone, url, seconds }) =>
        step(async (page) => {
          if (text || gone || url) {
            // The conditions are waited for together, so the step takes at most the time given.
            const timeout = (seconds ?? 20) * 1000;
            const met = (p: Promise<unknown>) =>
              p.then(
                () => true,
                () => false,
              );
            const [shown, left, moved] = await Promise.all([
              text ? met(page.getByText(text).first().waitFor({ timeout })) : true,
              gone ? met(page.getByText(gone).first().waitFor({ state: 'hidden', timeout })) : true,
              url
                ? met(page.waitForURL((u) => u.toString().includes(url), { timeout, waitUntil: 'commit' }))
                : true,
            ]);
            const missed = [
              ...(shown ? [] : [t('browser.textNotFound', { text: text! })]),
              ...(left ? [] : [t('browser.textStillThere', { text: gone! })]),
              ...(moved ? [] : [t('browser.urlNotReached', { url: url!, now: page.url() })]),
            ];
            if (missed.length) return missed.join('\n');
          } else await page.waitForTimeout((seconds ?? 2) * 1000);
          return outline(page);
        }),
      'internal',
    ),
    def(
      'browser_drag',
      {
        from_ref: ref.describe('ref of what to drag'),
        to_ref: ref.describe('ref of where to drop it'),
        element,
        sends,
      },
      async (a) => {
        const hold = !maySend('browser_drag', a);
        return act(
          async (page) => {
            const from = await fresh(page, a.from_ref);
            const to = await fresh(page, a.to_ref);
            await from.dragTo(to, { timeout: 10_000 });
          },
          false,
          hold,
        );
      },
      'internal',
      // A drop may save a new order or move a card to another list: the bot says when it sends.
      gate('browser_drag', async () => false),
    ),
    // Why a page does not work as it should: a request that failed or came back with an error.
    def(
      'browser_network',
      {
        tab: logTab,
        filter: z.string().max(200).optional().describe('only requests whose address contains this'),
        failed: z
          .boolean()
          .default(false)
          .describe('only requests that failed or got a status of 400 or more'),
        clear: forget,
      },
      async ({ tab, filter, failed, clear }) =>
        readLog(tab, (_page, log) => {
          const needle = filter?.toLowerCase();
          const matching = log.requests.filter(
            (e) => (!failed || requestFailed(e)) && (!needle || e.url.toLowerCase().includes(needle)),
          );
          const shown = matching.slice(-SHOWN_REQUESTS);
          const dropped = log.droppedRequests;
          if (clear) log.clearRequests();
          const body = shown.length ? formatRequests(shown, t) : t('browser.netNone');
          return body + logNotes(matching.length - shown.length, dropped, clear);
        }),
      'internal',
    ),
    // What the page's scripts logged, and the errors they did not catch.
    def(
      'browser_console',
      {
        tab: logTab,
        errors: z.boolean().default(false).describe('only errors and warnings'),
        clear: forget,
      },
      async ({ tab, errors, clear }) =>
        readLog(tab, (_page, log) => {
          const matching = log.messages.filter(
            (e) => !errors || e.level === 'error' || e.level === 'warning',
          );
          const shown = matching.slice(-SHOWN_MESSAGES);
          const dropped = log.droppedMessages;
          if (clear) log.clearMessages();
          const body = shown.length ? formatMessages(shown, t) : t('browser.consoleNone');
          return body + logNotes(matching.length - shown.length, dropped, clear);
        }),
      'internal',
    ),
  ];
}
