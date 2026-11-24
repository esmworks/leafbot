import type { Bot, BotSummary, Group } from '@leafbot/shared';
import {
  Blocks,
  CalendarCheck,
  KanbanSquare,
  Plus,
  Search,
  Settings2,
  Pause,
  ShieldCheck,
  X,
  BellOff,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { BotDragProvider, useBotDrag, useDragItem, useSectionOver } from '@/features/botDrag';
import { RoomRail, RoomsSection } from '@/features/Rooms';
import { BotMenu, GroupMenu, SidebarMenu } from '@/features/SidebarMenus';
import { isRtl } from '@leafbot/shared';
import { useLocale, useT } from '@/i18n';
import { botState, useBotActivity } from '@/lib/botActivity';
import { PINNED, UNGROUPED, type SectionKey } from '@/lib/botLayout';
import { initials, useFormat } from '@/lib/format';
import { useBots, useGroups, useRooms, useSettings, useSummaries } from '@/lib/queries';
import { useLayout } from '@/lib/layout';
import { isMuted, useNotify } from '@/lib/notify';
import { botShortcut, botStep, sidebarOrder } from '@/lib/botOrder';
import { SIDEBAR, useUi } from '@/lib/store';
import { useDensity } from '@/lib/density';
import { isUnread, useSeen } from '@/lib/unread';
import { usePaused } from '@/lib/paused';
import { cn } from '@/lib/utils';

export function Sidebar() {
  const { data: bots = [] } = useBots();
  const [query, setQuery] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const { phone, sidebar: width } = useLayout();
  const chosen = useUi((s) => s.sidebarWidth);
  const rail = width <= SIDEBAR.rail && !phone;
  // Moving is off while a search hides part of the list.
  return (
    <BotDragProvider enabled={rail || !query} scroller={scroller}>
      <SidebarPanel
        bots={bots}
        query={rail ? '' : query}
        setQuery={setQuery}
        scroller={scroller}
        width={width}
        rail={rail}
        // Folded for want of room, dragging could not widen it; it opens again as the window grows.
        resizable={!phone && (chosen <= SIDEBAR.rail || width > SIDEBAR.rail)}
        phone={phone}
      />
    </BotDragProvider>
  );
}

function SidebarPanel({
  bots,
  query,
  setQuery,
  scroller,
  width,
  rail,
  resizable,
  phone,
}: {
  bots: Bot[];
  query: string;
  setQuery(q: string): void;
  scroller: React.RefObject<HTMLDivElement | null>;
  /** The width it takes, after giving way to the chat in a narrow window. */
  width: number;
  rail: boolean;
  resizable: boolean;
  /** On a phone the list fills the screen and keeps no width of its own. */
  phone: boolean;
}) {
  const t = useT();
  const intl = useLocale((s) => s.intl);
  const { data: groups = [] } = useGroups();
  const { data: summaries = [] } = useSummaries();
  const { data: settings } = useSettings();
  const [searching, setSearching] = useState(false);
  const openBotPage = useUi((s) => s.openBotPage);
  const openSettings = useUi((s) => s.openSettings);
  const openApps = useUi((s) => s.openApps);
  const connected = useUi((s) => s.connected);
  // While a bot is dragged, empty sections show up so it can be dropped into them.
  const dragging = !!useBotDrag().drag;

  const byBot = useMemo(() => new Map(summaries.map((s) => [s.botId, s])), [summaries]);
  const visible = bots.filter(
    (b) => !query || b.name.toLocaleLowerCase(intl).includes(query.toLocaleLowerCase(intl)),
  );
  // Bots waiting on the person come first, in their own section, until they are answered.
  const needsYou = visible.filter((b) => byBot.get(b.id)?.waiting);
  const waitingIds = new Set(needsYou.map((b) => b.id));
  const pinned = visible.filter((b) => b.pinned && !waitingIds.has(b.id));
  const sections: { key: SectionKey; group: Group | null; bots: Bot[] }[] = [
    ...groups.map((g) => ({
      key: g.id,
      group: g,
      bots: visible.filter((b) => !b.pinned && b.groupId === g.id && !waitingIds.has(b.id)),
    })),
    {
      key: UNGROUPED,
      group: null,
      bots: visible.filter((b) => !b.pinned && !b.groupId && !waitingIds.has(b.id)),
    },
    // A group stays in view while empty, so it can be found to drag bots into; not while searching.
  ].filter((s) => s.bots.length || dragging || (s.group && !query));
  const userName = settings?.userName || t('sidebar.defaultUser');
  // ⌘1…⌘9 / Ctrl+1…Ctrl+9 opens the bot at that place in the list.
  const order = sidebarOrder(
    bots,
    groups,
    new Set(bots.filter((b) => byBot.get(b.id)?.waiting).map((b) => b.id)),
  );
  const orderRef = useRef(order);
  useEffect(() => {
    orderRef.current = order;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const list = orderRef.current;
      const step = botStep(e);
      const current = list.findIndex((b) => b.id === useUi.getState().botId);
      const at =
        step === null ? botShortcut(e) : list.length ? (current + step + list.length) % list.length : null;
      const target = at === null ? undefined : list[at];
      if (!target) return;
      e.preventDefault();
      useUi.getState().selectBot(target.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (rail) {
    return (
      <aside
        className="safe-pane relative flex h-full shrink-0 flex-col wallpaper-glass bg-sidebar shadow-[inset_-1px_0_0_var(--color-border)]"
        style={{ width }}
      >
        {/* Room for the window buttons; empty in a browser. */}
        <div className="window-drag h-12 shrink-0" />
        <div
          ref={scroller}
          // No scrollbar in a column this narrow; the faded edge tells that the list goes on.
          className="scroll-fade-end flex [scrollbar-width:none] flex-1 flex-col items-center overflow-x-hidden overflow-y-auto pb-4"
        >
          {(pinned.length > 0 || dragging) && (
            <SectionBox section={PINNED} className="flex flex-col items-center gap-1 p-0.5">
              {pinned.map((b) => (
                <RailItem key={b.id} bot={b} summary={byBot.get(b.id)} />
              ))}
              {!pinned.length && <RailHint label={t('sidebar.dropToPin')} />}
            </SectionBox>
          )}
          {sections.map(({ key, group, bots: list }, i) => (
            <div key={key} className="flex flex-col items-center">
              {(i > 0 || pinned.length > 0 || dragging) && <div className="my-2 h-px w-10 bg-border" />}
              <SectionBox section={key} className="flex flex-col items-center gap-1 p-0.5">
                {list.map((b) => (
                  <RailItem key={b.id} bot={b} summary={byBot.get(b.id)} />
                ))}
                {!list.length && <RailHint label={group?.name ?? t('sidebar.ungrouped')} />}
              </SectionBox>
            </div>
          ))}
          <RoomRail />
        </div>
        {/* The line marks where the list scrolls under, so a half-hidden icon reads as more list.
            The same buttons as the wide sidebar's footer, so folding it hides nothing; two to a row,
            so they take half the height a single column would and leave the bots most of it. */}
        <div className="grid grid-cols-2 place-items-center gap-1 border-t px-1.5 py-2.5">
          <RoundButton
            label={t('sidebar.newBot')}
            onClick={() => openBotPage({ mode: 'create' })}
            variant="ghost"
            side="right"
          >
            <Plus />
          </RoundButton>
          <RoundButton
            label={t('today.title')}
            onClick={() => useUi.getState().setTodayOpen(true)}
            variant="ghost"
            side="right"
          >
            <CalendarCheck />
          </RoundButton>
          <RoundButton
            label={t('board.title')}
            onClick={() => useUi.getState().setBoardOpen(true)}
            variant="ghost"
            side="right"
          >
            <KanbanSquare />
          </RoundButton>
          <RoundButton
            label={t('apps.open')}
            onClick={() => openApps({ botId: null })}
            variant="ghost"
            side="right"
          >
            <Blocks />
          </RoundButton>
          <RoundButton
            label={t('settings.title')}
            onClick={() => openSettings('general', true)}
            variant="ghost"
            side="right"
          >
            <Settings2 />
          </RoundButton>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => openSettings('profile')}
                aria-label={t('profile.open')}
                className="relative flex size-9 items-center justify-center rounded-full bg-secondary text-sm font-semibold transition-colors hover:bg-accent"
              >
                {initials(userName, intl)}
                <span
                  className={cn(
                    'absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar',
                    connected ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {userName} · {connected ? t('sidebar.connected') : t('sidebar.connecting')}
            </TooltipContent>
          </Tooltip>
        </div>
        {resizable && <ResizeHandle width={width} />}
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        'safe-pane relative flex h-full shrink-0 flex-col wallpaper-glass bg-sidebar',
        // A line drawn inside, since the border holds the clear room the screen edges need.
        phone ? 'w-full' : 'shadow-[inset_-1px_0_0_var(--color-border)]',
      )}
      style={phone ? undefined : { width }}
    >
      <div className="window-drag flex items-center gap-2 px-4 pt-1 pb-1 frameless:ps-[88px] phone:pt-2">
        {searching ? (
          <div className="relative flex-1">
            <Search className="absolute top-1/2 start-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), setSearching(false))}
              placeholder={t('sidebar.searchPlaceholder')}
              className="h-10 w-full rounded-full bg-secondary pe-10 ps-10 text-base outline-none md:text-sm placeholder:text-muted-foreground"
            />
            <button
              className="absolute top-1/2 end-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => (setQuery(''), setSearching(false))}
              aria-label={t('sidebar.closeSearch')}
            >
              <X className="size-4" />
            </button>
          </div>
        ) : (
          <>
            {phone ? (
              <h1 className="flex-1 ps-1 text-xl font-semibold">Leaf Bot</h1>
            ) : (
              <div className="flex-1" />
            )}
            <RoundButton label={t('sidebar.search')} onClick={() => setSearching(true)}>
              <Search />
            </RoundButton>
            <RoundButton label={t('sidebar.newBot')} onClick={() => openBotPage({ mode: 'create' })}>
              <Plus />
            </RoundButton>
          </>
        )}
      </div>

      <SidebarMenu>
        <div ref={scroller} className="scroll-thin flex-1 overflow-y-auto px-2 pb-4">
          {query.trim().length >= 2 && (
            <button
              type="button"
              onClick={() => useUi.getState().openSearch(true, query.trim())}
              className="mx-1 mb-2 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-xl px-3 py-2 text-start text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
            >
              <Search className="size-4 shrink-0" />
              <span className="truncate">{t('search.inMessages', { query: query.trim() })}</span>
              <kbd className="ms-auto shrink-0 rounded border px-1 text-[10px]">{SEARCH_KEYS}</kbd>
            </button>
          )}
          {needsYou.length > 0 && (
            <section className="mb-1" aria-label={t('sidebar.needsYou')}>
              <h3 className={cn(heading, 'flex items-center gap-2')}>
                {t('sidebar.needsYou')}
                <span className="rounded-full bg-amber-500 px-1.5 text-[10px] leading-4 font-bold text-black">
                  {needsYou.length}
                </span>
              </h3>
              {needsYou.map((b) => (
                <BotRow key={b.id} bot={b} summary={byBot.get(b.id)} />
              ))}
            </section>
          )}
          {(pinned.length > 0 || dragging) && (
            <SectionBox section={PINNED} className="py-1">
              {pinned.length ? (
                // Fixed-width columns that collapse when unused: a lone tile sits in the middle,
                // a full row spans the width and the next row starts from the left.
                <div className="grid grid-cols-[repeat(auto-fit,6rem)] justify-center gap-1 px-2">
                  {pinned.map((b) => (
                    <PinnedTile key={b.id} bot={b} summary={byBot.get(b.id)} />
                  ))}
                </div>
              ) : (
                <DropHint>{t('sidebar.dropToPin')}</DropHint>
              )}
            </SectionBox>
          )}
          {sections.map(({ key, group, bots: list }, i) => (
            <SectionBox key={key} section={key} className="mt-1">
              {group ? (
                <GroupMenu
                  group={group}
                  prevId={sections[i - 1]?.group?.id ?? null}
                  nextId={sections[i + 1]?.group?.id ?? null}
                >
                  <h3 className={heading}>{group.name}</h3>
                </GroupMenu>
              ) : (
                groups.length > 0 && <h3 className={heading}>{t('sidebar.ungrouped')}</h3>
              )}
              {list.map((b) => (
                <BotRow key={b.id} bot={b} summary={byBot.get(b.id)} />
              ))}
              {!list.length && <DropHint>{t(dragging ? 'sidebar.dropHere' : 'sidebar.emptyGroup')}</DropHint>}
            </SectionBox>
          ))}
          <RoomsSection query={query} />
          {bots.length === 0 && (
            <div className="mx-2 mt-6 flex flex-col items-center gap-3 rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              {t('sidebar.noBots')}
              <Button
                variant="secondary"
                className="rounded-full"
                onClick={() => openBotPage({ mode: 'create' })}
              >
                <Plus /> {t('sidebar.createFirst')}
              </Button>
            </div>
          )}
        </div>
      </SidebarMenu>

      {/* Too narrow for the name beside the four buttons, the avatar stands alone and carries the
          connection dot, as in the rail. */}
      <div className="@container flex items-center gap-1 border-t px-2 py-2 @xs:gap-2">
        <button
          type="button"
          onClick={() => openSettings('profile')}
          title={`${userName} · ${connected ? t('sidebar.connected') : t('sidebar.connecting')}`}
          aria-label={t('profile.open')}
          className="me-auto flex min-w-0 items-center gap-3 rounded-2xl p-0.5 text-start transition-colors hover:bg-accent @xs:me-0 @xs:flex-1 @xs:px-2 @xs:py-1.5"
        >
          <span className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold">
            {initials(userName, intl)}
            <span
              className={cn(
                'absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar @xs:hidden',
                connected ? 'bg-emerald-500' : 'bg-amber-500',
              )}
            />
          </span>
          <span className="hidden min-w-0 flex-1 @xs:block">
            <span className="block truncate text-sm font-medium">{userName}</span>
            <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  connected ? 'bg-emerald-500' : 'bg-amber-500',
                )}
              />
              <span className="truncate">{connected ? t('sidebar.connected') : t('sidebar.connecting')}</span>
            </span>
          </span>
        </button>
        <RoundButton
          label={t('today.title')}
          variant="ghost"
          onClick={() => useUi.getState().setTodayOpen(true)}
        >
          <CalendarCheck />
        </RoundButton>
        <RoundButton
          label={t('board.title')}
          variant="ghost"
          onClick={() => useUi.getState().setBoardOpen(true)}
        >
          <KanbanSquare />
        </RoundButton>
        <RoundButton label={t('apps.open')} variant="ghost" onClick={() => openApps({ botId: null })}>
          <Blocks />
        </RoundButton>
        <RoundButton label={t('settings.title')} onClick={() => openSettings('general', true)}>
          <Settings2 />
        </RoundButton>
      </div>
      {resizable && <ResizeHandle width={width} />}
    </aside>
  );
}

/** The search's shortcut as this computer's keyboard writes it. */
const SEARCH_KEYS = /mac|iphone|ipad/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

const heading = 'px-4 pt-3 pb-1 text-[13px] font-semibold tracking-wide text-muted-foreground uppercase';

/** Highlights a bot while its menu is open. */
const menuOpen = 'data-[state=open]:[&>button]:bg-accent/60';

/** A sidebar section as a drop area; lit while a bot hovers its empty part. */
function SectionBox({
  section,
  className,
  children,
}: {
  section: SectionKey;
  className?: string;
  children: React.ReactNode;
}) {
  const over = useSectionOver(section);
  return (
    <div
      data-section={section}
      className={cn('rounded-2xl transition-colors', over && 'bg-accent/50', className)}
    >
      {children}
    </div>
  );
}

function DropHint({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-2 my-1 rounded-xl border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
      {children}
    </div>
  );
}

function RailHint({ label }: { label: string }) {
  return <div title={label} aria-label={label} className="size-14 rounded-2xl border border-dashed" />;
}

/**
 * The sidebar's right edge. Dragging sets the width between the limits; dragging
 * far enough left folds it into the rail. Double-click restores the default width.
 */
function ResizeHandle({ width }: { width: number }) {
  const t = useT();
  const resize = useUi((s) => s.resizeSidebar);
  const rtl = useLocale((s) => isRtl(s.locale));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const startX = e.clientX;
    el.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // The panel sits at the end side, so dragging left widens it in a right-to-left language.
    const move = (ev: PointerEvent) => resize(width + (rtl ? startX - ev.clientX : ev.clientX - startX));
    const end = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', end);
      el.removeEventListener('pointercancel', end);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
    if (!step) return;
    e.preventDefault();
    // Arrow keys move across the gap between the rail and the narrowest width too.
    if (width <= SIDEBAR.rail) return step > 0 && resize(SIDEBAR.min);
    if (width <= SIDEBAR.min && step < 0) return resize(SIDEBAR.rail);
    resize(width + step);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t('sidebar.resize')}
      aria-valuenow={width}
      aria-valuemin={SIDEBAR.rail}
      aria-valuemax={SIDEBAR.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resize(SIDEBAR.default)}
      onKeyDown={onKeyDown}
      className="absolute inset-y-0 -end-1.5 z-20 w-3 cursor-col-resize outline-none [-webkit-app-region:no-drag] after:absolute after:inset-y-0 after:start-1/2 after:w-px after:bg-ring after:opacity-0 after:transition-opacity hover:after:opacity-60 focus-visible:after:opacity-100 active:after:opacity-100"
    />
  );
}

