import {
  plainText,
  type Bot,
  type BotSummary,
  type DeltaEvent,
  type RefreshScope,
  type TurnEvent,
} from '@leafbot/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFor } from '../api';
import { t, uiLocale } from '../i18n';
import { sitePattern } from '../share';
import { Avatar } from './Avatar';
import { Chat } from './Chat';
import { Live } from './live';
import { saveSharing } from './stored';

/** How long a bot's wish to read a new site waits for the person, within the server's own wait. */
const SITE_WAIT_MS = 80_000;

interface SiteAsk {
  id: number;
  origin: string;
  bot: string | null;
  answer: (allowed: boolean) => void;
}

/** Today's clock time, or the day for an older one, as the app's list shows it. */
function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(
    uiLocale,
    today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' },
  ).format(d);
}

/** What the live connection brings, handed to the conversation on screen. */
export type LiveEvent =
  { kind: 'delta'; e: DeltaEvent } | { kind: 'turn'; e: TurnEvent } | { kind: 'refresh'; e: RefreshScope };

export function Home(props: { origin: string; sharing: boolean; onDisconnect: () => void }) {
  const { origin } = props;
  const api = useMemo(() => apiFor(origin), [origin]);
  const [sharing, setSharing] = useState(props.sharing);
  const [connected, setConnected] = useState(true);
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [summaries, setSummaries] = useState<BotSummary[]>([]);
  const [bot, setBot] = useState<Bot | null>(null);
  const [sites, setSites] = useState<SiteAsk[]>([]);
  const listeners = useRef(new Set<(e: LiveEvent) => void>());
  const live = useRef<Live | null>(null);
  const seq = useRef(0);

  // A bot wants to read a site the extension may not read yet: a card here, answered by a click,
  // since Chrome shows its own prompt only then. No answer in time counts as no.
  const askToRead = useCallback(
    (site: string, who: string | null) =>
      new Promise<boolean>((resolve) => {
        const id = ++seq.current;
        const done = (allowed: boolean) => {
          clearTimeout(timer);
          setSites((list) => list.filter((x) => x.id !== id));
          resolve(allowed);
        };
        const timer = setTimeout(() => done(false), SITE_WAIT_MS);
        setSites((list) => [...list, { id, origin: site, bot: who, answer: done }]);
      }),
    [],
  );

  const sharingNow = useRef(sharing);
  useEffect(() => {
    const emit = (e: LiveEvent) => listeners.current.forEach((fn) => fn(e));
    const l = new Live(origin, sharingNow.current, askToRead, {
      onConnected: setConnected,
      onDelta: (e) => emit({ kind: 'delta', e }),
      onTurn: (e) => {
        if (e.state === 'idle') void api.summaries().then(setSummaries, () => undefined);
        emit({ kind: 'turn', e });
      },
      onRefresh: (e) => {
        if (e.scope === 'bots') void api.bots().then(setBots);
        if (e.scope === 'bots' || e.scope === 'threads' || e.scope === 'thread') {
          void api.summaries().then(setSummaries, () => undefined);
        }
        emit({ kind: 'refresh', e });
      },
    });
    live.current = l;
    return () => {
      l.close();
      live.current = null;
    };
  }, [origin, api, askToRead]);

  useEffect(() => {
    void api.bots().then(setBots);
    // The list still shows without the last messages.
    void api.summaries().then(setSummaries, () => undefined);
  }, [api]);

  const toggleSharing = (on: boolean) => {
    setSharing(on);
    sharingNow.current = on;
    void saveSharing(on);
    live.current?.setSharing(on);
    // Turning sharing off ends every wish to read a site that still waits.
    if (!on) sites.forEach((s) => s.answer(false));
  };

  const subscribe = useCallback((fn: (e: LiveEvent) => void) => {
    listeners.current.add(fn);
    return () => void listeners.current.delete(fn);
  }, []);

  const summaryOf = useMemo(() => new Map(summaries.map((x) => [x.botId, x])), [summaries]);

  const sorted = useMemo(
    () => [...(bots ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.position - b.position),
    [bots],
  );

  return (
    <div className="home">
      <header>
        {bot ? (
          <button type="button" className="link" onClick={() => setBot(null)}>
            ‹ {t('bots.back')}
          </button>
        ) : (
          <strong>{t('bots.title')}</strong>
        )}
        <div className="tools">
          {/* In the header, so the chat keeps the panel's height; what it means shows on hover. */}
          <label className="share" title={`${t('share.label')}\n\n${t('share.hint')}`}>
            <input type="checkbox" checked={sharing} onChange={(e) => toggleSharing(e.target.checked)} />
            <span>{t('share.short')}</span>
          </label>
          <button type="button" className="link quiet" onClick={props.onDisconnect}>
            {t('connect.disconnect')}
          </button>
        </div>
      </header>
      {!connected && <p className="notice">{t('share.offline')}</p>}
      {sites.map((s) => (
        <div key={s.id} className="card">
          <p>
            <strong>
              {t('site.title', { bot: s.bot ?? t('site.someBot'), site: new URL(s.origin).host })}
            </strong>
          </p>
          <small>{t('site.hint')}</small>
          <div className="actions">
            <button
              type="button"
              className="primary"
              // Chrome asks on this very click; the answer is what it says.
              onClick={() =>
                void chrome.permissions
                  .request({ origins: [sitePattern(s.origin)] })
                  .then(s.answer, () => s.answer(false))
              }
            >
              {t('site.allow')}
            </button>
            <button type="button" onClick={() => s.answer(false)}>
              {t('site.deny')}
            </button>
          </div>
        </div>
      ))}
      {bot ? (
        <Chat key={bot.id} api={api} origin={origin} bot={bot} sharing={sharing} subscribe={subscribe} />
      ) : (
        <ul className="bots">
          {bots && !sorted.length && <li className="empty">{t('bots.empty')}</li>}
          {sorted.map((b) => {
            const s = summaryOf.get(b.id);
            const preview = s?.preview ? plainText(s.preview) : b.description;
            return (
              <li key={b.id}>
                <button type="button" onClick={() => setBot(b)}>
                  <Avatar avatar={b.avatar} color={b.color} material={b.material} />
                  <span className="about">
                    <span className="top">
                      <strong>{b.name}</strong>
                      <time>{when(s?.previewAt ?? s?.repliedAt ?? null)}</time>
                    </span>
                    {preview && <small>{preview}</small>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
