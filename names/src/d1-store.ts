import type { NameRow, NameStore } from './service';

/**
 * The parts of Cloudflare's D1 binding this service uses, written out here so the package needs no
 * Cloudflare type package. Tests hand in an adapter over node:sqlite with the same shape.
 */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
}

interface Row {
  label: string;
  ip: string;
  record_id: string;
  token_hash: string;
  created_at: number;
  seen_at: number;
}

const toName = (r: Row): NameRow => ({
  label: r.label,
  ip: r.ip,
  recordId: r.record_id,
  tokenHash: r.token_hash,
  createdAt: Number(r.created_at),
  seenAt: Number(r.seen_at),
});

/** Names and claims kept in D1, which, unlike KV, reads back what was just written: the limits count on it. */
export class D1NameStore implements NameStore {
  constructor(private readonly db: D1Database) {}

  async byLabel(label: string): Promise<NameRow | null> {
    const r = await this.db.prepare('SELECT * FROM names WHERE label = ?').bind(label).first<Row>();
    return r ? toName(r) : null;
  }

  async countByIp(ip: string): Promise<number> {
    const r = await this.db
      .prepare('SELECT COUNT(*) AS n FROM names WHERE ip = ?')
      .bind(ip)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async latestByIp(ip: string): Promise<NameRow | null> {
    const r = await this.db
      .prepare('SELECT * FROM names WHERE ip = ? ORDER BY seen_at DESC, created_at DESC LIMIT 1')
      .bind(ip)
      .first<Row>();
    return r ? toName(r) : null;
  }

  async insert(n: NameRow): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO names (label, ip, record_id, token_hash, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .bind(n.label, n.ip, n.recordId, n.tokenHash, n.createdAt, n.seenAt)
      .run();
  }

  async setIp(label: string, ip: string, seenAt: number): Promise<void> {
    await this.db
      .prepare('UPDATE names SET ip = ?, seen_at = ? WHERE label = ?')
      .bind(ip, seenAt, label)
      .run();
  }

  async touch(label: string, seenAt: number): Promise<void> {
    await this.db.prepare('UPDATE names SET seen_at = ? WHERE label = ?').bind(seenAt, label).run();
  }

  async remove(label: string): Promise<void> {
    await this.db.prepare('DELETE FROM names WHERE label = ?').bind(label).run();
  }

  async count(): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM names').first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async claimsSince(since: number): Promise<number> {
    const r = await this.db
      .prepare('SELECT COUNT(*) AS n FROM claims WHERE at >= ?')
      .bind(since)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async claimsFromIpSince(ip: string, since: number): Promise<number> {
    const r = await this.db
      .prepare('SELECT COUNT(*) AS n FROM claims WHERE ip = ? AND at >= ?')
      .bind(ip, since)
      .first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async logClaim(ip: string, at: number): Promise<void> {
    await this.db.prepare('INSERT INTO claims (ip, at) VALUES (?, ?)').bind(ip, at).run();
  }

  async pruneClaims(before: number): Promise<void> {
    await this.db.prepare('DELETE FROM claims WHERE at < ?').bind(before).run();
  }

  async staleBefore(before: number, limit: number): Promise<NameRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM names WHERE seen_at < ? ORDER BY seen_at LIMIT ?')
      .bind(before, limit)
      .all<Row>();
    return results.map(toName);
  }
}
