import { DESKTOP_SIZE, type Bot, type ComputerState } from '@leafbot/shared';
import { Hand, Loader2, Minimize2, Monitor, MoonStar, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useT, type MessageKey } from '@/i18n';
import { openVnc, setComputerControl, useComputers, wakeComputer, watchComputer } from '@/lib/computer';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

const ASPECT = `${DESKTOP_SIZE.width} / ${DESKTOP_SIZE.height}`;
const VIEW_RATIO = DESKTOP_SIZE.width / DESKTOP_SIZE.height;

const ASLEEP = (botId: string): ComputerState => ({ botId, status: 'off', user: false, busy: false });

/** Follows a bot's computer while the calling part of the page is shown. */
export function useDesktop(botId: string): ComputerState {
  useEffect(() => watchComputer(botId), [botId]);
  return useComputers((s) => s.states[botId]) ?? ASLEEP(botId);
}

type Phase = 'asleep' | 'starting' | 'user' | 'busy' | 'idle';

function phaseOf(s: ComputerState): Phase {
  if (s.status === 'off') return 'asleep';
  if (s.status === 'starting') return 'starting';
  if (s.user) return 'user';
  return s.busy ? 'busy' : 'idle';
}

const PHASE_TEXT: Record<Phase, MessageKey> = {
  asleep: 'computer.desktop.asleep',
  starting: 'computer.desktop.starting',
  user: 'computer.desktop.user',
  busy: 'computer.desktop.busy',
  idle: 'computer.desktop.running',
};

function PhaseDot({ phase }: { phase: Phase }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        phase === 'asleep' && 'bg-muted-foreground/40',
        phase === 'starting' && 'animate-pulse bg-muted-foreground',
        phase === 'idle' && 'bg-emerald-500',
        phase === 'busy' && 'animate-pulse bg-[var(--brand)]',
        phase === 'user' && 'bg-amber-500',
      )}
    />
  );
}

/** Dot for the header button: only when someone is using the computer. */
export function useDesktopActive(botId: string): boolean {
  return useComputers((s) => {
    const c = s.states[botId];
    return !!c && c.status === 'running' && (c.user || c.busy);
  });
}

type Link = 'connecting' | 'live' | 'lost';

/**
 * The desktop's live screen. It connects when it mounts and disconnects when it unmounts; with
 * `control` the pointer and keys go to the desktop, otherwise it is view-only. Only one of these
 * may be mounted per bot at a time, since the stream is keyed by bot.
 */
