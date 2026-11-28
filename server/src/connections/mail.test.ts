import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MailSettings } from '@leafbot/shared';
import type { StoredConnectionTool } from '../db/schema';

/** A stand-in IMAP server: one folder of mails, a Sent folder and a Trash folder. */
const imap = {
  mails: new Map<number, string>(),
  validity: 7n,
  appended: [] as { path: string; content: string; flags: string[] }[],
  flagged: [] as { range: string; flags: string[] }[],
  unflagged: [] as { range: string; flags: string[] }[],
  searched: [] as Record<string, unknown>[],
  /** What a search finds, and each mail's envelope as FETCH gives it. */
  found: [] as number[],
  envelopes: new Map<
    number,
    { date?: Date | string; subject?: string; from?: { name?: string; address?: string }[] }
  >(),
  moved: [] as { range: string; to: string }[],
  options: [] as Record<string, unknown>[],
  failAppend: false,
  failLogin: false,
};
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox: { uidValidity: bigint } | false = false;
    constructor(options: Record<string, unknown>) {
      imap.options.push(options);
    }
    on() {}
    async connect() {
      if (imap.failLogin)
        throw Object.assign(new Error('Authentication failed'), { authenticationFailed: true });
    }
    async logout() {}
    close() {}
    async list() {
      return [
        { path: 'INBOX', name: 'INBOX', flags: new Set(), specialUse: '\\Inbox' },
        { path: 'Sent', name: 'Sent', flags: new Set(), specialUse: '\\Sent' },
        { path: 'Trash', name: 'Trash', flags: new Set(), specialUse: '\\Trash' },
      ];
    }
    async getMailboxLock() {
      this.mailbox = { uidValidity: imap.validity };
      return { release: () => undefined };
    }
    async fetchOne(uid: string, query: { source?: boolean }) {
      const source = imap.mails.get(Number(uid));
      if (!source) return false;
      return {
        uid: Number(uid),
        size: source.length,
        flags: new Set<string>(),
        ...(query.source && { source: Buffer.from(source) }),
      };
    }
    async append(path: string, content: string, flags: string[]) {
      if (imap.failAppend) throw new Error('over quota');
      imap.appended.push({ path, content, flags });
      return { destination: path };
    }
    async messageFlagsAdd(range: string, flags: string[]) {
      imap.flagged.push({ range, flags });
      return true;
    }
    async messageFlagsRemove(range: string, flags: string[]) {
      imap.unflagged.push({ range, flags });
      return true;
    }
    async search(query: Record<string, unknown>) {
      imap.searched.push(query);
      return imap.found;
    }
    async fetchAll(range: string) {
      return range.split(',').map((u) => ({
        uid: Number(u),
        size: 100,
        flags: new Set<string>(Number(u) % 2 ? ['\\Seen'] : []),
        envelope: imap.envelopes.get(Number(u)) ?? {},
        bodyStructure: { type: 'text/plain' },
      }));
    }
    async messageMove(range: string, to: string) {
      imap.moved.push({ range, to });
      return { path: 'INBOX', destination: to, uidValidity: 9n, uidMap: new Map([[Number(range), 50]]) };
    }
  },
}));

const sent: { envelope: { from: string; to: string[] }; raw: string }[] = [];
let failSend: Error | null = null;
let rejected: string[] = [];
/** The server says 354 before `failSend` is thrown: the mail went over before the failure. */
let handedOver = false;
type Logger = { debug?: (meta: { tnx?: string }, line: string) => void };
vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: { logger?: Logger | false }) => ({
      sendMail: async (m: { envelope: { from: string; to: string[] }; raw: string }) => {
        if (handedOver && opts.logger)
          opts.logger.debug?.({ tnx: 'server' }, '354 End data with <CR><LF>.<CR><LF>');
        if (failSend) throw failSend;
        sent.push(m);
        return { rejected };
      },
      verify: async () => true,
      close: () => undefined,
    }),
  },
}));

const mail = await import('./mail');
const { mailId, readMailId, outgoing, fromHeader, reach, mailTools, toolKind, runMailTool, mailSender } =
  mail;

