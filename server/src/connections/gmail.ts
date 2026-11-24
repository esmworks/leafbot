import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, type MailSender } from '@leafbot/shared';
import type { StoredConnectionTool } from '../db/schema';
import { fetchSignedIn, type ClientTarget } from './client';
import {
  addressesIn,
  forwardHeader,
  forwardSubject,
  headerOf,
  htmlFromText,
  messageIds,
  mimeMessage,
  readParts,
  replySubject,
  textFromHtml,
  withSignature,
  type GmailPart,
  type Mail,
  type MailFile,
} from './gmail-mime';

/**
 * The Gmail tools a Gmail connection's MCP server does not list: sending and changing mail, and
 * reading a mail whole with its files. The sign-in already holds the readonly, compose and modify
 * scopes, which let the Gmail API do what these tools do; this server adds each missing tool
 * under the server's own name and input where it has one, and runs it through that API. Once the
 * server lists a tool itself, the added one goes and the server's is used.
 */
const GMAIL_MCP_HOST = 'gmailmcp.googleapis.com';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

/** The most recipients and characters a mail may carry; more is surely a mistake. */
const MAX_RECIPIENTS = 100;
const MAX_BODY = 500_000;
/** Gmail's own limit on a mail's files together. */
const MAX_FILES_BYTES = 25 * 1024 * 1024;
/** Past this a mail goes as an upload: a request with the mail inside its JSON is held to less. */
const JSON_LIMIT = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// Input

const address = z
  .string()
  .trim()
  .max(320)
  // A plain address: no name part, no line break that would start another header.
  .regex(/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/, 'a plain email address, e.g. user@example.com');
const recipients = z.array(address).max(MAX_RECIPIENTS);
const oneLine = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\r\n\0]/.test(s), 'one line, with no line break');
/** An id as Gmail gives it; it goes into a URL path. */
const gmailId = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/, 'an id as Gmail gave it');
const text = z.string().max(MAX_BODY);

const attachment = z
  .object({
    content: z
      .string()
      .min(1)
      .transform((s) => s.replace(/\s/g, ''))
      .refine((s) => /^[A-Za-z0-9+/_-]*={0,2}$/.test(s), 'base64'),
    filename: oneLine(255).optional(),
    mimeType: z
      .string()
      .regex(/^[\w.+-]+\/[\w.+-]+$/, 'a media type such as application/pdf')
      .optional(),
    inline: z.boolean().optional(),
  })
  .strict();
type Attachment = z.infer<typeof attachment>;
const attachments = z.array(attachment).max(100);

/** What `send_message` takes. Unknown keys are refused: the card shows every field that goes out. */
export const GmailSendInput = z
  .object({
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: oneLine(998).optional(),
    body: text.optional(),
    htmlBody: text.optional(),
    attachments: attachments.optional(),
    includeSignature: z.boolean().optional(),
    replyThreadId: gmailId.optional(),
    replyToMessageId: gmailId.optional(),
    draftId: gmailId.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (m.draftId !== undefined) {
      // The draft goes as it is; anything else given would show on the card and not go.
      if (Object.keys(m).length > 1) issue('draftId sends the draft as it is: give nothing else with it');
      return;
    }
    if (!m.to?.length) issue('to is required');
    if (m.body === undefined && m.htmlBody === undefined && !m.attachments?.length) {
      issue('body or htmlBody is required');
    }
    if (m.replyThreadId && m.replyToMessageId) issue('give replyThreadId or replyToMessageId, not both');
  });