export function VncScreen({
  botId,
  control,
  compact = false,
  className,
}: {
  botId: string;
  control: boolean;
  compact?: boolean;
  className?: string;
}) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<{ viewOnly: boolean; focusOnClick: boolean; focus(): void } | null>(null);
  const controlNow = useRef(control);
  const [link, setLink] = useState<Link>('connecting');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    controlNow.current = control;
    const v = viewer.current;
    if (!v) return;
    v.viewOnly = !control;
    v.focusOnClick = control;
    if (control) v.focus();
  }, [control]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let rfb: { disconnect(): void } | null = null;
    setLink('connecting');
    // The viewer is loaded on demand: it is large and only needed once a screen is shown.
    void import('@novnc/novnc').then(({ default: RFB }) => {
      if (cancelled) return;
      const channel = openVnc(botId);
      if (!channel) return setLink('lost');
      const v = new RFB(el, channel);
      v.scaleViewport = true;
      v.resizeSession = false;
      v.background = '#000';
      v.viewOnly = !controlNow.current;
      v.focusOnClick = controlNow.current;
      v.addEventListener('connect', () => !cancelled && setLink('live'));
      v.addEventListener('disconnect', () => !cancelled && setLink('lost'));
      v.addEventListener('credentialsrequired', () => v.disconnect());
      viewer.current = v;
      rfb = v;
      if (controlNow.current) v.focus();
    });
    return () => {
      cancelled = true;
      viewer.current = null;
      rfb?.disconnect();
    };
  }, [botId, attempt]);

  return (
    <div
      className={cn('relative overflow-hidden bg-black select-none', className)}
      style={{ aspectRatio: ASPECT }}
    >
      <div ref={host} className={cn('absolute inset-0', !control && 'pointer-events-none')} />
      {link !== 'live' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-xs text-white/70">
          {link === 'connecting' ? (
            <>
              <Loader2 className="size-5 animate-spin" />
              {!compact && t('computer.desktop.connecting')}
            </>
          ) : (
            <>
              <span>{t('computer.desktop.lost')}</span>
              {!compact && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-full"
                  onClick={() => setAttempt((n) => n + 1)}
                >
                  {t('computer.desktop.reconnect')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Right panel: the bot's computer as a small live picture; click opens the large view. */
export function DesktopCard({ bot }: { bot: Bot }) {
  const t = useT();
  const open = useUi((s) => s.openComputer);
  // The large view owns the stream while it is open.
  const viewing = useUi((s) => s.computerBotId === bot.id);
  const state = useDesktop(bot.id);
  const phase = phaseOf(state);
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('computer.desktop.title')}</h4>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <PhaseDot phase={phase} />
          {t(PHASE_TEXT[phase])}
        </span>
      </div>
      <button
        onClick={() => open(bot.id)}
        className="group block w-full overflow-hidden rounded-2xl border bg-secondary/60 text-start transition-colors hover:border-foreground/20"
        aria-label={t('computer.open')}
      >
        <div className="relative w-full" style={{ aspectRatio: ASPECT }}>
          {state.status === 'running' && !viewing ? (
            <VncScreen botId={bot.id} control={false} compact className="absolute inset-0" />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
              {state.status === 'starting' ? (
                <Loader2 className="size-6 animate-spin" />
              ) : state.status === 'off' ? (
                <MoonStar className="size-6" />
              ) : (
                <Monitor className="size-6" />
              )}
              {state.status === 'off'
                ? t('computer.desktop.asleep')
                : state.status === 'starting'
                  ? t('computer.desktop.starting')
                  : null}
            </div>
          )}
        </div>
      </button>
    </section>
  );
}

/** The large view, opened from the header or the panel. */
export function DesktopDialog() {
  const botId = useUi((s) => s.computerBotId);
  const open = useUi((s) => s.openComputer);
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === botId);
  return (
    <Dialog open={!!bot} onOpenChange={(o) => !o && open(null)}>
      {bot && <DesktopView bot={bot} close={() => open(null)} />}
    </Dialog>
  );
}

function DesktopView({ bot, close }: { bot: Bot; close(): void }) {
  const t = useT();
  const state = useDesktop(bot.id);
  return (
    <DialogContent
      showCloseButton={false}
      className="screen-edges flex h-[100dvh] max-h-[100dvh] w-screen max-w-none items-center justify-center gap-0 rounded-none border-0 bg-neutral-950 p-3 text-white sm:max-w-none sm:rounded-none sm:p-6"
      // Escape and clicks belong to the desktop while the person controls it.
      onEscapeKeyDown={(e) => state.user && e.preventDefault()}
      onInteractOutside={(e) => state.user && e.preventDefault()}
    >
      <DialogTitle className="sr-only">{t('computer.titleOf', { name: bot.name })}</DialogTitle>
      <DialogDescription className="sr-only">{t(PHASE_TEXT[phaseOf(state)])}</DialogDescription>

      <Button
        variant="secondary"
        size="sm"
        className="absolute top-3 end-3 z-10 rounded-full bg-white/10 text-white hover:bg-white/20 sm:top-5 sm:end-5"
        onClick={close}
      >
        <Minimize2 /> {t('computer.desktop.collapse')}
      </Button>

      <DesktopStage bot={bot} state={state} />
    </DialogContent>
  );
}

/**
 * The desktop's screen as large as it fits, or a way to wake it, with the button that takes or
 * gives back control. The large view shows it in a dialog; the phone app shows it on a page alone.
 */
export function DesktopStage({ bot, state }: { bot: Bot; state: ComputerState }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  /** Whether this view took control, so closing it hands control back. */
  const took = useRef(false);

  useEffect(
    () => () => {
      if (took.current) void setComputerControl(bot.id, false);
    },
    [bot.id],
  );

  const wake = async () => {
    setPending(true);
    const r = await wakeComputer(bot.id);
    setPending(false);
    if (!r.ok) toast.error(r.error || t('computer.desktop.wakeFailed'));
  };

  const control = async (on: boolean) => {
    setPending(true);
    const r = await setComputerControl(bot.id, on);
    setPending(false);
    if (!r.ok) return void toast.error(r.error || t('computer.desktop.controlFailed'));
    took.current = on;
  };

  return (
    <>
      {state.status === 'running' ? (
        // As large as fits, in the desktop's own shape so pointer positions map one to one.
        <div style={{ aspectRatio: ASPECT, width: `min(100%, calc((100dvh - 6rem) * ${VIEW_RATIO}))` }}>
          <VncScreen
            botId={bot.id}
            control={state.user}
            className={cn(
              'size-full rounded-lg',
              state.user ? 'ring-2 ring-amber-500' : state.busy && 'ring-1 ring-[var(--brand)]/60',
            )}
          />
        </div>
      ) : (
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          {state.status === 'starting' ? (
            <Loader2 className="size-8 animate-spin text-white/70" />
          ) : (
            <MoonStar className="size-8 text-white/70" />
          )}
          <p className="text-sm text-white/70">
            {state.status === 'starting'
              ? t('computer.desktop.startingHint')
              : t('computer.desktop.asleepHint')}
          </p>
          {state.status === 'off' && (
            <Button className="rounded-full" disabled={pending} onClick={() => void wake()}>
              {t('computer.desktop.wake')}
            </Button>
          )}
        </div>
      )}

      {state.status === 'running' && (
        <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-neutral-900/90 py-1.5 pe-1.5 ps-4 shadow-lg backdrop-blur sm:bottom-6">
          {state.user ? (
            <>
              <span className="flex items-center gap-2 text-sm">
                <PhaseDot phase="user" />
                {t('computer.desktop.inControl')}
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                disabled={pending}
                onClick={() => void control(false)}
              >
                <Square /> {t('computer.desktop.stop')}
              </Button>
            </>
          ) : (
            <>
              {state.busy && (
                <span className="flex items-center gap-2 text-sm text-white/70">
                  <PhaseDot phase="busy" />
                  {t('computer.desktop.busy')}
                </span>
              )}
              <Button
                size="sm"
                className="rounded-full"
                disabled={pending}
                onClick={() => void control(true)}
              >
                <Hand /> {t('computer.desktop.take')}
              </Button>
            </>
          )}
        </div>
      )}
    </>
  );
}
