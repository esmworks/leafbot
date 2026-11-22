import { INTL_LOCALE, ROUTINE_STEP_MAX, type FlowLayout, type RoutineRun } from '@leafbot/shared';
import {
  ArrowDown,
  ArrowUp,
  FlaskConical,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  ScrollText,
  Trash2,
} from 'lucide-react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { useLocale, useT, type MessageKey } from '@/i18n';
import {
  BOX_W,
  canvasSize,
  insertStep,
  keepLayout,
  link,
  moveStep,
  PORT_Y,
  placeBoxes,
  removeStep,
  runAsStep,
  runPart,
  snap,
  type RunPart,
  type Spot,
} from '@/lib/routineFlow';
import { cn } from '@/lib/utils';
import {
  ApprovalAnswer,
  EndWait,
  NEW_STEP,
  STEP_KINDS,
  StepFields,
  StepIcon,
  type StepForm,
} from './RoutineSteps';

/** The width the canvas is laid out for before it is measured (and where nothing is, in tests). */
const FALLBACK_WIDTH = 1100;
/** How far an arrow key moves a box. */
const NUDGE = 16;

/**
 * The routine drawn as boxes on a canvas: what starts it, its own instruction and each step, joined
 * by lines in the order they run. Each box is edited where it is; a box is placed by dragging its
 * title (or with the arrow keys), and the order changes from its menu or with Alt and an arrow
 * key. While a run goes, each box shows how its part of the latest run went. Runs still go one
 * step after another, along the lines, as the server runs them.
 */
