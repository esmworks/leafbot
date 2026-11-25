import { placeTile, type DashboardTileView, type DashboardView } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

/*
 * Moving dashboard tiles by pressing anywhere on one and dragging it before or after another.
 * Tiles carry `data-tile-id`, the area they sit in `data-tile-grid`. Pointer events rather than native drag and drop, as for the
 * sidebar's bots, so a short press still selects text and the drop line never shifts the layout
 * under the pointer. On a touch screen a moving finger scrolls the page; the tile menu moves it.
 */

interface Target {
  overId: string;
  side: 'before' | 'after';
}

interface DragState {
  tile: DashboardTileView;
  x: number;
  y: number;
  target: Target | null;
}

const THRESHOLD = 5;
const EDGE = 48;
/** What a press on these starts is theirs: the tile menu, a chart's buttons, a card's fields. */
const OWN_PRESS =
  'button, a, input, select, textarea, label, [contenteditable="true"], [role="button"], [role="menuitem"], [role="combobox"], [role="slider"], [role="tab"]';

export function useTileDrag(pageId: string, scroller: React.RefObject<HTMLElement | null>) {
  const qc = useQueryClient();
  const [drag, setDrag] = useState<DragState | null>(null);
  const key = ['dashboard', pageId];

  const drop = (tile: DashboardTileView, target: Target) => {
    // Read the page as it stands now: a bot may have written while the tile was in the air.
    const ids = qc.getQueryData<DashboardView>(key)?.tiles.map((x) => x.id) ?? [];
    if (!ids.includes(target.overId)) return;
    const rest = ids.filter((id) => id !== tile.id);
    const beforeId =
      target.side === 'before' ? target.overId : (rest[rest.indexOf(target.overId) + 1] ?? null);
    const order = placeTile(ids, tile.id, beforeId);
    if (order.every((id, i) => id === ids[i])) return;
    void qc.cancelQueries({ queryKey: key });
    qc.setQueryData<DashboardView>(key, (old) =>
      old ? { ...old, tiles: order.map((id) => old.tiles.find((x) => x.id === id)!) } : old,
    );
    const settle = () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['dashboards'] });
    };
    api.placeDashboardTile(tile.id, beforeId).then(settle, (e: Error) => {
      toast.error(e.message);
      settle();
    });
  };

  const grab = (e: React.PointerEvent, tile: DashboardTileView) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as Element).closest(OWN_PRESS)) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let x = startX;
    let y = startY;
    let started = false;
    let target: Target | null = null;
    let edge = 0;

    const aim = () => {
      target = targetAt(x, y, tile.id, target);
      setDrag({ tile, x, y, target });
    };
    const move = (ev: PointerEvent) => {
      x = ev.clientX;
      y = ev.clientY;
      if (!started) {
        if (Math.hypot(x - startX, y - startY) < THRESHOLD) return;
        started = true;
        // The press began selecting the tile's text; the tile moves instead.
        window.getSelection()?.removeAllRanges();
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        // A page of tiles runs past the window: held near its top or bottom edge, it keeps
        // scrolling without the pointer moving, and the place is read again as tiles pass under it.
        edge = window.setInterval(() => autoScroll(scroller.current, y), 16);
        scroller.current?.addEventListener('scroll', aim);
      }
      ev.preventDefault();
      aim();
    };
    // Leaving the window (e.g. switching apps) cancels the drag; only a release drops.
    const end = (ev: Event) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      if (!started) return;
      window.clearInterval(edge);
      scroller.current?.removeEventListener('scroll', aim);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDrag(null);
      // The release would otherwise click whatever is under the pointer.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (ev.type === 'pointerup' && target) drop(tile, target);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  };

  /** Props for a tile: pressing it drags it when `movable`; it shows where a dragged one lands. */
  const itemProps = (tile: DashboardTileView, movable: boolean) => {
    const side = drag?.target?.overId === tile.id ? drag.target.side : null;
    return {
      item: { 'data-tile-id': tile.id },
      onPointerDown: movable ? (e: React.PointerEvent) => grab(e, tile) : undefined,
      dragging: drag?.tile.id === tile.id,
      indicator: side && <DropLine side={side} />,
    };
  };

  const ghost = drag && (
    <div
      className="pointer-events-none fixed z-50 max-w-64 truncate rounded-lg border bg-popover px-3 py-1.5 text-sm font-medium text-popover-foreground shadow-lg"
      // Beside the pointer, and above it near the window's bottom edge where the page scrolls.
      style={{ left: drag.x + 12, top: drag.y > window.innerHeight - 60 ? drag.y - 40 : drag.y + 12 }}
    >
      {drag.tile.title}
    </div>
  );

  return { itemProps, ghost };
}

function targetAt(x: number, y: number, dragId: string, last: Target | null): Target | null {
  const el = document.elementFromPoint(x, y);
  const item = el?.closest<HTMLElement>('[data-tile-id]');
  // Over the gap between tiles the last place still holds, so the line does not flicker; away
  // from the tiles there is none, and letting go there leaves the tile where it was.
  if (!item) return el?.closest('[data-tile-grid]') ? last : null;
  const overId = item.dataset.tileId!;
  if (overId === dragId) return null;
  const r = item.getBoundingClientRect();
  return { overId, side: x > r.left + r.width / 2 ? 'after' : 'before' };
}

function autoScroll(el: HTMLElement | null, y: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (y < r.top + EDGE) el.scrollTop -= 12;
  else if (y > r.bottom - EDGE) el.scrollTop += 12;
}

/** A line in the middle of the 16px gap beside the tile, where the dragged one will land. */
function DropLine({ side }: { side: 'before' | 'after' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-y-2 z-10 w-0.5 rounded-full bg-primary',
        side === 'before' ? '-start-[9px]' : '-end-[9px]',
      )}
    />
  );
}
