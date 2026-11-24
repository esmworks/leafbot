import type { SubagentState } from '../engine/types';
import type { T } from '../i18n';

/** One subagent as its group's card lists it. */
type Card = {
  description: string;
  state: SubagentState['state'];
  steps: number;
  tool?: string;
  result?: string;
  startedAt?: string;
  endedAt?: string;
};

interface Group {
  cards: Map<string, Card>;
  /** The card's message, once asked for. */
  message: Promise<string> | null;
  writing: boolean;
  /** Something changed while a write was on its way: write again once it lands. */
  again: boolean;
}

const busy = (c: Card) => c.state === 'waiting' || c.state === 'running';

/**
 * A turn's subagents in the chat. Those started together share one card: a new group begins when one
 * starts while none of the last group is still at work. Each group is one message, rewritten as its
 * subagents move on; writes go one at a time and always carry the newest state, so a slow write never
 * puts an older one back.
 */
export class SubagentCards {
  private groups = new Map<string, Group>();
  private last: Group | null = null;
  /** When each one started working; one still waiting has not. */
  private started = new Map<string, string>();

  constructor(
    private t: T,
    /** Writes a group's message: adds it when `id` is null, else rewrites it; gives back its id. */
    private write: (props: Record<string, unknown>, id: string | null) => Promise<string>,
    private now: () => Date = () => new Date(),
  ) {}

  show(sub: SubagentState): Promise<void> {
    let group = this.groups.get(sub.id);
    if (!group) {
      group =
        this.last && [...this.last.cards.values()].some(busy)
          ? this.last
          : { cards: new Map(), message: null, writing: false, again: false };
      this.groups.set(sub.id, group);
      this.last = group;
    }
    if (sub.state !== 'waiting' && !this.started.has(sub.id))
      this.started.set(sub.id, this.now().toISOString());
    const startedAt = this.started.get(sub.id);
    group.cards.set(sub.id, {
      description: sub.description,
      state: sub.state,
      steps: sub.steps,
      ...(sub.tool && { tool: sub.tool }),
      ...(sub.result && { result: sub.result }),
      ...(startedAt && { startedAt }),
      ...(sub.state !== 'running' && sub.state !== 'waiting' && { endedAt: this.now().toISOString() }),
    });
    return this.flush(group);
  }

  private async flush(group: Group): Promise<void> {
    if (group.writing) {
      group.again = true;
      return;
    }
    group.writing = true;
    try {
      do {
        group.again = false;
        const props = this.props(group);
        if (!group.message) {
          group.message = this.write(props, null);
          await group.message;
        } else {
          await this.write(props, await group.message);
        }
      } while (group.again);
    } catch (err) {
      console.warn('subagent', err);
    } finally {
      group.writing = false;
    }
  }

  /**
   * The group's message: every card in `subagents`, and in `subagent` the one subagent itself, or a
   * card that sums up several for apps that show only that one.
   */
  private props(group: Group): Record<string, unknown> {
    const list = [...group.cards.values()];
    return { subagent: list.length === 1 ? list[0] : this.summary(list), subagents: list };
  }

  private summary(list: Card[]): Card {
    const working = list.some(busy);
    const state: Card['state'] = working
      ? 'running'
      : list.some((c) => c.state === 'failed')
        ? 'failed'
        : list.some((c) => c.state === 'stopped')
          ? 'stopped'
          : 'done';
    const starts = list.flatMap((c) => (c.startedAt ? [c.startedAt] : [])).sort();
    const ends = list.flatMap((c) => (c.endedAt ? [c.endedAt] : [])).sort();
    const tool = list.findLast((c) => c.state === 'running' && c.tool)?.tool;
    return {
      description: this.t('turn.subagentGroup', {
        count: list.length,
        names: list.map((c) => c.description).join('; '),
      }).slice(0, 500),
      state,
      steps: list.reduce((n, c) => n + c.steps, 0),
      ...(tool && { tool }),
      ...(starts[0] && { startedAt: starts[0] }),
      ...(!working && ends.length && { endedAt: ends.at(-1) }),
    };
  }
}
