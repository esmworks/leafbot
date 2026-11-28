import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ImapFlow, type MessageStructureObject, type SearchObject } from 'imapflow';
import nodemailer from 'nodemailer';
import PostalMime, { type Address, type Email } from 'postal-mime';
import { z } from 'zod';
import {
  MAX_UPLOAD_BYTES,
  mailUsername,
  type MailSender,
  type MailServer,
  type MailSettings,
} from '@leafbot/shared';
import type { StoredConnectionTool } from '../db/schema';
import { privateAddress } from '../services/skill-link';
import { ConnectionClientError } from './client';
import {
  attachments,
  filesOf,
  toolKind as gmailToolKind,
  nameFor,
  oneLine,
  oneLineOf,
  recipients,
  text,
  unique,
} from './gmail';
import {
  forwardHeader,
  forwardSubject,
  headerText,
  htmlFromText,
  messageIds,
  mimeMessage,
  replySubject,
  textFromHtml,
  withSignature,
  type GmailPart,
  type Mail,
  type MailFile,
} from './gmail-mime';

/**
 * The tools of a mail account reached over IMAP (reading, moving, flagging) and SMTP (sending),
 * which this server runs itself: such accounts have no MCP server. Each call opens its own
 * connection and closes it, so nothing stays open between turns. Sending, replying and forwarding
 * keep the Gmail tools' names and inputs, so the card that shows a mail before it goes reads them
 * the same way.
 */

/** How long reaching a server and its greeting may take, and a quiet socket may stay open. */
const CONNECT_MS = 20_000;
const SOCKET_MS = 60_000;
/** The most of one mail read whole; larger ones are refused rather than held in memory. */
const MAX_SOURCE = 40 * 1024 * 1024;
/** The most files a mail sent may carry together; most providers refuse more. */
const MAX_FILES_BYTES = 25 * 1024 * 1024;
/** What a mail's text gives the bot in one answer; the rest is cut. */
const MAX_TEXT = 100_000;
const MAX_IDS = 100;

// ---------------------------------------------------------------------------------------------
// Ids

/**
 * A mail as the tools name it: its folder, the folder's UIDVALIDITY and its UID there. An IMAP UID
 * means something only in its folder, and only while the folder's UIDVALIDITY stays the same, so
 * all three go into one opaque id the bot hands back.
 */
export interface MailRef {
  folder: string;
  validity: string;
  uid: number;
}

export function mailId(ref: MailRef): string {
  return Buffer.from(JSON.stringify([ref.folder, ref.validity, ref.uid]), 'utf8').toString('base64url');
}

export function readMailId(id: string): MailRef | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(id, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) &&
      v.length === 3 &&
      typeof v[0] === 'string' &&
      v[0] &&
      typeof v[1] === 'string' &&
      /^\d{1,20}$/.test(v[1]) &&
      Number.isSafeInteger(v[2]) &&
      (v[2] as number) > 0
    ) {
      return { folder: v[0], validity: v[1], uid: v[2] as number };
    }
  } catch {
    // Not one of ours: refused below.
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Input

const id = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/, 'a messageId as search_messages gave it');
const ids = z.array(id).min(1).max(MAX_IDS);
const folder = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((s) => !/[\r\n\0]/.test(s), 'a folder path as list_folders gave it');
/** A day as YYYY-MM-DD that is on the calendar: 2026-02-30 would turn into a March day unseen. */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a day as YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'a day that is on the calendar');

/** What `send_message` takes. Unknown keys are refused: the card shows every field that goes out. */
export const MailSendInput = z
  .object({
    to: recipients.min(1),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: oneLine(998).optional(),
    body: text.optional(),
    htmlBody: text.optional(),
    attachments: attachments.optional(),
    includeSignature: z.boolean().optional(),
    replyToMessageId: id.optional(),
  })
  .strict()
  .refine(
    (m) => m.body !== undefined || m.htmlBody !== undefined || !!m.attachments?.length,
    'body or htmlBody is required',
  );

export const MailReplyInput = z
  .object({
    messageId: id,
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    body: text.optional(),
    htmlBody: text.optional(),
    replyAll: z.boolean().optional(),
    includeSignature: z.boolean().optional(),
    attachments: attachments.optional(),
  })
  .strict()
  .refine((m) => m.body !== undefined || m.htmlBody !== undefined, 'body or htmlBody is required');

export const MailForwardInput = z
  .object({
    messageId: id,
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    forwardText: text.optional(),
    htmlBody: text.optional(),
    includeSignature: z.boolean().optional(),
    attachments: attachments.optional(),
  })
  .strict()
  .refine((m) => !!(m.to?.length || m.cc?.length || m.bcc?.length), 'to, cc or bcc is required');

