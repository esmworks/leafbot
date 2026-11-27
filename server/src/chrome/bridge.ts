import { ChromeAnswer, type ChromeAsk, CHROME_ANSWER_MS } from '@leafbot/shared';

export class ChromeUnreachable extends Error {
  constructor() {
    super('chrome not reachable');
  }
}

/** Sends one question to one socket and waits for its answer; rejects when none comes in time. */
export type ChromeSend = (socketId: string, ask: ChromeAsk, timeoutMs: number) => Promise<unknown>;

/** How many turns sent from a panel are remembered; older ones no longer reach Chrome. */
const KEPT_TURNS = 200;

/**
 * The people's Chrome side panels that share their Chrome now. A panel says so over its socket
 * (`chrome:offer`); a question goes to that person's panel that offered most recently, never to
 * anyone else's.
 *
 * Only a turn the person started from such a panel reaches their Chrome: the message route notes
 * its turn here (`noteTurn`), and nothing else does. A routine, a mail, another bot or a message
 * from the app or the phone never reaches Chrome. The notes live in memory only, so after a restart
 * no turn reaches Chrome until the person writes from the panel again.
 */
export class ChromeBridge {
  private offers = new Map<string, { userId: string; at: number }>();
  private turns = new Set<string>();
  private send: ChromeSend | null = null;
  private seq = 0;

  constructor(private answerMs = CHROME_ANSWER_MS) {}

  attach(send: ChromeSend) {
    this.send = send;
  }

  offer(socketId: string, userId: string, sharing: unknown) {
    if (sharing === true) this.offers.set(socketId, { userId, at: ++this.seq });
    else this.offers.delete(socketId);
  }

  drop(socketId: string) {
    this.offers.delete(socketId);
  }

  /** Whether a panel of this person's shares their Chrome now. */
  has(userId: string): boolean {
    for (const o of this.offers.values()) if (o.userId === userId) return true;
    return false;
  }

  /** A turn the person started from their panel while it shared Chrome. */
  noteTurn(turnId: string) {
    this.turns.add(turnId);
    if (this.turns.size > KEPT_TURNS) this.turns.delete(this.turns.values().next().value!);
  }

  fromChrome(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  /**
   * Asks this person's Chrome. Throws `ChromeUnreachable` when no panel of theirs shares it now or
   * none answers in time; an answer that is not one the panel gives counts as a failure.
   */
  async ask(userId: string, ask: ChromeAsk): Promise<ChromeAnswer> {
    const target = [...this.offers.entries()]
      .filter(([, o]) => o.userId === userId)
      .sort(([, a], [, b]) => b.at - a.at)[0];
    if (!target || !this.send) throw new ChromeUnreachable();
    let raw: unknown;
    try {
      raw = await this.send(target[0], ask, this.answerMs);
    } catch {
      throw new ChromeUnreachable();
    }
    const parsed = ChromeAnswer.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: 'failed' };
    // An answer of another kind than asked is not used.
    if (parsed.data.ok && parsed.data.kind !== ask.kind) return { ok: false, reason: 'failed' };
    return parsed.data;
  }
}
