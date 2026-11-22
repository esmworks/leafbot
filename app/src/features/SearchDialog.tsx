import type { Bot, SearchHit } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeft, Loader2, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { BotAvatar } from '@/components/BotAvatar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { matchCommands, paletteCommands, type PaletteCommand } from '@/lib/commands';
import { useBots, useManagesServer, useSession } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

type Result =
  | { kind: 'command'; command: PaletteCommand; bot?: undefined }
  | { kind: 'bot'; bot: Bot }
  | { kind: 'message'; hit: SearchHit; bot: Bot | undefined };

/** Waits for typing to pause before the query reaches the server. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/**
 * ⌘K / Ctrl+K: finds what to do (open a place, a settings section, change the theme), bots by name
 * and messages by their text, and opens what is picked.
 */
export function SearchDialog() {
  const open = useUi((s) => s.searchOpen);
  const setOpen = useUi((s) => s.openSearch);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(!useUi.getState().searchOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="top-[15vh] translate-y-0 gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-xl"
        aria-describedby={undefined}
      >
        {open && <SearchBody onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function SearchBody({ onDone }: { onDone(): void }) {
  const t = useT();
  const intl = useLocale((s) => s.intl);
  const { shortTime } = useFormat();
  const { data: bots = [] } = useBots();
  const [query, setQuery] = useState(() => useUi.getState().searchQuery);
  const [active, setActive] = useState(0);
  const q = useDebounced(query.trim(), 250);
  const { data: hits = [], isFetching } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.search(q),
    enabled: q.length >= 2,
    staleTime: 10_000,
  });
  const byId = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const manages = useManagesServer();
  const known = !!useSession().data?.user;
  const commands = useMemo(() => paletteCommands(t, { manages, known }), [t, manages, known]);
  const results: Result[] = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(intl);
    const named = needle
      ? bots.filter((b) => b.name.toLocaleLowerCase(intl).includes(needle)).slice(0, 5)
      : [];
    return [
      ...matchCommands(commands, query, intl).map((command) => ({ kind: 'command' as const, command })),
      ...named.map((bot) => ({ kind: 'bot' as const, bot })),
      ...(q.length >= 2 ? hits : []).map((hit) => ({
        kind: 'message' as const,
        hit,
        bot: byId.get(hit.botId),
      })),
    ];
  }, [bots, byId, commands, hits, intl, q, query]);

  const pick = (r: Result) => {
    const ui = useUi.getState();
    if (r.kind === 'command') {
      // The palette closes first, so a dialog the command opens is not closed with it.
      onDone();
      r.command.run();
      return;
    }
    if (r.kind === 'bot') {
      ui.openChat(r.bot.id);
    } else {
      ui.openChat(r.hit.botId);
      ui.selectThread(r.hit.threadId);
      // The conversation opens with its find bar on the same words, at the message picked.
      ui.setFindOpen(true, { query: q.trim(), messageId: r.hit.messageId });
      ui.focusMessage({ id: r.hit.messageId, threadId: r.hit.threadId });
    }
    onDone();
  };

  return (
    <>
      <DialogTitle className="sr-only">{t('search.title')}</DialogTitle>
      <div className="flex items-center gap-3 border-b px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing && results[active]) {
              e.preventDefault();
              pick(results[active]);
            }
          }}
          placeholder={t('search.placeholder')}
          aria-label={t('search.title')}
          className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
        />
        {isFetching && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      <div
        className="scroll-thin max-h-[60vh] overflow-y-auto p-2"
        role="listbox"
        aria-label={t('search.title')}
      >
        {query.trim().length > 0 && results.length === 0 && !isFetching && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {q.length < 2 ? t('search.typeMore') : t('search.none')}
          </p>
        )}
        {!query.trim() && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('search.hint')}</p>
        )}
        {results.map((r, i) => {
          const bot = r.bot;
          return (
            <button
              key={
                r.kind === 'command'
                  ? `c:${r.command.id}`
                  : r.kind === 'bot'
                    ? `b:${r.bot.id}`
                    : `m:${r.hit.messageId}`
              }
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(r)}
              className={cn(
                'flex w-full items-start gap-3 rounded-2xl px-3 py-2 text-left',
                i === active && 'bg-accent',
              )}
            >
              {r.kind === 'command' ? (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                  <CornerDownLeft className="size-3.5" />
                </span>
              ) : bot ? (
                <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={28} />
              ) : (
                <span className="size-7 shrink-0 rounded-full bg-secondary" />
              )}
              {r.kind === 'command' ? (
                <div className="min-w-0 flex-1 self-center truncate text-sm font-medium">
                  {r.command.label}
                </div>
              ) : r.kind === 'bot' ? (
                <div className="min-w-0 flex-1 self-center">
                  <div className="truncate text-sm font-medium">{r.bot.name}</div>
                  {r.bot.description && (
                    <div className="truncate text-xs text-muted-foreground">{r.bot.description}</div>
                  )}
                </div>
              ) : (
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
                    <span className="truncate font-medium text-foreground">
                      {bot?.name ?? t('common.bot')}
                      {r.hit.threadTitle ? ` · ${r.hit.threadTitle}` : ''}
                    </span>
                    <span className="ml-auto shrink-0">{shortTime(r.hit.createdAt)}</span>
                  </div>
                  <div className="line-clamp-2 text-sm">
                    <span className="text-muted-foreground">
                      {r.hit.role === 'user' ? t('search.you') : `${bot?.name ?? t('common.bot')}:`}{' '}
                    </span>
                    <Highlight text={r.hit.excerpt} query={q} />
                  </div>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}

/** The excerpt with each match marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const intl = useLocale((s) => s.intl);
  if (!query) return <>{text}</>;
  const lower = text.toLocaleLowerCase(intl);
  const needle = query.toLocaleLowerCase(intl);
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0 && needle; i = lower.indexOf(needle, at)) {
    parts.push(
      text.slice(at, i),
      <mark key={i} className="rounded bg-amber-300/60 text-inherit">
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    at = i + needle.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