export function RoutineFlow({
  triggers,
  schedule,
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
  layout,
  onLayout,
}: {
  /** What else starts the routine, besides its schedule. */
  triggers: string[];
  /** The schedule's fields, edited in the first box. */
  schedule: ReactNode;
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
  layout: FlowLayout | null;
  onLayout(next: FlowLayout): void;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const full = steps.length >= ROUTINE_STEP_MAX;
  const ids = ['start', 'prompt', ...steps.map((s) => s.id)];

  // Boxes without a place of their own fill the canvas's width, so it is measured.
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || FALLBACK_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  // The box being dragged, where it is now; the others keep their places meanwhile.
  const [moving, setMoving] = useState<{ id: string; spot: Spot } | null>(null);
  const spots = placeBoxes(ids, layout, width);
  if (moving) spots[moving.id] = moving.spot;
  const size = canvasSize(Object.values(spots));

  // The box held, where the pointer took hold of it and where it is now.
  const grab = useRef<{ id: string; dx: number; dy: number; from: Spot; at: Spot } | null>(null);
  const movingId = moving?.id ?? null;
  const order = ids.join('\n');
  useEffect(() => {
    if (!movingId) return;
    const now = order.split('\n');
    const over = (e: PointerEvent) => {
      const g = grab.current;
      if (!g) return;
      g.at = { x: snap(e.clientX - g.dx), y: snap(e.clientY - g.dy) };
      setMoving({ id: g.id, spot: g.at });
    };
    const end = () => {
      const g = grab.current;
      grab.current = null;
      setMoving(null);
      if (!g || (g.at.x === g.from.x && g.at.y === g.from.y)) return;
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
  const add = (gap: number, kind: StepForm['kind']) => onSteps([...insertStep(steps, gap, NEW_STEP[kind]())]);
  const move = (i: number, by: -1 | 1) => onSteps([...moveStep(steps, i, i + by)]);
  const remove = (i: number) => onSteps([...removeStep(steps, i)]);

  /** How the latest run went at a box; the first box has no part of its own. */
  const partOf = (id: string): RunPart | undefined =>
    id === 'start' ? undefined : runPart(run, id === 'prompt' ? null : id);

  const grabBox = (id: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, textarea, select, a, [role="menuitem"]')) return;
    e.preventDefault();
    const from = spots[id]!;
    grab.current = { id, dx: e.clientX - from.x, dy: e.clientY - from.y, from, at: from };
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
        onClick={() => onTry(text, step)}
      >
        <FlaskConical className="size-3.5" /> {t('flow.try')}
      </Button>
    );

  const box = (o: {
    id: string;
    index: number;
    icon: ReactNode;
    title: string;
    status?: RunPart['status'];
    error?: boolean;
    menu?: ReactNode;
    children: ReactNode;
  }) => {
    const s = spots[o.id]!;
    return (
      <section
        key={o.id}
        aria-label={o.title}
        style={{ left: s.x, top: s.y, width: BOX_W }}
        className={cn(
          'absolute rounded-2xl border bg-card shadow-xs transition-shadow',
          moving?.id === o.id && 'z-10 shadow-lg',
          o.status === 'running' && 'border-[var(--brand)] ring-2 ring-[var(--brand)]/25',
          o.error && 'border-destructive',
        )}
      >
        {o.id !== 'start' && (
          <span
            className="absolute -left-1.5 size-3 rounded-full border bg-background"
            style={{ top: PORT_Y - 6 }}
            aria-hidden
          />
        )}
        <span
          className="absolute -right-1.5 size-3 rounded-full border bg-background"
          style={{ top: PORT_Y - 6 }}
          aria-hidden
        />
        <div
          tabIndex={0}
          title={t('flow.drag')}
          aria-label={`${o.title}. ${t('flow.drag')}`}
          onPointerDown={grabBox(o.id)}
          onKeyDown={keys(o.id, o.index)}
          className={cn(
            'flex h-11 touch-none items-center gap-2 rounded-t-2xl border-b px-3 text-sm font-medium select-none',
            'cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring',
            moving?.id === o.id && 'cursor-grabbing',
          )}
        >
          <span className="text-muted-foreground">{o.icon}</span>
          <span className="min-w-0 flex-1 truncate">{o.title}</span>
          {o.status && statusChip(o.status)}
          {o.menu}
        </div>
        <div className="space-y-2 p-3">{o.children}</div>
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
          className="-mr-1.5 size-7 rounded-full"
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

  const promptStatus = partOf('prompt');
  const last = spots[ids[ids.length - 1]!]!;

  return (
    <div className="space-y-2">
      <div
        ref={scroller}
        role="group"
        aria-label={t('routine.view.flow')}
        className={cn(
          'scroll-thin relative h-[max(34rem,calc(100dvh-16rem))] overflow-auto overscroll-contain rounded-2xl border',
          'bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]',
          moving && 'cursor-grabbing select-none',
        )}
      >
        <div className="relative" style={{ width: size.width, height: size.height, minWidth: '100%' }}>
          <svg
            className="pointer-events-none absolute inset-0"
            width={size.width}
            height={size.height}
            aria-hidden
          >
            {ids.slice(1).map((id, k) => {
              const from = ids[k]!;
              const { path } = link(spots[from]!, spots[id]!);
              // A line the run has gone along is drawn in the brand's color.
              const passed = partOf(from)?.status === 'done';
              const going = partOf(id)?.status === 'running';
              return (
                <path
                  key={id}
                  d={path}
                  fill="none"
                  strokeWidth={passed || going ? 2 : 1.5}
                  strokeDasharray={going ? '6 5' : undefined}
                  style={{ stroke: passed || going ? 'var(--brand)' : 'var(--border)' }}
                />
              );
            })}
          </svg>
          {/* Under the boxes: a box moved onto a line covers its button, not the other way round. */}
          {ids.slice(2).map((id, k) => addMenu(k, link(spots[ids[k + 1]!]!, spots[id]!).mid))}
          {addMenu(steps.length, { x: last.x + BOX_W + 28, y: last.y + PORT_Y })}

          {box({
            id: 'start',
            index: -1,
            icon: <Play className="size-4" />,
            title: t('flow.start'),
            status: run ? runAsStep(run) : undefined,
            children: (
              <>
                {triggers.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('flow.alsoStarts', { what: triggers.join(', ') })}
                  </p>
                )}
                <div className="space-y-3">{schedule}</div>
                <p className="text-xs text-muted-foreground">{when}</p>
                {onRunNow && (
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
                )}
              </>
            ),
          })}

          {box({
            id: 'prompt',
            index: -1,
            icon: <ScrollText className="size-4" />,
            title: t('routine.prompt'),
            status: promptStatus?.status,
            error: !!promptError,
            children: (
              <>
                <Textarea
                  value={prompt}
                  onChange={(e) => onPrompt(e.target.value)}
                  rows={4}
                  className="scroll-thin max-h-48 overflow-y-auto rounded-xl text-sm"
                  aria-label={t('routine.prompt')}
                />
                {promptError && <p className="text-xs text-destructive">{t(promptError as MessageKey)}</p>}
                {statusBody(promptStatus)}
                {tryButton(prompt, false)}
              </>
            ),
          })}

          {steps.map((s, i) => {
            const st = partOf(s.id);
            return box({
              id: s.id,
              index: i,
              icon: <StepIcon kind={s.kind} />,
              title: t(`routine.step.${s.kind}`),
              status: st?.status,
              error: !!errors?.[i],
              menu: stepMenu(i),
              children: (
                <>
                  <StepFields
                    step={s}
                    onChange={(next) => onSteps(steps.map((x, j) => (j === i ? next : x)))}
                    error={errors?.[i]}
                    modelListId={modelListId}
                    modelPlaceholder={modelPlaceholder}
                  />
                  {statusBody(st)}
                  {s.kind === 'agent' && tryButton(s.prompt, true)}
                </>
              ),
            });
          })}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{t('flow.pickHint')}</p>
    </div>
  );
}
