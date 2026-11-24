import { parseCard, type Message } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { ChatCard } from './ChatCard';

vi.mock('@/lib/api', () => ({ api: { answerCard: vi.fn() } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const answerCard = vi.mocked(api.answerCard);

const tree = {
  type: 'Card',
  children: [
    { type: 'Title', value: 'Toplantı' },
    {
      type: 'Form',
      onSubmitAction: { type: 'book' },
      children: [
        { type: 'Label', value: 'Konu', fieldName: 'topic' },
        { type: 'Input', name: 'topic', required: true },
        { type: 'DatePicker', name: 'day', defaultValue: '2026-12-01' },
        { type: 'Checkbox', name: 'remind', label: 'Hatırlat' },
        { type: 'Button', label: 'Ayarla', submit: true },
      ],
    },
    {
      type: 'Button',
      label: 'Site',
      onClickAction: { type: 'open_url', payload: { url: 'https://example.com' } },
    },
  ],
  cancel: { label: 'Vazgeç' },
};

const message = (props: Record<string, unknown> = {}): Message => {
  const r = parseCard(tree);
  if (!r.ok) throw new Error('card refused');
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    author: 'bot:b1',
    text: '',
    props: { card: r.card, cardRev: 2, ...props },
    clientId: null,
    turnId: null,
    createdAt: new Date().toISOString(),
  };
};

const draw = (m: Message) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ChatCard m={m} />
    </QueryClientProvider>,
  );

describe('ChatCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    answerCard.mockResolvedValue(message() as never);
  });
  afterEach(cleanup);

  it('draws the card with its defaults and sends the form with the revision it was made on', async () => {
    draw(message());
    expect(screen.getByRole('heading', { name: 'Toplantı' })).toBeTruthy();
    const day = screen.getByDisplayValue('2026-12-01');
    expect(day.getAttribute('type')).toBe('date');
    fireEvent.change(screen.getByLabelText('Konu'), { target: { value: 'Bütçe' } });
    fireEvent.click(screen.getByLabelText('Hatırlat'));
    fireEvent.click(screen.getByRole('button', { name: 'Ayarla' }));
    await waitFor(() => expect(answerCard).toHaveBeenCalledTimes(1));
    const [id, sent] = answerCard.mock.calls[0]!;
    expect(id).toBe('m1');
    expect(sent).toMatchObject({ rev: 2, values: { topic: 'Bütçe', day: '2026-12-01', remind: true } });
  });

  it('does not send while a required field is empty, and drops the warning once it is filled', () => {
    draw(message());
    fireEvent.click(screen.getByRole('button', { name: 'Ayarla' }));
    expect(answerCard).not.toHaveBeenCalled();
    expect(screen.getByText(/Konu/, { selector: 'div' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Konu'), { target: { value: 'Bütçe' } });
    expect(screen.queryByText(/Konu/, { selector: 'div' })).toBeNull();
  });

  it('opens a link button in a new window instead of answering', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    draw(message());
    fireEvent.click(screen.getByRole('button', { name: 'Site' }));
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(answerCard).not.toHaveBeenCalled();
  });

  it('shows an answered card with what was sent and takes no more presses', () => {
    draw(
      message({
        cardAnswered: true,
        cardAnswer: { node: 'cancel', label: 'Vazgeç', values: {} },
      }),
    );
    const other = screen.getByRole('button', { name: 'Ayarla' });
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('Konu') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(answerCard).not.toHaveBeenCalled();
  });
});
