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
 * (`chrome:offer`), and each of its messages names that socket.
 *
 * Only a turn the person started from such a panel reaches their Chrome, and only the Chrome of that
 * very panel: the person may have the panel open in several Chromes, and the page they mean is in the
 * one they wrote from. The turn is noted with its panel before it can start (`noteTurn`), and nothing
 * else notes one. A routine, a mail, another bot or a message from the app or the phone never reaches
 * Chrome. The notes live in memory only, so after a restart no turn reaches Chrome until the person
 * writes from the panel again.
 */
export class ChromeBridge {
  private offers = new Map<string, string>();
  private turns = new Map<string, string>();
  private send: ChromeSend | null = null;

  constructor(private answerMs = CHROME_ANSWER_MS) {}

  attach(send: ChromeSend) {
    this.send = send;
  }

  offer(socketId: string, userId: string, sharing: unknown) {
    if (sharing === true) this.offers.set(socketId, userId);
    else this.offers.delete(socketId);
  }

  drop(socketId: string) {
    this.offers.delete(socketId);
  }

  /** Whether this socket is a panel of this person that shares their Chrome now. */
  shares(socketId: string, userId: string): boolean {
    return this.offers.get(socketId) === userId;
  }

  /** A turn the person started from this panel while it shared Chrome. */
  noteTurn(turnId: string, socketId: string) {
    this.turns.delete(turnId);
    this.turns.set(turnId, socketId);
    if (this.turns.size > KEPT_TURNS) this.turns.delete(this.turns.keys().next().value!);
  }

  /**
   * Waiting turns joined into one (the person wrote again before the bot started): a panel noted
   * for one of them goes with the turn they became, so the words from the panel keep its Chrome.
   */
  carry(fromTurnIds: readonly string[], toTurnId: string) {
    if (this.turns.has(toTurnId)) return;
    const socketId = fromTurnIds.map((id) => this.turns.get(id)).find(Boolean);
    if (socketId) this.noteTurn(toTurnId, socketId);
  }

  /** The panel this person's turn was started from, while it still shares their Chrome. */
  panelOf(turnId: string, userId: string): string | null {
    const socketId = this.turns.get(turnId);
    return socketId && this.shares(socketId, userId) ? socketId : null;
  }

  /**
   * Asks the Chrome of the panel this turn was started from. Throws `ChromeUnreachable` when that
   * panel no longer shares it or does not answer in time; an answer that is not one the panel gives
   * counts as a failure. No other panel of the person is asked in its place.
   */
  async ask(turnId: string, userId: string, ask: ChromeAsk): Promise<ChromeAnswer> {
    const socketId = this.panelOf(turnId, userId);
    if (!socketId || !this.send) throw new ChromeUnreachable();
    let raw: unknown;
    try {
      raw = await this.send(socketId, ask, this.answerMs);
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
