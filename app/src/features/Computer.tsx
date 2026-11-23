import type { Bot, BrowserInput, BrowserState, BrowserStatus } from '@leafbot/shared';
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  Hand,
  Loader2,
  Maximize2,
  Monitor,
  PictureInPicture2,
  RotateCw,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { sendBrowserInput, setBrowserControl, useBrowsers, watchBrowser, type Screen } from '@/lib/browser';
import { TeachTask } from './TeachTask';
import {
  clampFloat,
  defaultFloat,
  loadFloat,
  resizeFloat,
  saveFloat,
  VIEW_RATIO,
  type FloatBox,
} from '@/lib/floatBox';
import { PHONE, useMedia } from '@/lib/media';
import { useBots, useInfo } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { DesktopCard, DesktopDialog, useDesktopActive } from './RemoteDesktop';
import { cn } from '@/lib/utils';

/** The browser's own size; the view keeps this shape at any screen width. */
const ASPECT = '1280 / 800';

const STATUS: Record<BrowserStatus, MessageKey> = {
  off: 'computer.status.off',
  idle: 'computer.status.idle',
  bot: 'computer.status.bot',
  user: 'computer.status.user',
  window: 'computer.status.window',
};

const OFF = (botId: string): BrowserState => ({ botId, status: 'off', url: null, title: null, tabs: 0 });

function useComputer(botId: string) {
  useEffect(() => watchBrowser(botId), [botId]);
  const state = useBrowsers((s) => s.states[botId]) ?? OFF(botId);
  const screen = useBrowsers((s) => s.screens[botId]);
  return { state, screen };
}

/** Bots have their own desktop (a computer service); otherwise they share the server's browser. */
export function useDesktopAvailable() {
  const { data } = useInfo();
  return data?.computer.status === 'ok';
}

export function useBrowserAvailable() {
  const { data } = useInfo();
  return data?.computer.status === 'ok' || data?.browser.status === 'ok';
}

function StatusDot({ status, className }: { status: BrowserStatus; className?: string }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'off' && 'bg-muted-foreground/40',
        status === 'idle' && 'bg-emerald-500',
        status === 'bot' && 'animate-pulse bg-[var(--brand)]',
        (status === 'user' || status === 'window') && 'bg-amber-500',
        className,
      )}
    />
  );
}

/** Header button: opens the bot's computer; a dot shows when someone is using it. */
export function ComputerButton({ bot }: { bot: Bot }) {
  const t = useT();
  const open = useUi((s) => s.openComputer);
  const status = useBrowsers((s) => s.states[bot.id]?.status) ?? 'off';
  const desktop = useDesktopAvailable();
  const desktopActive = useDesktopActive(bot.id);
  if (!useBrowserAvailable()) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative rounded-full"
          onClick={() => open(bot.id)}
          aria-label={t('computer.browserOpen')}
        >
          <Monitor className="size-5" />
          {desktop
            ? desktopActive && (
                <StatusDot status="bot" className="absolute top-1.5 end-1.5 ring-2 ring-background" />
              )
            : status !== 'off' &&
              status !== 'idle' && (
                <StatusDot status={status} className="absolute top-1.5 end-1.5 ring-2 ring-background" />
              )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t('computer.browserTitle')}</TooltipContent>
    </Tooltip>
  );
}

/** Right panel: the bot's computer when it has one, else a small live picture of its browser. */
export function ComputerCard({ bot }: { bot: Bot }) {
  return useDesktopAvailable() ? <DesktopCard bot={bot} /> : <BrowserCard bot={bot} />;
}