const settings = MailSettings.parse({
  address: 'deniz@example.com',
  displayName: 'Deniz',
  imap: { host: 'imap.example.com', port: 993, security: 'tls' },
  smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
  signature: 'Deniz\nexample.com',
});
const target = { settings, password: 'secret-password', publicOnly: async () => false };
const run = (name: string, args: Record<string, unknown>) => runMailTool(target, name, args);
const answer = (r: Awaited<ReturnType<typeof run>>) => {
  const part = r.content[0] as { text: string };
  return {
    error: !!r.isError,
    text: part.text,
    json: r.isError ? null : (JSON.parse(part.text) as Record<string, unknown>),
  };
};

const ORIGINAL = [
  'From: Ayşe <ayse@client.test>',
  'To: deniz@example.com, ali@client.test',
  'Cc: veli@client.test',
  'Subject: Teklif',
  'Date: Fri, 27 Nov 2026 09:00:00 +0300',
  'Message-ID: <first@client.test>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Merhaba, teklif ekte.',
  '--b',
  'Content-Type: application/pdf; name="teklif.pdf"',
  'Content-Disposition: attachment; filename="teklif.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 test').toString('base64'),
  '--b--',
  '',
].join('\r\n');
const originalId = mailId({ folder: 'INBOX', validity: '7', uid: 12 });

beforeEach(() => {
  imap.mails = new Map([[12, ORIGINAL]]);
  imap.validity = 7n;
  imap.appended = [];
  imap.flagged = [];
  imap.unflagged = [];
  imap.searched = [];
  imap.found = [];
  imap.envelopes = new Map();
  imap.moved = [];
  imap.options = [];
  imap.failAppend = false;
  imap.failLogin = false;
  sent.length = 0;
  failSend = null;
  rejected = [];
  handedOver = false;
});

describe('mail ids', () => {
  it('carry the folder, its UIDVALIDITY and the UID back unchanged, folder names with any characters included', () => {
    const ref = { folder: 'Gelen/İş "2026"', validity: '18446744073709551615', uid: 4242 };
    const id = mailId(ref);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readMailId(id)).toEqual(ref);
  });

  it('refuse anything that is not one of them', () => {
    expect(readMailId('abc')).toBeNull();
    expect(readMailId(Buffer.from('["INBOX","7",0]').toString('base64url'))).toBeNull();
    expect(readMailId(Buffer.from('["","7",3]').toString('base64url'))).toBeNull();
    expect(readMailId(Buffer.from('["INBOX","x",3]').toString('base64url'))).toBeNull();
  });
});

