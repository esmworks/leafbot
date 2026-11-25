import {
  FLOW_LAYOUT_MAX,
  FLOW_NOTES_MAX,
  INTL_LOCALE,
  ROUTINE_STEP_MAX,
  stepRoutes,
  type FlowLayout,
  type FlowNote,
  type RoutineRun,
} from '@leafbot/shared';
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  Loader2,
  MapIcon,
  Maximize2,
  Minimize2,
  Minus,
  MoreHorizontal,
  Network,
  Play,
  Plus,
  Scan,
  ScrollText,
  Settings2,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLocale, useT, type MessageKey } from '@/i18n';
import {
  BOX_W,
  boxesReach,
  canvasSize,
  fitZoom,
  insertStep,
  jumpLink,
  keepLayout,
  link,
  moveStep,
  PORT_Y,
  placeBoxes,
  removeStep,
  runAsStep,
  runPart,
  scrollAfterZoom,
  snap,
  takenWays,
  zoomBy,
  ZOOM_MAX,
  ZOOM_MIN,
  type RunPart,
  type Spot,
} from '@/lib/routineFlow';
import { useBots } from '@/lib/queries';
import { cn } from '@/lib/utils';
import {
  ApprovalAnswer,
  EndWait,
  NEW_STEP,
  STEP_KINDS,
  StepFields,
  StepIcon,
  stepText,
  type StepForm,
} from './RoutineSteps';
import { FlowNoteCard, NOTE_MAP_FILL } from './FlowNoteCard';
import { LongText } from './LongText';
import { markVars } from './RoutineInputs';
import { Tag } from './SettingsList';

/** The width the canvas is laid out for before it is measured (and where nothing is, in tests). */
const FALLBACK_WIDTH = 1100;
/** How far an arrow key moves a box. */
const NUDGE = 16;
/** The overview's size, and how tall it draws a box. */
const MAP_W = 180;
const MAP_H = 112;
const MAP_BOX_H = 120;

/** What the window over the canvas shows when it is the routine's settings rather than a box. */
const SETTINGS = '__settings';

/** Each kind of box's mark, tinted so the kinds tell apart at a glance across a long routine. */
const TINT: Record<StepForm['kind'] | 'start' | 'prompt', string> = {
  start: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  prompt: 'bg-secondary text-foreground',
  agent: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  approval: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  wait: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  notify: 'bg-teal-500/15 text-teal-600 dark:text-teal-400',
  fetch: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  extract: 'bg-pink-500/15 text-pink-600 dark:text-pink-400',
};

/** Scrolls a view to `to`, in screen pixels. */
function scrollView(el: HTMLElement | null, to: { left: number; top: number }) {
  if (!el) return;
  el.scrollLeft = to.left;
  el.scrollTop = to.top;
}

/** A button of the bar over the canvas's corner that sets how it is viewed. */
function BarButton({
  label,
  icon,
  onClick,
  pressed,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick(): void;
  pressed?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 rounded-full"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={label}
      title={label}
    >
      {icon}
    </Button>
  );
}

/**
 * The routine drawn as boxes on a canvas: what starts it, its own instruction and each step, joined
 * by lines in the order they run. A box says what its part does in a few lines; clicked, its fields
 * open in a window over the canvas, where there is room to write, and the canvas stays as it is. A box is placed by dragging its
 * title (or with the arrow keys), and the order changes from its menu or with Alt and an arrow
 * key. While a run goes, each box shows how its part of the latest run went. Runs still go one
 * step after another, along the lines, as the server runs them.
 */
