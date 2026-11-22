import {
  MAX_MINUTES_ITEMS,
  type Bot,
  type Meeting,
  type MeetingAnswer,
  type MeetingMinutes,
  type MeetingTask,
  type Message,
  type Room,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Bell,
  BellOff,
  CheckCircle2,
  ClipboardList,
  Copy,
  Download,
  Loader2,
  NotebookPen,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { exportFileName } from '@/lib/exportChat';
import { fits, LINE_MAX, lines, localDay, oneLine } from '@/lib/minutes';
import { useFormat } from '@/lib/format';
import { useBots, useMeetings, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { Field } from './RoutinePage';

/** The minutes window: a room's list of minutes, or one meeting's minutes. */
const useMinutesDialog = create<{
  open: { roomId: string; meetingId: string | null } | null;
  show(open: { roomId: string; meetingId: string | null } | null): void;
}>((set) => ({ open: null, show: (open) => set({ open }) }));

export const showMinutes = (roomId: string, meetingId: string | null = null) =>
  useMinutesDialog.getState().show({ roomId, meetingId });

/** The meeting calls of one room, each refreshing the room and its meetings when done. */
function useMeetingActions(roomId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['meetings', roomId] });
    void qc.invalidateQueries({ queryKey: ['rooms'] });
  };
  const onError = (e: unknown) => toast.error((e as Error).message);
  return {
    start: useMutation({ mutationFn: () => api.startMeeting(roomId), onSuccess: done, onError }),
    answer: useMutation({
      mutationFn: (v: { id: string; answer: MeetingAnswer['answer'] }) =>
        api.answerMeeting(roomId, v.id, v.answer),
      onSuccess: done,
      onError,
    }),
    end: useMutation({ mutationFn: (id: string) => api.endMeeting(roomId, id), onSuccess: done, onError }),
    resume: useMutation({
      mutationFn: (id: string) => api.resumeMeeting(roomId, id),
      onSuccess: done,
      onError,
    }),
    retry: useMutation({
      mutationFn: (id: string) => api.retryMeeting(roomId, id),
      onSuccess: done,
      onError,
    }),
  };
}

export function useStartMeeting(roomId: string) {
  return useMeetingActions(roomId).start;
}

const cardClass =
  'flex max-w-(--bubble-width) flex-col gap-3 self-center rounded-3xl border bg-card px-5 py-4 text-[15px]';
const lineClass = 'flex items-center justify-center gap-2 py-1 text-sm text-muted-foreground';

/**
 * The room's own line about a meeting, drawn as its card: at its start the question, or that the
 * minutes are taken; at its end the minutes being written, waiting for the person, or saved.
 */
