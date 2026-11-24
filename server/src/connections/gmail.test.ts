import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredConnectionTool } from '../db/schema';

const fetchSignedIn = vi.fn();
vi.mock('./client', () => ({ fetchSignedIn: (...a: unknown[]) => fetchSignedIn(...a) }));

const { GmailSendInput, gmailSender, runGmailTool, toolKind, withGmailTools } = await import('./gmail');

const GMAIL = 'https://gmailmcp.googleapis.com/mcp/v1';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const ADDED = [
  'send_message',
  'reply',
  'forward',
  'update_draft',
  'delete_draft',
  'update_label',
  'delete_label',
  'get_message',
  'get_draft',
  'download_attachment',
  'trash_message',
  'untrash_message',
  'trash_thread',
  'untrash_thread',
  'mark_message_spam',
  'unmark_message_spam',
  'mark_thread_spam',
  'unmark_thread_spam',
  'update_message_labels',
  'update_thread_labels',
];

const tool = (name: string, extra: Partial<StoredConnectionTool> = {}): StoredConnectionTool => ({
  name,
  title: null,
  description: '',
  inputSchema: { type: 'object' },
  hinted: 'read',
  kind: null,
  enabled: true,
  ...extra,
});
const target = {} as never;
const b64 = (s: string) => Buffer.from(s).toString('base64url');
const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));

type Call = { method: string; url: string; body: string };

/** A Gmail API that answers from a table of `METHOD path` → JSON, and records what it was asked. */
function gmail(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  fetchSignedIn.mockImplementation((_t: unknown, url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: typeof init.body === 'string' ? init.body : '' });
    const path = url
      .replace(API, '')
      .replace(/^https:\/\/gmail\.googleapis\.com\/upload\/gmail\/v1\/users\/me/, 'UPLOAD');
    const key = `${method} ${path}`;
    if (!(key in routes)) return Promise.resolve(new Response(`no route ${key}`, { status: 404 }));
    const v = routes[key];
    if (v instanceof Response) return Promise.resolve(v);
    return Promise.resolve(
      v === null ? new Response(null, { status: 204 }) : new Response(JSON.stringify(v)),
    );
  });
  return calls;
}

/** The mail a send call carried, decoded. */
const sentMail = (c: Call) => {
  const body = JSON.parse(c.body) as { raw?: string; message?: { raw?: string }; threadId?: string };
  return {
    mime: Buffer.from(body.raw ?? body.message?.raw ?? '', 'base64url').toString(),
    threadId: body.threadId,
  };
};
const run = (name: string, args: Record<string, unknown>) => runGmailTool(target, name, args);
const textOf = (r: Awaited<ReturnType<typeof run>>) => (r.content as { text: string }[])[0]!.text;

afterEach(() => fetchSignedIn.mockReset());

describe('withGmailTools', () => {
  it("adds to Gmail each tool its server does not list, and keeps the server's own", () => {
    const tools = withGmailTools(GMAIL, [tool('create_draft'), tool('reply', { hinted: 'write' })], []);
    expect(tools.map((t) => t.name)).toEqual([
      'create_draft',
      'reply',
      ...ADDED.filter((n) => n !== 'reply'),
    ]);
    expect(tools[1]?.local).toBeUndefined();
    expect(tools[2]).toMatchObject({ local: 'gmail', hinted: 'write', enabled: true });
    expect(withGmailTools('https://mcp.slack.com/mcp', [tool('search')], [])).toHaveLength(1);
  });

  it('keeps the person switching an added tool off, also from before the other tools came', () => {
    const before = [tool('send_message', { local: 'gmailSend', enabled: false })];
    const tools = withGmailTools(GMAIL, [], before);
    expect(tools.find((t) => t.name === 'send_message')).toMatchObject({ local: 'gmail', enabled: false });
  });

  it('lets an added tool that only reads count as a read, and one that changes mail never as one', () => {
    const tools = withGmailTools(GMAIL, [], []);
    const of = (name: string) => tools.find((t) => t.name === name)!;
    expect(toolKind(of('download_attachment'))).toBe('read');
    expect(toolKind(of('get_message'))).toBe('read');
    expect(toolKind(of('trash_message'))).toBe('write');
    expect(toolKind({ ...of('send_message'), kind: 'read' })).toBe('write');
    expect(toolKind({ ...of('get_message'), kind: 'write' })).toBe('write');
    expect(toolKind(tool('search_threads'))).toBe('read');
  });
});

