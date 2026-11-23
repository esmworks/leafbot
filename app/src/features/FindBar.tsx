import type { SearchHit } from '@leafbot/shared';
import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { findRanges } from '@/lib/findText';
import { useUi } from '@/lib/store';

/** The most matches one search brings back; enough for a long conversation. */
const FIND_LIMIT = 300;
const HIGHLIGHT = 'chat-find';

/**
 * ⌘F / Ctrl+F over a conversation: finds the words in all of its messages, also those not loaded
 * yet, steps through them from the newest, and marks the words in the messages on screen.
 */
export function FindBar({
  threadId,
  scroller,
}: {
  threadId: string;
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const close = () => useUi.getState().setFindOpen(false);
  const input = useRef<HTMLInputElement>(null);
  // Opened from the search, it starts on those words and on the message that was picked.
  const [seed] = useState(() => useUi.getState().findSeed);
  const [query, setQuery] = useState(seed?.query ?? '');
  // Oldest first, so "next" goes down the conversation as it does on the page.
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [index, setIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const q = query.trim();
  // Results of an earlier query stay in state until the next search; a too-short query shows none.
  const active = q.length >= 2;
  const shownHits = active ? hits : [];

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .search(q, { threadId, limit: FIND_LIMIT })
        .then((found) => {
          if (!live) return;
          const ordered = [...found].reverse();
          setHits(ordered);
          const picked =
            seed && seed.query === q ? ordered.findIndex((h) => h.messageId === seed.messageId) : -1;
          const at = picked >= 0 ? picked : ordered.length - 1;
          setIndex(at);
          const hit = ordered[at];
          if (hit) useUi.getState().focusMessage({ id: hit.messageId, threadId });
        })
        .catch(() => live && setHits([]))
        .finally(() => live && setLoading(false));
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q, threadId, seed]);

  const step = (by: number) => {
    if (!shownHits.length) return;
    const next = (index + by + shownHits.length) % shownHits.length;
    setIndex(next);
    useUi.getState().focusMessage({ id: shownHits[next]!.messageId, threadId });
  };

  // The words are marked in every message on screen, and again as messages come and go.
  useEffect(() => {
    const box = scroller.current;
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined;
    if (!box || !registry || typeof Highlight === 'undefined') return;
    const paint = () => {
      if (q.length < 2) return registry.delete(HIGHLIGHT);
      registry.set(HIGHLIGHT, new Highlight(...findRanges(box, q)));
    };
    paint();
    const watch = new MutationObserver(paint);
    watch.observe(box, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      registry.delete(HIGHLIGHT);
    };
  }, [q, scroller]);

  return (
    <div className="pointer-events-auto absolute top-16 end-3 z-20 flex w-[min(24rem,calc(100%-1.5rem))] items-center gap-1 rounded-full border bg-background/95 py-1 pe-1 ps-3 shadow-md backdrop-blur sm:end-4">
      <Search className="size-4 shrink-0 text-muted-foreground" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            step(e.shiftKey ? 1 : -1);
          }
        }}
        placeholder={t('find.placeholder')}
        aria-label={t('find.placeholder')}
        className="min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
      />
      <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {active && loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : active ? (
          shownHits.length ? (
            t('find.position', { at: index + 1, count: shownHits.length })
          ) : (
            t('find.none')
          )
        ) : null}
      </span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={!shownHits.length}
        aria-label={t('find.previous')}
        title={t('find.previous')}
        className="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
      >
        <ChevronUp className="size-4" />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={!shownHits.length}
        aria-label={t('find.next')}
        title={t('find.next')}
        className="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
      >
        <ChevronDown className="size-4" />
      </button>
      <button
        type="button"
        onClick={close}
        aria-label={t('find.close')}
        title={t('find.close')}
        className="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
