import type { OutsideTrigger } from '@leafbot/shared';
import { domainToUnicode } from 'node:url';
import { getDomainWithoutSuffix, getPublicSuffix } from 'tldts';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import { runsInlineCode } from './safety';

/** Programs that talk to another host, or an address written into a command. */
const NETWORK_COMMAND =
  /(?:^|[^\w-])(?:curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|ftp|telnet|http|https|xh)(?=$|[^\w-])|\b[a-z][\w+.-]*:\/\//i;

/**
 * Whether a step can reach another host: a web search or page, the browser, an API call, an app
 * tool that takes an address, or a command naming a network program or an address, or handing an
 * interpreter code inline. A script the bot runs by name is not caught here.
 */
export function reachesOut(toolName: string, input: Record<string, unknown>, tool?: AppTool): boolean {
  if (toolName === 'WebSearch' || toolName === 'WebFetch') return true;
  if (toolName === 'Bash') {
    const command = input.command;
    // Code handed straight to an interpreter can open a connection without naming a program.
    return typeof command !== 'string' || NETWORK_COMMAND.test(command) || runsInlineCode(command);
  }
  if (!tool) return false;
  if (!tool.server && (tool.name.startsWith('browser_') || tool.name.startsWith('api_'))) return true;
  return takesAddress(tool.jsonSchema);
}

/** Text compared without case or accents, so "Facebook'ta" and "İnstagram" match a site's name. */
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** Digits and letter pairs a copy of a site's name puts in place of letters. */
const STAND_INS: [RegExp, string][] = [
  // Letters of other alphabets drawn like Latin ones.
  [/ı/g, 'i'],
  [/і/g, 'i'],
  [/а/g, 'a'],
  [/е/g, 'e'],
  [/о/g, 'o'],
  [/р/g, 'p'],
  [/с/g, 'c'],
  [/х/g, 'x'],
  [/у/g, 'y'],
  [/ԁ/g, 'd'],
  [/ѕ/g, 's'],
  [/ο/g, 'o'],
  [/α/g, 'a'],
  [/0/g, 'o'],
  [/1/g, 'l'],
  [/3/g, 'e'],
  [/4/g, 'a'],
  [/5/g, 's'],
  [/7/g, 't'],
  [/rn/g, 'm'],
  [/vv/g, 'w'],
];
const unmask = (s: string) => STAND_INS.reduce((x, [from, to]) => x.replace(from, to), s);

/** Whether `a` becomes `b` by changing, adding or dropping one letter. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const [x, y] = [a.slice(i + 1), b.slice(i + 1)];
  return x === y || a.slice(i) === y || x === b.slice(i);
}

/**
 * Sites copies are made of to take a sign-in or a payment: mail, social media, stores, payments
 * and the banks and state services people here use. Their own domains on any suffix are the site.
 */
const OFTEN_COPIED = [
  'facebook',
  'instagram',
  'whatsapp',
  'telegram',
  'linkedin',
  'twitter',
  'tiktok',
  'youtube',
  'google',
  'gmail',
  'apple',
  'icloud',
  'microsoft',
  'outlook',
  'yahoo',
  'paypal',
  'stripe',
  'amazon',
  'netflix',
  'spotify',
  'dropbox',
  'github',
  'binance',
  'coinbase',
  'trendyol',
  'hepsiburada',
  'sahibinden',
  'getir',
  'yemeksepeti',
  'edevlet',
  'garanti',
  'garantibbva',
  'akbank',
  'ziraat',
  'isbank',
  'yapikredi',
  'halkbank',
  'vakifbank',
  'qnb',
  'enpara',
  'denizbank',
  'teb',
  'kuveytturk',
  'papara',
  'ininal',
  'iyzico',
  'ptt',
];

/** A domain written in the person's words, such as "leafdesk.com" or "www.ornek.com.tr". */
const WRITTEN_DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi;

/** The names of `hosts` (domains or addresses), as compared: folded, four letters or more. */
function namesOf(hosts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const host of hosts) {
    const name = getDomainWithoutSuffix(host.toLowerCase());
    if (name && name.length >= 4) names.add(fold(name));
  }
  return names;
}

/**
 * The known site a page address imitates without being it: its name written with look-alike
 * letters ("faceb00k", a punycode "İnstagram"), one letter off ("facebok"), or set inside another
 * domain ("facebook.com.giris.io", "facebook-login.net"). Known sites are the often copied ones,
 * those the person keeps a sign-in for (`known`) and the domains they wrote. Null when the address
 * is that site (on any suffix: google.com.tr is Google), or resembles none. The card says so, since a copy of a
 * site the person uses is where a sign-in or a payment would be taken.
 */
