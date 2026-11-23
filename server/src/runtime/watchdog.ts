/** The longest a single shell command may run when the bot asks for it: ten minutes. */
export const BASH_MAX_TIMEOUT_MS = 600_000;

/** How long a turn may go without a sign of life before it is stopped as stalled. */
export interface StallLimits {
  /** While the model itself should be answering. */
  silenceMs: number;
  /** While a tool call runs: a long shell command or a slow connected app stays quiet meanwhile. */
  toolSilenceMs: number;
}

/** Why a turn was stopped: nothing came at all, or one tool call never ended. */
export type Stall = { cause: 'silent'; ms: number } | { cause: 'tool'; ms: number; tool: string };

/**
 * Watches a running turn and stops it once it has been silent for too long, so a hung model call
 * or a tool that never returns does not keep the conversation busy forever.
 *
 * Time spent waiting on the person (an open card) is not silence, and neither is time the computer
 * slept: a timer that fires far later than it should means the process was not running.
 */
export class TurnWatchdog {
  private last: number;
  private lastTick: number;
  private readonly tools = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tickMs: number;
  private folding = false;
  stalled: Stall | null = null;

  constructor(
    private readonly o: {
      limits: StallLimits;
      /** True while the turn waits on the person, such as an approval card or a question. */
      waiting: () => boolean;
      onStall: (stall: Stall) => void;
      now?: () => number;
      tickMs?: number;
    },
  ) {
    const now = this.now();
    this.last = now;
    this.lastTick = now;
    this.tickMs = o.tickMs ?? Math.min(30_000, Math.max(10, Math.floor(o.limits.silenceMs / 4)));
    this.timer = setInterval(() => this.check(), this.tickMs);
    this.timer.unref?.();
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  /** The engine did something; with `tool`, a tool call started (`running`) or ended. */
  activity(tool?: { id: string; name: string; running: boolean }) {
    this.last = this.now();
    if (!tool) return;
    if (tool.running) this.tools.set(tool.id, tool.name);
    else this.tools.delete(tool.id);
  }

  /**
   * The engine is folding the conversation into a summary: one model call over a long history that
   * says nothing until it ends, so it gets the time a tool call does.
   */
  compacting(on: boolean) {
    this.last = this.now();
    this.folding = on;
  }

  /** Looks once; the timer calls it, and tests may too. */
  check() {
    if (this.stalled) return;
    const now = this.now();
    const gap = now - this.lastTick;
    this.lastTick = now;
    // Far past the tick: the computer slept, and that time is nobody's silence.
    if (gap > this.tickMs * 3) this.last += gap - this.tickMs;
    if (this.o.waiting()) {
      this.last = now;
      return;
    }
    const silent = now - this.last;
    const tool = [...this.tools.values()].at(-1);
    const limit = tool || this.folding ? this.o.limits.toolSilenceMs : this.o.limits.silenceMs;
    if (silent < limit) return;
    this.stalled = tool ? { cause: 'tool', ms: silent, tool } : { cause: 'silent', ms: silent };
    this.stop();
    this.o.onStall(this.stalled);
  }

  stop() {
    clearInterval(this.timer);
  }
}

/**
 * The limits for a turn. A running tool gets at least as long as the longest call the app allows
 * itself (a shell command, a connected app's call) and a few minutes more, so the tool's own limit
 * ends it first and the bot hears why.
 */
export function stallLimits(o: {
  silenceMs: number;
  mcpCallTimeoutMs: number;
  shellMaxMs: number;
}): StallLimits {
  const margin = 5 * 60_000;
  return {
    silenceMs: o.silenceMs,
    toolSilenceMs: Math.max(o.silenceMs, o.mcpCallTimeoutMs + margin, o.shellMaxMs + margin),
  };
}
