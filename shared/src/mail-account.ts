import { z } from 'zod';

/**
 * A mail account reached over IMAP (reading) and SMTP (sending), such as an address on one's own
 * domain at a hosting company: a connection whose tools this server runs itself, since such
 * accounts have no MCP server of their own. The password is kept sealed as the connection's token;
 * everything here is shown again in its settings.
 */

/**
 * How a mail server is reached: TLS from the first byte (993, 465), or STARTTLS required before
 * signing in (143, 587). There is no plain choice: the password would cross the network readable.
 */
export const MailSecurity = z.enum(['tls', 'starttls']);
export type MailSecurity = z.infer<typeof MailSecurity>;

/** A host name or IPv4 address, nothing else: it goes straight to a socket. */
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const MailServer = z.object({
  host: z.string().trim().toLowerCase().regex(HOST, 'error.mailHost'),
  port: z.number().int().min(1).max(65535),
  security: MailSecurity,
});
export type MailServer = z.infer<typeof MailServer>;

const MAIL_ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export const MailSettings = z.object({
  /** The address mail goes out from, and the account's own address when answering. */
  address: z.string().trim().max(320).regex(MAIL_ADDRESS, 'error.mailAddress'),
  /** The name shown beside the address on mail sent; empty for the address alone. */
  displayName: z
    .string()
    .trim()
    .max(100)
    // It goes into the From header: no line break, and no character that would end the name.
    .regex(/^[^\r\n\0"<>\\]*$/, 'error.mailDisplayName')
    .default(''),
  /** The user name both servers sign in with; empty for the address. */
  username: z
    .string()
    .trim()
    .max(320)
    .regex(/^[^\r\n\0]*$/)
    .default(''),
  imap: MailServer,
  smtp: MailServer,
  /**
   * A copy of each mail sent is put in the Sent folder. Off for providers that keep one themselves,
   * where the copy would show twice.
   */
  saveSent: z.boolean().default(true),
  /** Plain text added under a mail when the bot asks for the signature. */
  signature: z.string().max(10_000).default(''),
});
export type MailSettings = z.infer<typeof MailSettings>;
export type MailSettingsInput = z.input<typeof MailSettings>;

/** The user name the servers are signed in with. */
export const mailUsername = (m: Pick<MailSettings, 'username' | 'address'>) => m.username || m.address;

/**
 * The address a mail connection is kept under: its IMAP server. It is never fetched; it names the
 * connection, and tells it apart from an MCP server.
 */
export function mailUrl(m: Pick<MailSettings, 'imap'>): string {
  return `${m.imap.security === 'tls' ? 'imaps' : 'imap'}://${m.imap.host}:${m.imap.port}`;
}

/** Whether a connection's address is a mail account's rather than an MCP server's. */
export function isMailUrl(url: string): boolean {
  return /^imaps?:\/\//i.test(url);
}

/** The usual ports for each way in, to fill in when the person picks one. */
export const MAIL_PORTS = {
  imap: { tls: 993, starttls: 143 },
  smtp: { tls: 465, starttls: 587 },
} as const satisfies Record<'imap' | 'smtp', Record<MailSecurity, number>>;

/**
 * Servers to try for an address, before the person knows better: most hosts name them `imap.` and
 * `smtp.` under the mail's own domain, and take TLS on the usual ports.
 */
export function guessMailServers(address: string): Pick<MailSettings, 'imap' | 'smtp'> | null {
  const domain = address.trim().toLowerCase().split('@')[1];
  if (!domain || !HOST.test(domain) || !domain.includes('.')) return null;
  return {
    imap: { host: `imap.${domain}`, port: MAIL_PORTS.imap.tls, security: 'tls' },
    smtp: { host: `smtp.${domain}`, port: MAIL_PORTS.smtp.tls, security: 'tls' },
  };
}