function RoundButton({
  label,
  onClick,
  children,
  variant = 'secondary',
  side,
}: {
  label: string;
  onClick(): void;
  children: React.ReactNode;
  variant?: 'secondary' | 'ghost';
  side?: 'right';
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={variant}
          size="icon"
          className="size-10 rounded-full [&_svg:not([class*='size-'])]:size-5"
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}

function StateDot({ summary }: { summary?: BotSummary }) {
  const t = useT();
  const live = useUi((s) => (summary?.threadId ? s.states[summary.threadId] : undefined));
  const state = botState(live, summary?.state);
  if (summary?.pendingApprovals) {
    return (
      <span className="absolute -end-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-black ring-2 ring-sidebar">
        {summary.pendingApprovals}
      </span>
    );
  }
  if (state === 'idle') {
    if (!summary?.failedRoutine) return null;
    const label = t('sidebar.routineFailed', { name: summary.failedRoutine });
    // Servers older than the field send no ids; the mark then only tells.
    const routineId = summary.failedRoutines?.[0];
    // The mark sits on the bot's button: a click opens the failed routine instead of only the chat.
    const open = (e: React.SyntheticEvent) => {
      if (!routineId) return;
      e.stopPropagation();
      useUi.getState().openRoutine({ botId: summary.botId, routineId, showRuns: true });
    };
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        onClick={open}
        onPointerDown={(e) => routineId && e.stopPropagation()}
        className={cn(
          'absolute -end-0.5 -bottom-0.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-bold text-white ring-2 ring-sidebar',
          routineId && 'cursor-pointer',
        )}
      >
        !
      </span>
    );
  }
  return (
    <span className="absolute -end-0.5 -bottom-0.5 size-3 rounded-full bg-emerald-500 ring-2 ring-sidebar">
      <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/60" />
    </span>
  );
}

