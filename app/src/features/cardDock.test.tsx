import type { Approval, Bot, Message } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AwayCard, CardDock, ExchangeCards, MessageItem } from './MessageItem';

const message = (id: string, role: Message['role'], props: Message['props'] = {}): Message => ({
  id,
  threadId: role === 'marker' ? 't1' : 't2',
  role,
  author: 'bot:b2',
  text: id === 'q1' ? 'Depo bir komut çalıştırmak istiyor' : id,
  props,
  clientId: null,
  turnId: null,
  createdAt: '2026-11-18T00:00:00.000Z',
});

const approval = (status: Approval['status'], over: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  threadId: 't2',
  botId: 'b2',
  kind: 'tool',
  toolName: 'Bash',
  summary: 'Depo bir komut çalıştırmak istiyor',
  input: { command: 'ls' },
  options: [],
  status,
  answer: null,
  remembered: false,
  createdAt: '2026-11-18T00:00:00.000Z',
  decidedAt: null,
  answerIn: { threadId: 't1', botId: 'b1', props: { approvalId: 'a1' } },
  ...over,
});

/**
 * A conversation (t1) with an exchange between bots in it, and the end of that conversation where
 * the cards of the work begun there wait.
 */
function show(cards: Approval[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['approvals'], cards);
  qc.setQueryData(['job', 'j1'], {
    job: { id: 'j1', toThreadId: 't2' },
    messages: [message('w1', 'user'), message('q1', 'approval', { approvalId: 'a1' })],
  });
  const marker = message('k1', 'marker', { jobId: 'j1', peerBotId: 'b2', count: 1 });
  const bots = new Map<string, Bot>();
  const view = render(
    <QueryClientProvider client={qc}>
      <CardDock.Provider value>
        <div data-testid="exchange">
          <MessageItem m={marker} bots={bots} />
        </div>
        <div data-testid="end">
          <ExchangeCards threadId="t1" bots={bots} />
        </div>
      </CardDock.Provider>
    </QueryClientProvider>,
  );
  return {
    exchange: view.getByTestId('exchange'),
    end: view.getByTestId('end'),
  };
}

describe('botlar arası konuşmadaki kart', () => {
  afterEach(cleanup);

  it('cevap bekleyen kart sohbetin sonunda çıkar, konuşmanın içinde değil', () => {
    const { exchange, end } = show([approval('pending')]);
    expect(end.textContent).toContain('Allow this time');
    expect(exchange.textContent).not.toContain('Allow this time');
  });

  it('zincirin daha aşağısında sorulan kart da işin başladığı sohbetin sonunda çıkar', () => {
    // Asked in an exchange this conversation's marker never shows (t3, two bots further down).
    const { end } = show([approval('pending', { id: 'a2', threadId: 't3', botId: 'b3' })]);
    expect(end.textContent).toContain('Allow this time');
  });

  it('başka bir sohbette başlayan işin kartı burada çıkmaz', () => {
    const { end } = show([
      approval('pending', { answerIn: { threadId: 't9', botId: 'b1', props: { approvalId: 'a1' } } }),
    ]);
    expect(end.textContent).toBe('');
  });

  it('cevaplanan kart sohbetin sonunda kalmaz', () => {
    const { end } = show([approval('allowed')]);
    expect(end.textContent).toBe('');
  });
});

describe('başka sohbetteki kart ana sohbette', () => {
  afterEach(cleanup);

  /** A card waiting in a ticket's conversation, shown away from it. */
  function away(card: Approval) {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(['approvals'], [card]);
    return render(
      <QueryClientProvider client={qc}>
        <AwayCard approval={card} bots={new Map()} />
      </QueryClientProvider>,
    ).container;
  }

  it('cevaplanabilir çıkar', () => {
    const view = away(approval('pending', { answerIn: null, line: { approvalId: 'a1' } }));
    expect(view.textContent).toContain('Allow this time');
    expect(view.textContent).toContain('Always allow');
  });

  it('kendi satırı "hep izin ver" sunmuyorsa burada da sunmaz', () => {
    const view = away(approval('pending', { answerIn: null, line: { approvalId: 'a1', noAlways: true } }));
    expect(view.textContent).toContain('Allow this time');
    expect(view.textContent).not.toContain('Always allow');
  });
});
