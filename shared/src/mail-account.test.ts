import { describe, expect, it } from 'vitest';
import { ConnectionCreate } from './connections';
import { MailSettings, guessMailServers, isMailUrl, mailUrl, mailUsername } from './mail-account';

const servers = {
  imap: { host: 'IMAP.Example.com', port: 993, security: 'tls' as const },
  smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' as const },
};

describe('mail account settings', () => {
  it('fill in what was left out, and sign in with the address when no user name is given', () => {
    const m = MailSettings.parse({ address: 'deniz@example.com', ...servers });
    expect(m).toMatchObject({ displayName: '', username: '', saveSent: true, signature: '' });
    expect(m.imap.host).toBe('imap.example.com');
    expect(mailUsername(m)).toBe('deniz@example.com');
    expect(mailUsername({ ...m, username: 'deniz' })).toBe('deniz');
  });

  it('refuse a server name that is not a host, since it goes straight to a socket', () => {
    for (const host of ['imap.example.com:993', 'http://imap.example.com', 'imap example.com', '']) {
      expect(
        MailSettings.safeParse({ address: 'e@example.com', ...servers, imap: { ...servers.imap, host } })
          .success,
      ).toBe(false);
    }
  });

  it('refuse a display name that could start another header', () => {
    expect(
      MailSettings.safeParse({ address: 'e@example.com', displayName: 'Deniz\r\nBcc: x@y.z', ...servers })
        .success,
    ).toBe(false);
    expect(
      MailSettings.safeParse({ address: 'e@example.com', displayName: 'Deniz <x@y.z>', ...servers }).success,
    ).toBe(false);
  });

  it('are kept under their IMAP server, which tells them apart from an MCP server', () => {
    expect(mailUrl({ imap: { host: 'imap.example.com', port: 993, security: 'tls' } })).toBe(
      'imaps://imap.example.com:993',
    );
    expect(mailUrl({ imap: { host: 'imap.example.com', port: 143, security: 'starttls' } })).toBe(
      'imap://imap.example.com:143',
    );
    expect(isMailUrl('imaps://imap.example.com:993')).toBe(true);
    expect(isMailUrl('https://mcp.example.com/mcp')).toBe(false);
  });

  it("guess the servers from the address's domain", () => {
    expect(guessMailServers('deniz@ornek-ajans.com.tr')).toEqual({
      imap: { host: 'imap.ornek-ajans.com.tr', port: 993, security: 'tls' },
      smtp: { host: 'smtp.ornek-ajans.com.tr', port: 465, security: 'tls' },
    });
    expect(guessMailServers('deniz')).toBeNull();
  });
});

describe('adding a connection', () => {
  const mail = { address: 'deniz@example.com', ...servers };

  const account = { name: 'Mail', url: 'imaps://imap.example.com:993', auth: 'token' as const, mail };

  it('takes a mail account under its IMAP address with its password, spaces at either end kept', () => {
    const ok = ConnectionCreate.safeParse({ ...account, password: ' pw with spaces ' });
    expect(ok.success).toBe(true);
    expect(ok.data?.password).toBe(' pw with spaces ');
  });

  it('refuses a mail account without its password, a trimmed token not standing in for it', () => {
    expect(ConnectionCreate.safeParse(account).success).toBe(false);
    expect(ConnectionCreate.safeParse({ ...account, token: 'pw' }).success).toBe(false);
  });

  it('takes a password only for a mail account', () => {
    expect(
      ConnectionCreate.safeParse({
        name: 'X',
        url: 'https://mcp.example.com/mcp',
        auth: 'token',
        token: 't',
        password: 'p',
      }).success,
    ).toBe(false);
  });

  it('still takes only a web address for an MCP server', () => {
    expect(
      ConnectionCreate.safeParse({ name: 'X', url: 'imaps://imap.example.com:993', auth: 'none' }).success,
    ).toBe(false);
    expect(
      ConnectionCreate.safeParse({ name: 'X', url: 'https://mcp.example.com/mcp', auth: 'none' }).success,
    ).toBe(true);
  });
});