/** A dot for a bot that wrote since the person last looked at its chat on this device. */
function UnreadDot({ summary, className }: { summary?: BotSummary; className?: string }) {
  const t = useT();
  const unread = useSeen((s) => !!summary && isUnread(summary, s.seen));
  if (!unread) return null;
  return (
    <span
      role="img"
      aria-label={t('sidebar.unread')}
      className={cn('block size-2.5 shrink-0 rounded-full bg-sky-500', className)}
    />
  );
}

/**
 * A manager's shield and the live state, drawn on the avatar. A list row writes the unread dot beside the name, so it
 * leaves it off the avatar; a small avatar gets smaller marks so they do not cover its face.
 */
function Badges({
  bot,
  summary,
  unread = true,
  small = false,
}: {
  bot: Bot;
  summary?: BotSummary;
  unread?: boolean;
  small?: boolean;
}) {
  return (
    <>
      {unread && <UnreadDot summary={summary} className="absolute -top-0.5 -start-0.5 ring-2 ring-sidebar" />}
      {bot.isManager && (
        <span
          className={cn(
            'absolute -top-1 -end-1 flex items-center justify-center rounded-full bg-background ring-1 ring-border',
            small ? 'size-4' : 'size-5',
          )}
        >
          <ShieldCheck className={small ? 'size-2.5' : 'size-3'} style={{ color: bot.color }} />
        </span>
      )}
      <StateDot summary={summary} />
      <PausedBadge bot={bot} small={small} />
    </>
  );
}