export function MeetingCard({ room, m }: { room: Room; m: Message }) {
  const t = useT();
  const { data: meetings, isLoading } = useMeetings(room.id);
  const actions = useMeetingActions(room.id);
  const ref = m.props.meeting as { id?: unknown; stage?: unknown } | undefined;
  const id = typeof ref?.id === 'string' ? ref.id : '';
  const stage = ref?.stage === 'end' ? 'end' : 'start';
  const meeting = meetings?.find((x) => x.id === id);
  if (isLoading) return null;

  if (!meeting)
    return (
      <div className={lineClass}>
        <NotebookPen className="size-4" />
        {stage === 'start' ? t('meeting.notKept') : t('meeting.gone')}
      </div>
    );

  if (stage === 'start') {
    if (meeting.status === 'asked')
      return (
        <div className={cardClass} role="group" aria-label={t('meeting.ask')}>
          <div className="flex items-start gap-3">
            <NotebookPen className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="min-w-0 space-y-1">
              <div className="font-medium">{t('meeting.ask')}</div>
              <p className="text-sm text-muted-foreground">{t('meeting.askHint')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['yes', 'always', 'no', 'never'] as const).map((answer) => (
              <Button
                key={answer}
                size="sm"
                variant={answer === 'yes' ? 'default' : answer === 'always' ? 'secondary' : 'ghost'}
                className="rounded-full"
                disabled={actions.answer.isPending}
                onClick={() => actions.answer.mutate({ id: meeting.id, answer })}
              >
                {t(`meeting.${answer}`)}
              </Button>
            ))}
          </div>
        </div>
      );
    if (meeting.status === 'active')
      return (
        <div className={lineClass}>
          <Recording />
          {t('meeting.recording')}
          <Button
            size="xs"
            variant="secondary"
            className="rounded-full"
            disabled={actions.end.isPending}
            onClick={() => actions.end.mutate(meeting.id)}
          >
            {t('meeting.end')}
          </Button>
        </div>
      );
    return (
      <div className={lineClass}>
        <NotebookPen className="size-4" />
        {t('meeting.started')}
      </div>
    );
  }

  switch (meeting.status) {
    case 'writing':
      return (
        <div className={lineClass} role="status">
          <Loader2 className="size-4 animate-spin" />
          {t('meeting.writing')}
        </div>
      );
    case 'draft':
      return (
        <div className={cardClass}>
          <div className="flex items-start gap-3">
            <ClipboardList className="mt-0.5 size-5 shrink-0 text-primary" />
            <div className="min-w-0 space-y-1">
              <div className="font-medium">{meeting.minutes?.title}</div>
              <p className="text-sm text-muted-foreground">{t('meeting.draftReady')}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" className="rounded-full" onClick={() => showMinutes(room.id, meeting.id)}>
              {t('meeting.open')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={actions.resume.isPending}
              onClick={() => actions.resume.mutate(meeting.id)}
            >
              {t('meeting.resume')}
            </Button>
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className={cn(cardClass, 'border-destructive/30 bg-destructive/10')}>
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0 space-y-1">
              <div className="font-medium">{t('meeting.failed')}</div>
              {meeting.error && <p className="text-sm whitespace-pre-wrap">{meeting.error}</p>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              className="rounded-full"
              disabled={actions.retry.isPending}
              onClick={() => actions.retry.mutate(meeting.id)}
            >
              {t('meeting.retry')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={actions.resume.isPending}
              onClick={() => actions.resume.mutate(meeting.id)}
            >
              {t('meeting.resume')}
            </Button>
          </div>
        </div>
      );
    case 'saved':
      return (
        <div className={cardClass}>
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" />
            <div className="min-w-0 space-y-1">
              <div className="font-medium">{meeting.minutes?.title}</div>
              <SentLine meeting={meeting} />
            </div>
          </div>
          <div>
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              onClick={() => showMinutes(room.id, meeting.id)}
            >
              {t('meeting.open')}
            </Button>
          </div>
        </div>
      );
    default:
      return (
        <div className={lineClass}>
          <NotebookPen className="size-4" />
          {t('meeting.goesOn')}
        </div>
      );
  }
}

function Recording() {
  return (
    <span className="relative flex size-2.5">
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
    </span>
  );
}

function SentLine({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const waiting = meeting.sentTo.filter((s) => s.waiting).length;
  return (
    <span className="block text-sm text-muted-foreground">
      {t('meeting.saved')}
      {meeting.sentTo.length > 0 && ` · ${t('meeting.sentCount', { count: meeting.sentTo.length })}`}
      {waiting > 0 && ` · ${t('meeting.waitingCount', { count: waiting })}`}
      {meeting.reminders.length > 0 &&
        ` · ${t('meeting.reminderCount', { count: meeting.reminders.length })}`}
    </span>
  );
}

/** In the room's header: the meeting under way, or minutes waiting for the person. */
export function MeetingBar({ room }: { room: Room }) {
  const t = useT();
  const actions = useMeetingActions(room.id);
  const meeting = room.meeting;
  if (!meeting || meeting.status === 'asked') return null;
  const pill =
    'pointer-events-auto flex items-center gap-2 rounded-full border bg-background/80 py-1 pr-1 pl-3 text-xs shadow-sm backdrop-blur';
  if (meeting.status === 'active')
    return (
      <div className={pill} role="status">
        <Recording />
        <span className="font-medium">{t('meeting.recording')}</span>
        <Button
          size="xs"
          variant="secondary"
          className="rounded-full"
          disabled={actions.end.isPending}
          onClick={() => actions.end.mutate(meeting.id)}
        >
          {t('meeting.endShort')}
        </Button>
      </div>
    );
  if (meeting.status === 'writing')
    return (
      <div className={cn(pill, 'pr-3')} role="status">
        <Loader2 className="size-3.5 animate-spin" />
        {t('meeting.writing')}
      </div>
    );
  return (
    <button
      type="button"
      className={cn(pill, 'pr-3 hover:bg-accent', meeting.status === 'failed' && 'text-destructive')}
      onClick={() => showMinutes(room.id, meeting.id)}
    >
      {meeting.status === 'failed' ? (
        <AlertCircle className="size-3.5" />
      ) : (
        <ClipboardList className="size-3.5" />
      )}
      {meeting.status === 'failed' ? t('meeting.failed') : t('meeting.draftWaiting')}
    </button>
  );
}

/** The minutes as a Markdown document, to copy or keep. */
export function minutesMarkdown(
  m: MeetingMinutes,
  o: { room: string; day: string; t: ReturnType<typeof useT> },
): string {
  const { t } = o;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : `_${t('meeting.empty')}_`);
  const task = (x: MeetingTask) =>
    `- [ ] ${x.text}${x.owner ? ` — **${x.owner}**` : ''}${x.due ? ` (${t('meeting.taskDueOn', { due: x.due })})` : ''}`;
  return [
    `# ${m.title}`,
    `${o.room} · ${o.day}`,
    m.summary ? `## ${t('meeting.summary')}\n\n${m.summary}` : '',
    `## ${t('meeting.decisions')}\n\n${list(m.decisions)}`,
    `## ${t('meeting.tasks')}\n\n${m.tasks.length ? m.tasks.map(task).join('\n') : `_${t('meeting.empty')}_`}`,
    m.questions.length ? `## ${t('meeting.questions')}\n\n${list(m.questions)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The minutes window, opened from a card, the header or the room's menu. */
export function MinutesDialog({ rooms }: { rooms: Room[] }) {
  const open = useMinutesDialog((s) => s.open);
  const show = useMinutesDialog((s) => s.show);
  const room = open ? rooms.find((r) => r.id === open.roomId) : undefined;
  return (
    <Dialog open={!!open && !!room} onOpenChange={(o) => !o && show(null)}>
      <DialogContent className="screen-edges scroll-thin max-h-[90vh] overflow-y-auto rounded-3xl sm:max-w-2xl phone:h-dvh phone:max-h-none phone:max-w-full phone:content-start phone:rounded-none phone:border-0">
        {open && room && (
          <MinutesBody
            key={`${open.roomId}:${open.meetingId ?? ''}`}
            room={room}
            meetingId={open.meetingId}
            onOpen={(meetingId) => show({ roomId: room.id, meetingId })}
            onClose={() => show(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function MinutesBody({
  room,
  meetingId,
  onOpen,
  onClose,
}: {
  room: Room;
  meetingId: string | null;
  onOpen(id: string | null): void;
  onClose(): void;
}) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: meetings = [], isLoading } = useMeetings(room.id);
  // The editor picks the room's bots to tell as it opens: it waits until they are known.
  const { isLoading: botsLoading } = useBots();
  const meeting = meetingId ? meetings.find((m) => m.id === meetingId) : undefined;
  if (isLoading || botsLoading) return null;
  if (!meeting) {
    const listed = meetings.filter((m) => m.minutes);
    return (
      <div className="min-w-0 space-y-4">
        <DialogHeader>
          <DialogTitle>{t('meeting.list')}</DialogTitle>
          <DialogDescription>{room.title}</DialogDescription>
        </DialogHeader>
        {listed.length ? (
          <div className="space-y-1">
            {listed.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onOpen(m.id)}
                className="flex w-full items-center gap-3 rounded-2xl px-3 py-2 text-left hover:bg-accent/60"
              >
                {m.status === 'saved' ? (
                  <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
                ) : (
                  <ClipboardList className="size-4 shrink-0 text-primary" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.minutes!.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {m.status === 'saved' ? dayLabel(m.startedAt) : t('meeting.draftWaiting')}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('meeting.listEmpty')}</p>
        )}
      </div>
    );
  }
  if (meeting.status === 'draft' && meeting.minutes)
    return <MinutesEditor room={room} meeting={meeting} minutes={meeting.minutes} onDone={onClose} />;
  if (meeting.minutes)
    return (
      <MinutesView
        room={room}
        meeting={meeting}
        minutes={meeting.minutes}
        onBack={() => onOpen(null)}
        onClose={onClose}
      />
    );
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{t('meeting.dialogSaved')}</DialogTitle>
        <DialogDescription>
          {meeting.status === 'failed' ? meeting.error : t('meeting.writing')}
        </DialogDescription>
      </DialogHeader>
    </div>
  );
}

function MinutesView({
  room,
  meeting,
  minutes,
  onBack,
  onClose,
}: {
  room: Room;
  meeting: Meeting;
  minutes: MeetingMinutes;
  onBack(): void;
  onClose(): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { dayLabel } = useFormat();
  const day = localDay(meeting.startedAt);
  const md = minutesMarkdown(minutes, { room: room.title, day: dayLabel(meeting.startedAt), t });
  const remove = useMutation({
    mutationFn: () => api.deleteMeeting(room.id, meeting.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['meetings', room.id] });
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      onBack();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(minutes.title, day);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <div className="min-w-0 space-y-4">
      <DialogHeader>
        <DialogTitle>{t('meeting.dialogSaved')}</DialogTitle>
        <DialogDescription>
          <SentLine meeting={meeting} />
        </DialogDescription>
      </DialogHeader>
      <MinutesSections minutes={minutes} meta={`${room.title} · ${dayLabel(meeting.startedAt)}`} />
      {meeting.reminders.length > 0 && <Reminders meeting={meeting} />}
      <DialogFooter className="gap-2">
        <Button
          type="button"
          variant="ghost"
          className="mr-auto rounded-full text-destructive"
          disabled={remove.isPending}
          onClick={() => confirm(t('meeting.deleteConfirm')) && remove.mutate()}
        >
          <Trash2 /> {t('meeting.delete')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="rounded-full"
          onClick={() => void copyText(md).then((ok) => ok && toast.success(t('meeting.copied')))}
        >
          <Copy /> {t('meeting.copy')}
        </Button>
        <Button type="button" variant="ghost" className="rounded-full" onClick={download}>
          <Download /> {t('meeting.download')}
        </Button>
        <Button type="button" className="rounded-full" onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogFooter>
    </div>
  );
}

/** The minutes as the person reads them: the title, then each part under its own heading. */
function MinutesSections({ minutes, meta }: { minutes: MeetingMinutes; meta: string }) {
  const t = useT();
  const { calendarDay } = useFormat();
  const heading = 'mb-1.5 text-sm font-semibold';
  const empty = <p className="text-sm text-muted-foreground">{t('meeting.empty')}</p>;
  const list = (xs: string[]) =>
    xs.length ? (
      <ul className="list-disc space-y-1 pl-5 text-[15px]">
        {xs.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    ) : (
      empty
    );
  return (
    <div className="space-y-4 rounded-2xl border px-5 py-4">
      <div>
        <div className="text-lg font-semibold">{minutes.title}</div>
        <div className="text-sm text-muted-foreground">{meta}</div>
      </div>
      {minutes.summary && (
        <section>
          <h3 className={heading}>{t('meeting.summary')}</h3>
          <p className="text-[15px] whitespace-pre-wrap">{minutes.summary}</p>
        </section>
      )}
      <section>
        <h3 className={heading}>{t('meeting.decisions')}</h3>
        {list(minutes.decisions)}
      </section>
      <section>
        <h3 className={heading}>{t('meeting.tasks')}</h3>
        {minutes.tasks.length ? (
          <ul className="space-y-1.5 text-[15px]">
            {minutes.tasks.map((x, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                <span>{x.text}</span>
                {x.owner && <span className="font-medium">{x.owner}</span>}
                {x.due && (
                  <span className="text-sm text-muted-foreground">
                    {t('meeting.taskDueOn', { due: calendarDay(x.due) })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          empty
        )}
      </section>
      {minutes.questions.length > 0 && (
        <section>
          <h3 className={heading}>{t('meeting.questions')}</h3>
          {list(minutes.questions)}
        </section>
      )}
    </div>
  );
}

/** The written minutes, for the person to fix and approve, and the bots they go to. */
function MinutesEditor({
  room,
  meeting,
  minutes,
  onDone,
}: {
  room: Room;
  meeting: Meeting;
  minutes: MeetingMinutes;
  onDone(): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const { data: settings } = useSettings();
  const [title, setTitle] = useState(minutes.title);
  const [summary, setSummary] = useState(minutes.summary);
  const [decisions, setDecisions] = useState(oneLine(minutes.decisions));
  const [questions, setQuestions] = useState(oneLine(minutes.questions));
  const decisionsFit = fits(lines(decisions));
  const questionsFit = fits(lines(questions));
  // The room's bots first, then the rest the person may talk with; only bots that keep memory.
  const members = room.members.flatMap((id) => bots.filter((b) => b.id === id && !b.archivedAt));
  // A reminder is a follow-up of a bot the person talks with: the one that took the task on, or
  // else the room's first bot. The server picks the same.
  const editable = members;
  const byName = (name: string) =>
    members.find((b) => b.name.toLocaleLowerCase() === name.trim().replace(/^@/, '').toLocaleLowerCase());
  const reminderBot = (owner: string) => {
    const own = byName(owner);
    return (own && editable.find((b) => b.id === own.id)) ?? editable[0];
  };
  const [remindAt, setRemindAt] = useState('09:00');
  const upcoming = (due: string | null) => !!due && new Date(`${due}T${remindAt}`).getTime() > Date.now();
  const [tasks, setTasks] = useState<(MeetingTask & { remind: boolean })[]>(() =>
    minutes.tasks.map((x) => ({ ...x, remind: !!reminderBot(x.owner) && upcoming(x.due) })),
  );
  const others = bots.filter((b) => !b.archivedAt && !room.members.includes(b.id));
  const [picked, setPicked] = useState<string[]>(members.filter((b) => b.memory).map((b) => b.id));
  const person = settings?.userName || t('export.you');
  const names = [...new Set([person, ...members.map((b) => b.name)])];

  const setTask = (i: number, patch: Partial<MeetingTask & { remind: boolean }>) =>
    setTasks((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = useMutation({
    mutationFn: () => {
      const kept = tasks.filter((x) => x.text.trim());
      const approved: MeetingMinutes = {
        title: title.trim() || minutes.title,
        summary: summary.trim(),
        decisions: lines(decisions),
        tasks: kept.map((x) => {
          const bot = byName(x.owner);
          return {
            text: x.text.trim(),
            owner: (bot?.name ?? x.owner).trim(),
            botId: bot?.id ?? null,
            due: x.due || null,
          };
        }),
        questions: lines(questions),
      };
      const reminders = kept.flatMap((x, i) =>
        x.remind && upcoming(x.due) && reminderBot(x.owner) ? [i] : [],
      );
      return api.saveMeeting(room.id, meeting.id, { minutes: approved, botIds: picked, reminders, remindAt });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['meetings', room.id] });
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      void qc.invalidateQueries({ queryKey: ['memory'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <form
      className="min-w-0 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t('meeting.dialogDraft')}</DialogTitle>
        <DialogDescription>{t('meeting.dialogHint')}</DialogDescription>
      </DialogHeader>
      <Field label={t('meeting.title')}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          className="rounded-xl"
        />
      </Field>
      <Field label={t('meeting.summary')}>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={3}
          maxLength={6000}
          className="rounded-xl"
        />
      </Field>
      <Field label={t('meeting.decisions')}>
        <Textarea
          value={decisions}
          onChange={(e) => setDecisions(e.target.value)}
          rows={Math.min(8, Math.max(2, decisions.split('\n').length))}
          placeholder={t('meeting.linesHint')}
          aria-invalid={!decisionsFit}
          className="rounded-xl"
        />
        {!decisionsFit && <TooLong />}
      </Field>
      <Field label={t('meeting.tasks')}>
        <div className="space-y-2">
          <datalist id={`owners-${meeting.id}`}>
            {names.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {tasks.map((task, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto] gap-2 rounded-2xl border p-2 sm:grid-cols-[1fr_9rem_9rem_auto]"
            >
              <Input
                value={task.text}
                onChange={(e) => setTask(i, { text: e.target.value })}
                placeholder={t('meeting.taskText')}
                aria-label={t('meeting.taskText')}
                maxLength={1000}
                className="col-span-2 rounded-xl sm:col-span-1"
              />
              <Input
                value={task.owner}
                onChange={(e) => setTask(i, { owner: e.target.value })}
                placeholder={t('meeting.taskOwner')}
                aria-label={t('meeting.taskOwner')}
                list={`owners-${meeting.id}`}
                maxLength={120}
                className="rounded-xl"
              />
              <Input
                type="date"
                value={task.due ?? ''}
                onChange={(e) => setTask(i, { due: e.target.value || null })}
                aria-label={t('meeting.taskDue')}
                className="rounded-xl"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="rounded-full"
                onClick={() => setTasks((all) => all.filter((_, j) => j !== i))}
                aria-label={t('meeting.removeTask')}
              >
                <X className="size-4" />
              </Button>
              <ReminderToggle
                due={task.due}
                bot={reminderBot(task.owner)}
                upcoming={upcoming(task.due)}
                on={task.remind}
                onToggle={() => setTask(i, { remind: !task.remind })}
              />
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="rounded-full"
            disabled={tasks.length >= MAX_MINUTES_ITEMS}
            onClick={() =>
              setTasks((all) => [...all, { text: '', owner: '', botId: null, due: null, remind: true }])
            }
          >
            <Plus /> {t('meeting.addTask')}
          </Button>
        </div>
      </Field>
      {tasks.some((x) => x.due) && editable.length > 0 && (
        <Field label={t('meeting.remindAt')}>
          <Input
            type="time"
            value={remindAt}
            onChange={(e) => setRemindAt(e.target.value || '09:00')}
            className="w-36 rounded-xl"
          />
          <p className="text-xs text-muted-foreground">{t('meeting.remindHint')}</p>
        </Field>
      )}
      <Field label={t('meeting.questions')}>
        <Textarea
          value={questions}
          onChange={(e) => setQuestions(e.target.value)}
          rows={Math.min(6, Math.max(2, questions.split('\n').length))}
          placeholder={t('meeting.linesHint')}
          aria-invalid={!questionsFit}
          className="rounded-xl"
        />
        {!questionsFit && <TooLong />}
      </Field>
      <Field label={t('meeting.recipients')}>
        <div className="scroll-thin max-h-56 space-y-0.5 overflow-y-auto rounded-2xl border p-1">
          {[...members, ...others].map((b) => (
            <Recipient
              key={b.id}
              bot={b}
              member={room.members.includes(b.id)}
              on={picked.includes(b.id)}
              onToggle={() =>
                setPicked((p) => (p.includes(b.id) ? p.filter((x) => x !== b.id) : [...p, b.id]))
              }
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t('meeting.recipientsHint')}</p>
      </Field>
      <DialogFooter className="gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          className="rounded-full"
          disabled={save.isPending || !decisionsFit || !questionsFit}
        >
          {picked.length ? t('meeting.approve') : t('meeting.approveNone')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The reminders set for the meeting's tasks: when, by which bot, for what. */
function Reminders({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const { calendarDay } = useFormat();
  const { data: bots = [] } = useBots();
  return (
    <section className="space-y-1.5 rounded-2xl border px-5 py-4">
      <h3 className="text-sm font-semibold">{t('meeting.reminders')}</h3>
      <ul className="space-y-1 text-[15px]">
        {meeting.reminders.map((r) => (
          <li key={r.followUpId ?? r.routineId ?? r.task} className="flex flex-wrap items-baseline gap-x-2">
            <Bell className="size-3.5 shrink-0 self-center text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {calendarDay(r.date)} {r.time} ·{' '}
              {bots.find((b) => b.id === r.botId)?.name ?? t('room.unknownBot')}
            </span>
            <span>{r.task}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{t('meeting.remindersHint')}</p>
    </section>
  );
}

/** Whether a task is reminded of on its day, and by which bot; why not, when it cannot be. */
function ReminderToggle({
  due,
  bot,
  upcoming,
  on,
  onToggle,
}: {
  due: string | null;
  bot: Bot | undefined;
  upcoming: boolean;
  on: boolean;
  onToggle(): void;
}) {
  const t = useT();
  if (!due) return null;
  const why = !bot ? t('meeting.remindNoBot') : !upcoming ? t('meeting.remindPast') : null;
  return (
    <div className="col-span-full flex items-center gap-2 px-1 text-xs text-muted-foreground">
      {why ? (
        <>
          <BellOff className="size-3.5" />
          {why}
        </>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={on}
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2 py-0.5 hover:bg-accent',
            on && 'bg-primary/10 text-foreground',
          )}
        >
          {on ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
          {on ? t('meeting.remindOn', { bot: bot!.name }) : t('meeting.remindOff')}
        </button>
      )}
    </div>
  );
}

function TooLong() {
  const t = useT();
  return (
    <p className="text-sm text-destructive">
      {t('meeting.linesTooLong', { max: MAX_MINUTES_ITEMS, chars: LINE_MAX })}
    </p>
  );
}

function Recipient({
  bot,
  member,
  on,
  onToggle,
}: {
  bot: Bot;
  member: boolean;
  on: boolean;
  onToggle(): void;
}) {
  const t = useT();
  const note = !bot.memory
    ? t('meeting.noMemory')
    : bot.yourLevel === 'chat'
      ? t('meeting.needsOwner')
      : member
        ? t('meeting.member')
        : '';
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={!bot.memory}
      aria-pressed={on}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60 disabled:opacity-50',
        on && 'bg-accent/70',
      )}
    >
      <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={26} />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{bot.name}</span>
      {note && <span className="shrink-0 text-xs text-muted-foreground">{note}</span>}
      <span
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full border',
          on && 'border-transparent bg-primary text-primary-foreground',
        )}
      >
        {on && <CheckCircle2 className="size-3.5" />}
      </span>
    </button>
  );
}