function BrowserCard({ bot }: { bot: Bot }) {
  const t = useT();
  const open = useUi((s) => s.openComputer);
  const { state, screen } = useComputer(bot.id);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('computer.browserTitle')}</h4>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <StatusDot status={state.status} />
          {t(STATUS[state.status])}
        </span>
      </div>
      <button
        onClick={() => open(bot.id)}
        className="group block w-full overflow-hidden rounded-2xl border bg-secondary/60 text-start transition-colors hover:border-foreground/20"
        aria-label={t('computer.browserOpen')}
      >
        <div className="relative w-full" style={{ aspectRatio: ASPECT }}>
          {screen ? (
            <img
              src={screen.url}
              alt=""
              className="absolute inset-0 size-full object-cover"
              draggable={false}
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
              <Monitor className="size-6" />
              {state.status === 'off' ? t('computer.offHint') : t('computer.waiting')}
            </div>
          )}
        </div>
        {state.url && (
          <div className="truncate border-t px-3 py-2 text-xs text-muted-foreground">
            {state.title ? `${state.title} · ` : ''}
            {state.url}
          </div>
        )}
      </button>
    </section>
  );
}

/** The bot's computer, opened from the header or the panel. */
export function ComputerDialog() {
  return useDesktopAvailable() ? <DesktopDialog /> : <BrowserWindow />;
}

/**
 * The bot's browser, either large over everything or in a small window that leaves the chat
 * usable. A phone always gets the large view: there is no room beside the chat.
 */
function BrowserWindow() {
  const botId = useUi((s) => s.computerBotId);
  const open = useUi((s) => s.openComputer);
  const float = useUi((s) => s.computerFloat);
  const phone = useMedia(PHONE);
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === botId);
  const shownId = bot?.id;
  const compact = isCompact(useBrowsers((s) => (shownId ? s.states[shownId]?.status : undefined) ?? 'off'));

  // Closing the browser, or switching it to another bot, hands control back so the bot is never
  // left waiting by mistake. Switching between the two sizes keeps it.
  useEffect(() => {
    if (!shownId) return;
    return () => void setBrowserControl(shownId, false);
  }, [shownId]);

  if (bot && float && !phone) return <FloatingBrowser bot={bot} />;
  return (
    <Dialog open={!!bot} onOpenChange={(o) => !o && open(null)}>
      <DialogContent
        className={cn(
          'flex flex-col gap-3',
          // With no picture to show, only what to do next, the dialog is a small card.
          compact
            ? 'rounded-3xl p-5'
            : 'screen-edges h-[100dvh] max-h-[100dvh] w-full max-w-full rounded-none p-3 sm:h-auto sm:max-h-[94vh] sm:max-w-[min(1320px,96vw)] sm:rounded-3xl sm:p-5',
        )}
      >
        {bot && <ComputerView bot={bot} />}
      </DialogContent>
    </Dialog>
  );
}

function useBrowserControl(bot: Bot) {
  const t = useT();
  const { state, screen } = useComputer(bot.id);
  const control = state.status === 'user';
  const [busy, setBusy] = useState(false);
  const send = useCallback((input: BrowserInput) => sendBrowserInput(bot.id, input), [bot.id]);
  const toggle = async () => {
    setBusy(true);
    const r = await setBrowserControl(bot.id, !control);
    setBusy(false);
    if (!r.ok) toast.error(r.error || t('computer.failed'));
  };
  return { state, screen, control, busy, send, toggle };
}

/** Whether the bot's browser can open as an ordinary window on the person's computer. */
function useWindowAvailable() {
  const { data } = useInfo();
  return data?.browser.window === true;
}

/** Opens the bot's browser as a window of its own, at the page it shows now. */
function useOpenWindow(state: BrowserState) {
  const t = useT();
  const available = useWindowAvailable();
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      await api.openBrowserWindow(state.botId, state.url ?? undefined);
    } catch (err) {
      toast.error((err as Error).message || t('computer.failed'));
    } finally {
      setBusy(false);
    }
  };
  return { available, busy, open };
}

function OpenWindowButton({ state }: { state: BrowserState }) {
  const t = useT();
  const { available, busy, open } = useOpenWindow(state);
  if (!available) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          onClick={() => void open()}
          disabled={busy || state.status === 'window'}
          variant="secondary"
          className="shrink-0 rounded-full max-sm:w-full"
        >
          {busy ? <Loader2 className="animate-spin" /> : <AppWindow />} {t('computer.openWindow')}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{t('computer.openWindowHint')}</TooltipContent>
    </Tooltip>
  );
}