/** A pause mark on a bot that starts no work now, itself or with its group. */
function PausedBadge({ bot, small = false }: { bot: Bot; small?: boolean }) {
  const t = useT();
  const { paused } = usePaused(bot);
  if (!paused) return null;
  return (
    <span
      role="img"
      aria-label={t('pause.badge')}
      title={t('pause.badge')}
      className={cn(
        'absolute -bottom-1 -start-1 flex items-center justify-center rounded-full bg-background ring-1 ring-border',
        small ? 'size-4' : 'size-5',
      )}
    >
      <Pause className={cn('fill-current text-muted-foreground', small ? 'size-2.5' : 'size-3')} />
    </span>
  );
}

/** A bot in the folded sidebar: the avatar alone, the name in a tooltip. */
function RailItem({ bot, summary }: { bot: Bot; summary?: BotSummary }) {
  const activity = useBotActivity(bot.id, summary);
  const selected = useUi((s) => s.botId === bot.id && !s.roomId);
  const select = useUi((s) => s.openChat);
  const d = useDragItem(bot, 'y');
  return (
    <BotMenu bot={bot}>
      <div {...d.item} className={cn('relative', menuOpen, d.dragging && 'opacity-40')}>
        {d.indicator}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => select(bot.id)}
              onPointerDown={d.onGrab}
              aria-label={bot.name}
              className={cn(
                'flex size-14 shrink-0 items-center justify-center rounded-2xl transition-colors hover:bg-accent/60',
                selected && 'bg-accent',
              )}
            >
              <BotAvatar
                avatar={bot.avatar}
                material={bot.material}
                color={bot.color}
                seed={bot.id}
                size={42}
                activity={activity}
                motion={selected ? 'always' : 'hover'}
                badge={<Badges bot={bot} summary={summary} />}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{bot.name}</TooltipContent>
        </Tooltip>
      </div>
    </BotMenu>
  );
}

