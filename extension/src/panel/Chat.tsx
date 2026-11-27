import type { Approval, Bot, Message, Thread, TurnState } from '@leafbot/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { errorText, type Api } from '../api';
import { t } from '../i18n';
import type { LiveEvent } from './Home';
import { Markdown } from './Markdown';

/** The lines a person reads here; the rest (markers, notes for the bot) stay in the app. */
const SHOWN = new Set<Message['role']>(['user', 'assistant', 'approval', 'error']);

interface Props {
  api: Api;
  origin: string;
  bot: Bot;
  sharing: boolean;
  subscribe: (fn: (e: LiveEvent) => void) => () => void;
}

/** The bot's main conversation with the person, as in the app, in a narrow column. */
export function Chat({ api, origin, bot, sharing, subscribe }: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Approval[]>([]);
  const [stream, setStream] = useState<{ turnId: string; text: string } | null>(null);
  const [state, setState] = useState<TurnState>('idle');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const reload = useCallback(
    async (id: string) => {
      const [list, pending] = await Promise.all([api.messages(id), api.pendingApprovals()]);
      setMessages(list);
      setCards(pending.filter((a) => a.threadId === id));
      // A reply that is saved now no longer streams.
      setStream((s) => (s && list.some((m) => m.turnId === s.turnId && m.role === 'assistant') ? null : s));
    },
    [api],
  );

  // Another bot gets a fresh Chat (keyed by the bot), so nothing of this one carries over.
  useEffect(() => {
    let gone = false;
    void api.mainThread(bot.id).then((th) => {
      if (gone) return;
      setThread(th);
      setState(th.state);
      void reload(th.id);
    });
    return () => {
      gone = true;
    };
  }, [api, bot.id, reload]);

  useEffect(() => {
    if (!thread) return;
    return subscribe((ev) => {
      if (ev.kind === 'delta' && ev.e.threadId === thread.id) {
        const { turnId, text, restart } = ev.e;
        setStream((s) => ({ turnId, text: s && s.turnId === turnId && !restart ? s.text + text : text }));
      } else if (ev.kind === 'turn' && ev.e.threadId === thread.id) {
        setState(ev.e.state);
        if (ev.e.state === 'idle') void reload(thread.id);
      } else if (
        ev.kind === 'refresh' &&
        ((ev.e.scope === 'thread' && ev.e.threadId === thread.id) || ev.e.scope === 'approvals')
      ) {
        void reload(thread.id);
      }
    });
  }, [subscribe, thread, reload]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [messages, stream, cards]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || !thread) return;
    setDraft('');
    setError(null);
    void api
      .send(thread.id, crypto.randomUUID(), text, [], undefined, undefined, undefined, sharing)
      .then(() => reload(thread.id))
      .catch((err: unknown) => {
        setDraft(text);
        setError(t('chat.sendFailed', { message: errorText(err) }));
      });
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  const answer = (card: Approval, decision: 'allow' | 'deny') => {
    void api
      .answer(card.id, { decision })
      .then(() => thread && reload(thread.id))
      .catch((err: unknown) => setError(errorText(err)));
  };

  const busy = state === 'running' || state === 'queued' || state === 'waiting';
  const shown = messages.filter((m) => SHOWN.has(m.role) && m.text.trim());

  return (
    <div className="chat">
      <div className="messages">
        {thread && !shown.length && !stream && <p className="empty">{t('chat.empty')}</p>}
        {shown.map((m) => {
          const card = m.role === 'approval' ? cards.find((c) => c.id === m.props.approvalId) : undefined;
          return (
            <div key={m.id} className={`message ${m.role}`}>
              {m.role === 'assistant' ? <Markdown text={m.text} /> : <div className="text">{m.text}</div>}
              {card &&
                (card.kind === 'tool' ? (
                  <div className="actions">
                    <button type="button" className="primary" onClick={() => answer(card, 'allow')}>
                      {t('card.allow')}
                    </button>
                    <button type="button" onClick={() => answer(card, 'deny')}>
                      {t('card.deny')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void chrome.tabs.create({ url: `${origin}/` })}
                  >
                    {t('card.inApp')}
                  </button>
                ))}
            </div>
          );
        })}
        {stream && stream.text && (
          <div className="message assistant streaming">
            <Markdown text={stream.text} />
          </div>
        )}
        {busy && !stream && <p className="working">{t('chat.working')}</p>}
        <div ref={bottom} />
      </div>
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={send}>
        <textarea
          value={draft}
          rows={2}
          placeholder={t('chat.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="actions">
          <button
            type="button"
            className="link quiet"
            onClick={() => void chrome.tabs.create({ url: `${origin}/` })}
          >
            {t('chat.openApp')}
          </button>
          {busy ? (
            <button type="button" onClick={() => thread && void api.stop(thread.id)}>
              {t('chat.stop')}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={!draft.trim() || !thread}>
              {t('chat.send')}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