export const MailSearchInput = z
  .object({
    folder: folder.optional(),
    query: z.string().trim().min(1).max(500).optional(),
    from: z.string().trim().min(1).max(320).optional(),
    to: z.string().trim().min(1).max(320).optional(),
    subject: z.string().trim().min(1).max(500).optional(),
    since: day.optional(),
    before: day.optional(),
    unreadOnly: z.boolean().optional(),
    flaggedOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const MessageIdInput = z.object({ messageId: id }).strict();
const AttachmentInput = z
  .object({
    messageId: id,
    attachmentIndex: z.number().int().min(0).max(1000).optional(),
    filename: z.string().max(1000).optional(),
  })
  .strict();
const FlagsInput = z
  .object({ messageIds: ids, seen: z.boolean().optional(), flagged: z.boolean().optional() })
  .strict()
  .refine((m) => m.seen !== undefined || m.flagged !== undefined, 'give seen or flagged');
const MoveInput = z.object({ messageIds: ids, folder }).strict();
const TrashInput = z.object({ messageIds: ids }).strict();

/** The input could not make a call, or names a mail that is not there; nothing was done. */
class InputError extends Error {}

function parse<S extends z.ZodTypeAny>(schema: S, args: Record<string, unknown>): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new InputError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data as z.infer<S>;
}

function refOf(messageId: string): MailRef {
  const ref = readMailId(messageId);
  if (!ref) throw new InputError('messageId: not an id search_messages gave');
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Reaching the servers

/** Where the account's servers are, and how to sign in to them. */
export interface MailTarget {
  settings: MailSettings;
  password: string;
  /** The account is a person's who may not point the server at its own machine or network. */
  publicOnly: () => Promise<boolean>;
}

/**
 * A mail account that cannot be reached for a reason of its own settings, which the person is told
 * in their language: a server name with no address, one on a private network, or settings lost.
 */
export class MailAccountError extends ConnectionClientError {
  constructor(
    readonly reason: 'hostNotFound' | 'hostPrivate' | 'settingsMissing',
    readonly host: string,
    message: string,
  ) {
    super(reason === 'settingsMissing' ? 'unauthorized' : 'unreachable', message);
  }
}

/**
 * Where to open the socket. For an account that must stay public the name is looked up here, every
 * address checked, and the socket opened to a checked address with the name kept for TLS: the mail
 * libraries would otherwise look it up again, and could reach an address that was never checked.
 */
export async function reach(
  server: Pick<MailServer, 'host'>,
  publicOnly: boolean,
  resolve: (host: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true }),
): Promise<{ host: string; servername?: string }> {
  if (!publicOnly) return { host: server.host };
  const literal = isIP(server.host) !== 0;
  const found = literal ? [{ address: server.host }] : await resolve(server.host).catch(() => []);
  if (!found.length) throw new MailAccountError('hostNotFound', server.host, `${server.host} was not found`);
  if (found.some((a) => privateAddress(a.address))) {
    throw new MailAccountError(
      'hostPrivate',
      server.host,
      `${server.host} is on this computer or a private network`,
    );
  }
  return { host: found[0]!.address, ...(!literal && { servername: server.host }) };
}

/** Why reaching a server failed, as the connection's error kinds name it. */
function connectError(err: unknown, server: 'IMAP' | 'SMTP', host: string): ConnectionClientError {
  if (err instanceof ConnectionClientError) return err;
  // imapflow passes the lookup's ENOTFOUND on; nodemailer calls it EDNS and keeps it in the message.
  const dns = err as { code?: string; message?: string } | undefined;
  if (dns?.code === 'ENOTFOUND' || (dns?.code === 'EDNS' && /ENOTFOUND/.test(dns.message ?? ''))) {
    return new MailAccountError('hostNotFound', host, `${server}: ${host} was not found`);
  }
  const e = (err ?? {}) as {
    authenticationFailed?: boolean;
    code?: string;
    responseText?: string;
    response?: string;
    message?: string;
  };
  const said = `${server}: ${e.responseText || e.response || e.message || String(err)}`;
  if (e.authenticationFailed || e.code === 'EAUTH') return new ConnectionClientError('unauthorized', said);
  if (/TIMEOUT|ETIMEDOUT/.test(e.code ?? '') || /timed? ?out/i.test(said)) {
    return new ConnectionClientError('timeout', said);
  }
  return new ConnectionClientError('unreachable', said);
}

/** Opens the IMAP server, runs `fn`, and closes it whatever happens. */
async function withImap<T>(t: MailTarget, signal: AbortSignal | undefined, fn: (c: ImapFlow) => Promise<T>) {
  signal?.throwIfAborted();
  const { imap } = t.settings;
  const at = await reach(imap, await t.publicOnly());
  const client = new ImapFlow({
    host: at.host,
    port: imap.port,
    secure: imap.security === 'tls',
    // Signing in waits for TLS; a server that offers none is refused rather than read in the clear.
    ...(imap.security === 'starttls' && { doSTARTTLS: true }),
    ...(at.servername && { servername: at.servername }),
    auth: { user: mailUsername(t.settings), pass: t.password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
    clientInfo: { name: 'Leaf Bot' },
  });
  // A dropped socket is reported as an event as well as to the call waiting on it.
  client.on('error', () => undefined);
  const stop = () => client.close();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    try {
      await client.connect();
    } catch (err) {
      throw connectError(err, 'IMAP', imap.host);
    }
    const out = await fn(client);
    await client.logout().catch(() => undefined);
    return out;
  } finally {
    signal?.removeEventListener('abort', stop);
    client.close();
  }
}

/**
 * A logger that hears the server's lines and calls `onData` once the server said 354, that is,
 * once it is ready to take the mail itself: after that a dropped connection may have sent it.
 * nodemailer gives an error after DATA no mark of its own, so the server's lines are the only sign.
 */
function dataWatch(onData: () => void) {
  const none = () => undefined;
  return {
    trace: none,
    info: none,
    warn: none,
    error: none,
    fatal: none,
    debug: (meta: { tnx?: string } | undefined, line?: unknown) => {
      if (meta?.tnx === 'server' && /^354\b/.test(String(line ?? ''))) onData();
    },
  };
}

/** The SMTP server, ready to send or check; closed by the caller. `onData` see `dataWatch`. */
async function smtp(t: MailTarget, onData?: () => void) {
  const { smtp: server } = t.settings;
  const at = await reach(server, await t.publicOnly());
  return nodemailer.createTransport({
    host: at.host,
    port: server.port,
    secure: server.security === 'tls',
    requireTLS: server.security === 'starttls',
    auth: { user: mailUsername(t.settings), pass: t.password },
    ...(at.servername && { tls: { servername: at.servername } }),
    connectionTimeout: CONNECT_MS,
    greetingTimeout: CONNECT_MS,
    socketTimeout: SOCKET_MS,
    // The server's lines reach the logger only with the transaction log on; debug would also pass
    // it the whole mail, attachments and all. Nothing of them is kept.
    ...(onData ? { logger: dataWatch(onData), transactionLog: true } : { logger: false }),
    debug: false,
  });
}

/**
 * Signs in to both servers and lists the folders: what adding the account or checking it again
 * does. Throws a connection error saying which server failed and why.
 */
export async function checkMailAccount(t: MailTarget, signal?: AbortSignal): Promise<void> {
  await withImap(t, signal, (c) => c.list());
  const transport = await smtp(t);
  const stop = () => transport.close();
  signal?.addEventListener('abort', stop, { once: true });
  try {
    await transport.verify();
  } catch (err) {
    throw connectError(err, 'SMTP', t.settings.smtp.host);
  } finally {
    signal?.removeEventListener('abort', stop);
    transport.close();
  }
}

/** A server refused a step after signing in: nothing was sent or changed at that step. */
class StepError extends Error {
  constructor(
    readonly step: string,
    readonly said: string,
  ) {
    super(step);
  }
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ConnectionClientError || err instanceof InputError || err instanceof StepError)
      throw err;
    const e = (err ?? {}) as { authenticationFailed?: boolean; responseText?: string; message?: string };
    if (e.authenticationFailed) throw connectError(err, 'IMAP', '');
    throw new StepError(name, e.responseText || e.message || String(err));
  }
}