/** A pinned bot at the top of the sidebar: a large avatar with the name below. */
function PinnedTile({ bot, summary }: { bot: Bot; summary?: BotSummary }) {
  const activity = useBotActivity(bot.id, summary);
  const selected = useUi((s) => s.botId === bot.id && !s.roomId);
  const select = useUi((s) => s.openChat);
  const d = useDragItem(bot, 'x');
  return (
    <BotMenu bot={bot}>
      <div {...d.item} className={cn('relative', menuOpen, d.dragging && 'opacity-40')}>
        {d.indicator}
        <button
          onClick={() => select(bot.id)}
          onPointerDown={d.onGrab}
          title={bot.name}
          className={cn(
            'flex w-24 flex-col items-center rounded-2xl px-1.5 pt-2 pb-1.5 transition-colors select-none hover:bg-accent/60',
            selected && 'bg-accent',
          )}
        >
          <BotAvatar
            avatar={bot.avatar}
            material={bot.material}
            color={bot.color}
            seed={bot.id}
            size={68}
            activity={activity}
            motion={selected ? 'always' : 'hover'}
            badge={<Badges bot={bot} summary={summary} />}
          />
          <span className="-mt-1 w-full truncate text-center text-sm font-medium">{bot.name}</span>
        </button>
      </div>
    </BotMenu>
  );
}

