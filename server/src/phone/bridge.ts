import { PhoneAnswer, type PhoneAsk, type PhoneKind, PHONE_KINDS } from '@leafbot/shared';

/** How long a bot waits for the phone; an app in the background may not answer at all. */
export const PHONE_ANSWER_MS = 20_000;

export class PhoneUnreachable extends Error {
  constructor() {
    super('phone not reachable');
  }
}

/** Sends one question to one socket and waits for its answer; rejects when none comes in time. */
export type PhoneSend = (socketId: string, ask: PhoneAsk, timeoutMs: number) => Promise<unknown>;

/**
 * The people's phones that are connected now and what each lets bots read. A phone app says it
 * over its socket (`phone:offer`); a question goes to that person's phone that offered it most
 * recently, never to anyone else's.
 */
export class PhoneBridge {
  private offers = new Map<string, { userId: string; kinds: ReadonlySet<PhoneKind>; at: number }>();
  private send: PhoneSend | null = null;
  private seq = 0;

  constructor(private answerMs = PHONE_ANSWER_MS) {}

  attach(send: PhoneSend) {
    this.send = send;
  }

  offer(socketId: string, userId: string, kinds: unknown) {
    const list = Array.isArray(kinds) ? kinds.filter((k): k is PhoneKind => PHONE_KINDS.includes(k)) : [];
    if (!list.length) this.offers.delete(socketId);
    else this.offers.set(socketId, { userId, kinds: new Set(list), at: ++this.seq });
  }

  drop(socketId: string) {
    this.offers.delete(socketId);
  }

  /** What this person's connected phones let bots read now. */
  kinds(userId: string): Set<PhoneKind> {
    const all = new Set<PhoneKind>();
    for (const o of this.offers.values()) if (o.userId === userId) for (const k of o.kinds) all.add(k);
    return all;
  }

  /**
   * Asks this person's phone. Throws `PhoneUnreachable` when no phone of theirs offers it now or
   * none answers in time; an answer that is not one a phone gives counts as a failure.
   */
  async ask(userId: string, ask: PhoneAsk): Promise<PhoneAnswer> {
    const target = [...this.offers.entries()]
      .filter(([, o]) => o.userId === userId && o.kinds.has(ask.kind))
      .sort(([, a], [, b]) => b.at - a.at)[0];
    if (!target || !this.send) throw new PhoneUnreachable();
    let raw: unknown;
    try {
      raw = await this.send(target[0], ask, this.answerMs);
    } catch {
      throw new PhoneUnreachable();
    }
    const parsed = PhoneAnswer.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'failed' };
    // An answer of another kind than asked is not used.
    if (parsed.data.ok && parsed.data.kind !== ask.kind) return { ok: false, reason: 'failed' };
    return parsed.data;
  }
}