describe('GmailSendInput', () => {
  const ok = { to: ['a@example.com'], subject: 'Deneme', body: 'Merhaba' };
  const takes = (v: unknown) => GmailSendInput.safeParse(v).success;

  it('takes a plain mail, one in a conversation, one with files, and a draft by itself', () => {
    expect(takes(ok)).toBe(true);
    expect(takes({ ...ok, replyThreadId: 't1' })).toBe(true);
    expect(takes({ ...ok, attachments: [{ content: 'aGVsbG8=', filename: 'a.txt' }] })).toBe(true);
    expect(takes({ draftId: 'r-123' })).toBe(true);
  });

  it('refuses what would add a header of its own or that the card would not show', () => {
    expect(takes({ ...ok, subject: 'Hi\r\nBcc: x@example.com' })).toBe(false);
    expect(takes({ ...ok, to: ['a@example.com\r\nBcc: x@example.com'] })).toBe(false);
    expect(takes({ ...ok, to: ['Ad <a@example.com>'] })).toBe(false);
    expect(takes({ ...ok, from: 'x@example.com' })).toBe(false);
    expect(takes({ draftId: 'r-1', to: ['a@example.com'] })).toBe(false);
    expect(takes({ ...ok, replyThreadId: '../labels' })).toBe(false);
    expect(takes({ ...ok, attachments: [{ content: 'x', mimeType: 'text/plain\r\nX: y' }] })).toBe(false);
    expect(takes({ to: ['a@example.com'] })).toBe(false);
  });
});