describe('a mail ready for SMTP', () => {
  const m = {
    to: ['a@client.test'],
    cc: ['b@client.test'],
    bcc: ['hidden@client.test'],
    subject: 'Merhaba',
    text: 'Selam',
  };

  it('keeps Bcc off the wire, where every recipient would read it, but in the Sent copy and the envelope', () => {
    const out = outgoing(settings, m, new Date('2026-11-28T10:00:00Z'));
    expect(out.wire).not.toMatch(/^Bcc:/im);
    expect(out.wire).not.toContain('hidden@client.test');
    expect(out.copy).toMatch(/^Bcc: hidden@client.test$/im);
    expect(out.envelope).toEqual({
      from: 'deniz@example.com',
      to: ['a@client.test', 'b@client.test', 'hidden@client.test'],
    });
  });

  it('writes From, Date and Message-ID, which Gmail filled in and an SMTP server does not', () => {
    const out = outgoing(settings, m, new Date('2026-11-28T10:00:00Z'));
    expect(out.wire).toMatch(/^From: "Deniz" <deniz@example.com>\r\n/);
    expect(out.wire).toContain('Date: Sat, 28 Nov 2026 10:00:00 +0000');
    expect(out.messageId).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    expect(out.wire).toContain(`Message-ID: ${out.messageId}`);
  });

  it('sends each recipient once however often they are named', () => {
    const out = outgoing(settings, { to: ['a@client.test'], cc: ['a@client.test'], text: 'x' }, new Date());
    expect(out.envelope.to).toEqual(['a@client.test']);
  });

  /** The header block, unfolded lines kept as they are, and the mail read back. */
  const headLines = (raw: string) => raw.split('\r\n\r\n')[0]!.split('\r\n');

  it('folds long headers onto short lines, which an SMTP server needs, and reads back the same', async () => {
    const to = Array.from({ length: 60 }, (_, i) => `recipient-${i}@client.test`);
    const references = Array.from({ length: 20 }, (_, i) => `<${'x'.repeat(50)}-${i}@client.test>`).join(' ');
    const subject = 'Teklif hakkında görüşme: ' + 'şartlar ve ödeme planı '.repeat(12).trim();
    const out = outgoing(
      settings,
      { to, subject, text: 'x', inReplyTo: '<last@client.test>', references },
      new Date('2026-11-28T10:00:00Z'),
    );
    for (const line of headLines(out.wire)) expect(line.length).toBeLessThanOrEqual(78);
    const { default: PostalMime } = await import('postal-mime');
    const back = await PostalMime.parse(out.wire);
    expect(back.to?.map((a) => a.address)).toEqual(to);
    expect(back.subject).toBe(subject);
    expect(back.inReplyTo).toBe('<last@client.test>');
    expect(back.references?.replace(/\s+/g, ' ')).toBe(references);
  });

  it('folds a long plain subject at its spaces and keeps every word', async () => {
    const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const out = outgoing(settings, { to: ['a@client.test'], subject, text: 'x' }, new Date());
    const lines = headLines(out.wire);
    expect(lines.find((l) => l.startsWith('Subject: '))).not.toContain('=?');
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(78);
    const { default: PostalMime } = await import('postal-mime');
    expect((await PostalMime.parse(out.wire)).subject).toBe(subject);
  });

  it('encodes a display name past plain ASCII', () => {
    expect(fromHeader({ address: 'e@example.com', displayName: 'Deniz Yılmaz' })).toBe(
      `=?UTF-8?B?${Buffer.from('Deniz Yılmaz').toString('base64')}?= <e@example.com>`,
    );
    expect(fromHeader({ address: 'e@example.com', displayName: '' })).toBe('e@example.com');
  });
});

describe('reaching a server', () => {
  it('connects a public-only account to the address it checked, keeping the name for TLS', async () => {
    const at = await reach({ host: 'imap.example.com' }, true, async () => [{ address: '93.184.216.34' }]);
    expect(at).toEqual({ host: '93.184.216.34', servername: 'imap.example.com' });
  });

  it("refuses a public-only account a name that points at this machine or the server's network", async () => {
    await expect(
      reach({ host: 'mail.evil.test' }, true, async () => [
        { address: '93.184.216.34' },
        { address: '10.0.0.5' },
      ]),
    ).rejects.toThrow(/private network/);
    await expect(reach({ host: '127.0.0.1' }, true)).rejects.toThrow(/private network/);
  });

  it('names what is wrong with the server, so the person can be told in their language', async () => {
    const missing = await reach({ host: 'nowhere.example.com' }, true, async () => []).catch(
      (e: unknown) => e,
    );
    expect(missing).toBeInstanceOf(mail.MailAccountError);
    expect(missing).toMatchObject({
      reason: 'hostNotFound',
      host: 'nowhere.example.com',
      code: 'unreachable',
    });
    const near = await reach({ host: '10.0.0.5' }, true).catch((e: unknown) => e);
    expect(near).toMatchObject({ reason: 'hostPrivate', host: '10.0.0.5' });
  });

  it('leaves the lookup to the library for an account its owner may point anywhere', async () => {
    expect(await reach({ host: 'mail.lan' }, false)).toEqual({ host: 'mail.lan' });
  });
});

describe('the tools', () => {
  const tool = (name: string, over: Partial<StoredConnectionTool> = {}) => ({
    ...mailTools([]).find((t) => t.name === name)!,
    ...over,
  });

  it('keep the names and inputs of the mail card, so it shows what will be sent', () => {
    const names = mailTools([]).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['send_message', 'reply', 'forward']));
    expect(mailTools([]).every((t) => t.local === 'mail')).toBe(true);
  });

  it('count reading as reading and anything that sends or changes as a change, whatever the person set', () => {
    expect(toolKind(tool('search_messages'))).toBe('read');
    expect(toolKind(tool('list_folders'))).toBe('read');
    expect(toolKind(tool('send_message', { kind: 'read' }))).toBe('write');
    expect(toolKind(tool('trash_message', { kind: 'read' }))).toBe('write');
    expect(toolKind(tool('get_message', { kind: 'write' }))).toBe('write');
  });

  it('keep the switches the person set when listed again', () => {
    const before = mailTools([]).map((t) => (t.name === 'trash_message' ? { ...t, enabled: false } : t));
    expect(mailTools(before).find((t) => t.name === 'trash_message')!.enabled).toBe(false);
  });

  it("give the card the account's address and its signature as HTML", () => {
    expect(mailSender(settings)).toEqual({ address: 'deniz@example.com', signature: 'Deniz<br>example.com' });
  });
});