export function RoutineFlow({
  triggers,
  schedule,
  scheduleSummary,
  when,
  run,
  onRunNow,
  runBlocked,
  onTry,
  prompt,
  onPrompt,
  promptError,
  steps,
  onSteps,
  errors,
  modelListId,
  modelPlaceholder,
  botId,
  layout,
  onLayout,
  notes = [],
  onNotes,
  inputNames = [],
  fullScreenBar,
  promptExtra,
  settings,
  settingsAtStart = false,
}: {
  /** What else starts the routine, besides its schedule. */
  triggers: string[];
  /** The schedule's fields, edited in the first box's window. */
  schedule: ReactNode;
  /** How often it runs, in words, shown on the first box. */
  scheduleSummary?: string;
  /** When it runs next, as the first box says it. */
  when: string;
  /** The routine's latest run, if any. */
  run?: RoutineRun | null;
  onRunNow?(): void;
  /** Why it cannot be run now (changes not saved), when it cannot. */
  runBlocked?: string;
  /** Tries an instruction without doing anything; `step` for a step's own, tried on its own. */
  onTry?(prompt: string, step: boolean): void;
  prompt: string;
  onPrompt(next: string): void;
  promptError?: string;
  steps: StepForm[];
  onSteps(next: StepForm[]): void;
  errors?: (string | undefined)[];
  modelListId: string;
  modelPlaceholder: string;
  /** The routine's own bot; a step another bot does is named after that bot. */
  botId?: string;
  layout: FlowLayout | null;
  onLayout(next: FlowLayout): void;
  /** The notes written on the canvas, for people only; without `onNotes` none can be added. */
  notes?: FlowNote[];
  onNotes?(next: FlowNote[]): void;
  /** The names of the routine's inputs, shown on the first box. */
  inputNames?: string[];
  /** What the bar over a canvas covering the window shows besides its own button (title, save). */
  fullScreenBar?: ReactNode;
  /** Shown in the instruction's box under it, such as the apps it names that are not connected. */
  promptExtra?: ReactNode;
  /**
   * What else starts the routine and how it runs, beyond the boxes: opened over the canvas from the
   * first box or the canvas's corner, so the whole routine is set from the flow.
   */
  settings?: ReactNode;
  /** Opens with the settings showing, as for a routine opened to see its latest runs. */
  settingsAtStart?: boolean;
}) {
  const t = useT();
  const bots = useBots();
  const locale = useLocale((s) => s.locale);
  const full = steps.length >= ROUTINE_STEP_MAX;
  const ids = ['start', 'prompt', ...steps.map((s) => s.id)];

  // Boxes without a place of their own fill the canvas's width, so it is measured.
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  /** The arrow at a jump's end, by an id of this view's own. */
  const arrow = useId();
  /** The part of the canvas in view, in screen pixels, for the overview. */
  const [port, setPort] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const syncPort = () => {
    const el = scroller.current;
    if (el)
      setPort({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth || FALLBACK_WIDTH);
      setPort({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The canvas can cover the whole window, for a long routine.
  const [fullScreen, setFullScreen] = useState(false);

  /**
   * How large the canvas is drawn. Only the view changes: boxes keep their places, and those
   * without one are still laid out for the canvas's own width, so zooming does not move them.
   */
  const [zoom, setZoom] = useState(1);
  const zoomNow = useRef(1);
  /** Where the view scrolls once drawn at a new size, so the place being looked at stays put. */
  const scrollTo = useRef<{ left: number; top: number } | null>(null);
  const [showMap, setShowMap] = useState(false);
  /** Draws the canvas at `next`, scrolled to `to` (in screen pixels at that size). */
  const zoomTo = (next: number, to: { left: number; top: number }) => {
    const el = scroller.current;
    if (next === zoomNow.current) {
      scrollView(el, to);
      return;
    }
    scrollTo.current = to;
    zoomNow.current = next;
    setZoom(next);
  };
  /** Zooms to `next` around a point of the view (its middle when none is given). */
  const zoomAround = (next: number, at?: { x: number; y: number }) => {
    const el = scroller.current;
    if (!el) return zoomTo(next, { left: 0, top: 0 });
    const x = at?.x ?? el.clientWidth / 2;
    const y = at?.y ?? el.clientHeight / 2;
    const from = zoomNow.current;
    zoomTo(next, {
      left: scrollAfterZoom(el.scrollLeft, x, from, next),
      top: scrollAfterZoom(el.scrollTop, y, from, next),
    });
  };
  useLayoutEffect(() => {
    const to = scrollTo.current;
    scrollTo.current = null;
    if (to) scrollView(scroller.current, to);
    syncPort();
  }, [zoom]);
  // Pinching a trackpad, or the wheel with Ctrl or Cmd held, zooms around the pointer; the wheel
  // alone scrolls as ever. Listened for directly: a listener React adds cannot stop the page zooming.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      if ((e.target as HTMLElement).closest('textarea, input, [role="menu"], [role="listbox"]')) return;
      e.preventDefault();
      const from = zoomNow.current;
      // At most one press's worth per turn of the wheel, so a fast flick does not leap.
      const by = Math.min(1.2, Math.max(1 / 1.2, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002))));
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, from * by));
      const r = el.getBoundingClientRect();
      zoomAround(next, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // zoomAround reads only refs and the view, so the first one serves for good.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * What the window over the canvas shows: a box's fields by the box's id, the routine's settings,
   * or nothing. A step is kept by its id, so moving it keeps it open and removing it closes it.
   */
  const [side, setSide] = useState<string | null>(settingsAtStart ? SETTINGS : null);
  const shown = side === SETTINGS || (side !== null && ids.includes(side)) ? side : null;
  const settingsOpen = shown === SETTINGS;

  // Escape brings the canvas back from covering the window; not while it closes a box's window, a
  // menu or a list open over the canvas.
  useEffect(() => {
    if (!fullScreen || shown) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('[data-radix-popper-content-wrapper]')) return;
      setFullScreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreen, shown]);

  // The box being dragged, where it is now; the others keep their places meanwhile.
  const [moving, setMoving] = useState<{ id: string; spot: Spot } | null>(null);
  const spots = placeBoxes(ids, layout, width);
  if (moving) spots[moving.id] = moving.spot;
  // A note's far corner, as a box's place, so the canvas and fitting reach it too.
  const noteEnds = notes.map((n) => ({ x: n.x + n.w - BOX_W, y: n.y + n.h }));
  const size = canvasSize([...Object.values(spots), ...noteEnds]);

  // The box held, where the pointer took hold of it and where it is now.
  const grab = useRef<{ id: string; sx: number; sy: number; from: Spot; at: Spot } | null>(null);
  /** The box just dragged: the click that ends the drag places it rather than opening it. */
  const dragged = useRef<string | null>(null);
  const movingId = moving?.id ?? null;
  const order = ids.join('\n');
  useEffect(() => {
    if (!movingId) return;
    const now = order.split('\n');
    const over = (e: PointerEvent) => {
      const g = grab.current;
      if (!g) return;
      const z = zoomNow.current;
      g.at = { x: snap(g.from.x + (e.clientX - g.sx) / z), y: snap(g.from.y + (e.clientY - g.sy) / z) };
      setMoving({ id: g.id, spot: g.at });
    };
    const end = () => {
      const g = grab.current;
      grab.current = null;
      setMoving(null);
      if (!g || (g.at.x === g.from.x && g.at.y === g.from.y)) return;
      dragged.current = g.id;
      // Once a box is moved, every box keeps the place it has, so none jumps when the canvas changes size.
      onLayout(keepLayout({ ...placeBoxes(now, layout, width), [g.id]: g.at }, now));
    };
    window.addEventListener('pointermove', over);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('pointermove', over);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [movingId, order, layout, width, onLayout]);

  const place = (id: string, spot: Spot) => onLayout(keepLayout({ ...spots, [id]: spot }, ids));
  // A new step opens at once: an empty box would otherwise wait for a second click.
  const add = (gap: number, kind: StepForm['kind']) => {
    const step = NEW_STEP[kind]();
    onSteps([...insertStep(steps, gap, step)]);
    setSide(step.id);
  };
  const move = (i: number, by: -1 | 1) => onSteps([...moveStep(steps, i, i + by)]);
  const remove = (i: number) => onSteps([...removeStep(steps, i)]);
  const open = (id: string) => {
    if (dragged.current === id) {
      dragged.current = null;
      return;
    }
    setSide(id);
  };

  /** How the latest run went at a box; the first box has no part of its own. */
  const partOf = (id: string): RunPart | undefined =>
    id === 'start' ? undefined : runPart(run, id === 'prompt' ? null : id);
  /** The lines the latest run went along, drawn in the brand's color. */
  const taken = takenWays(steps, partOf);
  /** The ways that jump ahead or go back, each with the box it leaves and the one it goes to. */
  const jumps = stepRoutes(steps).flatMap((r) => {
    const from = steps[r.from]!.id;
    return spots[r.to] && r.to !== from ? [{ from, to: r.to, field: r.field }] : [];
  });

  const grabBox = (id: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a, [role="menuitem"]')) return;
    e.preventDefault();
    const from = spots[id]!;
    grab.current = { id, sx: e.clientX, sy: e.clientY, from, at: from };
    setMoving({ id, spot: from });
  };

  const keys = (id: string, i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const step = i >= 0;
    const earlier = e.key === 'ArrowUp' || e.key === 'ArrowLeft';
    const later = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    if (e.altKey && step && (earlier || later)) {
      e.preventDefault();
      move(i, earlier ? -1 : 1);
    } else if (!e.altKey && (earlier || later)) {
      e.preventDefault();
      const s = spots[id]!;
      const dx = e.key === 'ArrowLeft' ? -NUDGE : e.key === 'ArrowRight' ? NUDGE : 0;
      const dy = e.key === 'ArrowUp' ? -NUDGE : e.key === 'ArrowDown' ? NUDGE : 0;
      place(id, { x: snap(s.x + dx), y: snap(s.y + dy) });
    } else if (step && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      remove(i);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setSide(id);
    }
  };

  const addMenu = (gap: number, at: Spot) =>
    !full &&
    !moving && (
      <div key={`add-${gap}`} className="absolute" style={{ left: at.x - 12, top: at.y - 12 }}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="size-6 rounded-full bg-background"
              aria-label={t('flow.addStep')}
            >
              <Plus className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            {STEP_KINDS.map((kind) => (
              <DropdownMenuItem key={kind} onSelect={() => add(gap, kind)}>
                <StepIcon kind={kind} />
                {t(`routine.step.${kind}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );

  const statusChip = (status: RunPart['status']) => (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[11px] font-normal',
        status === 'running' && 'text-[var(--brand)]',
        status === 'done' && 'text-emerald-600 dark:text-emerald-400',
        (status === 'error' || status === 'stopped') && 'text-destructive',
        status === 'waiting' && 'text-amber-600 dark:text-amber-400',
      )}
    >
      {status === 'running' ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <span
          className={cn(
            'size-1.5 rounded-full bg-current',
            (status === 'pending' || status === 'skipped') && 'opacity-40',
          )}
          aria-hidden
        />
      )}
      {t(`routine.stepStatus.${status}`)}
    </span>
  );

  /** What a box's part of the run ended with, or what it waits for. */
  const statusBody = (s: RunPart | undefined) => {
    if (!s || !run) return null;
    if (s.status === 'error' || s.status === 'stopped')
      return s.reason ? <p className="text-xs break-words text-destructive">{s.reason}</p> : null;
    if (s.status === 'waiting')
      return (
        <div className="space-y-1 text-xs text-muted-foreground">
          {s.waitUntil && (
            <p>
              {t('routine.waitUntil', {
                at: new Date(s.waitUntil).toLocaleString(INTL_LOCALE[locale], {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          )}
          {s.approvalId && <ApprovalAnswer approvalId={s.approvalId} routineId={run.routineId} />}
          {s.kind === 'wait' && <EndWait run={run} />}
        </div>
      );
    if (s.status === 'done' && (s.output || s.reason))
      return (
        <div className="rounded-xl bg-secondary/60 px-2.5 py-1.5">
          <div className="text-[11px] text-muted-foreground">{t('flow.result')}</div>
          <p className="line-clamp-4 text-xs break-words whitespace-pre-wrap">{s.output ?? s.reason}</p>
        </div>
      );
    return null;
  };

  const tryButton = (text: string, step: boolean) =>
    onTry && (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 rounded-full px-2 text-xs text-muted-foreground"
        disabled={!text.trim()}
        onClick={() => {
          // The trial shows under the canvas, so the box's window and a canvas covering the window
          // make way for it.
          setSide(null);
          setFullScreen(false);
          onTry(text, step);
        }}
      >
        <FlaskConical className="size-3.5" /> {t('flow.try')}
      </Button>
    );

  const box = (o: {
    id: string;
    index: number;
    kind: keyof typeof TINT;
    icon: ReactNode;
    title: string;
    status?: RunPart['status'];
    /** What is wrong with it, said on the box so a save that is turned away shows where. */
    error?: string;
    menu?: ReactNode;
    /** What it does, a few lines at most; empty, `placeholder` stands in muted. */
    summary: string;
    placeholder: string;
    /** A second line under the summary. */
    note?: string;
    tags?: ReactNode;
    /** Under the summary and outside its button: what the run shows or waits for, and actions. */
    below?: ReactNode;
  }) => {
    const s = spots[o.id]!;
    const selected = shown === o.id;
    // Blank lines between a text's parts would spend the box's few lines on nothing.
    const summary = o.summary.trim().replace(/\n\s*\n+/g, '\n');
    return (
      <section
        key={o.id}
        aria-label={o.title}
        style={{ left: s.x, top: s.y, width: BOX_W }}
        className={cn(
          'absolute rounded-2xl border bg-card shadow-xs transition-shadow',
          moving?.id === o.id && 'z-10 shadow-lg',
          selected && 'border-ring ring-2 ring-ring/30',
          o.status === 'running' && 'border-[var(--brand)] ring-2 ring-[var(--brand)]/25',
          o.error && 'border-destructive',
        )}
      >
        {o.id !== 'start' && (
          <span
            className="absolute -start-1.5 size-3 rounded-full border bg-background"
            style={{ top: PORT_Y - 6 }}
            aria-hidden
          />
        )}
        <span
          className="absolute -end-1.5 size-3 rounded-full border bg-background"
          style={{ top: PORT_Y - 6 }}
          aria-hidden
        />
        <div
          tabIndex={0}
          title={t('flow.drag')}
          aria-label={`${o.title}. ${t('flow.drag')}`}
          onPointerDown={grabBox(o.id)}
          onKeyDown={keys(o.id, o.index)}
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('button, [role="menuitem"]')) open(o.id);
          }}
          className={cn(
            'flex h-11 touch-none items-center gap-2.5 rounded-t-2xl ps-2 pe-3 text-sm font-medium select-none',
            'cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring',
            moving?.id === o.id && 'cursor-grabbing',
          )}
        >
          <span
            className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg', TINT[o.kind])}
            aria-hidden
          >
            {o.icon}
          </span>
          <span className="min-w-0 flex-1 truncate">{o.title}</span>
          {o.status && statusChip(o.status)}
          {o.menu}
        </div>
        <button
          type="button"
          onClick={() => open(o.id)}
          aria-label={`${o.title}. ${t('flow.openStep')}`}
          aria-expanded={selected}
          className={cn(
            'block w-full px-3 pt-0.5 pb-3 text-start outline-none transition-colors',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            !o.below && 'rounded-b-2xl',
          )}
        >
          <span
            dir="auto"
            className={cn(
              'line-clamp-3 text-[13px] leading-5 [overflow-wrap:anywhere] whitespace-pre-line',
              !summary && 'text-muted-foreground',
            )}
          >
            {summary ? markVars(summary) : o.placeholder}
          </span>
          {o.note && <span className="mt-1 block truncate text-xs text-muted-foreground">{o.note}</span>}
          {o.tags && <span className="mt-2 flex flex-wrap gap-1">{o.tags}</span>}
          {o.error && <span className="mt-2 block text-xs text-destructive">{t(o.error as MessageKey)}</span>}
        </button>
        {o.below && <div className="space-y-2 border-t px-3 py-2.5">{o.below}</div>}
      </section>
    );
  };

  const stepMenu = (i: number) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="-me-1.5 size-7 rounded-full"
          aria-label={t('flow.options')}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={i === 0} onSelect={() => move(i, -1)}>
          <ArrowUp /> {t('routine.stepUp')}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={i === steps.length - 1} onSelect={() => move(i, 1)}>
          <ArrowDown /> {t('routine.stepDown')}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={() => remove(i)}>
          <Trash2 /> {t('routine.stepRemove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  /** A step's name: its kind, or the bot that does it. */
  const stepTitle = (s: StepForm) =>
    s.kind === 'agent' && s.bot
      ? t('routine.stepByBot', {
          bot: bots.data?.find((b) => b.id === s.bot)?.name ?? t('routine.stepBotLost'),
        })
      : t(`routine.step.${s.kind}`);

  /** The few facts about a step worth seeing without opening it. */
  const stepTags = (s: StepForm) => {
    const tags = [
      s.when ? t('flow.tagWhen') : null,
      s.kind === 'agent' && s.model.trim() ? s.model.trim() : null,
      s.kind === 'notify' && s.withBefore ? t('flow.tagWithBefore') : null,
      s.kind === 'approval' || (s.kind === 'wait' && s.on !== 'time')
        ? t('flow.tagDays', { count: s.timeoutDays })
        : null,
    ].filter((x): x is string => !!x);
    return tags.length ? tags.map((x) => <Tag key={x}>{x}</Tag>) : undefined;
  };

  const promptStatus = partOf('prompt');
  const last = spots[ids[ids.length - 1]!]!;

  // What the window shows for the box open in it.
  const panelStep = steps.findIndex((x) => x.id === shown);
  const openStep = panelStep >= 0 ? steps[panelStep]! : null;
  const panelKind: keyof typeof TINT | null =
    shown === 'start' ? 'start' : shown === 'prompt' ? 'prompt' : openStep ? openStep.kind : null;
  const panelIcon =
    shown === 'start' ? (
      <Play className="size-4" />
    ) : shown === 'prompt' ? (
      <ScrollText className="size-4" />
    ) : openStep ? (
      <StepIcon kind={openStep.kind} />
    ) : null;
  const panelTitle = settingsOpen
    ? t('flow.settings')
    : shown === 'start'
      ? t('flow.start')
      : shown === 'prompt'
        ? t('routine.prompt')
        : openStep
          ? stepTitle(openStep)
          : '';
  const panelBody = !shown ? null : settingsOpen ? (
    settings
  ) : shown === 'start' ? (
    <>
      <div className="space-y-3">{schedule}</div>
      <p className="text-xs text-muted-foreground">{when}</p>
      {triggers.length > 0 && (
        <p className="text-xs text-muted-foreground">{t('flow.alsoStarts', { what: triggers.join(', ') })}</p>
      )}
      {settings && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="w-full rounded-xl"
          onClick={() => setSide(SETTINGS)}
        >
          <Settings2 className="size-3.5" /> {t('flow.settings')}
        </Button>
      )}
    </>
  ) : shown === 'prompt' ? (
    <>
      <LongText
        value={prompt}
        onChange={onPrompt}
        rows={10}
        label={t('routine.prompt')}
        placeholder={t('flow.emptyPrompt')}
        className="scroll-thin max-h-[55dvh] min-h-40 overflow-y-auto rounded-xl text-sm leading-relaxed"
      />
      {promptError && <p className="text-xs text-destructive">{t(promptError as MessageKey)}</p>}
      {promptExtra}
      {statusBody(promptStatus)}
      {tryButton(prompt, false)}
    </>
  ) : openStep ? (
    <>
      <StepFields
        step={openStep}
        later={steps.slice(panelStep + 1)}
        earlier={steps.slice(0, panelStep)}
        onChange={(next) => onSteps(steps.map((x, j) => (j === panelStep ? next : x)))}
        error={errors?.[panelStep]}
        modelListId={modelListId}
        modelPlaceholder={modelPlaceholder}
        botId={botId}
      />
      {statusBody(partOf(openStep.id))}
      {/* A step another bot does is tried on that bot in a run only: a try here would run it on the routine's. */}
      {openStep.kind === 'agent' && !openStep.bot && tryButton(openStep.prompt, true)}
    </>
  ) : null;

  /** Shows every box at once, from the canvas's top left. */
  const fitAll = (at: Record<string, Spot> = spots) => {
    const el = scroller.current;
    if (!el) return;
    const reach = boxesReach([...Object.values(at), ...noteEnds]);
    zoomTo(fitZoom(reach, { width: el.clientWidth, height: el.clientHeight }), {
      left: 0,
      top: 0,
    });
  };
  /** Lays every box out afresh in the order they run, in rows as wide as the view, then shows them all. */
  const arrange = () => {
    const next = placeBoxes(ids, null, width / zoom);
    onLayout(keepLayout(next, ids));
    fitAll(next);
  };

  /** The note just added, which takes the keyboard. */
  const [fresh, setFresh] = useState<string | null>(null);
  const addNote = () => {
    const el = scroller.current;
    if (!onNotes || notes.length >= FLOW_NOTES_MAX) return;
    const w = 240;
    const h = 160;
    const cx = el ? (el.scrollLeft + el.clientWidth / 2) / zoom : 200;
    const cy = el ? (el.scrollTop + el.clientHeight / 2) / zoom : 200;
    const note: FlowNote = {
      id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      x: Math.min(FLOW_LAYOUT_MAX, snap(cx - w / 2)),
      y: Math.min(FLOW_LAYOUT_MAX, snap(cy - h / 2)),
      w,
      h,
      text: '',
      color: 'yellow',
    };
    onNotes([...notes, note]);
    setFresh(note.id);
  };

  // Ctrl or Cmd with + and - zooms, and with 0 shows the canvas at its own size, while the canvas
  // has the keyboard.
  const zoomKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if ((e.target as HTMLElement).closest('textarea, input')) return;
    if (e.key === '=' || e.key === '+') zoomAround(zoomBy(zoom, 1));
    else if (e.key === '-') zoomAround(zoomBy(zoom, -1));
    else if (e.key === '0') zoomAround(1);
    else return;
    e.preventDefault();
  };

  const percent = new Intl.NumberFormat(INTL_LOCALE[locale], { style: 'percent' }).format(zoom);
  const zoomBar = (
    <div
      role="toolbar"
      aria-label={t('flow.view')}
      className="absolute start-2 bottom-2 z-10 flex items-center gap-0.5 rounded-full border bg-background/90 p-0.5 shadow-xs backdrop-blur"
    >
      <BarButton
        label={t('flow.zoomOut')}
        icon={<Minus className="size-3.5" />}
        onClick={() => zoomAround(zoomBy(zoom, -1))}
        disabled={zoom <= ZOOM_MIN}
      />
      <Button
        type="button"
        variant="ghost"
        className="h-7 min-w-12 rounded-full px-1.5 text-xs tabular-nums"
        onClick={() => zoomAround(1)}
        aria-label={t('flow.zoomReset', { percent })}
        title={t('flow.zoomReset', { percent })}
      >
        {percent}
      </Button>
      <BarButton
        label={t('flow.zoomIn')}
        icon={<Plus className="size-3.5" />}
        onClick={() => zoomAround(zoomBy(zoom, 1))}
        disabled={zoom >= ZOOM_MAX}
      />
      <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
      <BarButton label={t('flow.fit')} icon={<Scan className="size-3.5" />} onClick={() => fitAll()} />
      <BarButton label={t('flow.arrange')} icon={<Network className="size-3.5" />} onClick={arrange} />
      <BarButton
        label={t('flow.overview')}
        icon={<MapIcon className="size-3.5" />}
        onClick={() => setShowMap(!showMap)}
        pressed={showMap}
      />
      {onNotes && (
        <>
          <span className="mx-0.5 h-4 w-px bg-border" aria-hidden />
          <BarButton
            label={notes.length >= FLOW_NOTES_MAX ? t('flow.notesFull') : t('flow.addNote')}
            icon={<StickyNote className="size-3.5" />}
            onClick={addNote}
            disabled={notes.length >= FLOW_NOTES_MAX}
          />
        </>
      )}
    </div>
  );

  // The overview: every box small, and the part of the canvas in view; a click or a drag there
  // brings that place into view.
  const reach = boxesReach([...Object.values(spots), ...noteEnds]);
  const mapW = Math.max(reach.width, (port.left + port.width) / zoom);
  const mapH = Math.max(reach.height, (port.top + port.height) / zoom);
  const m = Math.min(MAP_W / mapW, MAP_H / mapH);
  const lookAt = (e: ReactPointerEvent<SVGSVGElement>) => {
    const el = scroller.current;
    if (!el) return;
    const r = e.currentTarget.getBoundingClientRect();
    scrollView(el, {
      left: Math.max(0, ((e.clientX - r.left) / m) * zoom - el.clientWidth / 2),
      top: Math.max(0, ((e.clientY - r.top) / m) * zoom - el.clientHeight / 2),
    });
  };
  const overview = showMap && (
    <svg
      role="img"
      aria-label={t('flow.overview')}
      width={mapW * m}
      height={mapH * m}
      className="absolute end-2 bottom-2 z-10 cursor-pointer touch-none rounded-xl border bg-background/90 shadow-xs backdrop-blur"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        lookAt(e);
      }}
      onPointerMove={(e) => e.buttons === 1 && lookAt(e)}
    >
      {notes.map((n) => (
        <rect
          key={n.id}
          x={n.x * m}
          y={n.y * m}
          width={n.w * m}
          height={n.h * m}
          rx={2}
          fill={NOTE_MAP_FILL[n.color]}
          fillOpacity={0.6}
        />
      ))}
      {ids.map((id) => {
        const s = spots[id]!;
        const st = partOf(id)?.status;
        return (
          <rect
            key={id}
            x={s.x * m}
            y={s.y * m}
            width={BOX_W * m}
            height={MAP_BOX_H * m}
            rx={2}
            style={{
              fill:
                st === 'running' ? 'var(--brand)' : id === shown ? 'var(--ring)' : 'var(--muted-foreground)',
              fillOpacity: st === 'running' || id === shown ? 0.8 : 0.35,
            }}
          />
        );
      })}
      <rect
        x={(port.left / zoom) * m}
        y={(port.top / zoom) * m}
        width={(port.width / zoom) * m}
        height={(port.height / zoom) * m}
        rx={3}
        fill="none"
        strokeWidth={1.5}
        style={{ stroke: 'var(--foreground)', strokeOpacity: 0.6 }}
      />
    </svg>
  );

  const fullScreenButton = (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className="size-8 rounded-full"
      onClick={() => setFullScreen(!fullScreen)}
      aria-label={t(fullScreen ? 'flow.exitFullScreen' : 'flow.fullScreen')}
      title={t(fullScreen ? 'flow.exitFullScreen' : 'flow.fullScreen')}
    >
      {fullScreen ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
    </Button>
  );

  return (
    <div
      className={cn(
        // No margin: the page's column spaces its parts with margins, which would cut it short.
        fullScreen
          ? 'safe-pane fixed inset-0 z-40 m-0 flex flex-col gap-2 bg-background p-3'
          : 'relative flex flex-1 flex-col gap-2',
      )}
    >
      {fullScreen && (
        // Over the whole window the bar keeps clear of the window's own buttons and moves the window.
        <div className="window-drag flex items-center justify-end gap-2 frameless:ps-[88px]">
          {fullScreenBar}
        </div>
      )}
      <div
        className={cn(
          'relative flex gap-3',
          // On the page it takes the height left under the bar, never less than room for a few boxes.
          fullScreen ? 'min-h-0 flex-1' : 'min-h-[28rem] flex-1',
        )}
      >
        {/* Sized by the room it is given; the boxes scroll inside it instead of stretching the page. */}
        <div className="relative min-w-0 flex-1 contain-size">
          <div className="absolute top-2 end-2 z-10 flex gap-1.5">
            {settings && (
              <Button
                type="button"
                variant="secondary"
                size="icon"
                className="size-8 rounded-full"
                aria-pressed={settingsOpen}
                onClick={() => setSide(settingsOpen ? null : SETTINGS)}
                aria-label={t('flow.settings')}
                title={t('flow.settings')}
              >
                <Settings2 className="size-4" />
              </Button>
            )}
            {fullScreenButton}
          </div>
          {zoomBar}
          {overview}
          <div
            ref={scroller}
            role="group"
            aria-label={t('routine.view.flow')}
            onScroll={syncPort}
            onKeyDown={zoomKeys}
            className={cn(
              // Wheeling past the canvas's own edge goes on to scroll the page around it.
              'scroll-thin relative h-full overflow-auto rounded-2xl border',
              'bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]',
              moving && 'cursor-grabbing select-none',
            )}
          >
            {/* Takes the room the canvas has at its zoom, so the view scrolls as far as it reaches. */}
            <div
              className="relative"
              style={{ width: size.width * zoom, height: size.height * zoom, minWidth: '100%' }}
            >
              <div
                // Placed as the boxes are, by the canvas's own left: their places do not mirror.
                className="absolute origin-top-left"
                style={{
                  top: 0,
                  left: 0,
                  width: size.width,
                  height: size.height,
                  transform: zoom === 1 ? undefined : `scale(${zoom})`,
                }}
              >
                <svg
                  className="pointer-events-none absolute inset-0"
                  width={size.width}
                  height={size.height}
                  aria-hidden
                >
                  <defs>
                    {/* A way's end, so one that goes back reads as going back. */}
                    <marker
                      id={arrow}
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 8 4 L 0 8 z" fill="context-stroke" />
                    </marker>
                  </defs>
                  {ids.slice(1).map((id, k) => {
                    const from = ids[k]!;
                    const { path } = link(spots[from]!, spots[id]!);
                    // A line the run has gone along is drawn in the brand's color; the first box has no
                    // part, so its line shows the instruction under way.
                    const on = from === 'start' || taken.has(`${from}>${id}`);
                    const going = on && partOf(id)?.status === 'running';
                    const passed = from !== 'start' && on && !going;
                    // A step that goes elsewhere once it ended well leaves this line to a condition
                    // passing it over, or to nothing: it is drawn faint.
                    const step = steps.find((x) => x.id === from);
                    const faint = !!step?.next && step.when?.otherwise !== 'skip';
                    return (
                      <path
                        key={id}
                        d={path}
                        fill="none"
                        strokeWidth={passed || going ? 2 : 1.5}
                        strokeDasharray={going ? '6 5' : undefined}
                        strokeOpacity={faint && !passed && !going ? 0.4 : undefined}
                        style={{ stroke: passed || going ? 'var(--brand)' : 'var(--border)' }}
                      />
                    );
                  })}
                  {jumps.map((j, lane) => {
                    const { path, mid } = jumpLink(spots[j.from]!, spots[j.to]!, lane);
                    const on = taken.has(`${j.from}>${j.to}`);
                    const going = on && partOf(j.to)?.status === 'running';
                    const label =
                      j.field === 'otherwise'
                        ? 'flow.wayOtherwise'
                        : j.field === 'next'
                          ? 'flow.wayNext'
                          : j.field === 'onReject'
                            ? 'flow.wayReject'
                            : 'flow.wayError';
                    return (
                      <g key={`${j.from}-${j.field}`}>
                        <path
                          d={path}
                          fill="none"
                          strokeWidth={on ? 2 : 1.5}
                          strokeDasharray={going ? '6 5' : '3 4'}
                          markerEnd={`url(#${arrow})`}
                          style={{
                            stroke: on
                              ? 'var(--brand)'
                              : j.field === 'onError'
                                ? 'var(--destructive)'
                                : 'var(--muted-foreground)',
                          }}
                        />
                        <text
                          x={mid.x}
                          y={mid.y - 4}
                          textAnchor="middle"
                          fontSize={11}
                          style={{ fill: 'var(--muted-foreground)' }}
                        >
                          {t(label)}
                        </text>
                      </g>
                    );
                  })}
                </svg>
                {/* Under the boxes: a box moved onto a line covers its button, not the other way round. */}
                {ids.slice(2).map((id, k) => addMenu(k, link(spots[ids[k + 1]!]!, spots[id]!).mid))}
                {addMenu(steps.length, { x: last.x + BOX_W + 28, y: last.y + PORT_Y })}
                {/* Over the lines and their buttons, under the boxes: a note may be laid over a line. */}
                {notes.map((n) => (
                  <FlowNoteCard
                    key={n.id}
                    note={n}
                    zoom={zoom}
                    focus={n.id === fresh}
                    onChange={(next) => onNotes?.(notes.map((x) => (x.id === n.id ? next : x)))}
                    onRemove={() => onNotes?.(notes.filter((x) => x.id !== n.id))}
                  />
                ))}

                {box({
                  id: 'start',
                  index: -1,
                  kind: 'start',
                  icon: <Play className="size-4" />,
                  title: t('flow.start'),
                  status: run ? runAsStep(run) : undefined,
                  summary: scheduleSummary ?? when,
                  placeholder: when,
                  note: scheduleSummary ? when : undefined,
                  tags:
                    triggers.length + inputNames.length > 0 ? (
                      <>
                        {triggers.map((what) => (
                          <Tag key={what}>{what}</Tag>
                        ))}
                        {inputNames.map((name) => (
                          <span
                            key={`input-${name}`}
                            title={t('flow.inputTag', { name })}
                            className="rounded-md bg-[var(--brand)]/12 px-1.5 py-0.5 text-[11px] font-semibold text-[var(--brand)]"
                          >
                            {name}
                          </span>
                        ))}
                      </>
                    ) : undefined,
                  below: onRunNow && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        className="w-full rounded-xl"
                        disabled={!!runBlocked || run?.status === 'running'}
                        onClick={onRunNow}
                      >
                        <Play className="size-3.5" /> {t('panel.runNow')}
                      </Button>
                      {runBlocked && <p className="text-xs text-muted-foreground">{runBlocked}</p>}
                    </>
                  ),
                })}

                {box({
                  id: 'prompt',
                  index: -1,
                  kind: 'prompt',
                  icon: <ScrollText className="size-4" />,
                  title: t('routine.prompt'),
                  status: promptStatus?.status,
                  error: promptError,
                  summary: prompt,
                  placeholder: t('flow.emptyPrompt'),
                  below: statusBody(promptStatus),
                })}

                {steps.map((s, i) => {
                  const st = partOf(s.id);
                  return box({
                    id: s.id,
                    index: i,
                    kind: s.kind,
                    icon: <StepIcon kind={s.kind} />,
                    title: stepTitle(s),
                    status: st?.status,
                    error: errors?.[i],
                    menu: stepMenu(i),
                    summary: stepText(s, t),
                    placeholder: t('flow.emptyStep'),
                    tags: stepTags(s),
                    below: statusBody(st),
                  });
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Over the flow rather than beside it: the canvas keeps its width and its boxes their places. */}
      <Dialog open={!!panelBody} onOpenChange={(open) => !open && setSide(null)}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-4rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
          // The Escape that closes the window stops here: once it is closed, the canvas listens for
          // Escape to leave full screen, and the same key press would reach it too.
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2.5 border-b px-5 py-3.5">
            {panelKind && (
              <span
                className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', TINT[panelKind])}
                aria-hidden
              >
                {panelIcon}
              </span>
            )}
            <DialogTitle className="min-w-0 flex-1 truncate text-base">{panelTitle}</DialogTitle>
            <DialogDescription className="sr-only">{t('flow.openStep')}</DialogDescription>
            {panelStep >= 0 && stepMenu(panelStep)}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-me-1.5 size-8 rounded-full"
              onClick={() => setSide(null)}
              aria-label={t('common.close')}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{panelBody}</div>
          <div className="flex justify-end border-t px-5 py-3">
            <Button type="button" className="rounded-full" onClick={() => setSide(null)}>
              {t('flow.done')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <p className="text-xs text-muted-foreground">{t('flow.pickHint')}</p>
    </div>
  );
}