describe('send_message', () => {
  it('sends the message and answers with its id', async () => {
    const calls = gmail({ 'POST /messages/send': { id: 'm1', threadId: 't1' } });
    const r = await run('send_message', { to: ['a@example.com'], subject: 'Deneme', body: 'Merhaba' });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(textOf(r))).toEqual({ sent: true, id: 'm1', threadId: 't1' });
    expect(sentMail(calls[0]!).mime).toContain('To: a@example.com');
  });

  it('sends a draft as it is', async () => {
    const calls = gmail({ 'POST /drafts/send': { id: 'm2', threadId: 't2', labelIds: ['SENT'] } });
    const r = await run('send_message', { draftId: 'r-9' });
    expect(JSON.parse(textOf(r))).toMatchObject({ sent: true, id: 'm2' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ id: 'r-9' });
  });

  it('sends in a conversation with its reply headers, subject and the signature', async () => {
    const calls = gmail({
      'GET /threads/t7?format=metadata': {
        id: 't7',
        messages: [
          { payload: { headers: headers({ 'Message-ID': '<old@x>', Subject: 'Eski' }) } },
          {
            payload: {
              headers: headers({ 'Message-ID': '<son@x>', References: '<old@x>', Subject: 'Teklif' }),
            },
          },
        ],
      },
      'GET /settings/sendAs': {
        sendAs: [{ sendAsEmail: 'ben@example.com', isDefault: true, signature: '<b>Erhan</b>' }],
      },
      'POST /messages/send': { id: 'm3', threadId: 't7' },
    });
    await run('send_message', {
      to: ['a@example.com'],
      body: 'Merhaba',
      replyThreadId: 't7',
      includeSignature: true,
    });
    const sent = sentMail(calls.at(-1)!);
    expect(sent.threadId).toBe('t7');
    expect(sent.mime).toContain('Subject: Re: Teklif');
    expect(sent.mime).toContain('In-Reply-To: <son@x>');
    expect(sent.mime).toContain('References: <old@x> <son@x>');
    expect(sent.mime).toContain('multipart/alternative');
  });

  it('uploads a large mail beside its JSON rather than inside it', async () => {
    const calls = gmail({ 'POST UPLOAD/messages/send?uploadType=multipart': { id: 'm4', threadId: 't4' } });
    const big = Buffer.alloc(4 * 1024 * 1024, 1).toString('base64');
    const r = await run('send_message', {
      to: ['a@example.com'],
      body: 'Ek',
      attachments: [{ content: big, filename: 'big.bin' }],
    });
    expect(r.isError).toBeUndefined();
    expect(calls[0]!.body).toContain('Content-Type: message/rfc822');
    expect(calls[0]!.body).toContain('filename="big.bin"');
  });

  it('refuses files past 25 MB before asking Gmail', async () => {
    const calls = gmail({});
    const big = Buffer.alloc(26 * 1024 * 1024).toString('base64');
    const r = await run('send_message', { to: ['a@example.com'], attachments: [{ content: big }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('25 MB');
    expect(calls).toHaveLength(0);
  });

  it("passes on Google's own words and the step it refused", async () => {
    gmail({
      'POST /messages/send': new Response('{"error":{"message":"Gmail API has not been used"}}', {
        status: 403,
      }),
    });
    const r = await run('send_message', { to: ['a@example.com'], body: 'Merhaba' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Gmail refused sending (HTTP 403)');
    expect(textOf(r)).toContain('Gmail API has not been used');
  });

  it('sends nothing when the input is refused', async () => {
    const calls = gmail({});
    const r = await run('send_message', { to: ['a@example.com'], body: 'x', cc: 'b@example.com' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Nothing was done');
    expect(calls).toHaveLength(0);
  });
});

describe('reply', () => {
  const original = {
    id: 'm1',
    threadId: 't1',
    payload: {
      headers: headers({
        From: 'Ali <ali@example.com>',
        To: 'ben@example.com, veli@example.com',
        Cc: 'Ayşe <ayse@example.com>, BEN@example.com',
        Subject: 'Teklif\r\nBcc: x@example.com',
        'Message-ID': '<m1@x>',
      }),
    },
  };
  const routes = {
    'GET /messages/m1?format=metadata': original,
    'GET /settings/sendAs': { sendAs: [{ sendAsEmail: 'ben@example.com', isDefault: true }] },
    'POST /messages/send': { id: 'r1', threadId: 't1' },
  };

  it('answers the sender in the conversation', async () => {
    const calls = gmail(routes);
    const r = await run('reply', { messageId: 'm1', body: 'Teşekkürler' });
    const sent = sentMail(calls.at(-1)!);
    expect(JSON.parse(textOf(r))).toMatchObject({ to: ['ali@example.com'], cc: [] });
    expect(sent.threadId).toBe('t1');
    expect(sent.mime).toContain('To: ali@example.com\r\n');
    expect(sent.mime).toContain('In-Reply-To: <m1@x>');
    // A line break in the original's subject does not become a header of this mail.
    expect(sent.mime).toContain('Subject: Re: Teklif Bcc: x@example.com');
    expect(sent.mime).not.toContain('\r\nBcc:');
  });

  it('answers everyone but the account itself with replyAll', async () => {
    gmail(routes);
    const r = await run('reply', { messageId: 'm1', body: 'x', replyAll: true });
    expect(JSON.parse(textOf(r))).toMatchObject({
      to: ['ali@example.com', 'veli@example.com'],
      cc: ['ayse@example.com'],
    });
  });

  it('sends nothing when the mail cannot be read', async () => {
    const calls = gmail({ 'GET /messages/m1?format=metadata': new Response('not found', { status: 404 }) });
    const r = await run('reply', { messageId: 'm1', body: 'x' });
    expect(textOf(r)).toContain('Gmail refused reading the mail it answers (HTTP 404), so nothing was sent');
    expect(calls).toHaveLength(1);
  });
});

describe('forward', () => {
  it('forwards the mail with its files, a note above it', async () => {
    const calls = gmail({
      'GET /messages/m1?format=full': {
        id: 'm1',
        payload: {
          mimeType: 'multipart/mixed',
          headers: headers({ From: 'Ali <ali@example.com>', Subject: 'Fiyat listesi' }),
          parts: [
            { mimeType: 'text/plain', body: { data: b64('Liste ekte') } },
            { mimeType: 'application/pdf', filename: 'liste.pdf', body: { attachmentId: 'A1', size: 3 } },
          ],
        },
      },
      'GET /messages/m1/attachments/A1': { data: b64('pdf') },
      'POST /messages/send': { id: 'f1', threadId: 't9' },
    });
    const r = await run('forward', { messageId: 'm1', to: ['veli@example.com'], forwardText: 'Bilgine' });
    expect(JSON.parse(textOf(r))).toMatchObject({ sent: true, id: 'f1', originalMessageId: 'm1' });
    const mime = sentMail(calls.at(-1)!).mime;
    expect(mime).toContain('Subject: Fwd: Fiyat listesi');
    expect(mime).toContain('filename="liste.pdf"');
    expect(mime).toContain(Buffer.from('pdf').toString('base64'));
    const plain = /text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([^-]+)/.exec(
      mime,
    )![1]!;
    const text = Buffer.from(plain.replace(/\r\n/g, ''), 'base64').toString();
    expect(text).toContain('Bilgine');
    expect(text).toContain('---------- Forwarded message ---------');
    expect(text).toContain('Liste ekte');
  });

  it('wants someone to forward to', async () => {
    gmail({});
    expect((await run('forward', { messageId: 'm1' })).isError).toBe(true);
  });
});

describe('update_draft', () => {
  const draft = {
    id: 'r1',
    message: {
      id: 'dm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: headers({
          From: 'Satış <satis@example.com>',
          To: 'ali@example.com',
          Subject: 'Taslak',
          'In-Reply-To': '<m1@x>',
          References: '<m0@x> <m1@x>',
        }),
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Eski metin') } },
          { mimeType: 'application/pdf', filename: 'teklif.pdf', body: { attachmentId: 'A1', size: 3 } },
        ],
      },
    },
  };

  it('changes only what is given and keeps the files, the thread and the reply headers', async () => {
    const calls = gmail({
      'GET /drafts/r1?format=full': draft,
      'GET /messages/dm1/attachments/A1': { data: b64('pdf') },
      'PUT /drafts/r1': { id: 'r1', message: { id: 'dm2', threadId: 't1' } },
    });
    const r = await run('update_draft', { draftId: 'r1', subject: 'Yeni konu' });
    expect(JSON.parse(textOf(r))).toEqual({ updated: true, id: 'r1', messageId: 'dm2', threadId: 't1' });
    const put = JSON.parse(calls.at(-1)!.body) as { id: string; message: { raw: string; threadId: string } };
    expect(put.id).toBe('r1');
    expect(put.message.threadId).toBe('t1');
    const mime = Buffer.from(put.message.raw, 'base64url').toString();
    expect(mime).toContain('From: satis@example.com');
    expect(mime).toContain('To: ali@example.com');
    expect(mime).toContain('Subject: Yeni konu');
    expect(mime).toContain('In-Reply-To: <m1@x>');
    expect(mime).toContain('References: <m0@x> <m1@x>');
    expect(mime).toContain('filename="teklif.pdf"');
    expect(mime).toContain(Buffer.from('Eski metin').toString('base64'));
  });

  it('drops the files when given an empty list', async () => {
    const calls = gmail({
      'GET /drafts/r1?format=full': draft,
      'PUT /drafts/r1': { id: 'r1', message: { id: 'dm2', threadId: 't1' } },
    });
    await run('update_draft', { draftId: 'r1', attachments: [] });
    const put = JSON.parse(calls.at(-1)!.body) as { message: { raw: string } };
    expect(Buffer.from(put.message.raw, 'base64url').toString()).not.toContain('teklif.pdf');
    expect(calls.some((c) => c.url.includes('/attachments/'))).toBe(false);
  });
});

describe('drafts and labels', () => {
  it('deletes a draft', async () => {
    const calls = gmail({ 'DELETE /drafts/r1': null });
    expect(JSON.parse(textOf(await run('delete_draft', { draftId: 'r1' })))).toEqual({
      deleted: true,
      draftId: 'r1',
    });
    expect(calls[0]!.method).toBe('DELETE');
  });

  it("changes a label in Gmail's own words", async () => {
    const calls = gmail({ 'PATCH /labels/Label_5': { id: 'Label_5', name: 'Müşteri' } });
    const r = await run('update_label', {
      labelId: 'Label_5',
      displayName: 'Müşteri',
      colorPreset: 'LABEL_COLOR_PRESET_GREEN',
      labelListVisibility: 'LABEL_SHOW_IF_UNREAD',
      messageListVisibility: 'HIDE',
    });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(calls[0]!.body)).toEqual({
      name: 'Müşteri',
      color: { backgroundColor: '#16a765', textColor: '#ffffff' },
      labelListVisibility: 'labelShowIfUnread',
      messageListVisibility: 'hide',
    });
  });

  it('refuses a label change that changes nothing, and deletes a label', async () => {
    gmail({ 'DELETE /labels/Label_5': null });
    expect((await run('update_label', { labelId: 'Label_5' })).isError).toBe(true);
    expect(JSON.parse(textOf(await run('delete_label', { labelId: 'Label_5' })))).toMatchObject({
      deleted: true,
    });
  });
});

const PDF_MAIL = {
  id: 'm1',
  threadId: 't1',
  labelIds: ['INBOX', 'UNREAD'],
  payload: {
    mimeType: 'multipart/mixed',
    headers: headers({ From: 'Gamze <gamze@example.com>', To: 'ben@example.com', Subject: 'Sevk\r\nX: y' }),
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [{ mimeType: 'text/html', body: { data: b64('<p>Ekte <b>irsaliye</b></p>') } }],
      },
      { mimeType: 'application/pdf', filename: 'irsaliye.pdf', body: { attachmentId: 'A1', size: 3 } },
      {
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        filename: '../../liste.xlsx',
        body: { attachmentId: 'A2', size: 4 },
      },
      {
        mimeType: 'image/png',
        headers: headers({ 'Content-ID': '<logo>' }),
        body: { attachmentId: 'A3', size: 2 },
      },
    ],
  },
};

