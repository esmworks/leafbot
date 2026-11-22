import type { Memory } from '@leafbot/shared';
import { MEMORY_REVIEW_STEPS } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Pencil, Pin, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT } from '@/i18n';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { historyText, historyWho, noteExpired, untilDay, untilEndOfDay } from '@/lib/memoryNotes';
import { useBots, useManagesServer, useMemoryTidy, useSession, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { NoteSource } from './NoteSource';
import { Card, Row, useSaveSettings } from './SettingsDialog';

/** The interval a looking back starts with when the person turns it on. */
const REVIEW_DEFAULT = 20;

/**
 * One note: its words, a pin, an edit and a delete. Editing turns the line into a box (Enter
 * saves, Escape leaves it) with a date the note is true until, which can be cleared; the save
 * carries the version the person began on, so a note changed meanwhile is not overwritten.
 */
export function NoteRow({
  m,
  hint,
  onSave,
  onPin,
  onForget,
}: {
  m: Memory;
  hint?: string;
  onSave: (m: Memory, patch: { content?: string; validUntil?: string | null }) => Promise<unknown>;
  onPin: (m: Memory) => void;
  onForget: (m: Memory) => void;
}) {
  const t = useT();
  const { calendarDay } = useFormat();
  const [draft, setDraft] = useState<string | null>(null);
  // The date field's own text: a day, or empty for no end.
  const [until, setUntil] = useState('');
  const [busy, setBusy] = useState(false);
  if (draft !== null) {
    const submit = () => {
      const content = draft.trim();
      if (!content || busy) return;
      const before = m.validUntil ? untilDay(m.validUntil) : '';
      const patch = {
        ...(content !== m.content && { content }),
        // A day left as it was keeps the exact time the bot gave.
        ...(until !== before && { validUntil: until ? untilEndOfDay(until) : null }),
      };
      if (!Object.keys(patch).length) return setDraft(null);
      setBusy(true);
      onSave(m, patch)
        .then(() => setDraft(null))
        // A note changed meanwhile: the list is already fetched again, so leave the stale draft.
        .catch((e) => e instanceof ApiError && e.status === 409 && setDraft(null))
        .finally(() => setBusy(false));
    };
    return (
      <form
        className="flex flex-wrap items-center gap-2 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Input
          autoFocus
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setDraft(null))}
          aria-label={t('memory.edit')}
          className="min-w-40 flex-1 rounded-full"
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('memory.validUntil')}
          <Input
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="w-40 rounded-full"
          />
          {until && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => setUntil('')}
            >
              {t('memory.validUntilClear')}
            </Button>
          )}
        </label>
        <Button className="rounded-full" size="sm" disabled={busy || !draft.trim()}>
          {t('common.save')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-full"
          onClick={() => setDraft(null)}
        >
          {t('common.cancel')}
        </Button>
      </form>
    );
  }
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-40 flex-1">
        <div className="flex items-start gap-1.5 text-sm">
          {m.pinned && (
            <>
              <Pin className="mt-0.5 size-3.5 shrink-0 fill-current text-muted-foreground" aria-hidden />
              <span className="sr-only">{t('memory.pinned')}</span>
            </>
          )}
          <span className="min-w-0 break-words">{m.site ? `${m.site} · ${m.content}` : m.content}</span>
        </div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
        {m.validUntil && (
          <div className="text-xs text-muted-foreground">
            {t(noteExpired(m) ? 'memory.expiredOn' : 'memory.validUntilOn', {
              date: calendarDay(untilDay(m.validUntil), true),
            })}
          </div>
        )}
      </div>
      <NoteSource m={m} />
      <div className="flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          onClick={() => onPin(m)}
          aria-pressed={!!m.pinned}
          aria-label={m.pinned ? t('memory.unpin') : t('memory.pin')}
          title={m.pinned ? t('memory.unpin') : t('memory.pin')}
        >
          <Pin className={cn('size-4', m.pinned && 'fill-current')} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          onClick={() => {
            setDraft(m.content);
            setUntil(m.validUntil ? untilDay(m.validUntil) : '');
          }}
          aria-label={t('memory.edit')}
          title={t('memory.edit')}
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full"
          onClick={() => onForget(m)}
          aria-label={t('common.delete')}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/** What happened to the notes lately; read from the server only once opened. */
