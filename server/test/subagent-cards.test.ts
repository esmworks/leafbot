import { describe, expect, it } from 'vitest';
import type { SubagentState } from '../src/engine/types';
import { translator } from '../src/i18n';
import { SubagentCards } from '../src/runtime/subagent-cards';

type Props = { subagent: Record<string, unknown>; subagents: Record<string, unknown>[] };

/** Cards over a stand-in for the thread's messages; each write can be held back to land late. */
function setup() {
  const messages = new Map<string, Props>();
  const writes: { id: string | null; props: Props }[] = [];
  let hold: Promise<void> | null = null;
  let n = 0;
  const cards = new SubagentCards(translator('tr'), async (props, id) => {
    writes.push({ id, props: props as Props });
    if (hold) await hold;
    const key = id ?? `m${++n}`;
    messages.set(key, props as Props);
    return key;
  });
  return {
    cards,
    messages,
    writes,
    holdWrites() {
      let release!: () => void;
      hold = new Promise((r) => (release = r));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

const sub = (
  id: string,
  state: SubagentState['state'],
  extra: Partial<SubagentState> = {},
): SubagentState => ({
  id,
  description: `Görev ${id}`,
  state,
  steps: 0,
  ...extra,
});

describe('alt ajan grup kartı', () => {
  it('birlikte başlayanlar tek mesajda; eski uygulamalar için özet kart taşır', async () => {
    const s = setup();
    await s.cards.show(sub('a', 'waiting'));
    await s.cards.show(sub('b', 'waiting'));
    await s.cards.show(sub('a', 'running'));
    await s.cards.show(sub('a', 'done', { result: 'tamam', steps: 2 }));
    expect(s.messages.size).toBe(1);
    const props = s.messages.get('m1')!;
    expect(props.subagents.map((c) => [c.description, c.state])).toEqual([
      ['Görev a', 'done'],
      ['Görev b', 'waiting'],
    ]);
    // A waiting one has not started yet: its card tells no time.
    expect(props.subagents[1]!.startedAt).toBeUndefined();
    expect(props.subagents[0]!).toMatchObject({ result: 'tamam', steps: 2 });
    expect(props.subagent).toMatchObject({
      description: '2 alt görev: Görev a; Görev b',
      state: 'running',
      steps: 2,
    });
    expect(props.subagent.endedAt).toBeUndefined();

    await s.cards.show(sub('b', 'failed', { result: 'olmadı' }));
    const ended = s.messages.get('m1')!;
    expect(ended.subagent).toMatchObject({ state: 'failed' });
    expect(ended.subagent.endedAt).toBeTypeOf('string');
  });

  it('tek alt ajanın kartı kendisidir', async () => {
    const s = setup();
    await s.cards.show(sub('a', 'running', { tool: 'Grep', steps: 1 }));
    expect(s.messages.get('m1')!.subagent).toMatchObject({
      description: 'Görev a',
      state: 'running',
      tool: 'Grep',
    });
  });

  it('öncekiler bitince başlayan yeni bir kart açar', async () => {
    const s = setup();
    await s.cards.show(sub('a', 'running'));
    await s.cards.show(sub('a', 'done'));
    await s.cards.show(sub('b', 'running'));
    expect([...s.messages.keys()]).toEqual(['m1', 'm2']);
    expect(s.messages.get('m2')!.subagents).toHaveLength(1);
  });

  it('geç kalan yazma yeni durumu eskisiyle ezmez; araya girenler tek yazmada toplanır', async () => {
    const s = setup();
    await s.cards.show(sub('a', 'running'));
    const release = s.holdWrites();
    const first = s.cards.show(sub('a', 'running', { steps: 1 }));
    void s.cards.show(sub('a', 'running', { steps: 2 }));
    void s.cards.show(sub('a', 'done', { steps: 3, result: 'bitti' }));
    release();
    await first;
    const states = s.writes.map((w) => w.props.subagents[0]!.state);
    expect(states.at(-1)).toBe('done');
    // The first write, the held one, then one more carrying the newest state.
    expect(s.writes).toHaveLength(3);
    expect(s.messages.get('m1')!.subagents[0]).toMatchObject({ state: 'done', steps: 3 });
  });
});