/** Closes the browser's own window so the bot can go on with the same sign-ins. */
function useCloseWindow(botId: string) {
  const t = useT();
  const [closing, setClosing] = useState(false);
  const close = async () => {
    setClosing(true);
    try {
      await api.closeBrowserWindow(botId);
    } catch (err) {
      toast.error((err as Error).message || t('computer.failed'));
    } finally {
      setClosing(false);
    }
  };
  return { closing, close };
}

function WindowDoneButton({ botId, className }: { botId: string; className?: string }) {
  const t = useT();
  const { closing, close } = useCloseWindow(botId);
  return (
    <Button onClick={() => void close()} disabled={closing} className={cn('rounded-full', className)}>
      {closing && <Loader2 className="animate-spin" />}
      {closing ? t('computer.windowClosing') : t('computer.windowDone')}
    </Button>
  );
}

/** In place of the picture in the small window while the browser is open in its own window. */
function WindowNote({ botId }: { botId: string }) {
  const t = useT();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-secondary px-6 text-center text-sm">
      <AppWindow className="size-8 text-muted-foreground" />
      <p className="max-w-md text-muted-foreground">{t('computer.windowNote')}</p>
      <WindowDoneButton botId={botId} />
    </div>
  );
}

/** Whether there is no picture of the browser to show, only what to do: off, or in its own window. */
function isCompact(status: BrowserStatus) {
  return status === 'off' || status === 'window';
}

/** The dialog as a small card: what state the browser is in and the actions that fit it. */
function CompactView({
  bot,
  state,
  hint,
  children,
}: {
  bot: Bot;
  state: BrowserState;
  hint: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <>
      <div className="flex items-start gap-3 pe-8">
        <StatusDot status={state.status} className="mt-2" />
        <div className="min-w-0">
          <DialogTitle className="text-base">{t('computer.browserTitleOf', { name: bot.name })}</DialogTitle>
          <DialogDescription className="mt-1 text-sm">
            {t(STATUS[state.status])} · {hint}
          </DialogDescription>
        </div>
      </div>
      {/* Reversed so the dialog focuses the main action, put first, rather than a button with a tooltip. */}
      <div className="flex flex-row-reverse flex-wrap justify-start gap-2">{children}</div>
    </>
  );
}