// ---------------------------------------------------------------------------------------------
// Building a mail to send

/** The From header: the name quoted when plain ASCII, else encoded, then the address. */
export function fromHeader(m: Pick<MailSettings, 'address' | 'displayName'>): string {
  if (!m.displayName) return m.address;
  const name = /^[\x20-\x7e]*$/.test(m.displayName) ? `"${m.displayName}"` : headerText(m.displayName);
  return `${name} <${m.address}>`;
}

/** A date as mail headers write it: `Sat, 28 Nov 2026 10:00:00 +0000`. */
const mailDate = (d: Date) => d.toUTCString().replace(/GMT$/, '+0000');

/**
 * A header folded onto lines of about 78 characters, the items joined by `sep`: an SMTP server
 * refuses a line over 998, which a long list of recipients or a long reply chain would reach.
 */
function folded(name: string, items: string[], sep: string): string {
  const lines: string[] = [];
  let line = `${name}:`;
  items.forEach((item, i) => {
    const piece = i < items.length - 1 ? `${item}${sep}` : item;
    if (line.length > name.length + 1 && line.length + 1 + piece.length > 78) {
      lines.push(line);
      line = '';
    }
    line += ` ${piece}`;
  });
  lines.push(line);
  return lines.join('\r\n');
}

/**
 * The Subject header. Plain ASCII folds at its spaces; anything else, or a word too long to fold,
 * goes as UTF-8 encoded words of a few dozen bytes each, cut between characters, never inside one.
 */
