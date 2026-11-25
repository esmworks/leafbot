import {
  FLOW_NOTE_COLORS,
  FLOW_NOTE_H,
  FLOW_NOTE_TEXT_MAX,
  FLOW_NOTE_W,
  type FlowNote,
} from '@leafbot/shared';
import { Check, GripHorizontal, Palette, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n';
import { snap } from '@/lib/routineFlow';
import { cn } from '@/lib/utils';

/** A note's paper, and the swatch that picks it. */
export const NOTE_TINT: Record<FlowNote['color'], { paper: string; swatch: string }> = {
  yellow: {
    paper: 'border-yellow-300/80 bg-yellow-100 dark:border-yellow-400/30 dark:bg-yellow-400/15',
    swatch: 'bg-yellow-300',
  },
  orange: {
    paper: 'border-orange-300/80 bg-orange-100 dark:border-orange-400/30 dark:bg-orange-400/15',
    swatch: 'bg-orange-300',
  },
  pink: {
    paper: 'border-pink-300/80 bg-pink-100 dark:border-pink-400/30 dark:bg-pink-400/15',
    swatch: 'bg-pink-300',
  },
  blue: {
    paper: 'border-sky-300/80 bg-sky-100 dark:border-sky-400/30 dark:bg-sky-400/15',
    swatch: 'bg-sky-300',
  },
  green: {
    paper: 'border-emerald-300/80 bg-emerald-100 dark:border-emerald-400/30 dark:bg-emerald-400/15',
    swatch: 'bg-emerald-300',
  },
  purple: {
    paper: 'border-violet-300/80 bg-violet-100 dark:border-violet-400/30 dark:bg-violet-400/15',
    swatch: 'bg-violet-300',
  },
};

/** The fill a note is drawn with in the canvas's overview. */
export const NOTE_MAP_FILL: Record<FlowNote['color'], string> = {
  yellow: '#facc15',
  orange: '#fb923c',
  pink: '#f472b6',
  blue: '#38bdf8',
  green: '#34d399',
  purple: '#a78bfa',
};

const clamp = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, v));

/**
 * A note on the flow's canvas: written where it is, moved by its top strip, made larger or smaller
 * from its corner. While it moves or changes size only this card redraws; the routine hears of the
 * change once the pointer lets go.
 */
export function FlowNoteCard({
  note,
  zoom,
  focus,
  onChange,
  onRemove,
}: {
  note: FlowNote;
  /** How large the canvas is drawn: the pointer's travel on screen is the note's times this. */
  zoom: number;
  /** Takes the keyboard once drawn, as a note just added does. */
  focus?: boolean;
  onChange(next: FlowNote): void;
  onRemove(): void;
}) {
  const t = useT();
  const text = useRef<HTMLTextAreaElement>(null);
  // Where it is and how large while held; the note as given otherwise.
  const [held, setHeld] = useState<Pick<FlowNote, 'x' | 'y' | 'w' | 'h'> | null>(null);
  const shown = held ?? note;

  useEffect(() => {
    if (focus) text.current?.focus();
  }, [focus]);

  /** Follows the pointer from where it took hold until it lets go, moving the note or sizing it. */
  const hold = (how: 'move' | 'size') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (how === 'move' && (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    let now = { x: note.x, y: note.y, w: note.w, h: note.h };
    const over = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / zoom;
      const dy = (ev.clientY - sy) / zoom;
      now =
        how === 'move'
          ? { ...now, x: snap(note.x + dx), y: snap(note.y + dy) }
          : {
              ...now,
              w: clamp(Math.round((note.w + dx) / 8) * 8, FLOW_NOTE_W),
              h: clamp(Math.round((note.h + dy) / 8) * 8, FLOW_NOTE_H),
            };
      setHeld(now);
    };
    const end = () => {
      window.removeEventListener('pointermove', over);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setHeld(null);
      if (now.x !== note.x || now.y !== note.y || now.w !== note.w || now.h !== note.h)
        onChange({ ...note, ...now });
    };
    window.addEventListener('pointermove', over);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <div
      role="note"
      aria-label={t('flow.note')}
      style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }}
      className={cn(
        // On the card's colour first: a tint alone would let the lines under it show through.
        'group absolute flex flex-col rounded-xl border border-transparent bg-card shadow-xs',
        held && 'z-10 shadow-lg',
      )}
    >
      <span
        className={cn(
          'pointer-events-none absolute -inset-px rounded-[inherit] border',
          NOTE_TINT[note.color].paper,
        )}
        aria-hidden
      />
      <div
        onPointerDown={hold('move')}
        title={t('flow.noteDrag')}
        className="flex h-7 shrink-0 cursor-grab touch-none items-center gap-0.5 ps-2 pe-1 text-foreground/50 select-none active:cursor-grabbing"
      >
        <GripHorizontal className="size-3.5" aria-hidden />
        <span className="flex-1" />
        {/* Shown when the note is pointed at or has the keyboard, so a quiet note reads as paper. */}
        <div className="flex opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 rounded-full"
                aria-label={t('flow.noteColor')}
                title={t('flow.noteColor')}
              >
                <Palette className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {FLOW_NOTE_COLORS.map((c) => (
                <DropdownMenuItem key={c} onSelect={() => onChange({ ...note, color: c })}>
                  <span className={cn('size-3.5 rounded-full', NOTE_TINT[c].swatch)} aria-hidden />
                  {t(`flow.noteColor.${c}`)}
                  {c === note.color && <Check className="ms-auto" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 rounded-full"
            onClick={onRemove}
            aria-label={t('flow.noteRemove')}
            title={t('flow.noteRemove')}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <textarea
        ref={text}
        dir="auto"
        value={note.text}
        maxLength={FLOW_NOTE_TEXT_MAX}
        onChange={(e) => onChange({ ...note, text: e.target.value })}
        placeholder={t('flow.notePlaceholder')}
        aria-label={t('flow.note')}
        className="scroll-thin min-h-0 flex-1 resize-none bg-transparent px-3 pb-3 text-sm leading-relaxed text-foreground outline-none placeholder:text-foreground/40"
      />
      <span
        onPointerDown={hold('size')}
        title={t('flow.noteSize')}
        // At the far corner of the note's width on the canvas, which grows rightwards in any language.
        style={{ right: 0, bottom: 0 }}
        className="absolute size-4 cursor-nwse-resize touch-none"
        aria-hidden
      />
    </div>
  );
}
