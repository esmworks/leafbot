import {
  lastResetIndex,
  MAX_ROOM_MEMBERS,
  MAX_ROOM_ROUNDS,
  type Message,
  type Room,
  type RoomMinutes,
  type RoomFace as BotFace,
  type RoomResponders,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUp,
  ChevronLeft,
  ClipboardList,
  History,
  LogOut,
  MoreHorizontal,
  NotebookPen,
  Pencil,
  Plus,
  Reply,
  RotateCcw,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { useThreadActivity } from '@/lib/botActivity';
import { newClientId, useFormat } from '@/lib/format';
import { useLiveCards } from '@/lib/liveCards';
import { PHONE } from '@/lib/media';
import { useBots, useMessages, usePeople, useRooms, useSession } from '@/lib/queries';
import { useLiveCatchUp } from '@/lib/liveCatchUp';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { useFitHeight } from '@/lib/fitHeight';
import { personName } from './PeopleTab';
import { Field } from './RoutinePage';
import { AssistantCard, CardDock, ExchangeCards, MessageItem, replyExcerpt, Working } from './MessageItem';
import { MeetingBar, MeetingCard, MinutesDialog, showMinutes, useStartMeeting } from './Meetings';

const heading = 'px-4 pt-3 pb-1 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase';

/**
 * The bots of a room that still exist, in speaking order. One not shared with the person, who was
 * put in the room, shows as the room describes it.
 */
function useMembers(room: Room | undefined): BotFace[] {
  const { data: bots = [] } = useBots();
  return useMemo(
    () =>
      (room?.members ?? [])
        .map((id) => bots.find((b) => b.id === id) ?? room?.faces?.find((f) => f.id === id))
        .filter((b): b is BotFace => !!b),
    [room?.members, room?.faces, bots],
  );
}

/** Whether the one signed in opened the room, and whether they may manage it (an admin in it may). */
function useRoomRole(room: Room) {
  const user = useSession().data?.user;
  const owner = !room.ownerId || room.ownerId === user?.id;
  return { me: user?.id, owner, manages: owner || user?.role === 'owner' || user?.role === 'admin' };
}

/** Up to three member avatars overlapping, as the room's picture. */
function RoomFace({ members, size = 22 }: { members: BotFace[]; size?: number }) {
  const shown = members.slice(0, 3);
  if (!shown.length)
    return (
      <span
        className="flex items-center justify-center rounded-full bg-secondary text-muted-foreground"
        style={{ width: size, height: size }}
      >
        <Users className="size-3.5" />
      </span>
    );
  return (
    <span className="flex items-center">
      {shown.map((b, i) => (
        <span key={b.id} className={cn(i > 0 && '-ms-2')} style={{ zIndex: shown.length - i }}>
          <BotAvatar avatar={b.avatar} material={b.material} color={b.color} seed={b.id} size={size} />
        </span>
      ))}
    </span>
  );
}

/**
 * Where up to three member avatars sit in a square, as fractions of its side, and how large
 * each is. In a row of overlapping faces three would be wider than a bot's avatar; stacked
 * corner to corner they fill the same square, so a room's row lines up with the bots' rows.
 */
const CLUSTER: Record<number, { size: number; at: [number, number][] }> = {
  1: { size: 0.8, at: [[0.1, 0.1]] },
  2: {
    size: 0.68,
    at: [
      [0, 0],
      [0.32, 0.32],
    ],
  },
  3: {
    size: 0.58,
    at: [
      [0, 0],
      [0.42, 0],
      [0.21, 0.42],
    ],
  },
};

/** The room's picture fitted to a `box` px square, the size of a bot's avatar in the same list. */
function RoomCluster({ members, box }: { members: BotFace[]; box: number }) {
  const shown = members.slice(0, 3);
  const layout = CLUSTER[shown.length];
  if (!layout)
    return (
      <span className="flex items-center justify-center" style={{ width: box, height: box }}>
        <RoomFace members={[]} size={Math.round(box * 0.7)} />
      </span>
    );
  const size = Math.round(box * layout.size);
  return (
    <span className="relative block" style={{ width: box, height: box }}>
      {shown.map((b, i) => {
        const [x, y] = layout.at[i] ?? [0, 0];
        return (
          <span
            key={b.id}
            className="absolute flex"
            style={{ left: box * x, top: box * y, zIndex: shown.length - i }}
          >
            <BotAvatar avatar={b.avatar} material={b.material} color={b.color} seed={b.id} size={size} />
          </span>
        );
      })}
    </span>
  );
}

/** The rooms in the sidebar, under the bots. */
export function RoomsSection({ query }: { query: string }) {
  const t = useT();
  const intl = useLocale((s) => s.intl);
  const { data: rooms = [] } = useRooms();
  const { data: bots = [] } = useBots();
  const openRoomDialog = useUi((s) => s.openRoomDialog);
  const shown = rooms.filter(
    (r) => !query || r.title.toLocaleLowerCase(intl).includes(query.toLocaleLowerCase(intl)),
  );
  if (!bots.length || (query && !shown.length)) return null;
  return (
    <section className="mt-1" aria-label={t('rooms.title')}>
      <div className="flex items-center pe-2">
        <h3 className={cn(heading, 'flex-1')}>{t('rooms.title')}</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 rounded-full text-muted-foreground"
              onClick={() => openRoomDialog({ mode: 'create' })}
              aria-label={t('rooms.new')}
            >
              <Plus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('rooms.new')}</TooltipContent>
        </Tooltip>
      </div>
      {shown.map((r) => (
        <RoomRow key={r.id} room={r} />
      ))}
      {!rooms.length && (
        <button
          type="button"
          onClick={() => openRoomDialog({ mode: 'create' })}
          className="mx-1 flex w-[calc(100%-0.5rem)] items-center gap-3 rounded-2xl px-3 py-2 text-start text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Users className="size-4 shrink-0" />
          {t('room.dialogHint')}
        </button>
      )}
    </section>
  );
}

