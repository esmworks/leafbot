/**
 * The reply a bot is writing now, as the socket brings it, before the turn saves it. Pieces carry
 * where they start in the turn's text (`at`), so a piece seen twice is not added twice and a piece
 * after a gap (a reconnect, a page opened mid-reply) is noticed instead of being glued on.
 */
export interface LiveStream {
  turnId: string;
  /** The text so far, up to the first gap. */
  text: string;
  /** Pieces that came after a gap, kept until the text before them is fetched (see `seedStream`). */
  waiting?: LivePiece[];
}

export interface LivePiece {
  text: string;
  /** Where the piece starts in the turn's text; missing from older servers. */
  at?: number;
  /** The turn's run started over: the piece replaces what came before. */
  restart?: boolean;
}

/** Adds one piece of a turn's reply to what is shown of the conversation's stream. */
export function addPiece(cur: LiveStream | undefined, turnId: string, piece: LivePiece): LiveStream {
  const at = piece.restart ? 0 : piece.at;
  // Another turn's text, or a run that started over: this turn's text begins here.
  if (!cur || cur.turnId !== turnId || piece.restart) {
    if (at === undefined || at === 0) return { turnId, text: piece.text };
    return { turnId, text: '', waiting: [piece] };
  }
  if (cur.waiting) return { ...cur, waiting: [...cur.waiting, piece] };
  // An older server says nothing of where a piece goes: it is the next one.
  if (at === undefined || at === cur.text.length) return { turnId, text: cur.text + piece.text };
  // Partly or wholly seen already: only the new end is added.
  if (at < cur.text.length) {
    const end = at + piece.text.length;
    return end > cur.text.length ? { turnId, text: cur.text + piece.text.slice(cur.text.length - at) } : cur;
  }
  return { ...cur, waiting: [piece] };
}

/** Whether pieces wait for text that has not arrived; the client then fetches the turn's text. */
export function hasGap(s: LiveStream | undefined): boolean {
  return !!s?.waiting?.length;
}

/**
 * Starts the stream from the text the server has shown of the running turn so far, then adds the
 * pieces that came meanwhile. Text already longer than the fetched one stays as it is.
 */
export function seedStream(cur: LiveStream | undefined, live: { turnId: string; text: string }): LiveStream {
  if (cur && cur.turnId === live.turnId && !cur.waiting && cur.text.length >= live.text.length) return cur;
  let next: LiveStream = { turnId: live.turnId, text: live.text };
  if (cur?.turnId === live.turnId) for (const p of cur.waiting ?? []) next = addPiece(next, live.turnId, p);
  return next;
}

/**
 * Whether a turn event says the streamed turn has ended: another turn runs now, or none does. The
 * conversation need not come to rest in between (a message sent while the bot was busy, or right
 * after a stop), so its state alone cannot tell. An older server names no turn: then only rest does.
 */
export function streamEnded(streamTurnId: string, e: { state: string; turnId?: string | null }): boolean {
  if (e.turnId !== undefined) return e.turnId !== streamTurnId;
  return e.state === 'idle';
}