export function MemoryHistory() {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: bots = [] } = useBots();
  const me = useSession().data?.user?.id;
  const [open, setOpen] = useState(false);
  const { data: lines = [], isPending } = useQuery({
    queryKey: ['memory', 'history'],
    queryFn: api.memoryHistory,
    enabled: open,
  });
  return (
    <section className="mb-6">
      <h3 className="mb-2 px-1 text-sm font-medium text-muted-foreground">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1"
        >
          <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
          {t('memory.history')}
        </button>
      </h3>
      {open && (
        <div className="divide-y rounded-2xl border bg-card/50">
          {!isPending && lines.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t('memory.historyEmpty')}</div>
          )}
          {[...lines].reverse().map((l) => (
            <Row
              key={l.id}
              label={historyText(l, t)}
              hint={`${historyWho(l, me, bots, t)} · ${dayLabel(l.createdAt)}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Whether bots look back at conversations for lasting facts, how often, and whether their notes are tidied. */
export function LearnSetting() {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const manages = useManagesServer();
  const every = settings?.memoryReviewEvery;
  const tidy = settings?.memoryTidy;
  // A server older than the setting does not offer it; it is the server's, so only those who look
  // after the server may change it.
  if (every === undefined || !manages) return null;
  return (
    <Card>
      <Row label={t('memory.learn')} hint={t('memory.learnHint')}>
        <Switch
          checked={every > 0}
          aria-label={t('memory.learn')}
          onCheckedChange={(on) => save.mutate({ memoryReviewEvery: on ? REVIEW_DEFAULT : 0 })}
        />
      </Row>
      {every > 0 && (
        <Row label={t('memory.learnEvery')}>
          <Select value={String(every)} onValueChange={(v) => save.mutate({ memoryReviewEvery: Number(v) })}>
            <SelectTrigger className="w-44 rounded-full" aria-label={t('memory.learnEvery')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_REVIEW_STEPS.filter((n) => n > 0).map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {t('memory.learnEveryChoice', { count: n })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      {tidy !== undefined && <TidyRows on={tidy} />}
    </Card>
  );
}

/** The weekly tidy-up of the notes: on or off, what its last pass did, and a pass now. */
function TidyRows({ on }: { on: boolean }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const { data: status } = useMemoryTidy();
  const now = useMutation({
    mutationFn: api.tidyMemory,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['memory', 'tidy'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const last = status?.last;
  const running = !!status?.running;
  return (
    <>
      <Row label={t('memory.tidy')} hint={t('memory.tidyHint')}>
        <Switch
          checked={on}
          aria-label={t('memory.tidy')}
          onCheckedChange={(v) => save.mutate({ memoryTidy: v })}
        />
      </Row>
      {on && (
        <Row
          label={
            running
              ? t('memory.tidyRunning')
              : last
                ? t('memory.tidyLast', { when: dayLabel(last.at) })
                : t('memory.tidyNever')
          }
          hint={
            !running && last
              ? (last.checked ?? 0) + last.merged + last.updated + last.forgot
                ? t('memory.tidyDid', {
                    checked: last.checked ?? 0,
                    merged: last.merged,
                    updated: last.updated,
                    forgot: last.forgot,
                  })
                : t('memory.tidyNothing')
              : undefined
          }
        >
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            disabled={running || now.isPending}
            onClick={() => now.mutate()}
          >
            {t('memory.tidyNow')}
          </Button>
        </Row>
      )}
    </>
  );
}
