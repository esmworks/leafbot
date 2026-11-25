import { MAC_BEGIN_MS, MAC_REQUEST_MS } from '@leafbot/shared/mac';
import { failureOf, PersonComputer, type PersonComputerDriver } from './person';

/** Sends one request to one socket and waits for its answer; rejects when none comes in time. */
export type MacSend = (socketId: string, req: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;

interface Offer {
  userId: string;
  /** The Mac's name, as its desktop app gives it. */
  device: string;
  computer: PersonComputer;
  at: number;
  gone: boolean;
  /** Ends the requests still waiting on this Mac, when it goes away. */
  waiting: Set<() => void>;
  /** Whether the person lets bots run commands there, as its desktop app said on connecting. */
  commands: boolean;
  ask(req: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
}

/** A computer that runs commands: where they go, straight to its desktop app. */
export interface CommandComputer {
  device: string;
  ask(req: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>;
}

const OFFLINE = { ok: false, error: 'offline' } as const;

/** How much longer than the socket's own limit a request may take before it counts as lost. */
const GRACE_MS = 1_000;

/**
 * The people's Macs offered from afar: a desktop app connected to this server over its `/mac`
 * socket, with "Bots may use this Mac" on in its menu. Each person's bots use only that person's
 * Mac, the one that connected most recently; a turn keeps the Mac it started with, so a step never
 * lands on another machine whose screen the bot has not seen.
 */
export class MacBridge {
  private offers = new Map<string, Offer>();
  private send: MacSend | null = null;
  private seq = 0;

  constructor(
    private requestMs = MAC_REQUEST_MS,
    private beginMs = MAC_BEGIN_MS,
  ) {}

  attach(send: MacSend) {
    this.send = send;
  }

  offer(socketId: string, userId: string, device: string, commands = false) {
    const ask = async (req: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> => {
      if (offer.gone || !this.send) return OFFLINE;
      let raw: unknown;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let left: (() => void) | undefined;
      try {
        // The socket gives up by itself; this holds even if it never does, and a Mac that goes
        // away ends the wait at once rather than when the time is up.
        const lost = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs + GRACE_MS);
          left = () => reject(new Error('gone'));
          offer.waiting.add(left);
        });
        raw = await Promise.race([this.send(socketId, req, timeoutMs), lost]);
      } catch {
        // No answer in time, or the socket went away during the step.
        return OFFLINE;
      } finally {
        clearTimeout(timer);
        if (left) offer.waiting.delete(left);
      }
      if (offer.gone) return OFFLINE;
      return raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : { ok: false, error: 'failed' };
    };
    const driver: PersonComputerDriver = {
      send: (req) => ask(req, this.requestMs),
      begin: (bot) => ask({ op: 'begin', bot }, this.beginMs),
      close: () => undefined,
    };
    const computer = new PersonComputer(driver, async (size) => {
      const r = await ask({ op: 'screenshot', ...size }, this.requestMs);
      if (
        r.ok === true &&
        typeof r.data === 'string' &&
        (r.mimeType === 'image/jpeg' || r.mimeType === 'image/png')
      )
        return { data: r.data, mimeType: r.mimeType };
      throw failureOf(r);
    });
    const offer: Offer = {
      userId,
      device: device.slice(0, 100),
      computer,
      at: ++this.seq,
      gone: false,
      waiting: new Set(),
      commands,
      ask,
    };
    this.drop(socketId);
    this.offers.set(socketId, offer);
  }

  drop(socketId: string) {
    const offer = this.offers.get(socketId);
    if (offer) {
      offer.gone = true;
      for (const end of offer.waiting) end();
    }
    this.offers.delete(socketId);
  }

  private latest(userId: string): Offer | null {
    let best: Offer | null = null;
    for (const o of this.offers.values()) if (o.userId === userId && (!best || o.at > best.at)) best = o;
    return best;
  }

  /** This person's Mac connected now, the most recent one; null when none is. */
  for(userId: string): PersonComputer | null {
    return this.latest(userId)?.computer ?? null;
  }

  /**
   * This person's computer that runs commands, the most recent one; null when none does. Asked at
   * each step, not kept by a turn: a command needs no screen the bot has seen.
   */
  commandsFor(userId: string): CommandComputer | null {
    let best: Offer | null = null;
    for (const o of this.offers.values())
      if (o.userId === userId && o.commands && !o.gone && (!best || o.at > best.at)) best = o;
    return best ? { device: best.device, ask: best.ask } : null;
  }

  /** Sends one request to every computer of this person that runs commands, as Stop does. */
  async toAll(userId: string, req: Record<string, unknown>, timeoutMs = this.requestMs) {
    const asks = [...this.offers.values()].filter((o) => o.userId === userId && o.commands && !o.gone);
    return Promise.all(asks.map((o) => o.ask(req, timeoutMs)));
  }

  /** The name of the Mac `for` gives. */
  device(userId: string): string | null {
    return this.latest(userId)?.device ?? null;
  }
}
