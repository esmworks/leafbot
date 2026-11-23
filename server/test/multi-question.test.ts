import type { Approval } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { cardView } from '../src/channels/common';
import { translator } from '../src/i18n';

const question = (q: Record<string, unknown>) =>
  ({
    id: 'q1',
    kind: 'question',
    toolName: 'ask_user',
    input: { questions: [{ question: 'Which apps?', options: ['Mail', 'Calendar', 'Files'], ...q }] },
    summary: 'Which apps?',
    options: [],
  }) as unknown as Approval;

describe('a question that takes several picks in a chat app', () => {
  it('numbers the options and asks for numbers instead of showing buttons', () => {
    const view = cardView(question({ multi: true }), {}, translator('en'));
    expect(view.buttons).toEqual([]);
    expect(view.text).toContain('1. Mail');
    expect(view.text).toContain('3. Files');
    expect(view.text).toContain(translator('en')('channel.pickSeveral'));
  });

  it('keeps buttons for a single-choice question', () => {
    const view = cardView(question({}), {}, translator('en'));
    expect(view.buttons.map((b) => b.label)).toEqual(['Mail', 'Calendar', 'Files']);
  });
});
