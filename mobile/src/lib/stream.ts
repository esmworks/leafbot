import { addPiece, hasGap, type LiveStream, type Message } from '@leafbot/shared';

/** The reply a bot is writing now, as it arrives over the socket, before it is saved. */
export type Stream = LiveStream;

export type Streams = Readonly<Record<string, Stream>>;

/**
 * Adds a piece of a reply; a piece of a new turn starts that conversation's text over, and so does
 * a run that started over (a retry, a fresh session). `at` is where the piece starts in the turn's
 * text: a piece after missing words waits for them (see `seedStream` in the shared package).
 */
export function appendStream(
  streams: Streams,
  threadId: string,
  turnId: string,
  text: string,
  restart = false,
  at?: number,
): Streams {
  return { ...streams, [threadId]: addPiece(streams[threadId], turnId, { text, at, restart }) };
}

/** One piece of a reply as the socket sent it. */
export interface StreamPiece {
  threadId: string;
  turnId: string;
  text: string;
  restart?: boolean;
  at?: number;
}

/**
 * Adds the pieces of one frame in the order they came, each as `appendStream` would, and names
 * the conversations left missing words, so what the bot wrote so far is fetched for them.
 */
export function appendPieces(
  streams: Streams,
  pieces: readonly StreamPiece[],
): { streams: Streams; gaps: string[] } {
  let next = streams;
  for (const p of pieces) next = appendStream(next, p.threadId, p.turnId, p.text, p.restart, p.at);
  const gaps = [...new Set(pieces.map((p) => p.threadId))].filter((id) => hasGap(next[id]));
  return { streams: next, gaps };
}

/** Drops a conversation's text, only when it is still that turn's if one is named. */
export function dropStream(streams: Streams, threadId: string, turnId?: string): Streams {
  const cur = streams[threadId];
  if (!cur || (turnId && cur.turnId !== turnId)) return streams;
  const rest = { ...streams };
  delete rest[threadId];
  return rest;
}

/** Whether the saved reply of the streamed turn is already in the list, so the stream is not shown twice. */
export function streamSaved(stream: Stream | undefined, messages: readonly Message[]): boolean {
  return !!stream && messages.some((m) => m.turnId === stream.turnId && m.role === 'assistant');
}

/**
 * The messages to show: the saved ones, then those sent from this phone that the server has not
 * listed yet. One already listed under the same client id is not shown again.
 */
export function withPending(messages: readonly Message[], pending: readonly Message[]): Message[] {
  const listed = new Set(messages.map((m) => m.clientId).filter(Boolean));
  return [...messages, ...pending.filter((p) => !listed.has(p.clientId))];
}

/** An id for a message sent from this phone, so a resend is not saved twice. */
export function newClientId(): string {
  const rand = () => Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${Date.now().toString(36)}-${rand()}${rand()}`;
}

/**
 * Where the cards that just showed up were asked in their turn's streaming reply, by message id.
 * The bot waits for the answer, so the text that has arrived when a card does is the text before
 * it. A card asked before the reply wrote a word (still pending, no text of its turn yet) goes at
 * the start, so what the bot writes after the answer goes below it. A card's first note stays.
 */
export function newCardCuts(
  messages: readonly Message[],
  stream: Stream | undefined,
  pendingApprovals: ReadonlySet<string>,
  known: Readonly<Record<string, number>>,
): Record<string, number> {
  const fresh: Record<string, number> = {};
  for (const m of messages) {
    if (m.role !== 'approval' || !m.turnId || m.id in known) continue;
    if (stream?.turnId === m.turnId) fresh[m.id] = stream.text.length;
    else if (pendingApprovals.has(String(m.props.approvalId ?? ''))) fresh[m.id] = 0;
  }
  return fresh;
}

/**
 * Takes the cards of the turn still streaming in out of the list, to be drawn inside its reply
 * where they were asked. The card is saved the moment it is asked, the reply only when the turn
 * ends, so in the list the card would sit above everything written before it. `end` is the point
 * of the last card: the text after it is the part still being written.
 */
export function placeCards(
  messages: readonly Message[],
  liveTurnId: string | null,
  cuts: Readonly<Record<string, number>>,
): { messages: readonly Message[]; cards: { card: Message; at: number }[]; end: number } {
  if (!liveTurnId) return { messages, cards: [], end: 0 };
  const cards: { card: Message; at: number }[] = [];
  for (const m of messages)
    if (m.role === 'approval' && m.turnId === liveTurnId && m.id in cuts)
      cards.push({ card: m, at: cuts[m.id]! });
  if (!cards.length) return { messages, cards, end: 0 };
  const placed = new Set(cards.map((c) => c.card.id));
  return {
    messages: messages.filter((m) => !placed.has(m.id)),
    cards,
    end: Math.max(...cards.map((c) => c.at)),
  };
}