function subjectHeader(subject: string): string {
  const words = subject.split(' ');
  if (/^[\x20-\x7e]*$/.test(subject) && words.every((w) => w.length <= 70) && !/ {2}|^ | $/.test(subject)) {
    return folded('Subject', words, '');
  }
  const chunks: string[] = [];
  let chunk = '';
  for (const ch of subject) {
    // 39 bytes are 52 in base64: with the encoded word's markers and `Subject: `, 73 characters.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 39) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) chunks.push(chunk);
  return folded(
    'Subject',
    chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`),
    '',
  );
}

export interface Outgoing {
  /** Who the SMTP server is told the mail is from and goes to: every recipient, Bcc included. */
  envelope: { from: string; to: string[] };
  /** What goes over the wire: without the Bcc header, which would show every hidden recipient. */
  wire: string;
  /** The copy kept in the Sent folder, Bcc kept, as mail apps keep it. */
  copy: string;
  messageId: string;
}

/**
 * A mail ready for SMTP. Gmail's API fills in From, Date and Message-ID and drops Bcc itself; an
 * SMTP server does none of that, so they are written here.
 */
export function outgoing(settings: Pick<MailSettings, 'address' | 'displayName'>, mail: Mail, now: Date) {
  const domain = settings.address.split('@')[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;
  const head = [`From: ${fromHeader(settings)}`, `Date: ${mailDate(now)}`, `Message-ID: ${messageId}`].join(
    '\r\n',
  );
  const boundary = `leaf-${randomUUID()}`;
  // The headers that can run long are written here, folded; the MIME part comes from Gmail's code.
  const lines = (bcc: string[] | undefined) =>
    [
      ...(mail.to.length ? [folded('To', mail.to, ',')] : []),
      ...(mail.cc?.length ? [folded('Cc', mail.cc, ',')] : []),
      ...(bcc?.length ? [folded('Bcc', bcc, ',')] : []),
      ...(mail.subject ? [subjectHeader(mail.subject)] : []),
      ...(mail.inReplyTo ? [folded('In-Reply-To', [mail.inReplyTo], '')] : []),
      ...(mail.references ? [folded('References', mail.references.split(/\s+/).filter(Boolean), '')] : []),
    ].join('\r\n');
  const mime = mimeMessage(
    {
      ...mail,
      from: undefined,
      to: [],
      cc: undefined,
      bcc: undefined,
      subject: undefined,
      inReplyTo: undefined,
      references: undefined,
    },
    boundary,
  );
  const body = (bcc: string[] | undefined) => [head, lines(bcc), mime].filter(Boolean).join('\r\n');
  const to = unique([...mail.to, ...(mail.cc ?? []), ...(mail.bcc ?? [])], new Set());
  return {
    envelope: { from: settings.address, to },
    wire: body(undefined),
    copy: body(mail.bcc),
    messageId,
  } satisfies Outgoing;
}

function checkSize(files: { data: { length: number } }[]) {
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_FILES_BYTES) {
    throw new InputError(
      `the files come to ${Math.ceil(total / 1024 / 1024)} MB; mail servers take about 25 MB at most. Share larger files by a link in the body.`,
    );
  }
}

/** The body with the account's signature at the end, when asked for and set. */
function signed(body: { text?: string; html?: string }, settings: MailSettings, include?: boolean) {
  return include && settings.signature.trim() ? withSignature(body, htmlFromText(settings.signature)) : body;
}

/**
 * Sends a mail over SMTP, then keeps a copy in the Sent folder. Once the server took the mail it
 * is sent, whatever happens to the copy: the answer then says the copy is missing rather than that
 * nothing went, so the bot does not send it again.
 */
async function deliver(c: ImapFlow, t: MailTarget, mail: Mail, signal?: AbortSignal) {
  const now = new Date();
  const out = outgoing(t.settings, mail, now);
  let handedOver = false;
  const transport = await smtp(t, () => (handedOver = true));
  const stop = () => transport.close();
  signal?.addEventListener('abort', stop, { once: true });
  let base: { sent: true; messageId: string; rejected?: string[] };
  try {
    const info = await transport.sendMail({ envelope: out.envelope, raw: out.wire });
    // The server may take the mail for some recipients and turn others away: those are named.
    const rejected = info.rejected ?? [];
    base = { sent: true, messageId: out.messageId, ...(rejected.length && { rejected }) };
  } catch (err) {
    const e = (err ?? {}) as { code?: string; response?: string; responseCode?: number; message?: string };
    // The mail went over and the server never answered: it may well have gone, so the bot is told
    // not to send it again blindly. A server that answered with a refusal did not take it.
    if (handedOver && !e.responseCode) {
      return {
        sent: 'unknown' as const,
        messageId: out.messageId,
        savedToSent: false,
        note: `The connection dropped after the mail was handed to the server${e.message ? ` (${e.message})` : ''}, so it may have been sent. Do not send it again before the person checks: their Sent folder at the provider, or the recipient.`,
      };
    }
    // Not reaching the server, or not signing in: the connection's trouble, not a refused mail.
    if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ENOTFOUND'].includes(e.code ?? '')) {
      throw connectError(err, 'SMTP', t.settings.smtp.host);
    }
    throw new StepError('sending', e.response || e.message || String(err));
  } finally {
    signal?.removeEventListener('abort', stop);
    transport.close();
  }
  if (!t.settings.saveSent) return { ...base, savedToSent: false };
  try {
    const sent = (await c.list()).find((f) => f.specialUse === '\\Sent');
    if (!sent) {
      return { ...base, savedToSent: false, note: 'Sent; the account has no Sent folder to keep a copy in.' };
    }
    await c.append(sent.path, out.copy, ['\\Seen'], now);
    return { ...base, savedToSent: true };
  } catch (err) {
    const said =
      (err as { responseText?: string; message?: string })?.responseText ?? (err as Error)?.message;
    return {
      ...base,
      savedToSent: false,
      note: `Sent; keeping a copy in the Sent folder failed${said ? `: ${said}` : ''}. Do not send it again.`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Reading

/** Opens a folder, runs `fn` with its UIDVALIDITY, and lets it go. */
async function inFolder<T>(c: ImapFlow, path: string, write: boolean, fn: (validity: string) => Promise<T>) {
  const lock = await step(`opening the folder ${path}`, () => c.getMailboxLock(path, { readOnly: !write }));
  try {
    const box = c.mailbox;
    return await fn(box ? box.uidValidity.toString() : '');
  } finally {
    lock.release();
  }
}

/** The ids' UIDs in their folder, refused when the folder was renumbered since they were given. */
function uidsIn(refs: MailRef[], validity: string): number[] {
  if (refs.some((r) => r.validity !== validity)) {
    throw new InputError('the folder was renumbered since these ids were given: search again for new ones');
  }
  return refs.map((r) => r.uid);
}

/** Groups mails by their folder, in the order first seen. */
function byFolder(refs: MailRef[]): Map<string, MailRef[]> {
  const out = new Map<string, MailRef[]>();
  for (const r of refs) out.set(r.folder, [...(out.get(r.folder) ?? []), r]);
  return out;
}

/** One mail read whole and parsed, with its flags. */
async function readMail(c: ImapFlow, ref: MailRef) {
  return inFolder(c, ref.folder, false, async (validity) => {
    uidsIn([ref], validity);
    const uid = String(ref.uid);
    const head = await step('reading the mail', () =>
      c.fetchOne(uid, { uid: true, size: true, flags: true }, { uid: true }),
    );
    if (!head) throw new InputError('no such mail in the folder now: it may have been moved or deleted');
    if ((head.size ?? 0) > MAX_SOURCE) {
      throw new InputError(
        `the mail is ${Math.ceil((head.size ?? 0) / 1024 / 1024)} MB, too large to read here`,
      );
    }
    const full = await step('reading the mail', () =>
      c.fetchOne(uid, { uid: true, source: true }, { uid: true }),
    );
    if (!full || !full.source) throw new InputError('no such mail in the folder now');
    const parsed = await PostalMime.parse(full.source, { attachmentEncoding: 'arraybuffer' });
    return { parsed, flags: head.flags ?? new Set<string>() };
  });
}

/** Every address in a list, groups opened up. */
function plain(list: (Address | undefined)[] | undefined): string[] {
  const out: string[] = [];
  for (const a of list ?? []) {
    if (!a) continue;
    if (a.group) out.push(...plain(a.group));
    else if (a.address) out.push(a.address);
  }
  return out;
}

/** Addresses as one line: `Ayşe <a@example.com>, b@example.com`. */
function addressLine(list: (Address | undefined)[] | undefined): string | undefined {
  const out: string[] = [];
  for (const a of list ?? []) {
    if (!a) continue;
    if (a.group) out.push(...(a.group.map((g) => addressLine([g])).filter(Boolean) as string[]));
    else if (a.address) out.push(a.name ? `${oneLineOf(a.name)} <${a.address}>` : a.address);
  }
  return out.length ? out.join(', ') : undefined;
}

const headerIn = (mail: Email, name: string) =>
  mail.headers.find((h) => h.key?.toLowerCase() === name.toLowerCase())?.value;

/** A Content-ID as a plain token, or nothing: it goes back into a header. */
const cidOf = (raw: string | undefined) =>
  raw
    ?.trim()
    .replace(/^<|>$/g, '')
    .match(/^[^\s<>"]+$/)?.[0];

function filesIn(mail: Email): MailFile[] {
  return mail.attachments.map((a) => {
    const cid = a.related || a.disposition === 'inline' ? cidOf(a.contentId) : undefined;
    return {
      ...(a.filename && { filename: a.filename.replace(/[\r\n\0]/g, ' ') }),
      mimeType: a.mimeType || 'application/octet-stream',
      data:
        typeof a.content === 'string'
          ? Buffer.from(a.content, 'utf8')
          : Buffer.from(new Uint8Array(a.content)),
      ...(cid && { contentId: cid }),
    };
  });
}

function fileList(files: MailFile[]) {
  return files.map((f, i) => ({
    attachmentIndex: i,
    filename: f.filename ?? null,
    mimeType: f.mimeType,
    size: f.data.length,
    // A picture the mail's HTML shows in its text, such as a signature's logo.
    ...(f.contentId && { inline: true }),
  }));
}

const bodyText = (mail: Email) => mail.text ?? (mail.html !== undefined ? textFromHtml(mail.html) : '');

/** The reply headers that keep a mail in the conversation it answers. */
function threading(mail: Email) {
  const msgId = messageIds(headerIn(mail, 'Message-ID'))[0];
  if (!msgId) return {};
  const chain = [...messageIds(headerIn(mail, 'References')), msgId];
  return { inReplyTo: msgId, references: chain.slice(-20).join(' ') };
}

/** The header lines a forward quotes, decoded, in the shape the forward's header reads. */
function quotedHead(mail: Email): GmailPart {
  const rows: [string, string | undefined][] = [
    ['From', addressLine([mail.from])],
    ['Date', oneLineOf(headerIn(mail, 'Date')) || undefined],
    ['Subject', mail.subject ? oneLineOf(mail.subject) : undefined],
    ['To', addressLine(mail.to)],
    ['Cc', addressLine(mail.cc)],
  ];
  return {
    headers: rows.filter((r): r is [string, string] => !!r[1]).map(([name, value]) => ({ name, value })),
  };
}

/** Whether a message's structure carries a file. */
function hasFiles(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment' || node.dispositionParameters?.filename) return true;
  return (node.childNodes ?? []).some(hasFiles);
}

/** A mail's date as ISO text; a Date header nobody could read stays as it was written. */
function dateOf(d: Date | string | undefined): string | null {
  if (!d) return null;
  const at = new Date(d);
  return Number.isNaN(at.getTime()) ? oneLineOf(String(d)) || null : at.toISOString();
}

const flagsOf = (flags: Set<string> | undefined) => ({
  seen: !!flags?.has('\\Seen'),
  flagged: !!flags?.has('\\Flagged'),
  answered: !!flags?.has('\\Answered'),
});

// ---------------------------------------------------------------------------------------------
// The tools

export interface MailToolContext {
  /** Keeps a file in the conversation's folder; absent where there is no conversation. */
  saveFile?: (name: string, data: Buffer) => Promise<string>;
}

type Run = (
  t: MailTarget,
  args: Record<string, unknown>,
  ctx: MailToolContext,
  signal?: AbortSignal,
) => Promise<Record<string, unknown>>;

const listFolders: Run = (t, args, _ctx, signal) => {
  parse(z.object({}).strict(), args);
  return withImap(t, signal, async (c) => {
    const list = await step('listing the folders', () =>
      c.list({ statusQuery: { messages: true, unseen: true } }),
    );
    return {
      folders: list
        .filter((f) => !f.flags.has('\\Noselect') && !f.flags.has('\\NonExistent'))
        .map((f) => ({
          folder: f.path,
          name: f.name,
          ...(f.specialUse && { specialUse: f.specialUse }),
          ...(f.status?.messages !== undefined && { messages: f.status.messages }),
          ...(f.status?.unseen !== undefined && { unread: f.status.unseen }),
        })),
    };
  });
};

const searchMessages: Run = (t, args, _ctx, signal) => {
  const m = parse(MailSearchInput, args);
  const path = m.folder ?? 'INBOX';
  const limit = m.limit ?? 20;
  return withImap(t, signal, (c) =>
    inFolder(c, path, false, async (validity) => {
      const query: SearchObject = {
        ...(m.query && { text: m.query }),
        ...(m.from && { from: m.from }),
        ...(m.to && { to: m.to }),
        ...(m.subject && { subject: m.subject }),
        ...(m.since && { since: new Date(`${m.since}T00:00:00Z`) }),
        ...(m.before && { before: new Date(`${m.before}T00:00:00Z`) }),
        ...(m.unreadOnly && { seen: false }),
        ...(m.flaggedOnly && { flagged: true }),
      };
      const found =
        (await step('searching', () =>
          c.search(Object.keys(query).length ? query : { all: true }, { uid: true }),
        )) || [];
      // UIDs grow as mail arrives: the highest are the newest.
      const newest = [...found].sort((a, b) => b - a).slice(0, limit);
      const rows: Record<string, unknown>[] = [];
      if (newest.length) {
        const fetched = await step('reading the mails found', () =>
          c.fetchAll(
            newest.join(','),
            { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
            { uid: true },
          ),
        );
        fetched.sort((a, b) => b.uid - a.uid);
        for (const msg of fetched) {
          const e = msg.envelope;
          rows.push({
            messageId: mailId({ folder: path, validity, uid: msg.uid }),
            date: dateOf(e?.date),
            from: addressLine(e?.from?.map((a) => ({ name: a.name ?? '', address: a.address }))) ?? null,
            to: addressLine(e?.to?.map((a) => ({ name: a.name ?? '', address: a.address }))) ?? null,
            subject: e?.subject ? oneLineOf(e.subject) : null,
            ...flagsOf(msg.flags),
            size: msg.size ?? null,
            hasAttachments: hasFiles(msg.bodyStructure),
          });
        }
      }
      return { folder: path, total: found.length, messages: rows };
    }),
  );
};

const getMessage: Run = (t, args, _ctx, signal) => {
  const m = parse(MessageIdInput, args);
  const ref = refOf(m.messageId);
  return withImap(t, signal, async (c) => {
    const { parsed, flags } = await readMail(c, ref);
    const body = bodyText(parsed);
    return {
      messageId: m.messageId,
      folder: ref.folder,
      from: addressLine([parsed.from]) ?? null,
      to: addressLine(parsed.to) ?? null,
      cc: addressLine(parsed.cc) ?? null,
      replyTo: addressLine(parsed.replyTo) ?? null,
      date: oneLineOf(headerIn(parsed, 'Date')) || null,
      subject: parsed.subject ? oneLineOf(parsed.subject) : null,
      ...flagsOf(flags),
      body:
        body.length > MAX_TEXT
          ? `${body.slice(0, MAX_TEXT)}\n… (cut: ${body.length} characters in all)`
          : body,
      attachments: fileList(filesIn(parsed)),
    };
  });
};

const downloadAttachment: Run = (t, args, ctx, signal) => {
  const m = parse(AttachmentInput, args);
  const save = ctx.saveFile;
  if (!save) throw new InputError('there is no conversation folder here to keep the file in');
  const ref = refOf(m.messageId);
  return withImap(t, signal, async (c) => {
    const files = filesIn((await readMail(c, ref)).parsed);
    if (!files.length) throw new InputError('the mail has no files');
    const indexed = files.map((f, i) => ({ f, i }));
    let chosen =
      m.attachmentIndex !== undefined
        ? indexed.filter((x) => x.i === m.attachmentIndex)
        : m.filename
          ? indexed.filter((x) => x.f.filename === m.filename)
          : // Every file it names; nameless pictures in the text are mostly logos.
            indexed.filter((x) => x.f.filename);
    if (!chosen.length && m.attachmentIndex === undefined && !m.filename) chosen = indexed;
    if (!chosen.length) {
      throw new InputError(
        `no file of the mail matches; call again with attachmentIndex from this list: ${JSON.stringify(fileList(files))}`,
      );
    }
    const saved: Record<string, unknown>[] = [];
    for (const { f, i } of chosen) {
      const entry = {
        attachmentIndex: i,
        filename: f.filename ?? null,
        mimeType: f.mimeType,
        size: f.data.length,
      };
      if (!f.data.length) saved.push({ ...entry, error: 'the file is empty' });
      else if (f.data.length > MAX_UPLOAD_BYTES) {
        saved.push({ ...entry, error: `larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, not kept` });
      } else saved.push({ ...entry, path: await save(nameFor(f, i), f.data) });
    }
    return {
      messageId: m.messageId,
      saved,
      note: 'Each file is in the conversation folder at its path: read it from there with the file tools.',
    };
  });
};

/** Marks the mail answered, if it can: the reply went whatever happens here. */
async function markAnswered(c: ImapFlow, ref: MailRef) {
  await inFolder(c, ref.folder, true, async (validity) => {
    if (validity === ref.validity) await c.messageFlagsAdd(String(ref.uid), ['\\Answered'], { uid: true });
  }).catch(() => undefined);
}

const sendMessage: Run = (t, args, _ctx, signal) => {
  const m = parse(MailSendInput, args);
  const files = filesOf(m.attachments);
  checkSize(files);
  const answering = m.replyToMessageId ? refOf(m.replyToMessageId) : null;
  return withImap(t, signal, async (c) => {
    let headers: { inReplyTo?: string; references?: string } = {};
    let subject = m.subject;
    if (answering) {
      const { parsed } = await readMail(c, answering);
      headers = threading(parsed);
      subject ??= replySubject(oneLineOf(parsed.subject));
    }
    const body = signed({ text: m.body, html: m.htmlBody }, t.settings, m.includeSignature);
    const out = await deliver(
      c,
      t,
      { to: m.to, cc: m.cc, bcc: m.bcc, subject, ...body, files, ...headers },
      signal,
    );
    // A mail that may not have gone does not mark the one it answers as answered.
    if (answering && out.sent === true) await markAnswered(c, answering);
    return out;
  });
};

const reply: Run = (t, args, _ctx, signal) => {
  const m = parse(MailReplyInput, args);
  const files = filesOf(m.attachments);
  checkSize(files);
  const ref = refOf(m.messageId);
  return withImap(t, signal, async (c) => {
    const { parsed } = await readMail(c, ref);
    const me = new Set([t.settings.address.toLowerCase(), mailUsername(t.settings).toLowerCase()]);
    const from = plain([parsed.from]);
    const replyTo = plain(parsed.replyTo);
    const theirTo = plain(parsed.to);
    const theirCc = plain(parsed.cc);
    const fromMe = from.some((a) => me.has(a.toLowerCase()));
    // Answering one's own mail goes on to whom it went.
    let to = fromMe ? theirTo : replyTo.length ? replyTo : from;
    let cc: string[] = [];
    if (m.replyAll) {
      to = unique([...to, ...(fromMe ? [] : theirTo)], me);
      cc = unique(theirCc, new Set([...me, ...to.map((a) => a.toLowerCase())]));
    }
    if (m.to) to = m.to;
    if (m.cc) cc = m.cc;
    if (!to.length) throw new InputError('the mail it answers names no one to reply to: give to');
    const body = signed({ text: m.body, html: m.htmlBody }, t.settings, m.includeSignature);
    const out = await deliver(
      c,
      t,
      {
        to,
        cc,
        bcc: m.bcc,
        subject: replySubject(oneLineOf(parsed.subject)),
        ...body,
        files,
        ...threading(parsed),
      },
      signal,
    );
    if (out.sent === true) await markAnswered(c, ref);
    return { ...out, to, cc };
  });
};

const forward: Run = (t, args, _ctx, signal) => {
  const m = parse(MailForwardInput, args);
  const added = filesOf(m.attachments);
  checkSize(added);
  const ref = refOf(m.messageId);
  return withImap(t, signal, async (c) => {
    const { parsed } = await readMail(c, ref);
    const carried = filesIn(parsed);
    checkSize([...carried, ...added]);
    const note = signed({ text: m.forwardText, html: m.htmlBody }, t.settings, m.includeSignature);
    const head = forwardHeader(quotedHead(parsed));
    const noteText = note.text ?? (note.html !== undefined ? textFromHtml(note.html) : '');
    const noteHtml = note.html ?? htmlFromText(note.text ?? '');
    const out = await deliver(
      c,
      t,
      {
        to: m.to ?? [],
        cc: m.cc,
        bcc: m.bcc,
        subject: forwardSubject(oneLineOf(parsed.subject)),
        text: [noteText, '', head.text, '', bodyText(parsed)].join('\n').trimStart(),
        html: `${noteHtml}<br><br>${head.html}<br>${parsed.html ?? htmlFromText(parsed.text ?? '')}`,
        files: [...carried, ...added],
      },
      signal,
    );
    return { ...out, originalMessageId: m.messageId };
  });
};

const updateFlags: Run = (t, args, _ctx, signal) => {
  const m = parse(FlagsInput, args);
  const refs = m.messageIds.map(refOf);
  const add = [...(m.seen ? ['\\Seen'] : []), ...(m.flagged ? ['\\Flagged'] : [])];
  const remove = [...(m.seen === false ? ['\\Seen'] : []), ...(m.flagged === false ? ['\\Flagged'] : [])];
  return withImap(t, signal, async (c) => {
    for (const [path, list] of byFolder(refs)) {
      await inFolder(c, path, true, async (validity) => {
        const range = uidsIn(list, validity).join(',');
        if (add.length) await step('changing the flags', () => c.messageFlagsAdd(range, add, { uid: true }));
        if (remove.length)
          await step('changing the flags', () => c.messageFlagsRemove(range, remove, { uid: true }));
      });
    }
    return {
      changed: refs.length,
      ...(m.seen !== undefined && { seen: m.seen }),
      ...(m.flagged !== undefined && { flagged: m.flagged }),
    };
  });
};

/** Moves mails to a folder; their ids change, so the new ones come back. */
async function moveTo(c: ImapFlow, refs: MailRef[], dest: string) {
  const moved: { from: string; to: string | null }[] = [];
  for (const [path, list] of byFolder(refs)) {
    await inFolder(c, path, true, async (validity) => {
      const uids = uidsIn(list, validity);
      const res = await step(`moving to ${dest}`, () => c.messageMove(uids.join(','), dest, { uid: true }));
      const map = res ? res.uidMap : undefined;
      const destValidity = res && res.uidValidity !== undefined ? res.uidValidity.toString() : null;
      for (const r of list) {
        const next = map?.get(r.uid);
        moved.push({
          from: mailId(r),
          to: next && destValidity ? mailId({ folder: dest, validity: destValidity, uid: next }) : null,
        });
      }
    });
  }
  return moved;
}

const moveMessages: Run = (t, args, _ctx, signal) => {
  const m = parse(MoveInput, args);
  const refs = m.messageIds.map(refOf);
  return withImap(t, signal, async (c) => {
    const list = await step('listing the folders', () => c.list());
    if (!list.some((f) => f.path === m.folder)) {
      throw new InputError(
        `no folder ${JSON.stringify(m.folder)}; the folders are: ${JSON.stringify(list.map((f) => f.path))}`,
      );
    }
    return { folder: m.folder, moved: await moveTo(c, refs, m.folder) };
  });
};

const trashMessages: Run = (t, args, _ctx, signal) => {
  const m = parse(TrashInput, args);
  const refs = m.messageIds.map(refOf);
  return withImap(t, signal, async (c) => {
    const list = await step('listing the folders', () => c.list());
    const trash = list.find((f) => f.specialUse === '\\Trash');
    if (!trash)
      throw new InputError('the account has no Trash folder: move the mails to a folder with move_messages');
    if (refs.some((r) => r.folder === trash.path))
      throw new InputError('these mails are in the Trash already');
    return { folder: trash.path, moved: await moveTo(c, refs, trash.path) };
  });
};

// ---------------------------------------------------------------------------------------------
// The tools' descriptions, as the bot reads them

const recipientsSchema = (what: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `${what} Each a plain email address (user@example.com).`,
});
const idsSchema = {
  type: 'array',
  items: { type: 'string' },
  description: `Mails as search_messages gave their messageId, ${MAX_IDS} at most.`,
};
const attachmentsSchema = {
  type: 'array',
  description: 'Files to attach, 25 MB together at most. Share larger files by a link in the body.',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['content'],
    properties: {
      content: { type: 'string', description: 'The file, base64-encoded.' },
      filename: { type: 'string', description: 'The name recipients see, e.g. "invoice.pdf".' },
      mimeType: { type: 'string', description: 'The media type; application/octet-stream when left out.' },
      inline: {
        type: 'boolean',
        description:
          'Shown inside htmlBody rather than listed as a file: add <img src="cid:attN">, N being its zero-based place among all attachments.',
      },
    },
  },
};
const bodySchema = {
  type: 'string',
  description: 'Plain text body. No Markdown. With htmlBody, it is the plain-text alternative.',
};
const htmlSchema = { type: 'string', description: 'HTML body, for formatted text.' };
const signatureSchema = {
  type: 'boolean',
  description: "Add the signature set in the account's settings at the end. Defaults to false.",
};
const messageIdSchema = (what: string) => ({
  type: 'string',
  description: `${what}, as search_messages gave it.`,
});

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length && { required }),
  properties,
});

interface LocalTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: 'read' | 'write';
  run: Run;
}

const SENT_NOTE =
  ' A copy goes to the Sent folder unless the account is set not to keep one. If the answer has savedToSent false with a note, the mail was still sent: do not send it again. `rejected` lists recipients the server turned away; the others got it. `sent: "unknown"` means the connection dropped after the mail went over: it may have been sent, so tell the person and do not send it again unasked.';

const TOOLS: LocalTool[] = [
  {
    name: 'list_folders',
    title: 'List folders',
    description:
      'Lists the folders of the mail account with how many mails and unread mails each holds. specialUse marks the Inbox, Sent, Drafts, Trash, Junk and Archive folders, whatever they are called. Give a folder path from here to search_messages or move_messages.',
    inputSchema: object({}),
    kind: 'read',
    run: listFolders,
  },
  {
    name: 'search_messages',
    title: 'Search email',
    description:
      "Finds mails in one folder of the mail account (the Inbox unless `folder` is given), newest first. Every condition given must match: `query` looks in the whole mail, `from`, `to` and `subject` in those fields; `since` and `before` are days (YYYY-MM-DD, before is exclusive). With no condition it lists the newest mails. Returns each mail's messageId, date, sender, recipients, subject, whether it is read, flagged or answered, and whether it has files, plus how many matched in all. Read one with get_message.",
    inputSchema: object({
      folder: {
        type: 'string',
        description: 'The folder to search, as list_folders gave it. Defaults to INBOX.',
      },
      query: { type: 'string', description: 'Words to find anywhere in the mail.' },
      from: { type: 'string', description: 'Part of the sender address or name.' },
      to: { type: 'string', description: 'Part of a recipient address or name.' },
      subject: { type: 'string', description: 'Part of the subject.' },
      since: { type: 'string', description: 'Mails from this day on, YYYY-MM-DD.' },
      before: { type: 'string', description: 'Mails before this day, YYYY-MM-DD.' },
      unreadOnly: { type: 'boolean', description: 'Only unread mails.' },
      flaggedOnly: { type: 'boolean', description: 'Only flagged mails.' },
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many to return, 20 by default.' },
    }),
    kind: 'read',
    run: searchMessages,
  },
  {
    name: 'get_message',
    title: 'Get email',
    description:
      'Reads one mail of the mail account: its sender, recipients, date, subject, whether it is read, flagged or answered, its text, and the list of its files (name, type, size and attachmentIndex). Reading it does not mark it read. To read a file, call download_attachment.',
    inputSchema: object({ messageId: messageIdSchema('The mail to read') }, ['messageId']),
    kind: 'read',
    run: getMessage,
  },
  {
    name: 'download_attachment',
    title: 'Download attachment',
    description:
      "Saves the files of a mail (PDF, Excel, Word, pictures and the like) into this conversation's folder so they can be opened and read with the file tools. Give the mail's `messageId`, and to pick one file its `attachmentIndex` (from get_message) or its `filename`. Left out, every named file of the mail is saved. Returns each saved file's path, name, type and size.",
    inputSchema: object(
      {
        messageId: messageIdSchema('The mail the file belongs to'),
        attachmentIndex: {
          type: 'integer',
          minimum: 0,
          description: "The file's place among the mail's files, as get_message listed it.",
        },
        filename: { type: 'string', description: "The file's name, as the mail lists it." },
      },
      ['messageId'],
    ),
    kind: 'read',
    run: downloadAttachment,
  },
  {
    name: 'send_message',
    title: 'Send email',
    description:
      "Sends an email from the mail account right away. Give recipients in `to` (and `cc`, `bcc`), a `subject`, and the content in `body` (plain text) or `htmlBody` (HTML). To send it as an answer inside a conversation, give `replyToMessageId`; the subject then defaults to that mail's. Returns the sent mail's Message-ID." +
      SENT_NOTE,
    inputSchema: object(
      {
        to: recipientsSchema('Recipients.'),
        cc: recipientsSchema('Carbon copy recipients.'),
        bcc: recipientsSchema('Blind carbon copy recipients.'),
        subject: { type: 'string', description: 'The subject line.' },
        body: bodySchema,
        htmlBody: htmlSchema,
        attachments: attachmentsSchema,
        includeSignature: signatureSchema,
        replyToMessageId: messageIdSchema('The mail this one answers, in its conversation'),
      },
      ['to'],
    ),
    kind: 'write',
    run: sendMessage,
  },
  {
    name: 'reply',
    title: 'Reply to email',
    description:
      "Replies to a mail of the mail account, in its conversation. Give the `messageId` of the mail to answer and the content in `body` or `htmlBody`. The reply goes to the sender (or the mail's Reply-To); with `replyAll` also to everyone else on the mail. `to`, `cc` and `bcc` replace those recipients when given. Returns the sent mail's Message-ID and who it went to." +
      SENT_NOTE,
    inputSchema: object(
      {
        messageId: messageIdSchema('The mail to answer'),
        body: bodySchema,
        htmlBody: htmlSchema,
        replyAll: { type: 'boolean', description: 'Reply to everyone on the mail. Defaults to false.' },
        to: recipientsSchema('Replaces who the reply goes to.'),
        cc: recipientsSchema('Replaces the carbon copy recipients.'),
        bcc: recipientsSchema('Blind carbon copy recipients.'),
        includeSignature: signatureSchema,
        attachments: attachmentsSchema,
      },
      ['messageId'],
    ),
    kind: 'write',
    run: reply,
  },
  {
    name: 'forward',
    title: 'Forward email',
    description:
      "Forwards a mail of the mail account, with its files. Give the `messageId` of the mail, recipients in `to` (and `cc`, `bcc`), and an optional note above it in `forwardText` (plain text) or `htmlBody` (HTML). `attachments` adds files to those the mail already has. Returns the sent mail's Message-ID." +
      SENT_NOTE,
    inputSchema: object(
      {
        messageId: messageIdSchema('The mail to forward'),
        to: recipientsSchema('Recipients.'),
        cc: recipientsSchema('Carbon copy recipients.'),
        bcc: recipientsSchema('Blind carbon copy recipients.'),
        forwardText: {
          type: 'string',
          description: 'A note above the forwarded mail, plain text. No Markdown.',
        },
        htmlBody: { type: 'string', description: 'The note above the forwarded mail, as HTML.' },
        includeSignature: signatureSchema,
        attachments: attachmentsSchema,
      },
      ['messageId'],
    ),
    kind: 'write',
    run: forward,
  },
  {
    name: 'update_message_flags',
    title: 'Mark email',
    description:
      'Marks mails of the mail account read or unread (`seen`) and flagged or not (`flagged`). Give their `messageIds` and what to change.',
    inputSchema: object(
      {
        messageIds: idsSchema,
        seen: { type: 'boolean', description: 'true marks them read, false unread.' },
        flagged: { type: 'boolean', description: 'true flags them, false takes the flag off.' },
      },
      ['messageIds'],
    ),
    kind: 'write',
    run: updateFlags,
  },
  {
    name: 'move_messages',
    title: 'Move email',
    description:
      'Moves mails of the mail account to another folder, as list_folders names it. A moved mail gets a new messageId there: the answer gives each old id with its new one (null when the server does not say).',
    inputSchema: object(
      {
        messageIds: idsSchema,
        folder: { type: 'string', description: 'The folder to move them to, as list_folders gave it.' },
      },
      ['messageIds', 'folder'],
    ),
    kind: 'write',
    run: moveMessages,
  },
  {
    name: 'trash_message',
    title: 'Move email to Trash',
    description:
      'Moves mails of the mail account to its Trash folder, where they can still be taken back with move_messages until the provider empties it. Give their `messageIds`. The answer gives each old id with its new one in the Trash.',
    inputSchema: object({ messageIds: idsSchema }, ['messageIds']),
    kind: 'write',
    run: trashMessages,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------------------------
// Joining a connection

/** A mail account's tools, each keeping the switch it had in `kept`. */
export function mailTools(kept: StoredConnectionTool[]): StoredConnectionTool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    hinted: t.kind,
    kind: kept.find((k) => k.name === t.name && k.local === 'mail')?.kind ?? null,
    enabled: kept.find((k) => k.name === t.name && k.local === 'mail')?.enabled ?? true,
    local: 'mail' as const,
  }));
}

/**
 * Whether a connection's tool reads or changes, as the bot's turn treats it. A tool this server
 * runs that sends or changes mail is always a change, whatever the person set it to: only its card
 * stands between the bot and the account.
 */
export function toolKind(
  t: Pick<StoredConnectionTool, 'name' | 'kind' | 'hinted' | 'local'>,
): 'read' | 'write' {
  if (t.local === 'mail') return BY_NAME.get(t.name)?.kind !== 'read' ? 'write' : (t.kind ?? t.hinted);
  return gmailToolKind(t);
}

/** Who the account sends as, for the mail card: its address, and its signature as HTML. */
export function mailSender(settings: MailSettings): MailSender {
  const signature = settings.signature.trim();
  return { address: settings.address, signature: signature ? htmlFromText(signature) : null };
}

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * Runs one of a mail account's tools. A refusal after signing in comes back with the step and the
 * server's own words; a sign-in that fails, or a server that cannot be reached, throws a
 * connection error, as an MCP server's would.
 */
export async function runMailTool(
  t: MailTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  ctx: MailToolContext = {},
): Promise<CallToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return fail(`No such mail tool: ${name}`);
  try {
    const out = await tool.run(t, args, ctx, signal);
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  } catch (err) {
    if (err instanceof InputError) return fail(`Nothing was done: ${err.message}`);
    if (err instanceof StepError) {
      const outcome = tool.kind === 'read' ? '' : ', so nothing was sent or changed at that step';
      return fail(`The mail server refused ${err.step}${outcome}: ${err.said.slice(0, 2000)}`);
    }
    throw err;
  }
}