function ComputerView({ bot }: { bot: Bot }) {
  const t = useT();
  const floatComputer = useUi((s) => s.floatComputer);
  const { state, screen, control, busy, send, toggle } = useBrowserControl(bot);
  /** What the person is typing in the address bar; null shows the page's own address. */
  const [draft, setDraft] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const go = (e: FormEvent) => {
    e.preventDefault();
    const url = draft?.trim();
    setDraft(null);
    if (url) send({ type: 'open', url });
  };

  const type = (e: FormEvent) => {
    e.preventDefault();
    if (typed) send({ type: 'text', text: typed });
    setTyped('');
  };

  // Nothing to watch or steer yet: the address bar and the empty picture would only take room.
  // Taking control starts the browser, e.g. to sign in to a site before the bot needs it.
  if (state.status === 'off')
    return (
      <CompactView bot={bot} state={state} hint={t('computer.offHint')}>
        <Button onClick={() => void toggle()} disabled={busy} className="shrink-0 rounded-full max-sm:w-full">
          {busy ? <Loader2 className="animate-spin" /> : <Hand />} {t('computer.take')}
        </Button>
        <OpenWindowButton state={state} />
      </CompactView>
    );
  // The browser is on the person's screen in a window of its own; here is only how to give it back.
  if (state.status === 'window')
    return (
      <CompactView bot={bot} state={state} hint={t('computer.windowNote')}>
        <WindowDoneButton botId={bot.id} className="shrink-0 max-sm:w-full" />
      </CompactView>
    );

  return (
    <>
      <div className="flex items-center gap-3 pe-8">
        <StatusDot status={state.status} />
        <div className="min-w-0">
          <DialogTitle className="truncate text-base">
            {t('computer.browserTitleOf', { name: bot.name })}
          </DialogTitle>
          <DialogDescription className="truncate text-xs">
            {t(STATUS[state.status])} · {control ? t('computer.controlHint') : t('computer.watchHint')}
          </DialogDescription>
        </div>
        {/* A title, not a tooltip: the dialog focuses this button first, and a tooltip would open with it. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="ms-auto shrink-0 rounded-full phone:hidden"
          onClick={() => floatComputer(true)}
          aria-label={t('computer.float')}
          title={t('computer.float')}
        >
          <PictureInPicture2 />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <NavButton
          label={t('computer.back')}
          disabled={!control}
          onClick={() => send({ type: 'nav', action: 'back' })}
        >
          <ArrowLeft className="rtl:-scale-x-100" />
        </NavButton>
        <NavButton
          label={t('computer.forward')}
          disabled={!control}
          onClick={() => send({ type: 'nav', action: 'forward' })}
        >
          <ArrowRight className="rtl:-scale-x-100" />
        </NavButton>
        <NavButton
          label={t('computer.reload')}
          disabled={!control}
          onClick={() => send({ type: 'nav', action: 'reload' })}
        >
          <RotateCw />
        </NavButton>
        <form onSubmit={go} className="min-w-40 flex-1">
          <Input
            value={draft ?? state.url ?? ''}
            readOnly={!control}
            onBlur={() => setDraft(null)}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('computer.address')}
            aria-label={t('computer.address')}
            className="h-9 rounded-full bg-secondary/60 text-sm"
          />
        </form>
        {!control && <OpenWindowButton state={state} />}
        <Button
          onClick={() => void toggle()}
          disabled={busy}
          variant={control ? 'secondary' : 'default'}
          className="shrink-0 rounded-full max-sm:w-full"
        >
          <Hand /> {control ? t('computer.release') : t('computer.take')}
        </Button>
      </div>

      <TeachTask bot={bot} />

      <RemoteScreen screen={screen} state={state} control={control} send={send} />

      {control && (
        <form onSubmit={type} className="flex items-center gap-2">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={t('computer.typePlaceholder')}
            className="h-9 flex-1 rounded-full text-sm"
          />
          <Button type="submit" variant="secondary" className="rounded-full">
            {t('computer.typeSend')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            onClick={() => {
              send({ type: 'key', action: 'down', key: 'Enter' });
              send({ type: 'key', action: 'up', key: 'Enter' });
            }}
          >
            <CornerDownLeft /> {t('computer.enter')}
          </Button>
        </form>
      )}
    </>
  );
}

/**
 * The browser in a small window over the chat, moved by its title bar and resized from its bottom
 * left corner. It is not modal: the chat stays usable, and it takes the keyboard only while the
 * person controls the browser and has clicked into the picture.
 */
function FloatingBrowser({ bot }: { bot: Bot }) {
  const t = useT();
  const open = useUi((s) => s.openComputer);
  const floatComputer = useUi((s) => s.floatComputer);
  const { state, screen, control, busy, send, toggle } = useBrowserControl(bot);
  const win = useOpenWindow(state);
  const [box, setBox] = useState<FloatBox>(() =>
    clampFloat(loadFloat() ?? defaultFloat(innerWidth, innerHeight), innerWidth, innerHeight),
  );
  const drag = useRef<{ mode: 'move' | 'resize'; x: number; y: number; start: FloatBox } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const fit = () => setBox((b) => clampFloat(b, innerWidth, innerHeight));
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    if (!dragging) saveFloat(box);
  }, [box, dragging]);

  const begin = (mode: 'move' | 'resize', e: ReactPointerEvent<HTMLElement>) => {
    // A button in the title bar is clicked, not dragged.
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, start: box };
    setDragging(true);
  };
  const follow = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    setBox(
      d.mode === 'move'
        ? clampFloat(
            { ...d.start, x: d.start.x + dx, y: d.start.y + e.clientY - d.y },
            innerWidth,
            innerHeight,
          )
        : resizeFloat(d.start, dx, innerWidth, innerHeight),
    );
  };
  const end = () => {
    drag.current = null;
    setDragging(false);
  };

  return (
    <section
      role="dialog"
      aria-label={t('computer.browserTitleOf', { name: bot.name })}
      className={cn(
        'fixed z-40 flex flex-col overflow-hidden rounded-2xl border bg-background shadow-2xl',
        dragging && 'select-none',
      )}
      style={{ left: box.x, top: box.y, width: box.width }}
    >
      <header
        onPointerDown={(e) => begin('move', e)}
        onPointerMove={follow}
        onPointerUp={end}
        onPointerCancel={end}
        className={cn(
          'flex h-11 shrink-0 touch-none items-center gap-1 border-b pe-1.5 ps-3 select-none',
          dragging ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <StatusDot status={state.status} />
        <span className="ms-1 min-w-0 flex-1 truncate text-sm font-medium" title={state.url ?? undefined}>
          {bot.name}
          {state.title && <span className="font-normal text-muted-foreground"> · {state.title}</span>}
        </span>
        {control && (
          <>
            <IconAction label={t('computer.back')} onClick={() => send({ type: 'nav', action: 'back' })}>
              <ArrowLeft className="rtl:-scale-x-100" />
            </IconAction>
            <IconAction
              label={t('computer.forward')}
              onClick={() => send({ type: 'nav', action: 'forward' })}
            >
              <ArrowRight className="rtl:-scale-x-100" />
            </IconAction>
            <IconAction label={t('computer.reload')} onClick={() => send({ type: 'nav', action: 'reload' })}>
              <RotateCw />
            </IconAction>
          </>
        )}
        <IconAction
          label={control ? t('computer.release') : t('computer.take')}
          onClick={() => void toggle()}
          disabled={busy || state.status === 'off' || state.status === 'window'}
          active={control}
        >
          <Hand />
        </IconAction>
        {win.available && !control && (
          <IconAction
            label={t('computer.openWindow')}
            onClick={() => void win.open()}
            disabled={win.busy || state.status === 'window'}
          >
            <AppWindow />
          </IconAction>
        )}
        <IconAction label={t('computer.expand')} onClick={() => floatComputer(false)}>
          <Maximize2 />
        </IconAction>
        <IconAction label={t('common.close')} onClick={() => open(null)}>
          <X />
        </IconAction>
      </header>
      <RemoteScreen screen={screen} state={state} control={control} send={send} fill />
      <div
        onPointerDown={(e) => begin('resize', e)}
        onPointerMove={follow}
        onPointerUp={end}
        onPointerCancel={end}
        title={t('computer.resize')}
        className="absolute bottom-0 start-0 z-10 size-5 cursor-nesw-resize touch-none"
      />
    </section>
  );
}

function IconAction(props: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={props.active ? 'secondary' : 'ghost'}
          size="icon-sm"
          className={cn('shrink-0 rounded-full', props.active && 'text-amber-600 dark:text-amber-400')}
          disabled={props.disabled}
          onClick={props.onClick}
          aria-label={props.label}
          aria-pressed={props.active}
        >
          {props.children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function NavButton(props: { label: string; disabled: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9 shrink-0 rounded-full"
      disabled={props.disabled}
      onClick={props.onClick}
      aria-label={props.label}
    >
      {props.children}
    </Button>
  );
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/**
 * The live picture. With control, pointer, wheel and keys go to the browser; on a touch screen a
 * tap clicks and a drag scrolls.
 */
function RemoteScreen({
  screen,
  state,
  control,
  send,
  fill = false,
}: {
  screen: Screen | undefined;
  state: BrowserState;
  control: boolean;
  send(input: BrowserInput): void;
  /** Fills its container's width, as in the small window, instead of sizing to the screen. */
  fill?: boolean;
}) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const touch = useRef<{ x: number; y: number; lastY: number; moved: boolean } | null>(null);

  const point = (clientX: number, clientY: number) => {
    const r = box.current!.getBoundingClientRect();
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x: clamp((clientX - r.left) / r.width), y: clamp((clientY - r.top) / r.height) };
  };

  // React's wheel listener is passive; this one may stop the dialog from scrolling instead.
  useEffect(() => {
    const el = box.current;
    if (!el || !control) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send({ type: 'wheel', ...point(e.clientX, e.clientY), dx: e.deltaX, dy: e.deltaY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [control, send]);

  useEffect(() => {
    if (control) box.current?.focus();
  }, [control]);

  /** Mouse moves are sent at most once per frame. */
  const move = (p: { x: number; y: number }) => {
    const first = !pending.current;
    pending.current = p;
    if (!first) return;
    requestAnimationFrame(() => {
      if (pending.current) send({ type: 'mouse', action: 'move', ...pending.current });
      pending.current = null;
    });
  };

  return (
    <div
      ref={box}
      tabIndex={control ? 0 : -1}
      className={cn(
        'relative mx-auto shrink-0 overflow-hidden rounded-2xl border bg-secondary/60 outline-none select-none',
        fill && 'rounded-none border-0',
        control && (fill ? 'ring-2 ring-amber-500 ring-inset' : 'ring-2 ring-amber-500'),
        control && 'touch-none',
      )}
      // Exactly the browser's shape, as large as fits: pointer positions then map one to one.
      style={{
        aspectRatio: ASPECT,
        width: fill ? '100%' : `min(100%, calc((100dvh - 15rem) * ${VIEW_RATIO}))`,
      }}
      onContextMenu={(e) => control && e.preventDefault()}
      onPointerDown={(e) => {
        if (!control) return;
        e.preventDefault();
        box.current?.focus();
        const p = point(e.clientX, e.clientY);
        if (e.pointerType === 'touch') {
          touch.current = { x: e.clientX, y: e.clientY, lastY: e.clientY, moved: false };
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        send({ type: 'mouse', action: 'down', ...p, button: BUTTONS[e.button] ?? 'left' });
      }}
      onPointerMove={(e) => {
        if (!control) return;
        const tc = touch.current;
        if (e.pointerType === 'touch' && tc) {
          if (Math.hypot(e.clientX - tc.x, e.clientY - tc.y) > 8) tc.moved = true;
          if (tc.moved) {
            send({ type: 'wheel', ...point(e.clientX, e.clientY), dx: 0, dy: (tc.lastY - e.clientY) * 2 });
            tc.lastY = e.clientY;
          }
          return;
        }
        move(point(e.clientX, e.clientY));
      }}
      onPointerUp={(e) => {
        if (!control) return;
        const p = point(e.clientX, e.clientY);
        if (e.pointerType === 'touch') {
          if (touch.current && !touch.current.moved) {
            send({ type: 'mouse', action: 'down', ...p, button: 'left' });
            send({ type: 'mouse', action: 'up', ...p, button: 'left' });
          }
          touch.current = null;
          return;
        }
        send({ type: 'mouse', action: 'up', ...p, button: BUTTONS[e.button] ?? 'left' });
      }}
      onKeyDown={(e) => {
        if (!control || e.key === 'Dead' || e.key === 'Unidentified' || e.key === 'Process') return;
        // Paste arrives as a paste event with the text.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
        e.preventDefault();
        send({ type: 'key', action: 'down', key: e.key });
      }}
      onKeyUp={(e) => {
        if (!control || [...e.key].length === 1) return;
        e.preventDefault();
        send({ type: 'key', action: 'up', key: e.key });
      }}
      onPaste={(e) => {
        if (!control) return;
        const text = e.clipboardData.getData('text');
        if (text) send({ type: 'text', text: text.slice(0, 5000) });
        e.preventDefault();
      }}
    >
      {state.status === 'window' ? (
        <WindowNote botId={state.botId} />
      ) : screen ? (
        <img
          src={screen.url}
          alt={state.title ?? ''}
          className="pointer-events-none absolute inset-0 size-full object-contain"
          draggable={false}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
          <Monitor className="size-8" />
          {state.status === 'off' ? t('computer.offHint') : t('computer.waiting')}
        </div>
      )}
    </div>
  );
}
