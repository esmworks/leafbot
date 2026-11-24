import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { authHeaders, type AiEndpointService, type AiService } from './ai-endpoints';

const TIMEOUT_MS = 30_000;
/** Notes sent in one request; local servers handle small batches best. */
const BATCH = 16;
/** How similar a note must be to a query to count as a hit when its words do not match. */
export const MIN_SCORE = 0.45;

/** Why a call to the embedding service failed, in its own words. */
export class EmbeddingError extends Error {}

const keyOf = (model: string, text: string) => createHash('sha256').update(`${model}\n${text}`).digest('hex');

function normalize(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / len);
}

/** Cosine similarity of two vectors of length 1. */
export const similarity = (a: number[], b: number[]) => {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) sum += a[i]! * b[i]!;
  return sum;
};

/**
 * Search of memory by meaning: each note is turned into numbers by the embedding service the
 * person set, and a query finds the notes nearest to it, also when they share no word ("my
 * spouse" finds "Ayşe is my wife"). Notes are indexed in the background; one not indexed yet is
 * still found by its words.
 */
export class EmbeddingService {
  private syncing: Promise<{ indexed: number; left: number }> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ctx: Ctx,
    private ai: AiEndpointService,
    private fetcher: typeof fetch = fetch,
  ) {
    // A new model or address indexes every note again.
    ai.onChange((kind) => {
      if (kind === 'embeddings') this.soon();
    });
  }

  async available(): Promise<boolean> {
    return !!(await this.ai.get('embeddings'));
  }

  /** Embeds texts with the service; each vector has length 1. */
  async embed(texts: string[], service?: AiService): Promise<number[][]> {
    const s = service ?? (await this.ai.get('embeddings'));
    if (!s) throw new EmbeddingError('off');
    const res = await this.fetcher(`${s.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(s) },
      body: JSON.stringify({ model: s.model, input: texts }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: { embedding?: unknown; index?: number }[];
      error?: { message?: string } | string;
    } | null;
    if (!res.ok || !Array.isArray(body?.data)) {
      const msg = typeof body?.error === 'string' ? body.error : body?.error?.message;
      throw new EmbeddingError(msg ?? `HTTP ${res.status}`);
    }
    const rows = [...body.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== texts.length) throw new EmbeddingError('count');
    return rows.map((r) => {
      if (!Array.isArray(r.embedding) || !r.embedding.every((x) => typeof x === 'number'))
        throw new EmbeddingError('format');
      return normalize(r.embedding as number[]);
    });
  }

  /** Tries the service with a short text: how many numbers its vectors have. */
  async test(): Promise<{ dimensions: number }> {
    const [v] = await this.embed(['Leaf Bot']);
    return { dimensions: v!.length };
  }

  /** Indexing a little later, after a burst of changes has settled. */
  soon(delayMs = 2_000) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync().catch((err) => console.warn(`Memory indexing failed: ${String(err)}`));
    }, delayMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Indexes notes that have no embedding of the current model and words, up to `max` of them.
   * One run at a time; a second caller waits for the run under way.
   */
  sync(max = 1000): Promise<{ indexed: number; left: number }> {
    this.syncing ??= this.run(max).finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async run(max: number): Promise<{ indexed: number; left: number }> {
    const s = await this.ai.get('embeddings');
    if (!s) return { indexed: 0, left: 0 };
    const rows = await this.ctx.db
      .select({ id: schema.memories.id, content: schema.memories.content, key: schema.memories.embeddingKey })
      .from(schema.memories);
    const stale = rows.filter((r) => r.key !== keyOf(s.model, r.content));
    const todo = stale.slice(0, max);
    for (let i = 0; i < todo.length; i += BATCH) {
      const part = todo.slice(i, i + BATCH);
      const vectors = await this.embed(
        part.map((r) => r.content),
        s,
      );
      for (const [j, r] of part.entries()) {
        await this.ctx.db
          .update(schema.memories)
          .set({ embedding: vectors[j]!, embeddingKey: keyOf(s.model, r.content) })
          .where(eq(schema.memories.id, r.id));
      }
    }
    return { indexed: todo.length, left: stale.length - todo.length };
  }

  /**
   * The vectors of these notes that are indexed with the current model and words, by id; null when
   * search by meaning is off. Nothing is sent to the service: a note not indexed yet has none.
   */
  async vectors(
    notes: { id: string; content: string; embedding: number[] | null; embeddingKey: string | null }[],
  ) {
    const s = await this.ai.get('embeddings');
    if (!s) return null;
    const out = new Map<string, number[]>();
    for (const n of notes) {
      if (n.embedding && n.embeddingKey === keyOf(s.model, n.content)) out.set(n.id, n.embedding);
    }
    return out;
  }

  /** How many notes are indexed with the current model, of all of them. */
  async status(): Promise<{ indexed: number; total: number }> {
    const s = await this.ai.get('embeddings');
    const rows = await this.ctx.db
      .select({ content: schema.memories.content, key: schema.memories.embeddingKey })
      .from(schema.memories);
    return {
      indexed: s ? rows.filter((r) => r.key === keyOf(s.model, r.content)).length : 0,
      total: rows.length,
    };
  }

  /**
   * How near each note is to `query`, by id, for the notes indexed with the current model. Null
   * when search by meaning is off or the service cannot be reached; the caller then goes by words.
   */
  async scores(
    query: string,
    notes: { id: string; content: string; embedding: number[] | null; embeddingKey: string | null }[],
  ): Promise<Map<string, number> | null> {
    const s = await this.ai.get('embeddings');
    if (!s) return null;
    try {
      // A few notes written just now are indexed first, so a fact saved a moment ago is found.
      await this.sync(32);
      const fresh = await this.ctx.db
        .select({
          id: schema.memories.id,
          embedding: schema.memories.embedding,
          key: schema.memories.embeddingKey,
        })
        .from(schema.memories);
      const byId = new Map(fresh.map((r) => [r.id, r]));
      const [q] = await this.embed([query], s);
      const out = new Map<string, number>();
      for (const n of notes) {
        const row = byId.get(n.id);
        if (!row?.embedding || row.key !== keyOf(s.model, n.content)) continue;
        out.set(n.id, similarity(q!, row.embedding));
      }
      this.soon();
      return out;
    } catch (err) {
      console.warn(`Search by meaning failed, searching by words: ${String(err)}`);
      return null;
    }
  }
}
