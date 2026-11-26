import { DnsFull, type NameDns } from './service';

const API = 'https://api.cloudflare.com/client/v4';

/** Cloudflare's error code for a record that does not exist. */
const NO_RECORD = 81044;

interface ApiReply {
  success: boolean;
  errors?: { code: number; message: string }[];
  result?: { id?: string } | null;
}

export class DnsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[],
  ) {
    super(message);
  }
}

/**
 * A records in one Cloudflare zone, through its API. The token needs Zone → DNS → Edit on that zone
 * only.
 */
export class CloudflareDns implements NameDns {
  constructor(
    private readonly zoneId: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(method: string, path: string, body?: unknown): Promise<ApiReply> {
    // Called on its own, not as `this.fetcher(...)`: the Workers runtime refuses its fetch with any
    // `this` but the global one ("Illegal invocation").
    const fetcher = this.fetcher;
    const res = await fetcher(`${API}/zones/${this.zoneId}/dns_records${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const reply = (await res.json().catch(() => ({ success: false }))) as ApiReply;
    if (!res.ok || !reply.success) {
      const errors = reply.errors ?? [];
      throw new DnsApiError(
        errors.map((e) => `${e.code} ${e.message}`).join('; ') || `HTTP ${res.status}`,
        res.status,
        errors.map((e) => e.code),
      );
    }
    return reply;
  }

  async create(fqdn: string, ip: string): Promise<string> {
    try {
      const reply = await this.call('POST', '', {
        type: 'A',
        name: fqdn,
        content: ip,
        // Automatic (five minutes): an address rarely changes, and the first lookup is after the record exists.
        ttl: 1,
        // DNS only: Caddy on the server answers Let's Encrypt and serves HTTPS itself.
        proxied: false,
        comment: 'Leaf Bot server name',
      });
      const id = reply.result?.id;
      if (!id) throw new DnsApiError('no record id in the reply', 200, []);
      return id;
    } catch (e) {
      // A full zone is told apart by the message, which names the quota, rather than by an error code
      // this service would have to keep up with. The service's own `total` limit usually comes first.
      if (e instanceof DnsApiError && /quota|limit/i.test(e.message)) throw new DnsFull(e.message);
      throw e;
    }
  }

  async update(recordId: string, ip: string): Promise<void> {
    await this.call('PATCH', `/${recordId}`, { content: ip });
  }

  async remove(recordId: string): Promise<void> {
    try {
      await this.call('DELETE', `/${recordId}`);
    } catch (e) {
      if (e instanceof DnsApiError && (e.status === 404 || e.codes.includes(NO_RECORD))) return;
      throw e;
    }
  }
}