describe('sending', () => {
  it('sends without the Bcc header and keeps a copy with it in the Sent folder', async () => {
    const a = answer(
      await run('send_message', {
        to: ['a@client.test'],
        bcc: ['hidden@client.test'],
        subject: 'Hi',
        body: 'Selam',
      }),
    );
    expect(a.error).toBe(false);
    expect(a.json).toMatchObject({ sent: true, savedToSent: true });
    expect(sent[0]!.envelope.to).toEqual(['a@client.test', 'hidden@client.test']);
    expect(sent[0]!.raw).not.toContain('hidden@client.test');
    expect(imap.appended[0]).toMatchObject({ path: 'Sent', flags: ['\\Seen'] });
    expect(imap.appended[0]!.content).toContain('Bcc: hidden@client.test');
  });

  it('says the mail went when only the Sent copy failed, so the bot does not send it twice', async () => {
    imap.failAppend = true;
    const a = answer(await run('send_message', { to: ['a@client.test'], body: 'Selam' }));
    expect(a.error).toBe(false);
    expect(a.json).toMatchObject({ sent: true, savedToSent: false });
    expect(String(a.json!.note)).toMatch(/Do not send it again/);
    expect(sent).toHaveLength(1);
  });

  it('keeps no copy when the account is set not to, for providers that keep one themselves', async () => {
    const own = { ...target, settings: { ...settings, saveSent: false } };
    await runMailTool(own, 'send_message', { to: ['a@client.test'], body: 'x' });
    expect(sent).toHaveLength(1);
    expect(imap.appended).toHaveLength(0);
  });

  it('says what the SMTP server refused, and that nothing was sent', async () => {
    failSend = Object.assign(new Error('Message failed'), {
      code: 'EENVELOPE',
      response: '550 relay denied',
    });
    const a = answer(await run('send_message', { to: ['a@client.test'], body: 'x' }));
    expect(a.error).toBe(true);
    expect(a.text).toMatch(/refused sending, so nothing was sent.*550 relay denied/);
  });

  it('says a mail may have gone when the connection dropped after it went over, and keeps no copy', async () => {
    handedOver = true;
    failSend = Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' });
    const a = answer(await run('send_message', { to: ['a@client.test'], body: 'x' }));
    expect(a.error).toBe(false);
    expect(a.json).toMatchObject({ sent: 'unknown', savedToSent: false });
    expect(String(a.json!.note)).toMatch(/may have been sent/);
    expect(imap.appended).toHaveLength(0);
  });

  it('tells a name with no address apart from other failures, as each library reports it', async () => {
    const dns = (code: string) =>
      Object.assign(new Error('getaddrinfo ENOTFOUND smtp.example.com'), { code });
    for (const code of ['EDNS', 'ENOTFOUND']) {
      failSend = dns(code);
      await expect(run('send_message', { to: ['a@client.test'], body: 'x' })).rejects.toMatchObject({
        reason: 'hostNotFound',
        host: 'smtp.example.com',
      });
    }
  });

  it('leaves the answered mail unmarked when the reply may not have gone', async () => {
    handedOver = true;
    failSend = Object.assign(new Error('Connection closed unexpectedly'), { code: 'ECONNECTION' });
    const a = answer(await run('reply', { messageId: originalId, body: 'Tamam' }));
    expect(a.json).toMatchObject({ sent: 'unknown' });
    expect(imap.flagged).toHaveLength(0);
  });

  it('says nothing was sent when the server answered the mail with a refusal', async () => {
    handedOver = true;
    failSend = Object.assign(new Error('Message failed'), {
      code: 'EMESSAGE',
      response: '554 spam',
      responseCode: 554,
    });
    const a = answer(await run('send_message', { to: ['a@client.test'], body: 'x' }));
    expect(a.error).toBe(true);
    expect(a.text).toMatch(/nothing was sent.*554 spam/);
  });

  it('says the connection failed when it dropped before the mail went over', async () => {
    failSend = Object.assign(new Error('Connection closed'), { code: 'ECONNECTION' });
    await expect(run('send_message', { to: ['a@client.test'], body: 'x' })).rejects.toMatchObject({
      code: 'unreachable',
      message: 'SMTP: Connection closed',
    });
  });

  it('adds the signature from the settings only when asked', async () => {
    await run('send_message', { to: ['a@client.test'], body: 'Selam', includeSignature: true });
    await run('send_message', { to: ['a@client.test'], body: 'Selam' });
    const decoded = (raw: string) =>
      [...raw.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)]
        .map((x) => Buffer.from(x[1]!.replace(/\r\n/g, ''), 'base64').toString('utf8'))
        .join('\n');
    expect(decoded(sent[0]!.raw)).toContain('-- \nDeniz\nexample.com');
    expect(decoded(sent[1]!.raw)).not.toContain('example.com');
  });

  it('refuses a mail with no recipient before reaching any server', async () => {
    const a = answer(await run('send_message', { body: 'x' }));
    expect(a.text).toMatch(/^Nothing was done: to/);
    expect(imap.options).toHaveLength(0);
  });
});

