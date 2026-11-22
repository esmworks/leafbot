import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { connect, type ClientHttp2Session } from 'node:http2';

/** What the server needs to talk to Apple's push service. */
export interface ApnsCredentials {
  teamId: string;
  keyId: string;
  bundleId: string;
  /** The .p8 file's contents (PEM). */
  key: string;
}

export interface ApnsRequest {
  token: string;
  sandbox: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface ApnsResponse {
  status: number;
  /** Apple's reason for a refusal, such as BadDeviceToken or Unregistered. */
  reason?: string;
}

/** Sends one request to Apple; replaced in tests. */
export type ApnsTransport = (req: ApnsRequest) => Promise<ApnsResponse>;

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');

/** Whether the text is a private key Node can sign with; false for anything else pasted. */
export function readableKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'ec';
  } catch {
    return false;
  }
}

/**
 * The signed token Apple asks for with each request. Apple refuses tokens older than an hour and
 * throttles new ones made more often than every 20 minutes, so one is kept for 50 minutes.
 */
export class ApnsToken {
  private cached: { value: string; at: number } | null = null;
  private keyObject: KeyObject;
  constructor(
    private creds: ApnsCredentials,
    private now: () => number = Date.now,
  ) {
    this.keyObject = createPrivateKey(creds.key);
  }

  get(): string {
    const now = this.now();
    if (this.cached && now - this.cached.at < 50 * 60_000) return this.cached.value;
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: this.creds.keyId }));
    const claims = b64url(JSON.stringify({ iss: this.creds.teamId, iat: Math.floor(now / 1000) }));
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: this.keyObject,
      dsaEncoding: 'ieee-p1363',
    });
    const value = `${header}.${claims}.${b64url(signature)}`;
    this.cached = { value, at: now };
    return value;
  }
}

/** HTTP/2 to Apple, one connection per service kept open while in use. */
export function http2Transport(): ApnsTransport & { close(): void } {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string) => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(origin);
    s.on('error', () => sessions.delete(origin));
    s.on('close', () => sessions.delete(origin));
    // An idle connection is let go; the next notification opens a new one.
    s.setTimeout(5 * 60_000, () => s.close());
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  const send: ApnsTransport = (req) =>
    new Promise((resolve, reject) => {
      const origin = req.sandbox ? APNS_HOSTS.sandbox : APNS_HOSTS.production;
      const stream = session(origin).request({
        ':method': 'POST',
        ':path': `/3/device/${req.token}`,
        ...req.headers,
      });
      let status = 0;
      let data = '';
      stream.setEncoding('utf8');
      stream.setTimeout(15_000, () => stream.close());
      stream.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
      });
      stream.on('data', (chunk: string) => {
        data += chunk;
      });
      stream.on('end', () => {
        let reason: string | undefined;
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason;
        } catch {
          // Success has no body.
        }
        resolve({ status, ...(reason && { reason }) });
      });
      stream.on('error', reject);
      stream.end(req.body);
    });
  return Object.assign(send, {
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  });
}

export interface ApnsAlert {
  title: string;
  body: string;
  /** Groups a conversation's notifications together on the phone. */
  threadId: string;
  /** A newer notification with the same id replaces the older one. */
  collapseId: string;
  data: Record<string, string>;
}

/** A change to a Live Activity on the lock screen: new content, or its end. */
export interface ApnsActivity {
  event: 'update' | 'end';
  /** Unix seconds; Apple drops an update older than one it already has. */
  timestamp: number;
  /** The state the phone's layout reads: the name it is registered under and its props as JSON. */
  contentState: { name: string; props: string };
  /** After this the phone dims the activity as out of date, if nothing newer has come. */
  staleDate?: number;
  /** For an end: when the phone takes it off the lock screen. */
  dismissalDate?: number;
}

/** The request Apple expects for a Live Activity, sent to that activity's own token. */
export function activityRequest(
  token: string,
  sandbox: boolean,
  auth: string,
  topic: string,
  a: ApnsActivity,
) {
  return {
    token,
    sandbox,
    headers: {
      authorization: `bearer ${auth}`,
      'apns-topic': `${topic}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
    },
    body: JSON.stringify({
      aps: {
        timestamp: a.timestamp,
        event: a.event,
        'content-state': a.contentState,
        ...(a.staleDate !== undefined && { 'stale-date': a.staleDate }),
        ...(a.dismissalDate !== undefined && { 'dismissal-date': a.dismissalDate }),
      },
    }),
  } satisfies ApnsRequest;
}

/** The request Apple expects for a visible notification. */
export function alertRequest(token: string, sandbox: boolean, auth: string, topic: string, a: ApnsAlert) {
  return {
    token,
    sandbox,
    headers: {
      authorization: `bearer ${auth}`,
      'apns-topic': topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': a.collapseId.slice(0, 64),
    },
    body: JSON.stringify({
      aps: { alert: { title: a.title, body: a.body }, sound: 'default', 'thread-id': a.threadId },
      ...a.data,
    }),
  } satisfies ApnsRequest;
}