function BotRow({ bot, summary }: { bot: Bot; summary?: BotSummary }) {
  const activity = useBotActivity(bot.id, summary);
  const { data: rooms } = useRooms();
  const t = useT();
  const { shortTime } = useFormat();
  const selected = useUi((s) => s.botId === bot.id && !s.roomId);
  const select = useUi((s) => s.openChat);
  const selectThread = useUi((s) => s.selectThread);
  const muted = useNotify((s) => isMuted(s.mutes, bot.id));
  const unread = useSeen((s) => !!summary && isUnread(summary, s.seen));
  const compact = useDensity((s) => s.density === 'compact');
  const d = useDragItem(bot, 'y');
  return (
    <BotMenu bot={bot}>
      <div {...d.item} className={cn('relative', menuOpen, d.dragging && 'opacity-40')}>
        {d.indicator}
        <button
          onClick={() => {
            const waitsIn = summary?.waiting?.threadId;
            // A card waiting in a room is answered there.
            if (waitsIn && rooms?.some((r) => r.id === waitsIn)) return useUi.getState().openRoom(waitsIn);
            select(bot.id);
            // Straight to the conversation where the card waits.
            if (waitsIn) selectThread(waitsIn);
          }}
          onPointerDown={d.onGrab}
          className={cn(
            'flex w-full items-center gap-3 rounded-2xl px-3 text-start transition-colors select-none hover:bg-accent/60',
            compact ? 'py-1' : 'py-1.5',
            selected && 'bg-accent',
          )}
        >
          <span className="shrink-0">
            <BotAvatar
              avatar={bot.avatar}
              material={bot.material}
              color={bot.color}
              seed={bot.id}
              size={compact ? 26 : 38}
              activity={activity}
              motion={selected ? 'always' : 'hover'}
              badge={<Badges bot={bot} summary={summary} unread={false} small />}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-[15px] leading-5 font-semibold">{bot.name}</span>
              {muted && (
                <BellOff
                  className="size-3.5 shrink-0 self-center text-muted-foreground"
                  aria-label={t('sidebar.muted')}
                />
              )}
              {summary?.previewAt && (
                <span
                  className={cn(
                    'ms-auto shrink-0 text-[13px] text-muted-foreground',
                    unread && 'font-semibold text-foreground',
                  )}
                >
                  {shortTime(summary.previewAt)}
                </span>
              )}
              {compact && <UnreadDot summary={summary} className="self-center" />}
            </div>
            {compact ? null : summary?.waiting ? (
              <div className="truncate text-sm leading-5" title={summary.waiting.summary}>
                <span className="font-medium text-amber-600 dark:text-amber-400">
                  {t(`sidebar.waitingFor.${summary.waiting.kind}`)}
                </span>{' '}
                <span className="text-muted-foreground">{summary.waiting.summary}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm leading-5 text-muted-foreground',
                    unread && 'font-medium text-foreground',
                  )}
                >
                  {summary?.preview || bot.description || t('sidebar.noMessages')}
                </div>
                <UnreadDot summary={summary} />
              </div>
            )}
          </div>
        </button>
      </div>
    </BotMenu>
  );
}