describe('replying and forwarding', () => {
  it('answers the sender in the conversation and marks the mail answered', async () => {
    const a = answer(await run('reply', { messageId: originalId, body: 'Teşekkürler' }));
    expect(a.json).toMatchObject({ sent: true, to: ['ayse@client.test'], cc: [] });
    expect(sent[0]!.raw).toContain('In-Reply-To: <first@client.test>');
    expect(sent[0]!.raw).toContain('References: <first@client.test>');
    expect(sent[0]!.raw).toContain('Subject: Re: Teklif');
    expect(imap.flagged).toContainEqual({ range: '12', flags: ['\\Answered'] });
  });

  it('answers everyone else on the mail with replyAll, leaving the account itself out', async () => {
    const a = answer(await run('reply', { messageId: originalId, body: 'x', replyAll: true }));
    expect(a.json).toMatchObject({ to: ['ayse@client.test', 'ali@client.test'], cc: ['veli@client.test'] });
  });

  it('forwards the mail with its files', async () => {
    const a = answer(
      await run('forward', { messageId: originalId, to: ['boss@example.com'], forwardText: 'Bakar mısın?' }),
    );
    expect(a.error).toBe(false);
    expect(sent[0]!.raw).toContain('Subject: Fwd: Teklif');
    expect(sent[0]!.raw).toContain('filename="teklif.pdf"');
  });

  it('refuses an id from before the folder was renumbered rather than touch another mail', async () => {
    imap.validity = 8n;
    const a = answer(await run('reply', { messageId: originalId, body: 'x' }));
    expect(a.text).toMatch(/renumbered/);
    expect(sent).toHaveLength(0);
  });
});

