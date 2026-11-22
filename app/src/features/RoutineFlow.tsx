import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Flag, GripVertical, Play, Plus, ScrollText, Trash2 } from 'lucide-react';
import { ROUTINE_STEP_MAX } from '@leafbot/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { useT, type MessageKey } from '@/i18n';
import { dropPlace, insertStep, moveStep, removeStep } from '@/lib/routineFlow';
import { cn } from '@/lib/utils';
import { NEW_STEP, STEP_KINDS, StepFields, StepIcon, type StepForm } from './RoutineSteps';

/** What is picked on the canvas: the routine's own instruction, a step by its id, or nothing. */
type Picked = 'prompt' | string | null;

/**
 * The routine drawn as a flow: what starts it, its instruction, each step in the order it runs, and
 * the end. It is another view of the same steps the list edits: a step is added on a line between
 * two boxes, moved by dragging its handle (or Alt with an arrow key), and changed in the panel
 * beside the canvas. Runs go straight down, one step after another, as the server runs them.
 */
export function RoutineFlow({
  triggers,
  prompt,
  onPrompt,
  promptError,
  steps,
  onSteps,
  errors,
  modelListId,
  modelPlaceholder,
}: {
  /** Lines saying what starts the routine. */
  triggers: string[];
  prompt: string;
  onPrompt(next: string): void;
  promptError?: string;
  steps: StepForm[];
  onSteps(next: StepForm[]): void;
  errors?: (string | undefined)[];
  modelListId: string;
  modelPlaceholder: string;
}) {
  const t = useT();
  const [picked, setPicked] = useState<Picked>(null);
  const [drag, setDrag] = useState<{ from: number; gap: number | null } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const index = steps.findIndex((s) => s.id === picked);
  const full = steps.length >= ROUTINE_STEP_MAX;

  // While a step is dragged, the line nearest the pointer is where it would go; letting go
  // there moves it. The place comes from where the pointer is, not from enter and leave
  // events, so a quick drag that skips past the lines still lands.
  const from = drag?.from ?? null;
  useEffect(() => {
    if (from === null) return;
    const gapAt = (x: number, y: number): number | null => {
      const area = canvas.current?.getBoundingClientRect();
      if (!area || x < area.left || x > area.right || y < area.top || y > area.bottom) return null;
      let best: { gap: number; far: number } | null = null;
      for (const el of canvas.current!.querySelectorAll<HTMLElement>('[data-gap]')) {
        const r = el.getBoundingClientRect();
        const far = Math.abs(r.top + r.height / 2 - y);
        if (!best || far < best.far) best = { gap: Number(el.dataset.gap), far };
      }
      return best?.gap ?? null;
    };
    const over = (e: PointerEvent) => setDrag((d) => d && { ...d, gap: gapAt(e.clientX, e.clientY) });
    const end = (e: PointerEvent) => {
      const gap = gapAt(e.clientX, e.clientY);
      setDrag(null);
      if (gap !== null) onSteps([...moveStep(steps, from, dropPlace(from, gap))]);
    };
    window.addEventListener('pointermove', over);
    window.addEventListener('pointerup', end);
    return () => {
      window.removeEventListener('pointermove', over);
      window.removeEventListener('pointerup', end);
    };
  }, [from, steps, onSteps]);

  const add = (gap: number, kind: StepForm['kind']) => {
    const step = NEW_STEP[kind]();
    onSteps([...insertStep(steps, gap, step)]);
    setPicked(step.id);
  };
  const move = (i: number, by: -1 | 1) => onSteps([...moveStep(steps, i, i + by)]);
  const remove = (i: number) => {
    onSteps([...removeStep(steps, i)]);
    setPicked(null);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed into a field are the field's.
    const target = e.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]') || index < 0) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(index);
    } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(index, e.key === 'ArrowUp' ? -1 : 1);
    }
  };

  /** The line between two boxes; `gap` is the place a step added or dropped here takes. */
  const line = (gap: number | null) => {
    const over = drag && gap !== null && drag.gap === gap;
    return (
      <div className="relative flex h-10 items-center justify-center" data-gap={gap ?? undefined}>
        <div className={cn('absolute inset-y-0 w-px bg-border', over && 'w-0.5 bg-[var(--brand)]')} />
        {gap !== null && !drag && !full && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="relative size-6 rounded-full bg-background"
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
        )}
      </div>
    );
  };

  const box = (o: {
    id: string;
    icon: ReactNode;
    title: string;
    body?: string;
    pick?: Picked;
    error?: boolean;
    handle?: ReactNode;
  }) => (
    <div
      key={o.id}
      role={o.pick !== undefined ? 'button' : undefined}
      tabIndex={o.pick !== undefined ? 0 : undefined}
      aria-pressed={o.pick !== undefined ? picked === o.pick : undefined}
      onClick={() => o.pick !== undefined && setPicked(o.pick)}
      onKeyDown={(e) => {
        if (o.pick !== undefined && (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          setPicked(o.pick);
        }
      }}
      className={cn(
        'flex w-full max-w-xs items-start gap-2 rounded-2xl border bg-card px-3 py-2.5 text-left shadow-xs',
        o.pick !== undefined && 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring',
        o.pick !== undefined && picked === o.pick && 'border-[var(--brand)] ring-1 ring-[var(--brand)]',
        o.error && 'border-destructive',
      )}
    >
      <span className="mt-0.5 text-muted-foreground">{o.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{o.title}</span>
        {o.body && <span className="line-clamp-2 block text-xs text-muted-foreground">{o.body}</span>}
      </span>
      {o.handle}
    </div>
  );

  const stepBody = (s: StepForm) =>
    s.kind === 'agent'
      ? s.prompt
      : s.kind === 'approval'
        ? s.question
        : s.kind === 'notify'
          ? s.text
          : s.kind === 'wait'
            ? t(`routine.waitOn.${s.on}`)
            : '';

  return (
    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_17rem]">
      <div
        ref={canvas}
        onKeyDown={onKey}
        className={cn(
          'scroll-thin flex max-h-[32rem] flex-col items-center overflow-y-auto rounded-2xl border px-4 py-5',
          'bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:16px_16px]',
          drag && 'cursor-grabbing select-none',
        )}
        aria-label={t('routine.view.flow')}
      >
        {box({
          id: 'start',
          icon: <Play className="size-4" />,
          title: t('flow.start'),
          body: triggers.join(' · '),
        })}
        {line(null)}
        {box({
          id: 'prompt',
          icon: <ScrollText className="size-4" />,
          title: t('routine.prompt'),
          body: prompt,
          pick: 'prompt',
          error: !!promptError,
        })}
        {steps.map((s, i) => (
          <Fragment key={s.id}>
            {line(i)}
            {box({
              id: s.id,
              icon: <StepIcon kind={s.kind} />,
              title: t(`routine.step.${s.kind}`),
              body: stepBody(s),
              pick: s.id,
              error: !!errors?.[i],
              handle: (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={t('flow.drag')}
                  className="-mr-1 cursor-grab touch-none p-1 text-muted-foreground"
                  onPointerDown={(e) => {
                    e.preventDefault();
                    setPicked(s.id);
                    setDrag({ from: i, gap: null });
                  }}
                >
                  <GripVertical className="size-4" />
                </span>
              ),
            })}
          </Fragment>
        ))}
        {line(steps.length)}
        {box({ id: 'end', icon: <Flag className="size-4" />, title: t('flow.end') })}
      </div>

      <div className="space-y-2 rounded-2xl border px-3 py-2.5">
        {picked === 'prompt' ? (
          <>
            <div className="text-xs text-muted-foreground">{t('routine.prompt')}</div>
            <Textarea
              value={prompt}
              onChange={(e) => onPrompt(e.target.value)}
              rows={8}
              className="scroll-thin max-h-80 overflow-y-auto rounded-xl"
              aria-label={t('routine.prompt')}
            />
            {promptError && <p className="text-sm text-destructive">{t(promptError as MessageKey)}</p>}
          </>
        ) : index >= 0 ? (
          <>
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <StepIcon kind={steps[index]!.kind} />
              <span className="min-w-0 flex-1">{t(`routine.step.${steps[index]!.kind}`)}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 rounded-full"
                disabled={index === 0}
                onClick={() => move(index, -1)}
                aria-label={t('routine.stepUp')}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 rounded-full"
                disabled={index === steps.length - 1}
                onClick={() => move(index, 1)}
                aria-label={t('routine.stepDown')}
              >
                <ArrowDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 rounded-full"
                onClick={() => remove(index)}
                aria-label={t('routine.stepRemove')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <StepFields
              step={steps[index]!}
              onChange={(next) => onSteps(steps.map((s, j) => (j === index ? next : s)))}
              error={errors?.[index]}
              modelListId={modelListId}
              modelPlaceholder={modelPlaceholder}
            />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">{t('flow.pickHint')}</p>
        )}
      </div>
    </div>
  );
}