export const GmailReplyInput = z
  .object({
    messageId: gmailId,
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

export const GmailForwardInput = z
  .object({
    messageId: gmailId,
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

export const GmailUpdateDraftInput = z
  .object({
    draftId: gmailId,
    to: recipients.optional(),
    cc: recipients.optional(),
    bcc: recipients.optional(),
    subject: oneLine(998).optional(),
    body: text.optional(),
    htmlBody: text.optional(),
    attachments: attachments.optional(),
  })
  .strict();

const DraftIdInput = z.object({ draftId: gmailId }).strict();
const LabelIdInput = z.object({ labelId: gmailId }).strict();
const MessageIdInput = z.object({ messageId: gmailId }).strict();
const ThreadIdInput = z.object({ threadId: gmailId }).strict();

export const GmailAttachmentInput = z
  .object({
    messageId: gmailId,
    attachmentId: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_-]+$/, 'an id as Gmail gave it')
      .optional(),
    filename: z.string().max(1000).optional(),
    attachmentIndex: z.number().int().min(0).max(1000).optional(),
    mimeType: z.string().max(255).optional(),
  })
  .strict();

const labelIds = z.array(gmailId).max(100);
const labelChange = { addLabelIds: labelIds.optional(), removeLabelIds: labelIds.optional() };
const someChange = (m: { addLabelIds?: string[]; removeLabelIds?: string[] }) =>
  !!(m.addLabelIds?.length || m.removeLabelIds?.length);
const MessageLabelsInput = z
  .object({ messageId: gmailId, ...labelChange })
  .strict()
  .refine(someChange, 'give addLabelIds or removeLabelIds');
const ThreadLabelsInput = z
  .object({ threadId: gmailId, ...labelChange })
  .strict()
  .refine(someChange, 'give addLabelIds or removeLabelIds');

/** Each preset's colors, as Gmail's own label palette has them. */
const LABEL_COLORS = {
  LABEL_COLOR_PRESET_BLACK: ['#000000', '#ffffff'],
  LABEL_COLOR_PRESET_DARK_GRAY: ['#434343', '#ffffff'],
  LABEL_COLOR_PRESET_GRAY: ['#666666', '#ffffff'],
  LABEL_COLOR_PRESET_LIGHT_GRAY: ['#cccccc', '#000000'],
  LABEL_COLOR_PRESET_WHITE: ['#ffffff', '#000000'],
  LABEL_COLOR_PRESET_RED: ['#fb4c2f', '#ffffff'],
  LABEL_COLOR_PRESET_ORANGE: ['#ffad47', '#000000'],
  LABEL_COLOR_PRESET_YELLOW: ['#fad165', '#000000'],
  LABEL_COLOR_PRESET_GREEN: ['#16a765', '#ffffff'],
  LABEL_COLOR_PRESET_MINT: ['#43d692', '#000000'],
  LABEL_COLOR_PRESET_TEAL: ['#2da2bb', '#ffffff'],
  LABEL_COLOR_PRESET_BLUE: ['#4a86e8', '#ffffff'],
  LABEL_COLOR_PRESET_PURPLE: ['#a479e2', '#ffffff'],
  LABEL_COLOR_PRESET_PINK: ['#f691b2', '#000000'],
  LABEL_COLOR_PRESET_DARK_RED: ['#822111', '#ffffff'],
  LABEL_COLOR_PRESET_DARK_ORANGE: ['#a46a21', '#ffffff'],
  LABEL_COLOR_PRESET_DARK_GREEN: ['#076239', '#ffffff'],
  LABEL_COLOR_PRESET_DARK_BLUE: ['#1c4587', '#ffffff'],
  LABEL_COLOR_PRESET_DARK_PURPLE: ['#41236d', '#ffffff'],
  LABEL_COLOR_PRESET_DARK_PINK: ['#83334c', '#ffffff'],
  LABEL_COLOR_PRESET_BROWN: ['#7a4706', '#ffffff'],
} as const satisfies Record<string, readonly [string, string]>;
type ColorPreset = keyof typeof LABEL_COLORS;
const PRESETS = Object.keys(LABEL_COLORS) as [ColorPreset, ...ColorPreset[]];

const LABEL_LIST = {
  LABEL_SHOW: 'labelShow',
  LABEL_SHOW_IF_UNREAD: 'labelShowIfUnread',
  LABEL_HIDE: 'labelHide',
};
const MESSAGE_LIST = { SHOW: 'show', HIDE: 'hide' };

export const GmailUpdateLabelInput = z
  .object({
    labelId: gmailId,
    displayName: oneLine(225).optional(),
    colorPreset: z.enum(PRESETS).optional(),
    labelListVisibility: z.enum(['LABEL_SHOW', 'LABEL_SHOW_IF_UNREAD', 'LABEL_HIDE']).optional(),
    messageListVisibility: z.enum(['SHOW', 'HIDE']).optional(),
  })
  .strict()
  .refine((m) => Object.keys(m).length > 1, 'give at least one thing to change');

// ---------------------------------------------------------------------------------------------
// Talking to the Gmail API

/** Google refused a request: its status and its own words, so the bot (and the person) see why. */
class GmailError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 2000)}`);
  }
}

class Gmail {
  constructor(
    private target: ClientTarget,
    private signal?: AbortSignal,
    /** Off for a read nobody asked for: see `fetchSignedIn`. */
    private noteScope = true,
  ) {}

  async request<T>(method: string, url: string, body?: { json: unknown } | { raw: string; type: string }) {
    const init: RequestInit = { method, ...(this.signal ? { signal: this.signal } : {}) };
    if (body && 'json' in body) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body.json);
    } else if (body) {
      init.headers = { 'Content-Type': body.type };
      init.body = body.raw;
    }
    const res = await fetchSignedIn(this.target, url, init, { noteScope: this.noteScope });
    const out = await res.text();
    if (!res.ok) throw new GmailError(res.status, out);
    if (!out) return {} as T;
    try {
      return JSON.parse(out) as T;
    } catch {
      return {} as T;
    }
  }

  get<T>(path: string) {
    return this.request<T>('GET', `${API}${path}`);
  }

  /**
   * Posts a mail: inside the JSON while it is small, as an upload beside the JSON when it is
   * large. `wrap` puts the mail where the call wants it (`{raw}` or `{message: {raw}}`).
   */
  postMail<T>(method: string, path: string, mime: string, wrap: (raw?: string) => Record<string, unknown>) {
    if (mime.length <= JSON_LIMIT) {
      return this.request<T>(method, `${API}${path}`, {
        json: wrap(Buffer.from(mime, 'utf8').toString('base64url')),
      });
    }
    const boundary = `leaf-upload-${crypto.randomUUID()}`;
    const raw = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(wrap()),
      `--${boundary}`,
      'Content-Type: message/rfc822',
      '',
      mime,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    return this.request<T>(method, `${UPLOAD}${path}?uploadType=multipart`, {
      raw,
      type: `multipart/related; boundary=${boundary}`,
    });
  }

  /** The account's addresses, and the one Gmail sends from by default with its signature. */
  async sendAs(): Promise<{ addresses: Set<string>; address: string | null; signature: string }> {
    const r = await this.get<{
      sendAs?: { sendAsEmail?: string; isDefault?: boolean; signature?: string }[];
    }>('/settings/sendAs');
    const list = r.sendAs ?? [];
    const main = list.find((s) => s.isDefault) ?? list[0];
    return {
      addresses: new Set(list.map((s) => (s.sendAsEmail ?? '').toLowerCase()).filter(Boolean)),
      address: main?.sendAsEmail ?? null,
      signature: main?.signature ?? '',
    };
  }

  async message(id: string, format: 'metadata' | 'full') {
    return this.get<GmailMessage>(`/messages/${id}?format=${format}`);
  }

  /** A file of a message, its content fetched when Gmail keeps it apart. */
  async file(messageId: string, f: ReturnType<typeof readParts>['files'][number]): Promise<MailFile> {
    let data = f.data;
    if (!data && f.attachmentId) {
      data = (await this.get<{ data?: string }>(`/messages/${messageId}/attachments/${f.attachmentId}`)).data;
    }
    return {
      filename: f.filename,
      mimeType: f.mimeType,
      data: Buffer.from(data ?? '', 'base64url'),
      ...(f.contentId && { contentId: f.contentId }),
    };
  }
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

/** A Gmail call failed at one step: nothing was sent or changed, and the step is named. */
class StepError extends Error {
  constructor(
    readonly step: string,
    readonly refusal: GmailError,
  ) {
    super(step);
  }
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof GmailError) throw new StepError(name, err);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Building a mail

/** The bot's files, each inline one named `attN` by its place among them all, as the tools say. */
function filesOf(list: Attachment[] | undefined): MailFile[] {
  return (list ?? []).map((a, i) => ({
    ...(a.filename && { filename: a.filename }),
    mimeType: a.mimeType ?? 'application/octet-stream',
    data: Buffer.from(a.content, 'base64'),
    ...(a.inline && { contentId: `att${i}` }),
  }));
}

function checkSize(files: MailFile[]) {
  const total = files.reduce((n, f) => n + f.data.length, 0);
  if (total > MAX_FILES_BYTES) {
    throw new InputError(
      `the files come to ${Math.ceil(total / 1024 / 1024)} MB; Gmail takes 25 MB at most. Put larger files in Drive and send the link.`,
    );
  }
}

/** The input could not make a mail; nothing was sent. */
class InputError extends Error {}

/** A header's value from someone else's mail, as one line. */
const oneLineOf = (s: string | undefined) => (s ?? '').replace(/[\r\n\0]+/g, ' ').trim();

/** The reply headers that keep a mail in the conversation it answers. */
function threading(original: GmailPart | undefined) {
  const id = messageIds(headerOf(original, 'Message-ID'))[0];
  if (!id) return {};
  const chain = [...messageIds(headerOf(original, 'References')), id];
  return { inReplyTo: id, references: chain.slice(-20).join(' ') };
}

const unique = (list: string[], drop: Set<string>) => {
  const seen = new Set(drop);
  return list.filter((a) => {
    const k = a.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

const boundary = () => `leaf-${crypto.randomUUID()}`;
const mime = (m: Mail) => mimeMessage(m, boundary());

// ---------------------------------------------------------------------------------------------
// The tools

/** What a tool may use besides Gmail. */
export interface GmailToolContext {
  /**
   * Keeps a file in the conversation's folder under a free name made from `name`, and gives back
   * its path; absent where there is no conversation to keep it in.
   */
  saveFile?: (name: string, data: Buffer) => Promise<string>;
}

type Run = (
  gmail: Gmail,
  args: Record<string, unknown>,
  ctx: GmailToolContext,
) => Promise<Record<string, unknown>>;

interface LocalTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Whether it only reads the account, or sends or changes something in it. */
  kind: 'read' | 'write';
  run: Run;
}

/** Parses the input, or stops before anything is sent. */
function parse<S extends z.ZodTypeAny>(schema: S, args: Record<string, unknown>): z.infer<S> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new InputError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
    );
  }
  return parsed.data as z.infer<S>;
}

const sendMessage: Run = async (gmail, args) => {
  const m = parse(GmailSendInput, args);
  if (m.draftId) {
    const sent = await step('sending the draft', () =>
      gmail.request<{ id?: string; threadId?: string; labelIds?: string[] }>('POST', `${API}/drafts/send`, {
        json: { id: m.draftId },
      }),
    );
    return {
      sent: true,
      id: sent.id ?? null,
      threadId: sent.threadId ?? null,
      labelIds: sent.labelIds ?? [],
    };
  }
  const files = filesOf(m.attachments);
  checkSize(files);
  let threadId: string | undefined;
  let headers: { inReplyTo?: string; references?: string } = {};
  let subject = m.subject;
  // A mail in a conversation needs the thread, the reply headers and a matching subject together.
  if (m.replyToMessageId) {
    const original = await step('reading the mail it answers', () =>
      gmail.message(m.replyToMessageId!, 'metadata'),
    );
    threadId = original.threadId;
    headers = threading(original.payload);
    subject ??= replySubject(oneLineOf(headerOf(original.payload, 'Subject')));
  } else if (m.replyThreadId) {
    const thread = await step('reading the conversation', () =>
      gmail.get<{ id?: string; messages?: GmailMessage[] }>(`/threads/${m.replyThreadId}?format=metadata`),
    );
    const last = thread.messages?.at(-1);
    threadId = thread.id ?? m.replyThreadId;
    headers = threading(last?.payload);
    subject ??= replySubject(oneLineOf(headerOf(last?.payload, 'Subject')));
  }
  let body: { text?: string; html?: string } = { text: m.body, html: m.htmlBody };
  if (m.includeSignature) {
    const { signature } = await step('reading the signature', () => gmail.sendAs());
    body = withSignature(body, signature);
  }
  const raw = mime({
    to: m.to!,
    cc: m.cc,
    bcc: m.bcc,
    subject,
    ...body,
    files,
    ...headers,
  });
  const sent = await step('sending', () =>
    gmail.postMail<{ id?: string; threadId?: string }>('POST', '/messages/send', raw, (r) => ({
      ...(r !== undefined && { raw: r }),
      ...(threadId && { threadId }),
    })),
  );
  return { sent: true, id: sent.id ?? null, threadId: sent.threadId ?? null };
};

const reply: Run = async (gmail, args) => {
  const m = parse(GmailReplyInput, args);
  const files = filesOf(m.attachments);
  checkSize(files);
  const original = await step('reading the mail it answers', () => gmail.message(m.messageId, 'metadata'));
  const me = await step('reading the account', () => gmail.sendAs());
  const p = original.payload;
  const from = addressesIn(headerOf(p, 'From'));
  const replyTo = addressesIn(headerOf(p, 'Reply-To'));
  const theirTo = addressesIn(headerOf(p, 'To'));
  const theirCc = addressesIn(headerOf(p, 'Cc'));
  const fromMe = from.some((a) => me.addresses.has(a.toLowerCase()));
  // Answering one's own mail goes on to whom it went, as Gmail does.
  let to = fromMe ? theirTo : replyTo.length ? replyTo : from;
  let cc: string[] = [];
  if (m.replyAll) {
    to = unique([...to, ...(fromMe ? [] : theirTo)], me.addresses);
    cc = unique(theirCc, new Set([...me.addresses, ...to.map((a) => a.toLowerCase())]));
  }
  if (m.to) to = m.to;
  if (m.cc) cc = m.cc;
  if (!to.length) throw new InputError('the mail it answers names no one to reply to: give to');
  let body: { text?: string; html?: string } = { text: m.body, html: m.htmlBody };
  if (m.includeSignature) body = withSignature(body, me.signature);
  const raw = mime({
    to,
    cc,
    bcc: m.bcc,
    subject: replySubject(oneLineOf(headerOf(p, 'Subject'))),
    ...body,
    files,
    ...threading(p),
  });
  const sent = await step('sending', () =>
    gmail.postMail<{ id?: string; threadId?: string }>('POST', '/messages/send', raw, (r) => ({
      ...(r !== undefined && { raw: r }),
      ...(original.threadId && { threadId: original.threadId }),
    })),
  );
  return { sent: true, id: sent.id ?? null, threadId: sent.threadId ?? null, to, cc };
};

const forward: Run = async (gmail, args) => {
  const m = parse(GmailForwardInput, args);
  const added = filesOf(m.attachments);
  checkSize(added);
  const original = await step('reading the mail to forward', () => gmail.message(m.messageId, 'full'));
  const read = readParts(original.payload);
  // Too large already by what Gmail says of its files: none is fetched.
  checkSize([...added, ...read.files.map((f) => ({ data: { length: f.size } }) as MailFile)]);
  const carried: MailFile[] = [];
  for (const f of read.files) {
    carried.push(
      await step(`reading the file ${f.filename ?? 'with no name'}`, () => gmail.file(m.messageId, f)),
    );
    checkSize([...added, ...carried]);
  }
  let note: { text?: string; html?: string } = { text: m.forwardText, html: m.htmlBody };
  if (m.includeSignature) {
    const { signature } = await step('reading the signature', () => gmail.sendAs());
    note = withSignature(note, signature);
  }
  const head = forwardHeader(original.payload);
  const noteText = note.text ?? (note.html !== undefined ? textFromHtml(note.html) : '');
  const noteHtml = note.html ?? htmlFromText(note.text ?? '');
  const raw = mime({
    to: m.to ?? [],
    cc: m.cc,
    bcc: m.bcc,
    subject: forwardSubject(oneLineOf(headerOf(original.payload, 'Subject'))),
    text: [noteText, '', head.text, '', read.text ?? textFromHtml(read.html ?? '')].join('\n').trimStart(),
    html: `${noteHtml}<br><br>${head.html}<br>${read.html ?? htmlFromText(read.text ?? '')}`,
    files: [...carried, ...added],
  });
  const sent = await step('sending', () =>
    gmail.postMail<{ id?: string; threadId?: string }>('POST', '/messages/send', raw, (r) => ({
      ...(r !== undefined && { raw: r }),
    })),
  );
  return { sent: true, id: sent.id ?? null, threadId: sent.threadId ?? null, originalMessageId: m.messageId };
};

const updateDraft: Run = async (gmail, args) => {
  const m = parse(GmailUpdateDraftInput, args);
  const draft = await step('reading the draft', () =>
    gmail.get<{ id?: string; message?: GmailMessage }>(`/drafts/${m.draftId}?format=full`),
  );
  const p = draft.message?.payload;
  const was = readParts(p);
  const given = (list: string[] | undefined) => (list?.length ? list : undefined);
  // A body given alone replaces both versions, as the server's own tool does.
  const body =
    m.body !== undefined || m.htmlBody !== undefined
      ? { text: m.body, html: m.htmlBody }
      : { text: was.text, html: was.html };
  let files: MailFile[];
  if (m.attachments) {
    files = filesOf(m.attachments);
  } else {
    // Files the draft has stay: dropping them because the bot did not repeat them would lose them.
    files = [];
    const messageId = draft.message?.id;
    for (const f of was.files) {
      if (!messageId) break;
      files.push(
        await step(`reading the file ${f.filename ?? 'with no name'}`, () => gmail.file(messageId, f)),
      );
    }
  }
  checkSize(files);
  const raw = mime({
    // A draft written from one of the account's aliases keeps going from it.
    ...(addressesIn(headerOf(p, 'From'))[0] && { from: addressesIn(headerOf(p, 'From'))[0] }),
    to: given(m.to) ?? addressesIn(headerOf(p, 'To')),
    cc: given(m.cc) ?? addressesIn(headerOf(p, 'Cc')),
    bcc: given(m.bcc) ?? addressesIn(headerOf(p, 'Bcc')),
    subject: m.subject || oneLineOf(headerOf(p, 'Subject')),
    ...body,
    files,
    // A reply kept as a draft stays a reply.
    ...(messageIds(headerOf(p, 'In-Reply-To'))[0] && {
      inReplyTo: messageIds(headerOf(p, 'In-Reply-To'))[0],
      references: messageIds(headerOf(p, 'References')).join(' '),
    }),
  });
  const threadId = draft.message?.threadId;
  const saved = await step('saving the draft', () =>
    gmail.postMail<{ id?: string; message?: { id?: string; threadId?: string } }>(
      'PUT',
      `/drafts/${m.draftId}`,
      raw,
      (r) => ({
        id: m.draftId,
        message: { ...(r !== undefined && { raw: r }), ...(threadId && { threadId }) },
      }),
    ),
  );
  return {
    updated: true,
    id: saved.id ?? m.draftId,
    messageId: saved.message?.id ?? null,
    threadId: saved.message?.threadId ?? null,
  };
};

const deleteDraft: Run = async (gmail, args) => {
  const m = parse(DraftIdInput, args);
  await step('deleting the draft', () => gmail.request('DELETE', `${API}/drafts/${m.draftId}`));
  return { deleted: true, draftId: m.draftId };
};

const updateLabel: Run = async (gmail, args) => {
  const m = parse(GmailUpdateLabelInput, args);
  const color = m.colorPreset && LABEL_COLORS[m.colorPreset];
  const label = await step('changing the label', () =>
    gmail.request<Record<string, unknown>>('PATCH', `${API}/labels/${m.labelId}`, {
      json: {
        ...(m.displayName !== undefined && { name: m.displayName }),
        ...(color && { color: { backgroundColor: color[0], textColor: color[1] } }),
        ...(m.labelListVisibility && { labelListVisibility: LABEL_LIST[m.labelListVisibility] }),
        ...(m.messageListVisibility && { messageListVisibility: MESSAGE_LIST[m.messageListVisibility] }),
      },
    }),
  );
  return { updated: true, label };
};

const deleteLabel: Run = async (gmail, args) => {
  const m = parse(LabelIdInput, args);
  await step('deleting the label', () => gmail.request('DELETE', `${API}/labels/${m.labelId}`));
  return { deleted: true, labelId: m.labelId };
};

/** The files of a mail as the bot sees them: numbered by their place, for `download_attachment`. */
function fileList(files: ReturnType<typeof readParts>['files']) {
  return files.map((f, i) => ({
    attachmentIndex: i,
    filename: f.filename ?? null,
    mimeType: f.mimeType,
    size: f.size,
    ...(f.attachmentId && { attachmentId: f.attachmentId }),
    // A picture the mail's HTML shows in its text, such as a signature's logo.
    ...(f.contentId && { inline: true }),
  }));
}

/** A mail as the bot reads it: who and when, its text, and its files. */
function mailView(msg: GmailMessage) {
  const p = msg.payload;
  const read = readParts(p);
  const header = (name: string) => oneLineOf(headerOf(p, name)) || undefined;
  return {
    id: msg.id ?? null,
    threadId: msg.threadId ?? null,
    labelIds: msg.labelIds ?? [],
    from: header('From'),
    to: header('To'),
    cc: header('Cc'),
    bcc: header('Bcc'),
    replyTo: header('Reply-To'),
    date: header('Date'),
    subject: header('Subject'),
    body: read.text ?? (read.html !== undefined ? textFromHtml(read.html) : ''),
    attachments: fileList(read.files),
  };
}

const getMessage: Run = async (gmail, args) => {
  const m = parse(MessageIdInput, args);
  return mailView(await step('reading the mail', () => gmail.message(m.messageId, 'full')));
};

const getDraft: Run = async (gmail, args) => {
  const m = parse(DraftIdInput, args);
  const draft = await step('reading the draft', () =>
    gmail.get<{ id?: string; message?: GmailMessage }>(`/drafts/${m.draftId}?format=full`),
  );
  return { draftId: draft.id ?? m.draftId, ...mailView(draft.message ?? {}) };
};

/** A name for a file the mail gives none, from its media type: `attachment-2.png`. */
function nameFor(f: { filename?: string; mimeType: string }, index: number) {
  if (f.filename) return f.filename;
  const sub = f.mimeType.split('/')[1] ?? '';
  return `attachment-${index}${/^[a-z0-9]{1,10}$/.test(sub) ? `.${sub}` : ''}`;
}

const downloadAttachment: Run = async (gmail, args, ctx) => {
  const m = parse(GmailAttachmentInput, args);
  const save = ctx.saveFile;
  if (!save) throw new InputError('there is no conversation folder here to keep the file in');
  const msg = await step('reading the mail', () => gmail.message(m.messageId, 'full'));
  const files = readParts(msg.payload).files;
  if (!files.length) throw new InputError('the mail has no files');
  const indexed = files.map((f, i) => ({ f, i }));
  let chosen: { f: (typeof files)[number]; i: number }[];
  if (m.attachmentIndex !== undefined) {
    chosen = indexed.filter((x) => x.i === m.attachmentIndex);
  } else if (m.attachmentId || m.filename) {
    // Gmail may give a file another id each time the mail is read: the name is the surer match.
    chosen = indexed.filter((x) => m.attachmentId && x.f.attachmentId === m.attachmentId);
    if (!chosen.length) chosen = indexed.filter((x) => m.filename && x.f.filename === m.filename);
  } else {
    // Every file it names; nameless pictures in the text are mostly logos.
    chosen = indexed.filter((x) => x.f.filename);
    if (!chosen.length) chosen = indexed;
  }
  if (!chosen.length) {
    throw new InputError(
      `no file of the mail matches; call again with attachmentIndex from this list: ${JSON.stringify(fileList(files))}`,
    );
  }
  // Too large by what Gmail says of the files: none is fetched.
  const said = chosen.reduce((n, x) => n + x.f.size, 0);
  if (said > MAX_UPLOAD_BYTES * 1.4) {
    throw new InputError(`the files come to ${Math.ceil(said / 1024 / 1024)} MB; ask for one at a time`);
  }
  const saved: Record<string, unknown>[] = [];
  for (const { f, i } of chosen) {
    const file = await step(`reading the file ${f.filename ?? 'with no name'}`, () =>
      gmail.file(m.messageId, f),
    );
    const entry = {
      attachmentIndex: i,
      filename: f.filename ?? null,
      mimeType: f.mimeType,
      size: file.data.length,
    };
    if (!file.data.length) saved.push({ ...entry, error: 'the file is empty' });
    else if (file.data.length > MAX_UPLOAD_BYTES) {
      saved.push({ ...entry, error: `larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB, not kept` });
    } else saved.push({ ...entry, path: await save(nameFor(f, i), file.data) });
  }
  return {
    messageId: m.messageId,
    saved,
    note: 'Each file is in the conversation folder at its path: read it from there with the file tools.',
  };
};

/** A call that changes one mail or conversation by its id and gives back what Gmail returns. */
const change =
  (
    input: typeof MessageIdInput | typeof ThreadIdInput,
    what: string,
    path: (id: string) => string,
    json?: unknown,
  ): Run =>
  async (gmail, args) => {
    const m = parse(input, args) as { messageId?: string; threadId?: string };
    const id = (m.messageId ?? m.threadId)!;
    const r = await step(what, () =>
      gmail.request<{ id?: string; threadId?: string; labelIds?: string[] }>(
        'POST',
        `${API}${path(id)}`,
        json === undefined ? undefined : { json },
      ),
    );
    return { done: true, ...m, ...(r.labelIds && { labelIds: r.labelIds }) };
  };

const SPAM = { addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] };
const NOT_SPAM = { addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] };

const updateMessageLabels: Run = async (gmail, args) => {
  const m = parse(MessageLabelsInput, args);
  const r = await step('changing the labels', () =>
    gmail.request<{ labelIds?: string[] }>('POST', `${API}/messages/${m.messageId}/modify`, {
      json: { addLabelIds: m.addLabelIds ?? [], removeLabelIds: m.removeLabelIds ?? [] },
    }),
  );
  return { done: true, messageId: m.messageId, labelIds: r.labelIds ?? [] };
};

const updateThreadLabels: Run = async (gmail, args) => {
  const m = parse(ThreadLabelsInput, args);
  await step('changing the labels', () =>
    gmail.request('POST', `${API}/threads/${m.threadId}/modify`, {
      json: { addLabelIds: m.addLabelIds ?? [], removeLabelIds: m.removeLabelIds ?? [] },
    }),
  );
  return { done: true, threadId: m.threadId };
};

// ---------------------------------------------------------------------------------------------
// The tools' descriptions, as the bot reads them

const recipientsSchema = (what: string) => ({
  type: 'array',
  items: { type: 'string' },
  description: `${what} Each a plain email address (user@example.com).`,
});
const attachmentsSchema = {
  type: 'array',
  description:
    'Files to attach, 25 MB together at most. For larger files, put them in Drive and give the link in the body.',
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
  description: "Add the account's Gmail signature at the end. Defaults to false.",
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  ...(required.length && { required }),
  properties,
});

const TOOLS: LocalTool[] = [
  {
    name: 'send_message',
    title: 'Send email',
    description:
      "Sends an email from the signed-in Gmail account right away. For a new mail give recipients in `to` (and `cc`, `bcc`), a `subject`, and the content in `body` (plain text) or `htmlBody` (HTML). To send an existing draft as it is, give only its `draftId`. To send it inside an existing conversation, give `replyThreadId` or `replyToMessageId`; the subject then defaults to the conversation's. Sent mail appears in Gmail's Sent folder. Returns the sent message's id and threadId.",
    inputSchema: object({
      to: recipientsSchema('Recipients; required unless draftId is given.'),
      cc: recipientsSchema('Carbon copy recipients.'),
      bcc: recipientsSchema('Blind carbon copy recipients.'),
      subject: { type: 'string', description: 'The subject line.' },
      body: bodySchema,
      htmlBody: htmlSchema,
      attachments: attachmentsSchema,
      includeSignature: signatureSchema,
      replyThreadId: { type: 'string', description: 'The conversation to send the mail in.' },
      replyToMessageId: { type: 'string', description: 'The mail this one answers, in its conversation.' },
      draftId: { type: 'string', description: 'A draft to send as it is; give nothing else with it.' },
    }),
    kind: 'write',
    run: sendMessage,
  },
  {
    name: 'reply',
    title: 'Reply to email',
    description:
      "Replies to an email in the signed-in Gmail account, in its conversation. Give the `messageId` of the mail to answer (for a conversation, its latest mail, from get_thread) and the content in `body` or `htmlBody`. The reply goes to the sender; with `replyAll` also to everyone else on the mail. `to`, `cc` and `bcc` replace those recipients when given. Returns the sent message's id, threadId and who it went to.",
    inputSchema: object(
      {
        messageId: { type: 'string', description: 'The mail to answer.' },
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
      "Forwards an email from the signed-in Gmail account, with its files. Give the `messageId` of the mail, recipients in `to` (and `cc`, `bcc`), and an optional note to put above it in `forwardText` (plain text) or `htmlBody` (HTML). `attachments` adds files to those the mail already has. Returns the sent message's id and threadId.",
    inputSchema: object(
      {
        messageId: { type: 'string', description: 'The mail to forward.' },
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
    name: 'update_draft',
    title: 'Update draft',
    description:
      "Changes a draft in the signed-in Gmail account. Give its `draftId` and only what changes: recipients, `subject`, and `body` and/or `htmlBody` (a body given alone replaces both versions). What is left out stays as it was. The draft's files stay too, unless `attachments` is given: then the draft has exactly those files, none for an empty list. Returns the draft's id, its message id and threadId.",
    inputSchema: object(
      {
        draftId: { type: 'string', description: 'The draft to change.' },
        to: recipientsSchema('Recipients; left out, they stay.'),
        cc: recipientsSchema('Carbon copy recipients; left out, they stay.'),
        bcc: recipientsSchema('Blind carbon copy recipients; left out, they stay.'),
        subject: { type: 'string', description: 'The subject line; left out, it stays.' },
        body: bodySchema,
        htmlBody: htmlSchema,
        attachments: attachmentsSchema,
      },
      ['draftId'],
    ),
    kind: 'write',
    run: updateDraft,
  },
  {
    name: 'delete_draft',
    title: 'Delete draft',
    description: 'Deletes a draft in the signed-in Gmail account for good. Give its `draftId`.',
    inputSchema: object({ draftId: { type: 'string', description: 'The draft to delete.' } }, ['draftId']),
    kind: 'write',
    run: deleteDraft,
  },
  {
    name: 'update_label',
    title: 'Update label',
    description:
      'Changes a label in the signed-in Gmail account: its name, color, and where Gmail shows it. Give its `labelId` (list_labels gives it for a name) and only what changes. Returns the label as Gmail now has it.',
    inputSchema: object(
      {
        labelId: { type: 'string', description: 'The label to change.' },
        displayName: { type: 'string', description: 'The new name.' },
        colorPreset: { type: 'string', enum: PRESETS, description: 'The new color.' },
        labelListVisibility: {
          type: 'string',
          enum: Object.keys(LABEL_LIST),
          description: 'Whether the label shows in the label list: always, only with unread mail, or not.',
        },
        messageListVisibility: {
          type: 'string',
          enum: Object.keys(MESSAGE_LIST),
          description: 'Whether the label shows on mails in the message list.',
        },
      },
      ['labelId'],
    ),
    kind: 'write',
    run: updateLabel,
  },
  {
    name: 'delete_label',
    title: 'Delete label',
    description:
      'Deletes a label in the signed-in Gmail account. Its mails stay; they lose the label. Give its `labelId`.',
    inputSchema: object({ labelId: { type: 'string', description: 'The label to delete.' } }, ['labelId']),
    kind: 'write',
    run: deleteLabel,
  },
  {
    name: 'get_message',
    title: 'Get email',
    description:
      'Reads one email in the signed-in Gmail account: its sender, recipients, date, subject, labels, text, and the list of its files (name, type, size and attachmentIndex). Give its `messageId`, as search_threads or get_thread gave it. To read a file, call download_attachment.',
    inputSchema: object({ messageId: { type: 'string', description: 'The mail to read.' } }, ['messageId']),
    kind: 'read',
    run: getMessage,
  },
  {
    name: 'get_draft',
    title: 'Get draft',
    description:
      'Reads one draft in the signed-in Gmail account: its recipients, subject, text and files. Give its `draftId`, as list_drafts gave it.',
    inputSchema: object({ draftId: { type: 'string', description: 'The draft to read.' } }, ['draftId']),
    kind: 'read',
    run: getDraft,
  },
  {
    name: 'download_attachment',
    title: 'Download attachment',
    description:
      "Saves the files of an email (PDF, Excel, Word, pictures and the like) into this conversation's folder so they can be opened and read with the file tools. Give the mail's `messageId`, and to pick one file its `attachmentIndex` (from get_message), or its `filename` or `attachmentId` as get_message or get_thread listed it. Left out, every named file of the mail is saved. Returns each saved file's path, name, type and size. If no file matches, the reply lists the mail's files with their attachmentIndex. Open a saved PDF with the file-reading tool, which shows its pages as pictures, so a scanned one can be read too; a command that pulls out its text finds nothing on a scanned page.",
    inputSchema: object(
      {
        messageId: { type: 'string', description: 'The mail the file belongs to.' },
        attachmentIndex: {
          type: 'integer',
          minimum: 0,
          description: "The file's place among the mail's files, as get_message listed it.",
        },
        filename: { type: 'string', description: "The file's name, as the mail lists it." },
        attachmentId: {
          type: 'string',
          description: "The file's id, as get_message or get_thread listed it.",
        },
        mimeType: { type: 'string', description: "The file's media type, as listed; not needed." },
      },
      ['messageId'],
    ),
    kind: 'read',
    run: downloadAttachment,
  },
  {
    name: 'trash_message',
    title: 'Move email to trash',
    description:
      'Moves one email of the signed-in Gmail account to the trash, where Gmail keeps it for 30 days; untrash_message brings it back. Give its `messageId`.',
    inputSchema: object({ messageId: { type: 'string', description: 'The mail to trash.' } }, ['messageId']),
    kind: 'write',
    run: change(MessageIdInput, 'moving the mail to the trash', (id) => `/messages/${id}/trash`),
  },
  {
    name: 'untrash_message',
    title: 'Restore email from trash',
    description: 'Takes one email of the signed-in Gmail account out of the trash. Give its `messageId`.',
    inputSchema: object({ messageId: { type: 'string', description: 'The mail to restore.' } }, [
      'messageId',
    ]),
    kind: 'write',
    run: change(MessageIdInput, 'taking the mail out of the trash', (id) => `/messages/${id}/untrash`),
  },
  {
    name: 'trash_thread',
    title: 'Move conversation to trash',
    description:
      'Moves every email of a conversation in the signed-in Gmail account to the trash, where Gmail keeps them for 30 days; untrash_thread brings them back. Give its `threadId`.',
    inputSchema: object({ threadId: { type: 'string', description: 'The conversation to trash.' } }, [
      'threadId',
    ]),
    kind: 'write',
    run: change(ThreadIdInput, 'moving the conversation to the trash', (id) => `/threads/${id}/trash`),
  },
  {
    name: 'untrash_thread',
    title: 'Restore conversation from trash',
    description:
      'Takes every email of a conversation in the signed-in Gmail account out of the trash. Give its `threadId`.',
    inputSchema: object({ threadId: { type: 'string', description: 'The conversation to restore.' } }, [
      'threadId',
    ]),
    kind: 'write',
    run: change(ThreadIdInput, 'taking the conversation out of the trash', (id) => `/threads/${id}/untrash`),
  },
  {
    name: 'mark_message_spam',
    title: 'Mark email as spam',
    description:
      'Moves one email of the signed-in Gmail account to Spam and out of the inbox. Give its `messageId`.',
    inputSchema: object({ messageId: { type: 'string', description: 'The mail to mark.' } }, ['messageId']),
    kind: 'write',
    run: change(MessageIdInput, 'marking the mail as spam', (id) => `/messages/${id}/modify`, SPAM),
  },
  {
    name: 'unmark_message_spam',
    title: 'Mark email as not spam',
    description:
      'Takes one email of the signed-in Gmail account out of Spam and back into the inbox. Give its `messageId`.',
    inputSchema: object({ messageId: { type: 'string', description: 'The mail to unmark.' } }, ['messageId']),
    kind: 'write',
    run: change(MessageIdInput, 'marking the mail as not spam', (id) => `/messages/${id}/modify`, NOT_SPAM),
  },
  {
    name: 'mark_thread_spam',
    title: 'Mark conversation as spam',
    description:
      'Moves every email of a conversation in the signed-in Gmail account to Spam and out of the inbox. Give its `threadId`.',
    inputSchema: object({ threadId: { type: 'string', description: 'The conversation to mark.' } }, [
      'threadId',
    ]),
    kind: 'write',
    run: change(ThreadIdInput, 'marking the conversation as spam', (id) => `/threads/${id}/modify`, SPAM),
  },
  {
    name: 'unmark_thread_spam',
    title: 'Mark conversation as not spam',
    description:
      'Takes every email of a conversation in the signed-in Gmail account out of Spam and back into the inbox. Give its `threadId`.',
    inputSchema: object({ threadId: { type: 'string', description: 'The conversation to unmark.' } }, [
      'threadId',
    ]),
    kind: 'write',
    run: change(
      ThreadIdInput,
      'marking the conversation as not spam',
      (id) => `/threads/${id}/modify`,
      NOT_SPAM,
    ),
  },
  {
    name: 'update_message_labels',
    title: 'Change email labels',
    description:
      "Adds and removes labels on one email of the signed-in Gmail account in one call. Label ids come from list_labels; Gmail's own are UNREAD, STARRED, IMPORTANT, INBOX and the like, so removing UNREAD marks the mail read and removing INBOX archives it. Give its `messageId`, and `addLabelIds` and/or `removeLabelIds`. Returns the labels the mail has now.",
    inputSchema: object(
      {
        messageId: { type: 'string', description: 'The mail to change.' },
        addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label ids to add.' },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label ids to remove.' },
      },
      ['messageId'],
    ),
    kind: 'write',
    run: updateMessageLabels,
  },
  {
    name: 'update_thread_labels',
    title: 'Change conversation labels',
    description:
      "Adds and removes labels on every email of a conversation in the signed-in Gmail account in one call. Label ids come from list_labels; Gmail's own are UNREAD, STARRED, IMPORTANT, INBOX and the like, so removing UNREAD marks the conversation read and removing INBOX archives it. Give its `threadId`, and `addLabelIds` and/or `removeLabelIds`.",
    inputSchema: object(
      {
        threadId: { type: 'string', description: 'The conversation to change.' },
        addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label ids to add.' },
        removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Label ids to remove.' },
      },
      ['threadId'],
    ),
    kind: 'write',
    run: updateThreadLabels,
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------------------------
// Joining a connection

export function isGmailMcp(url: string): boolean {
  try {
    return new URL(url).hostname === GMAIL_MCP_HOST;
  } catch {
    return false;
  }
}

/**
 * The tools of a connection after a refresh: for Gmail, this server's for each one the server does
 * not list. `kept` is the list before the refresh, whose switch on an added tool stays.
 */
export function withGmailTools(
  url: string,
  listed: StoredConnectionTool[],
  kept: StoredConnectionTool[],
): StoredConnectionTool[] {
  if (!isGmailMcp(url)) return listed;
  const own = new Set(listed.map((t) => t.name));
  const added = TOOLS.filter((t) => !own.has(t.name)).map((t): StoredConnectionTool => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    hinted: t.kind,
    kind: null,
    enabled: kept.find((k) => k.name === t.name && k.local)?.enabled ?? true,
    local: 'gmail',
  }));
  return [...listed, ...added];
}

/**
 * Whether a connection's tool reads or changes, as the bot's turn treats it. A tool this server
 * adds that sends or changes mail is always a change, whatever the person set it to: only its
 * card stands between the bot and the account.
 */
export function toolKind(
  t: Pick<StoredConnectionTool, 'name' | 'kind' | 'hinted' | 'local'>,
): 'read' | 'write' {
  if (t.local && BY_NAME.get(t.name)?.kind !== 'read') return 'write';
  return t.kind ?? t.hinted;
}

/** Who the account sends as, for the mail card: its default address and that address's signature. */
export async function gmailSender(target: ClientTarget, signal?: AbortSignal): Promise<MailSender> {
  const s = await new Gmail(target, signal, false).sendAs();
  return { address: s.address, signature: s.signature.trim() || null };
}

const fail = (text: string): CallToolResult => ({ isError: true, content: [{ type: 'text', text }] });

/**
 * Runs one of the tools this server adds. Anything Google refuses comes back with its status and
 * its own words, and the step it refused, so the bot (and the person) can see why: the API not
 * turned on in the Google Cloud project, a scope missing from the sign-in, a bad address.
 */
export async function runGmailTool(
  target: ClientTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  ctx: GmailToolContext = {},
): Promise<CallToolResult> {
  const tool = BY_NAME.get(name);
  if (!tool) return fail(`No such Gmail tool: ${name}`);
  try {
    const out = await tool.run(new Gmail(target, signal), args, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  } catch (err) {
    if (err instanceof InputError) return fail(`Nothing was done: ${err.message}`);
    if (err instanceof StepError) {
      const g = err.refusal;
      const outcome = tool.kind === 'read' ? '' : ', so nothing was sent or changed';
      return fail(`Gmail refused ${err.step} (HTTP ${g.status})${outcome}: ${g.body.slice(0, 2000)}`);
    }
    throw err;
  }
}
