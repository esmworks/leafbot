import { randomUUID } from 'node:crypto';

/** Reads a part of a result too long for the conversation, kept whole (see `ResultStore`). */
export const RESULT_TOOL = 'ReadResult';

/** The results one conversation keeps at most; an older one goes when a new one comes. */
const PER_SESSION = 10;
/** Characters all conversations keep together at most; the least recently used conversation goes first. */
const TOTAL_CHARS = 40_000_000;
/** The longest result kept: past it the end is left out too, and each page read back gives the kept length. */
export const SAVED_MAX = 4_000_000;

/** The source an outside-data block names (see `asOutsideData`); null when the text is not one. */
const OUTSIDE = /^[^\n]*\n<outside-data source="([^"]*)">\n/;

export interface SavedResult {
  text: string;
  /** Where the text came from, when it was outside data: each piece read back is marked again. */
  source: string | null;
}

/**
 * Tool results too long for the conversation's room, kept whole in memory for the rest of the
 * conversation so the bot reads the part it needs, page by page, instead of asking again for less.
 * Kept only in memory: what a tool returned stays with the conversation that asked for it, and a
 * restart forgets it.
 */
export class ResultStore {
  private sessions = new Map<string, Map<string, SavedResult>>();
  private chars = 0;

  save(sessionId: string, text: string): string {
    const kept = text.slice(0, SAVED_MAX);
    const source = OUTSIDE.exec(kept)?.[1] ?? null;
    const id = randomUUID().slice(0, 8);
    const results = this.sessions.get(sessionId) ?? new Map<string, SavedResult>();
    // Used now: it goes last among those that leave first.
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, results);
    results.set(id, { text: kept, source });
    this.chars += kept.length;
    while (results.size > PER_SESSION) {
      const [oldest] = results.keys();
      this.chars -= results.get(oldest!)!.text.length;
      results.delete(oldest!);
    }
    for (const [other, list] of this.sessions) {
      if (this.chars <= TOTAL_CHARS || other === sessionId) break;
      for (const r of list.values()) this.chars -= r.text.length;
      this.sessions.delete(other);
    }
    return id;
  }

  get(sessionId: string, id: string): SavedResult | null {
    return this.sessions.get(sessionId)?.get(id) ?? null;
  }
}