function RoomRow({ room }: { room: Room }) {
  const t = useT();
  const { shortTime } = useFormat();
  const members = useMembers(room);
  const selected = useUi((s) => s.roomId === room.id);
  const openRoom = useUi((s) => s.openRoom);
  const live = useUi((s) => s.states[room.id]);
  const busy = (live ?? room.state) !== 'idle';
  return (
    <button
      type="button"
      onClick={() => openRoom(room.id)}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl px-3 py-1.5 text-start transition-colors select-none hover:bg-accent/60',
        selected && 'bg-accent',
      )}
    >
      <span className="relative shrink-0">
        <RoomCluster members={members} box={38} />
        {busy && (
          <span className="absolute -end-0.5 -bottom-0.5 z-10 size-2.5 animate-pulse rounded-full bg-emerald-500 ring-2 ring-sidebar" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[15px] leading-5 font-semibold">{room.title}</span>
          <span className="ms-auto shrink-0 text-xs text-muted-foreground">{shortTime(room.updatedAt)}</span>
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {room.preview ?? t('rooms.members', { count: members.length })}
        </div>
      </div>
    </button>
  );
}

/** The rooms in the folded sidebar: one round button each. */
export function RoomRail() {
  const t = useT();
  const { data: rooms = [] } = useRooms();
  const { data: bots = [] } = useBots();
  const openRoomDialog = useUi((s) => s.openRoomDialog);
  const openRoom = useUi((s) => s.openRoom);
  const current = useUi((s) => s.roomId);
  if (!bots.length) return null;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="my-2 h-px w-10 bg-border" />
      {rooms.map((r) => (
        <Tooltip key={r.id}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => openRoom(r.id)}
              aria-label={r.title}
              className={cn(
                'flex size-11 items-center justify-center rounded-2xl transition-colors hover:bg-accent/60',
                current === r.id && 'bg-accent',
              )}
            >
              <Users className="size-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{r.title}</TooltipContent>
        </Tooltip>
      ))}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => openRoomDialog({ mode: 'create' })}
            aria-label={t('rooms.new')}
            className="flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent/60"
          >
            <Plus className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{t('rooms.new')}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Starting a room, or changing who is in it and how they talk. */