describe('reading and changing', () => {
  it('reads a mail with its files listed', async () => {
    const a = answer(await run('get_message', { messageId: originalId }));
    expect(a.json).toMatchObject({
      subject: 'Teklif',
      from: 'Ayşe <ayse@client.test>',
      body: expect.stringContaining('teklif ekte'),
      attachments: [{ attachmentIndex: 0, filename: 'teklif.pdf', mimeType: 'application/pdf' }],
    });
  });

  it('keeps an attachment in the conversation folder', async () => {
    const saveFile = vi.fn(async (name: string, _data: Buffer) => `/files/${name}`);
    const r = await runMailTool(target, 'download_attachment', { messageId: originalId }, undefined, {
      saveFile,
    });
    expect(answer(r).json).toMatchObject({ saved: [{ path: '/files/teklif.pdf' }] });
    expect(saveFile.mock.calls[0]![1].toString()).toBe('%PDF-1.4 test');
  });

  it('moves mails to the Trash and gives their new ids', async () => {
    const a = answer(await run('trash_message', { messageIds: [originalId] }));
    expect(imap.moved).toEqual([{ range: '12', to: 'Trash' }]);
    expect(a.json).toMatchObject({
      folder: 'Trash',
      moved: [{ from: originalId, to: mailId({ folder: 'Trash', validity: '9', uid: 50 }) }],
    });
  });

  it('refuses a move to a folder the account does not have', async () => {
    const a = answer(await run('move_messages', { messageIds: [originalId], folder: 'Arşiv' }));
    expect(a.text).toMatch(/no folder "Arşiv"/);
    expect(imap.moved).toHaveLength(0);
  });

  it('throws a sign-in failure as one, so the connection asks for the password again', async () => {
    imap.failLogin = true;
    await expect(run('get_message', { messageId: originalId })).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });

  it('asks for TLS before the password on a STARTTLS server', async () => {
    const starttls = {
      ...target,
      settings: { ...settings, imap: { ...settings.imap, port: 143, security: 'starttls' as const } },
    };
    await runMailTool(starttls, 'get_message', { messageId: originalId });
    expect(imap.options[0]).toMatchObject({ secure: false, doSTARTTLS: true, logger: false });
  });
});

describe('searching', () => {
  it('lists the newest first, as many as asked for, each with an id the other tools take', async () => {
    imap.found = [3, 9, 5, 7];
    imap.envelopes.set(9, {
      date: new Date('2026-11-27T09:00:00Z'),
      subject: 'Yeni',
      from: [{ name: 'Ayşe', address: 'ayse@client.test' }],
    });
    const a = answer(await run('search_messages', { limit: 2 }));
    expect(imap.searched).toEqual([{ all: true }]);
    expect(a.json).toMatchObject({ folder: 'INBOX', total: 4 });
    const rows = a.json!.messages as Record<string, unknown>[];
    expect(rows.map((r) => readMailId(String(r.messageId))?.uid)).toEqual([9, 7]);
    expect(rows[0]).toMatchObject({
      date: '2026-11-27T09:00:00.000Z',
      subject: 'Yeni',
      from: 'Ayşe <ayse@client.test>',
      seen: true,
    });
  });

  it('turns the conditions into one IMAP search', async () => {
    await run('search_messages', { folder: 'Arşiv', from: 'ayse', since: '2026-11-01', unreadOnly: true });
    expect(imap.searched[0]).toEqual({ from: 'ayse', since: new Date('2026-11-01T00:00:00Z'), seen: false });
  });

  it('refuses a day that is not on the calendar rather than search from another one', async () => {
    const a = answer(await run('search_messages', { since: '2026-02-30' }));
    expect(a.error).toBe(true);
    expect(a.text).toMatch(/Nothing was done/);
    expect(imap.searched).toHaveLength(0);
  });

  it('keeps a Date header nobody could read as written rather than failing the whole list', async () => {
    imap.found = [4];
    imap.envelopes.set(4, { date: 'yarın sabah' });
    const a = answer(await run('search_messages', {}));
    expect(a.error).toBe(false);
    expect((a.json!.messages as Record<string, unknown>[])[0]!.date).toBe('yarın sabah');
  });

  it('lists the folders with their special use', async () => {
    const a = answer(await run('list_folders', {}));
    expect(a.json!.folders).toEqual(
      expect.arrayContaining([expect.objectContaining({ folder: 'Sent', specialUse: '\\Sent' })]),
    );
  });
});

describe('marking', () => {
  it('marks mails read and takes the flag off in one call', async () => {
    const a = answer(
      await run('update_message_flags', { messageIds: [originalId], seen: true, flagged: false }),
    );
    expect(a.json).toMatchObject({ changed: 1, seen: true, flagged: false });
    expect(imap.flagged).toEqual([{ range: '12', flags: ['\\Seen'] }]);
    expect(imap.unflagged).toEqual([{ range: '12', flags: ['\\Flagged'] }]);
  });
});

describe('recipients the server turned away', () => {
  it('are named, so the bot does not say everyone got it', async () => {
    rejected = ['gone@client.test'];
    const a = answer(await run('send_message', { to: ['a@client.test', 'gone@client.test'], body: 'x' }));
    expect(a.json).toMatchObject({ sent: true, rejected: ['gone@client.test'] });
  });
});
