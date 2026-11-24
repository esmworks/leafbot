import type { Bot, BotMove } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { api } from '@/lib/api';
import { applyMove, isNoop, moveTo, sectionOf, type SectionKey } from '@/lib/botLayout';
import { cn } from '@/lib/utils';

/*
 * Moving bots in the sidebar by pressing anywhere on them. Items carry `data-bot-id`, `data-section`
 * and `data-axis` (x for tiles side by side, y for rows); section containers carry
 * `data-section`. Pointer events rather than native drag and drop, so a short press
 * still selects the bot and the indicators never shift the layout under the pointer.
 */

export interface DropTarget {
  section: SectionKey;
  beforeId: string | null;
  /** The item the pointer is over and which side of it the bot will land. */
  overId: string | null;
  side: 'before' | 'after' | null;
}

interface DragState {
  bot: Bot;
  x: number;
  y: number;
  target: DropTarget | null;
}

interface BotDrag {
  drag: DragState | null;
  /** Starts tracking a press on a bot; null when moving is off (e.g. while searching). */
  grab: ((e: React.PointerEvent, bot: Bot) => void) | null;
}

const Ctx = createContext<BotDrag>({ drag: null, grab: null });
export const useBotDrag = () => useContext(Ctx);

/** Moves a bot and shows the move at once, before the server answers. */
export function useMoveBot() {
  const qc = useQueryClient();
  return (id: string, to: BotMove) => {
    if (isNoop(qc.getQueryData<Bot[]>(['bots']) ?? [], id, to)) return;
    qc.setQueryData<Bot[]>(['bots'], (old) => (old ? applyMove(old, id, to) : old));
    api.moveBot(id, to).then(
      () => qc.invalidateQueries({ queryKey: ['bots'] }),
      (e: Error) => {
        toast.error(e.message);
        void qc.invalidateQueries({ queryKey: ['bots'] });
      },
    );
  };
}

const THRESHOLD = 5;
const EDGE = 48;

export function BotDragProvider({
  enabled,
  scroller,
  children,
}: {
  enabled: boolean;
  scroller: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const qc = useQueryClient();
  const moveBot = useMoveBot();
  const [drag, setDrag] = useState<DragState | null>(null);
  const current = () => qc.getQueryData<Bot[]>(['bots']) ?? [];

  const drop = (bot: Bot, target: DropTarget) => moveBot(bot.id, moveTo(target.section, target.beforeId));

  const grab = (e: React.PointerEvent, bot: Bot) => {
    // On a touch screen a moving finger scrolls the list; the bot's menu moves it instead.
    if (e.button !== 0 || e.pointerType === 'touch') return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let target: DropTarget | null = null;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
        started = true;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      ev.preventDefault();
      autoScroll(scroller.current, ev.clientY);
      target = targetAt(ev.clientX, ev.clientY, bot.id, current());
      setDrag({ bot, x: ev.clientX, y: ev.clientY, target });
    };
    // Leaving the window (e.g. switching apps) cancels the drag; only a release drops.
    const end = (ev: Event) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      if (!started) return;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDrag(null);
      // The release would otherwise click (select) whatever is under the pointer.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (ev.type === 'pointerup' && target) drop(bot, target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  };

  return (
    <Ctx.Provider value={{ drag, grab: enabled ? grab : null }}>
      {children}
      {drag && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          <BotAvatar
            avatar={drag.bot.avatar}
            material={drag.bot.material}
            color={drag.bot.color}
            seed={drag.bot.id}
            size={44}
          />
        </div>
      )}
    </Ctx.Provider>
  );
}

function targetAt(x: number, y: number, dragId: string, bots: Bot[]): DropTarget | null {
  const el = document.elementFromPoint(x, y);
  const item = el?.closest<HTMLElement>('[data-bot-id]');
  if (item) {
    const id = item.dataset.botId!;
    if (id === dragId) return null;
    const section = item.dataset.section!;
    const r = item.getBoundingClientRect();
    const after = item.dataset.axis === 'x' ? x > r.left + r.width / 2 : y > r.top + r.height / 2;
    const list = bots.filter((b) => b.id !== dragId && sectionOf(b) === section);
    const beforeId = after ? (list[list.findIndex((b) => b.id === id) + 1]?.id ?? null) : id;
    return { section, beforeId, overId: id, side: after ? 'after' : 'before' };
  }
  const section = el?.closest<HTMLElement>('[data-section]')?.dataset.section;
  return section ? { section, beforeId: null, overId: null, side: null } : null;
}

function autoScroll(el: HTMLElement | null, y: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (y < r.top + EDGE) el.scrollTop -= 12;
  else if (y > r.bottom - EDGE) el.scrollTop += 12;
}

/** Props that make an element a draggable item of a section. */
export function useDragItem(bot: Bot, axis: 'x' | 'y') {
  const { drag, grab } = useBotDrag();
  const over = drag?.target?.overId === bot.id ? drag.target.side : null;
  return {
    item: { 'data-bot-id': bot.id, 'data-section': sectionOf(bot), 'data-axis': axis },
    /** For the item's button: pressing and moving it drags the bot. Missing when moving is off. */
    onGrab: grab ? (e: React.PointerEvent) => grab(e, bot) : undefined,
    dragging: drag?.bot.id === bot.id,
    indicator: over && <DropLine axis={axis} side={over} />,
  };
}

/** True while a bot is dragged over the section's empty area (it lands at the end). */
export function useSectionOver(section: SectionKey) {
  const { drag } = useBotDrag();
  return !!drag && drag.target?.section === section && drag.target.overId === null;
}

function DropLine({ axis, side }: { axis: 'x' | 'y'; side: 'before' | 'after' }) {
  return (
    <span
      className={cn(
        'pointer-events-none absolute z-10 rounded-full bg-primary',
        axis === 'y' ? 'inset-x-2 h-0.5' : 'inset-y-2 w-0.5',
        axis === 'y' && (side === 'before' ? '-top-px' : '-bottom-px'),
        axis === 'x' && (side === 'before' ? '-start-px' : '-end-px'),
      )}
    />
  );
}