export function RoomDialog() {
  const dialog = useUi((s) => s.roomDialog);
  const close = useUi((s) => s.openRoomDialog);
  const { data: rooms = [] } = useRooms();
  const room = dialog?.mode === 'edit' ? rooms.find((r) => r.id === dialog.roomId) : undefined;
  return (
    <Dialog open={!!dialog} onOpenChange={(open) => !open && close(null)}>
      <DialogContent
        // On a phone it covers the screen; the fields scroll between the title and the buttons.
        className="screen-edges flex max-h-[90vh] flex-col overflow-hidden rounded-3xl sm:max-w-lg phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none phone:border-0"
      >
        {dialog && <RoomForm key={room?.id ?? 'new'} room={room} onDone={() => close(null)} />}
      </DialogContent>
    </Dialog>
  );
}

function RoomForm({ room, onDone }: { room?: Room; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const openRoom = useUi((s) => s.openRoom);
  const [title, setTitle] = useState(room?.title ?? '');
  const [goal, setGoal] = useState(room?.goal ?? '');
  const [picked, setPicked] = useState<string[]>(room?.members ?? []);
  const [responders, setResponders] = useState<RoomResponders>(room?.responders ?? 'everyone');
  const [rounds, setRounds] = useState(room?.rounds ?? 0);
  const [minutes, setMinutes] = useState<RoomMinutes>(room?.minutes ?? 'ask');
  const [tried, setTried] = useState(false);
  // An archived bot stays a member until the room is saved, but it is not in the list to pick from
  // and the server takes no archived bot, so only bots still in the list count as chosen.
  const chosen = bots.length ? picked.filter((id) => bots.some((b) => b.id === id)) : picked;
  const dropped =
    room && bots.length ? room.members.filter((id) => !bots.some((b) => b.id === id)).length : 0;
  const toggle = (id: string) =>
    setPicked((all) => {
      const p = all.filter((x) => bots.some((b) => b.id === x));
      return p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_ROOM_MEMBERS ? p : [...p, id];
    });
  const save = useMutation({
    mutationFn: () => {
      const input = { title: title.trim(), goal: goal.trim(), botIds: chosen, responders, rounds, minutes };
      return room ? api.updateRoom(room.id, input) : api.createRoom(input);
    },
    onSuccess: (saved) => {
      // In the list at once, so the room opens before the list is fetched again.
      qc.setQueryData<Room[]>(['rooms'], (old = []) => [saved, ...old.filter((r) => r.id !== saved.id)]);
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      if (!room) openRoom(saved.id);
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRoom(room!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      if (useUi.getState().roomId === room!.id) openRoom(null);
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const valid = !!title.trim() && chosen.length > 0;
  return (
    <form
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (valid) save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{room ? t('room.dialogEdit') : t('room.dialogCreate')}</DialogTitle>
        <DialogDescription>{t('room.dialogHint')}</DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <Field label={t('room.name')} error={tried && !title.trim() ? 'room.nameRequired' : undefined}>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('room.namePlaceholder')}
            maxLength={120}
            className="rounded-xl"
            autoFocus
          />
        </Field>
        <Field label={t('room.members')} error={tried && !chosen.length ? 'room.pickOne' : undefined}>
          {bots.length ? (
            <>
              <div className="scroll-thin max-h-56 space-y-0.5 overflow-y-auto rounded-2xl border p-1">
                {bots.map((b) => {
                  const at = chosen.indexOf(b.id);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggle(b.id)}
                      aria-pressed={at >= 0}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-start transition-colors hover:bg-accent/60',
                        at >= 0 && 'bg-accent/70',
                      )}
                    >
                      <BotAvatar
                        avatar={b.avatar}
                        material={b.material}
                        color={b.color}
                        seed={b.id}
                        size={28}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{b.name}</span>
                        {b.description && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {b.description}
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold',
                          at >= 0 && 'border-transparent bg-primary text-primary-foreground',
                        )}
                      >
                        {at >= 0 ? at + 1 : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">{t('room.membersHint')}</p>
              {dropped > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('room.archivedMembers', { count: dropped })}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t('room.noBots')}</p>
          )}
        </Field>
        <Field label={t('room.goal')}>
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder={t('room.goalPlaceholder')}
            className="rounded-xl"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('room.responders')}>
            <Select value={responders} onValueChange={(v) => setResponders(v as RoomResponders)}>
              <SelectTrigger className="w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="everyone">{t('room.respondersEveryone')}</SelectItem>
                <SelectItem value="mentions">{t('room.respondersMentions')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label={t('room.rounds')}>
            <Select value={String(rounds)} onValueChange={(v) => setRounds(Number(v))}>
              <SelectTrigger className="w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: MAX_ROOM_ROUNDS + 1 }, (_, n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n ? t('room.roundsN', { count: n }) : t('room.roundsOff')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field label={t('room.minutes')}>
          <Select value={minutes} onValueChange={(v) => setMinutes(v as RoomMinutes)}>
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{t('room.minutesAsk')}</SelectItem>
              <SelectItem value="always">{t('room.minutesAlways')}</SelectItem>
              <SelectItem value="never">{t('room.minutesNever')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('room.minutesHint')}</p>
        </Field>
      </DialogBody>
      <DialogFooter className="gap-2">
        {room && (
          <Button
            type="button"
            variant="ghost"
            className="me-auto rounded-full text-destructive"
            onClick={() => confirm(t('room.deleteConfirm', { name: room.title })) && remove.mutate()}
          >
            {t('room.delete')}
          </Button>
        )}
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending || !bots.length}>
          {room ? t('common.save') : t('room.create')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A room: the conversation of the person with its bots, one speaking at a time. */
export function RoomView({ room }: { room: Room }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: bots = [] } = useBots();
  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const members = useMembers(room);
  const faceMap = useMemo(() => new Map(members.map((b) => [b.id, b])), [members]);
  const { me } = useRoomRole(room);
  const { data: everyone = [] } = usePeople();
  const { data: messages = [], isLoading } = useMessages(room.id);
  // A room started fresh opens empty: what came before its last reset shows only when asked for,
  // and hides again once the room is reset anew.
  const reset = lastResetIndex(messages);
  const [earlierOf, setEarlierOf] = useState<string | null>(null);
  const hidden = reset >= 0 && earlierOf !== messages[reset]!.id ? reset + 1 : 0;
  const current = hidden ? messages.slice(hidden) : messages;
  const stream = useUi((s) => s.streams[room.id]);
  useLiveCatchUp(room.id);
  const live = useUi((s) => s.states[room.id]);
  const state = live ?? room.state;
  const busy = state !== 'idle';
  const speaker = room.speakerId ? (botMap.get(room.speakerId) ?? faceMap.get(room.speakerId)) : undefined;
  const activity = useThreadActivity(speaker?.id ?? '', room.id, state);
  const [pending, setPending] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const shown = pending.filter((p) => !messages.some((m) => m.clientId === p.clientId));
  // A sent message stays one row, keyed by its clientId, until the server's copy replaces it.
  const all = shown.length ? [...current, ...shown] : current;
  const waiting = new Set(shown.map((m) => m.clientId));
  const streamDone = stream && messages.some((m) => m.turnId === stream.turnId && m.role === 'assistant');
  // A card asked while the reply streams in goes inside it, where it was asked.
  const { rows, parts } = useLiveCards(all, stream, !!streamDone);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, shown.length, stream?.text, busy]);
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  /**
   * Whose words a row is: a bot's id, `user` for the one signed in, `person:<id>` for someone else
   * in the room, or null for the room's own notes. A line with no person is the room's opener's.
   */
  const speakerOf = (m: Message) =>
    m.role === 'assistant' || m.role === 'approval' || (m.role === 'system' && m.author.startsWith('bot:'))
      ? m.author.slice(4)
      : m.role === 'user'
        ? m.author !== 'user' || (m.userId ?? room.ownerId ?? me) === me
          ? 'user'
          : `person:${m.userId ?? room.ownerId}`
        : null;
  const nameOf = (id: string) => {
    const p = everyone.find((x) => x.id === id);
    return p ? personName(p, t('people.owner')) : t('room.someone');
  };
  // Of the rows drawn above the streaming reply: a card placed inside it comes after its words.
  const lastSpeaker =
    [...rows]
      .reverse()
      .map(speakerOf)
      .find((s) => s !== null) ?? null;

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <RoomHeader room={room} members={members} />
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="scroll-thin flex-1 overflow-y-auto"
      >
        <CardDock.Provider value>
          <div className="mx-auto flex max-w-[860px] flex-col gap-4 px-3 pt-20 pb-6 sm:px-6">
            {hidden > 0 && (
              <Button
                variant="secondary"
                size="sm"
                className="self-center"
                onClick={() => setEarlierOf(messages[reset]!.id)}
              >
                <History /> {t('room.showEarlier')}
              </Button>
            )}
            {!isLoading && current.length === 0 && shown.length === 0 && (
              <RoomEmpty room={room} members={members} />
            )}
            {rows.map((m, i) => {
              const who = speakerOf(m);
              const before = rows
                .slice(0, i)
                .reverse()
                .map(speakerOf)
                .find((s) => s !== null);
              const person = who?.startsWith('person:') ? who.slice(7) : null;
              const bot =
                who && who !== 'user' && !person ? (botMap.get(who) ?? faceMap.get(who)) : undefined;
              // The room's own line about a meeting is drawn as the meeting's card.
              if (m.role === 'system' && m.props.meeting)
                return (
                  <Fragment key={m.id}>
                    {needsDivider(rows[i - 1], m) && (
                      <div className="py-2 text-center text-xs text-muted-foreground">
                        {dayLabel(m.createdAt)}
                      </div>
                    )}
                    <MeetingCard room={room} m={m} />
                  </Fragment>
                );
              return (
                <Fragment key={m.clientId ?? m.id}>
                  {needsDivider(rows[i - 1], m) && (
                    <div className="py-2 text-center text-xs text-muted-foreground">
                      {dayLabel(m.createdAt)}
                    </div>
                  )}
                  {who && who !== 'user' && !person && who !== before && <SpeakerLine bot={bot} />}
                  {person ? (
                    <PersonMessage m={m} name={nameOf(person)} named={who !== before} />
                  ) : (
                    <MessageItem
                      m={m}
                      bots={botMap}
                      botId={bot?.id}
                      onReply={m.role === 'assistant' ? setReplyTo : undefined}
                      pending={waiting.has(m.clientId)}
                    />
                  )}
                </Fragment>
              );
            })}
            {parts.length > 0 && (
              <>
                {speaker && speaker.id !== lastSpeaker && <SpeakerLine bot={speaker} />}
                {parts.map((p) =>
                  p.kind === 'text' ? (
                    <AssistantCard
                      key={`text-${p.from}`}
                      text={p.text}
                      turnId={p.live ? stream?.turnId : undefined}
                      streaming={p.live}
                    />
                  ) : (
                    <MessageItem key={p.card.id} m={p.card} bots={botMap} botId={speaker?.id} />
                  ),
                )}
              </>
            )}
            {/* Cards a member's work with other bots waits on, however far down the chain. */}
            <ExchangeCards threadId={room.id} bots={botMap} />
            {speaker && activity !== 'idle' && !(stream && !streamDone && stream.text) && (
              <Working bot={speaker} activity={activity} threadId={room.id} />
            )}
          </div>
        </CardDock.Provider>
      </div>
      <MinutesDialog rooms={[room]} />
      <RoomComposer
        room={room}
        members={members}
        busy={busy}
        replyTo={replyTo}
        onReplyChange={setReplyTo}
        onPending={(m) => {
          stick.current = true;
          setPending((p) => [...p, m]);
        }}
        onFailed={(clientId) => setPending((p) => p.filter((x) => x.clientId !== clientId))}
      />
    </div>
  );
}

/** Someone else's line in a room more than one person is in: on the other side, under their name. */
function PersonMessage({ m, name, named }: { m: Message; name: string; named: boolean }) {
  return (
    <div className="flex flex-col items-start gap-1" data-message-id={m.id}>
      {named && <span className="ps-3 text-xs font-semibold text-muted-foreground">{name}</span>}
      <div className="wallpaper-bubble max-w-[80%] rounded-3xl border bg-background px-4 py-2.5 text-[15px] [overflow-wrap:anywhere]">
        <Markdown text={m.text} breaks className="prose-chat leading-relaxed break-words" />
      </div>
    </div>
  );
}

function needsDivider(prev: Message | undefined, m: Message) {
  if (!prev) return true;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 60 * 60 * 1000;
}

/** The name above a bot's turn in the room, when another spoke before it. */
function SpeakerLine({ bot }: { bot?: BotFace }) {
  const t = useT();
  return (
    <div className="-mb-2 flex items-center gap-2 pt-1 text-sm">
      {bot ? (
        <BotAvatar avatar={bot.avatar} material={bot.material} color={bot.color} seed={bot.id} size={22} />
      ) : (
        <span className="size-[22px] rounded-full bg-secondary" />
      )}
      <span className="font-semibold" style={bot ? { color: bot.color } : undefined}>
        {bot?.name ?? t('room.unknownBot')}
      </span>
    </div>
  );
}

function RoomEmpty({ room, members }: { room: Room; members: BotFace[] }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 pt-[12vh] text-center">
      <RoomFace members={members} size={48} />
      <div className="text-xl font-semibold">{room.title}</div>
      {room.goal && <p className="max-w-md text-sm whitespace-pre-wrap">{room.goal}</p>}
      <p className="max-w-md text-sm text-muted-foreground">
        {room.responders === 'mentions' ? t('room.emptyHintMentions') : t('room.emptyHint')}
      </p>
    </div>
  );
}