describe('get_message and get_draft', () => {
  it("gives a mail's headers, its text and its files by their place", async () => {
    gmail({ 'GET /messages/m1?format=full': PDF_MAIL });
    const out = JSON.parse(textOf(await run('get_message', { messageId: 'm1' })));
    expect(out).toMatchObject({
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX', 'UNREAD'],
      from: 'Gamze <gamze@example.com>',
      subject: 'Sevk X: y',
    });
    expect(out.body).toContain('irsaliye');
    expect(out.body).not.toContain('<b>');
    expect(out.attachments).toEqual([
      {
        attachmentIndex: 0,
        filename: 'irsaliye.pdf',
        mimeType: 'application/pdf',
        size: 3,
        attachmentId: 'A1',
      },
      expect.objectContaining({ attachmentIndex: 1, filename: '../../liste.xlsx' }),
      expect.objectContaining({ attachmentIndex: 2, filename: null, inline: true }),
    ]);
  });

  it('reads a draft with its id', async () => {
    gmail({ 'GET /drafts/r1?format=full': { id: 'r1', message: PDF_MAIL } });
    expect(JSON.parse(textOf(await run('get_draft', { draftId: 'r1' })))).toMatchObject({
      draftId: 'r1',
      id: 'm1',
    });
  });

  it('says what Google refused without saying nothing changed, for a read', async () => {
    gmail({ 'GET /messages/m1?format=full': new Response('not found', { status: 404 }) });
    const r = await run('get_message', { messageId: 'm1' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('HTTP 404');
    expect(textOf(r)).not.toContain('nothing was sent');
  });
});

describe('download_attachment', () => {
  const routes = {
    'GET /messages/m1?format=full': PDF_MAIL,
    'GET /messages/m1/attachments/A1': { data: b64('pdf') },
    'GET /messages/m1/attachments/A2': { data: b64('xlsx') },
    'GET /messages/m1/attachments/A3': { data: b64('pn') },
  };
  const saving = () => {
    const kept: { name: string; data: string }[] = [];
    const saveFile = (name: string, data: Buffer) => {
      kept.push({ name, data: data.toString() });
      return Promise.resolve(`/thread/${name}`);
    };
    return { kept, saveFile };
  };
  const download = (args: Record<string, unknown>, saveFile?: (n: string, d: Buffer) => Promise<string>) =>
    runGmailTool(target, 'download_attachment', args, undefined, saveFile ? { saveFile } : {});

  it('keeps every named file of the mail when none is picked, leaving the logo out', async () => {
    gmail(routes);
    const { kept, saveFile } = saving();
    const out = JSON.parse(textOf(await download({ messageId: 'm1' }, saveFile)));
    expect(kept).toEqual([
      { name: 'irsaliye.pdf', data: 'pdf' },
      { name: '../../liste.xlsx', data: 'xlsx' },
    ]);
    expect(out.saved.map((f: { path: string }) => f.path)).toEqual([
      '/thread/irsaliye.pdf',
      '/thread/../../liste.xlsx',
    ]);
  });

  it('picks one file by its place, its name, or its id', async () => {
    gmail(routes);
    let s = saving();
    await download({ messageId: 'm1', attachmentIndex: 2 }, s.saveFile);
    expect(s.kept).toEqual([{ name: 'attachment-2.png', data: 'pn' }]);
    s = saving();
    await download({ messageId: 'm1', filename: 'irsaliye.pdf' }, s.saveFile);
    expect(s.kept.map((k) => k.name)).toEqual(['irsaliye.pdf']);
    s = saving();
    // An id from an earlier read that Gmail no longer gives: the name still finds the file.
    await download({ messageId: 'm1', attachmentId: 'OLD', filename: '../../liste.xlsx' }, s.saveFile);
    expect(s.kept.map((k) => k.name)).toEqual(['../../liste.xlsx']);
  });

  it("lists the mail's files when none matches, and needs a folder to keep them in", async () => {
    gmail(routes);
    const s = saving();
    const r = await download({ messageId: 'm1', filename: 'yok.pdf' }, s.saveFile);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('"attachmentIndex":1');
    expect(s.kept).toEqual([]);
    expect((await download({ messageId: 'm1' })).isError).toBe(true);
  });
});

describe('trash, spam and labels', () => {
  it('moves a mail or a conversation to the trash and back', async () => {
    const calls = gmail({
      'POST /messages/m1/trash': { id: 'm1', labelIds: ['TRASH'] },
      'POST /threads/t1/untrash': { id: 't1' },
    });
    expect(JSON.parse(textOf(await run('trash_message', { messageId: 'm1' })))).toMatchObject({
      done: true,
      messageId: 'm1',
      labelIds: ['TRASH'],
    });
    expect(JSON.parse(textOf(await run('untrash_thread', { threadId: 't1' })))).toMatchObject({ done: true });
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, '')}`)).toEqual([
      'POST /messages/m1/trash',
      'POST /threads/t1/untrash',
    ]);
  });

  it('marks spam by moving it out of the inbox, and back', async () => {
    const calls = gmail({
      'POST /messages/m1/modify': { id: 'm1' },
      'POST /threads/t1/modify': { id: 't1' },
    });
    await run('mark_message_spam', { messageId: 'm1' });
    await run('unmark_thread_spam', { threadId: 't1' });
    expect(JSON.parse(calls[0]!.body)).toEqual({ addLabelIds: ['SPAM'], removeLabelIds: ['INBOX'] });
    expect(JSON.parse(calls[1]!.body)).toEqual({ addLabelIds: ['INBOX'], removeLabelIds: ['SPAM'] });
  });

  it('adds and removes labels in one call, and refuses a call that changes none', async () => {
    const calls = gmail({ 'POST /messages/m1/modify': { id: 'm1', labelIds: ['INBOX'] } });
    const r = await run('update_message_labels', { messageId: 'm1', removeLabelIds: ['UNREAD'] });
    expect(JSON.parse(textOf(r))).toMatchObject({ labelIds: ['INBOX'] });
    expect(JSON.parse(calls[0]!.body)).toEqual({ addLabelIds: [], removeLabelIds: ['UNREAD'] });
    expect((await run('update_thread_labels', { threadId: 't1' })).isError).toBe(true);
    expect((await run('trash_message', { messageId: 'a/b' })).isError).toBe(true);
  });
});

describe('gmailSender', () => {
  it('gives the default address and its signature, or none when it has none', async () => {
    gmail({
      'GET /settings/sendAs': {
        sendAs: [
          { sendAsEmail: 'alias@example.com', signature: 'x' },
          { sendAsEmail: 'ben@example.com', isDefault: true, signature: '<b>Erhan</b>' },
        ],
      },
    });
    expect(await gmailSender(target)).toEqual({ address: 'ben@example.com', signature: '<b>Erhan</b>' });
    gmail({
      'GET /settings/sendAs': {
        sendAs: [{ sendAsEmail: 'ben@example.com', isDefault: true, signature: ' ' }],
      },
    });
    expect(await gmailSender(target)).toEqual({ address: 'ben@example.com', signature: null });
  });
});