export function resembledSite(
  url: unknown,
  words: readonly string[],
  known: readonly string[] = [],
): string | null {
  if (typeof url !== 'string') return null;
  let host: string;
  try {
    const u = new URL(/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    host = u.hostname;
  } catch {
    return null;
  }
  const own = getDomainWithoutSuffix(host);
  const suffix = getPublicSuffix(host);
  if (!own || !suffix) return null;
  // The labels before the public suffix, each also split at its hyphens, read as letters.
  const labels = fold(domainToUnicode(host.slice(0, -suffix.length - 1)) || host)
    .split('.')
    .filter((l) => l && l !== 'www');
  const parts = new Set(labels.flatMap((l) => [l, ...l.split('-')]).map(unmask));
  const imitated = (names: ReadonlySet<string>) => {
    // The site itself, under its own name.
    if (names.has(fold(own))) return null;
    for (const name of names) {
      const plain = unmask(name);
      for (const part of parts) {
        if (part === plain || (plain.length >= 6 && oneEditApart(part, plain))) return name;
      }
    }
    return undefined;
  };
  // The often copied sites and those with a sign-in first: a copy's address the person pasted
  // themselves (from a message they were sent) is still a copy of them.
  const first = imitated(new Set([...OFTEN_COPIED, ...namesOf(known)]));
  if (first !== undefined) return first;
  return imitated(namesOf(words.flatMap((w) => w.match(WRITTEN_DOMAIN) ?? []))) ?? null;
}

/** Words in an input's name that make it a place to send to: a page, a host, a hook. */
const ADDRESS_WORDS = new Set([
  'url',
  'urls',
  'uri',
  'uris',
  'href',
  'link',
  'links',
  'endpoint',
  'webhook',
  'callback',
  'host',
  'hostname',
  'domain',
]);

/**
 * Whether a tool's input names an address anywhere in it (`url`, `callbackUrl`, `target_host`, a
 * string in `uri` format). A schema that cannot be walked counts as one, so the tool still asks.
 */
export function takesAddress(schema: Record<string, unknown> | undefined): boolean {
  if (!schema) return false;
  const seen = new Set<unknown>();
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some(visit);
    const obj = node as Record<string, unknown>;
    if (obj.format === 'uri' || obj.format === 'url' || obj.format === 'uri-reference') return true;
    const props = obj.properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) {
        const words = key
          .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
          .toLowerCase()
          .split(/[^a-z0-9]+/);
        if (words.some((w) => ADDRESS_WORDS.has(w))) return true;
      }
    }
    return Object.values(obj).some(visit);
  };
  try {
    return visit(schema);
  } catch {
    return true;
  }
}

/** The app's own tools that show text kept here which may have come from outside before. */
const STORED_READS: ReadonlySet<string> = new Set(['ticket_read', 'tickets_list', 'table_rows']);

/**
 * What outside text a tool's result brings into the run, if any: a mail, or a page or an API's
 * answer (`fromOutside`, see `outsideSource`). A connected app's answer is the person's own
 * business data (orders, sheets, records), and counting it as a stranger's words held every bot
 * that looked something up, and every bot it handed work to, to a card for each step whatever its
 * level. Its answer is still marked as data for the model; only a tool that takes an address,
 * which can bring back any page, counts as reading the web. Tickets and tables keep no record of
 * who wrote each line, and a bot that read outside text may have written one: with nobody
 * watching, reading them counts as reading stored outside text. Messages say where they came
 * from, so the tools that read them report it themselves.
 */
export function outsideRead(tool: AppTool, fromOutside: boolean, present: boolean): OutsideTrigger | null {
  if (tool.name === 'email_inbox' || tool.name === 'email_read') return 'email';
  if (tool.name === 'whatsapp_history' || tool.name === 'whatsapp_chats') return 'whatsapp';
  if (tool.server) return takesAddress(tool.jsonSchema) ? 'web' : null;
  if (fromOutside) return 'web';
  if (!tool.server && !present && STORED_READS.has(tool.name)) return 'stored';
  return null;
}

/** The tag outside content is wrapped in; the model is told what it means in the system prompt. */
const TAG = 'outside-data';

/**
 * Where a tool's results come from when that is outside this server: a connected app (by its
 * name) or a web page in the bot's browser. Null for the app's own tools, whose results the
 * server writes itself.
 */
export function outsideSource(tool: AppTool, apps: ReadonlyMap<string, string>, t: T): string | null {
  if (tool.server) return apps.get(tool.server) ?? tool.server;
  if (tool.name.startsWith('browser_')) return t('outside.browser');
  // Whatever is open on the person's screen: a page, a mail, someone else's message.
  if (tool.name.startsWith('person_computer_')) return t('outside.screen');
  // The person's calendar and contacts hold what others wrote: invitations, names, notes.
  if (tool.name.startsWith('person_phone_')) return t('outside.phone');
  // What the people in a call said, written out.
  if (tool.name === 'call_status' || tool.name === 'call_stop') return t('outside.call');
  if (tool.name === 'api_request' || tool.name === 'api_call') return t('outside.api');
  if (tool.name === 'email_inbox' || tool.name === 'email_read') return t('outside.email');
  if (tool.name === 'whatsapp_history' || tool.name === 'whatsapp_chats') return t('outside.whatsapp');
  return null;
}

/**
 * Text from outside, marked as data: one block that says where it came from and that nothing in
 * it is an instruction. A tag in the text that could end the block early, or start another, is
 * broken up so the text stays inside.
 */
export function asOutsideData(source: string, text: string, t: T): string {
  const name = source
    .replace(/["<>\r\n]/g, ' ')
    .trim()
    .slice(0, 80);
  const body = text.replace(new RegExp(`<(\\s*/?\\s*${TAG})`, 'gi'), '‹$1');
  return `${t('outside.header', { source: name })}\n<${TAG} source="${name}">\n${body}\n</${TAG}>`;
}

/** The tool with its results marked as outside data, when they come from outside. */
export function markedOutside(tool: AppTool, source: string | null, t: T): AppTool {
  if (!source) return tool;
  const mark = (r: ToolResult): ToolResult =>
    typeof r === 'string' ? asOutsideData(source, r, t) : { ...r, text: asOutsideData(source, r.text, t) };
  return { ...tool, handler: async (args) => mark(await tool.handler(args)) };
}