function RoomHeader({ room, members }: { room: Room; members: BotFace[] }) {
  const t = useT();
  const showList = useUi((s) => s.showList);
  const openRoomDialog = useUi((s) => s.openRoomDialog);
  const openRoom = useUi((s) => s.openRoom);
  const qc = useQueryClient();
  const startMeeting = useStartMeeting(room.id);
  const meetingLive = room.meeting?.status === 'active';
  const { owner, manages } = useRoomRole(room);
  const [peopleOpen, setPeopleOpen] = useState(false);
  // Only whoever opened the room changes its bots: an admin put in it may not see them all.
  const openSettings = () =>
    owner ? openRoomDialog({ mode: 'edit', roomId: room.id }) : setPeopleOpen(true);
  const leave = useMutation({
    mutationFn: () => api.leaveRoom(room.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      openRoom(null);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteRoom(room.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      openRoom(null);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const reset = useMutation({
    mutationFn: () => api.resetRoom(room.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['messages', room.id] });
      void qc.invalidateQueries({ queryKey: ['rooms'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 wallpaper-fade bg-gradient-to-b from-background via-background/80 to-transparent pb-6">
      <div className="window-drag grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 pt-3 sm:px-4">
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="pointer-events-auto rounded-full roomy:hidden"
            onClick={showList}
            aria-label={t('chat.backToList')}
          >
            <ChevronLeft className="size-5 rtl:-scale-x-100" />
          </Button>
        </div>
        <button
          type="button"
          onClick={openSettings}
          className="pointer-events-auto flex max-w-full min-w-0 items-center gap-2 rounded-full border bg-background/80 py-1.5 pe-3 ps-1.5 shadow-sm backdrop-blur transition-colors hover:bg-accent"
        >
          <RoomFace members={members} size={24} />
          <span className="truncate text-sm font-semibold">{room.title}</span>
          <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline">
            · {members.map((b) => b.name).join(', ')}
          </span>
        </button>
        <div className="pointer-events-auto flex items-center justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={owner ? t('room.edit') : t('room.menu')}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="rounded-2xl">
              {owner && (
                <DropdownMenuItem onClick={() => openRoomDialog({ mode: 'edit', roomId: room.id })}>
                  <Pencil /> {t('room.edit')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setPeopleOpen(true)}>
                <Users /> {t('room.people')}
              </DropdownMenuItem>
              {!meetingLive && (
                <DropdownMenuItem disabled={startMeeting.isPending} onClick={() => startMeeting.mutate()}>
                  <NotebookPen /> {t('meeting.start')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => showMinutes(room.id)}>
                <ClipboardList /> {t('meeting.list')}
              </DropdownMenuItem>
              {manages && (
                <DropdownMenuItem
                  disabled={reset.isPending}
                  onClick={() => confirm(t('room.resetConfirm')) && reset.mutate()}
                >
                  <RotateCcw /> {t('room.reset')}
                </DropdownMenuItem>
              )}
              {!owner && (
                <DropdownMenuItem
                  disabled={leave.isPending}
                  onClick={() => confirm(t('room.leaveConfirm', { name: room.title })) && leave.mutate()}
                >
                  <LogOut /> {t('room.leave')}
                </DropdownMenuItem>
              )}
              {manages && (
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => confirm(t('room.deleteConfirm', { name: room.title })) && remove.mutate()}
                >
                  <Trash2 /> {t('room.delete')}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <RoomPeopleDialog room={room} open={peopleOpen} onOpenChange={setPeopleOpen} manages={manages} />
      <div className="mt-2 flex justify-center px-3 empty:hidden">
        <MeetingBar room={room} />
      </div>
    </div>
  );
}

/**
 * Who is in the room. Whoever manages it puts people in or takes them out, and is told when someone
 * would talk here with a bot not shared with them.
 */
function RoomPeopleDialog({
  room,
  open,
  onOpenChange,
  manages,
}: {
  room: Room;
  open: boolean;
  onOpenChange(open: boolean): void;
  manages: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { me } = useRoomRole(room);
  const { data: everyone = [] } = usePeople();
  const [adding, setAdding] = useState<string[]>([]);
  const unshared = useQuery({
    queryKey: ['room-unshared', room.id, room.members.join()],
    queryFn: () => api.roomUnshared(room.id),
    enabled: open && manages,
  });
  const change = useMutation({
    mutationFn: (c: { add?: string[]; remove?: string[] }) => api.setRoomPeople(room.id, c),
    onSuccess: (saved) => {
      qc.setQueryData<Room[]>(['rooms'], (old = []) => old.map((r) => (r.id === saved.id ? saved : r)));
      void qc.invalidateQueries({ queryKey: ['rooms'] });
      setAdding([]);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const inRoom = [...(room.ownerId ? [room.ownerId] : []), ...(room.people ?? [])];
  const nameOf = (id: string) => {
    const p = everyone.find((x) => x.id === id);
    return p ? personName(p, t('people.owner')) : t('room.someone');
  };
  const candidates = everyone.filter((p) => !p.disabled && !inRoom.includes(p.id));
  const toggle = (id: string) => setAdding((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setAdding([]);
        onOpenChange(o);
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden rounded-3xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('room.people')}</DialogTitle>
          <DialogDescription>{t('room.peopleHint')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ul className="space-y-0.5">
            {inRoom.map((id) => (
              <li key={id} className="flex min-h-9 items-center gap-3 rounded-xl px-2.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {nameOf(id)}
                  {id === me && (
                    <span className="font-normal text-muted-foreground"> · {t('room.peopleYou')}</span>
                  )}
                </span>
                {id === room.ownerId ? (
                  <span className="shrink-0 text-xs text-muted-foreground">{t('room.peopleOwner')}</span>
                ) : (
                  manages &&
                  id !== me && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8 rounded-full"
                      disabled={change.isPending}
                      onClick={() => change.mutate({ remove: [id] })}
                      aria-label={t('room.peopleRemove', { name: nameOf(id) })}
                      title={t('room.peopleRemove', { name: nameOf(id) })}
                    >
                      <X />
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
          {manages && candidates.length > 0 && (
            <Field label={t('room.peopleAdd')}>
              <div className="scroll-thin max-h-56 space-y-0.5 overflow-y-auto rounded-2xl border p-1">
                {candidates.map((p) => {
                  const on = adding.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggle(p.id)}
                      aria-pressed={on}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-start transition-colors hover:bg-accent/60',
                        on && 'bg-accent/70',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{nameOf(p.id)}</span>
                      <span
                        className={cn(
                          'flex size-5 shrink-0 items-center justify-center rounded-full border',
                          on && 'border-transparent bg-primary text-primary-foreground',
                        )}
                      >
                        {on && <Plus className="size-3" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {adding
                .filter((id) => unshared.data?.[id]?.length)
                .map((id) => (
                  <p key={id} className="text-xs text-amber-600 dark:text-amber-400">
                    {t('room.peopleUnshared', { name: nameOf(id), bots: unshared.data![id]!.join(', ') })}
                  </p>
                ))}
            </Field>
          )}
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
          {manages && candidates.length > 0 && (
            <Button
              type="button"
              className="rounded-full"
              disabled={!adding.length || change.isPending}
              onClick={() => change.mutate({ add: adding })}
            >
              {t('room.peopleAddButton')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The `@name` being typed just before the caret, if any. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@([^\s@]*)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[2]!.length - 1, query: m[2]! };
}

function RoomComposer({
  room,
  members,
  busy,
  replyTo,
  onReplyChange,
  onPending,
  onFailed,
}: {
  room: Room;
  members: BotFace[];
  busy: boolean;
  replyTo: Message | null;
  onReplyChange(m: Message | null): void;
  onPending(m: Message): void;
  onFailed(clientId: string): void;
}) {
  const t = useT();
  const intl = useLocale((s) => s.intl);
  const qc = useQueryClient();
  const { me } = useRoomRole(room);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!matchMedia(PHONE).matches) ref.current?.focus();
  }, [room.id]);
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);
  useFitHeight(ref, text);

  const mention = mentionAt(text, caret);
  const choices = mention
    ? members.filter((b) => b.name.toLocaleLowerCase(intl).startsWith(mention.query.toLocaleLowerCase(intl)))
    : [];
  const pick = (b: BotFace) => {
    if (!mention) return;
    const next = `${text.slice(0, mention.start)}@${b.name} ${text.slice(caret)}`;
    const at = mention.start + b.name.length + 2;
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(at, at);
    });
  };

  const send = useMutation({
    mutationFn: (m: { clientId: string; text: string; replyTo: Message | null }) =>
      api.sendToRoom(room.id, m.clientId, m.text, m.replyTo?.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages', room.id] }),
    onError: (e, m) => {
      onFailed(m.clientId);
      setText((now) => now || m.text);
      if (m.replyTo) onReplyChange(m.replyTo);
      toast.error((e as Error).message);
    },
  });
  const stop = useMutation({
    mutationFn: () => api.stopRoom(room.id),
    onError: (e) => toast.error((e as Error).message),
  });

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const clientId = newClientId();
    onPending({
      id: clientId,
      threadId: room.id,
      role: 'user',
      author: 'user',
      userId: me,
      text: value,
      props: replyTo ? { replyTo: { id: replyTo.id, text: replyExcerpt(replyTo) } } : {},
      clientId,
      turnId: null,
      createdAt: new Date().toISOString(),
    });
    setText('');
    onReplyChange(null);
    send.mutate({ clientId, text: value, replyTo });
  };

  return (
    <div className="px-3 pb-3 sm:px-6 sm:pb-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="relative mx-auto flex max-w-[860px] flex-col rounded-[24px] border bg-card p-1 shadow-sm focus-within:ring-2 focus-within:ring-ring/30"
      >
        {choices.length > 0 && (
          <div className="absolute inset-x-2 bottom-full mb-2 flex flex-wrap gap-1 rounded-2xl border bg-popover p-1.5 shadow-md">
            {choices.map((b) => (
              <button
                key={b.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(b)}
                aria-label={t('room.mention', { name: b.name })}
                className="flex items-center gap-1.5 rounded-xl px-2 py-1 text-sm hover:bg-accent"
              >
                <BotAvatar avatar={b.avatar} material={b.material} color={b.color} seed={b.id} size={20} />
                {b.name}
              </button>
            ))}
          </div>
        )}
        {replyTo && (
          <div className="mx-1 mt-1 flex items-center gap-2 rounded-2xl bg-secondary py-1.5 pe-1.5 ps-3 text-sm text-muted-foreground">
            <Reply className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{replyExcerpt(replyTo)}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 rounded-full"
              onClick={() => onReplyChange(null)}
              aria-label={t('chat.cancelReply')}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
        <div className="flex items-end gap-1 ps-3">
          <textarea
            dir="auto"
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCaret(e.target.selectionStart);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if ((e.key === 'Tab' || e.key === 'Enter') && choices.length && !e.shiftKey) {
                e.preventDefault();
                pick(choices[0]!);
                return;
              }
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                onReplyChange(null);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              room.responders === 'mentions' ? t('room.placeholderMentions') : t('room.placeholder')
            }
            className="scroll-thin max-h-60 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base outline-none sm:text-[15px] placeholder:text-muted-foreground"
          />
          {busy && !text.trim() ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-9 shrink-0 rounded-full"
              onClick={() => stop.mutate()}
              aria-label={t('chat.stop')}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className="size-9 shrink-0 rounded-full"
              disabled={!text.trim()}
              aria-label={t('chat.send')}
            >
              <ArrowUp className="size-5" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
