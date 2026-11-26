import { placeTile, type DashboardTileView, type DashboardView } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { orderAt, reconcile, type Box } from './tileOrder';

/*
 * Moving dashboard tiles by pressing anywhere on one and dragging it. The tile lifts and follows
 * the pointer; where it will land stays open as a dashed outline of its size, and the other tiles
 * slide aside to make room as it passes over them. Letting go settles it into that place; Escape,
 * leaving the window or letting go off the page puts it back. Tiles carry `data-tile-id` and sit
 * in a positioned area (`grid`) their places are measured from.
 *
 * Pointer events rather than native drag and drop, as for the sidebar's bots, so a short press
 * still selects text. On a touch screen a moving finger scrolls the page; the tile menu moves it.
 */

interface Lift {
  id: string;
  /** The order shown while the tile is in the air. */
  order: string[];
  width: number;
  height: number;
  /** Where its top left corner was when it lifted; after that it moves without a render. */
  x: number;
  y: number;
  /** Let go: the tile is gliding into its place and takes no other press. */
  settling: boolean;
}

const THRESHOLD = 5;
const EDGE = 48;
/** How far the pointer moves after the tiles shift before they may shift again. */
const STEADY = 4;
const SLIDE_MS = 200;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
/** What a press on these starts is theirs: the tile menu, a chart's buttons, a card's fields. */
const OWN_PRESS =
  'button, a, input, select, textarea, label, [contenteditable="true"], [role="button"], [role="menuitem"], [role="combobox"], [role="slider"], [role="tab"]';

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const lifted = (x: number, y: number, scale = 1.02) => `translate3d(${x}px, ${y}px, 0) scale(${scale})`;

export function useTileDrag(
  pageId: string,
  tiles: DashboardTileView[],
  scroller: React.RefObject<HTMLElement | null>,
  grid: React.RefObject<HTMLElement | null>,
) {
  const qc = useQueryClient();
  const [lift, setLift] = useState<Lift | null>(null);
  /** The lifted copy; it follows the pointer without a render per move. */
  const liftEl = useRef<HTMLDivElement>(null);
  /** Where the lifted copy's top left corner is on screen now. */
  const at = useRef({ x: 0, y: 0 });
  /** Where each tile showed just before the order changed, to slide it over from there. */
  const before = useRef<Map<string, DOMRect> | null>(null);
  /** Ends a drag in progress without dropping, when the page goes away under it. */
  const abort = useRef<(() => void) | null>(null);
  useEffect(() => () => abort.current?.(), []);

  const ids = tiles.map((t) => t.id);
  const order = lift ? reconcile(lift.order, ids) : ids;
  const shown = order.map((id) => tiles.find((t) => t.id === id)!);

  /** Notes where the tiles show now, then shows them in `next`; they slide over from here. */
  const reorder = (next: string[]) => {
    const g = grid.current;
    if (g) {
      const seen = new Map<string, DOMRect>();
      for (const el of g.querySelectorAll<HTMLElement>('[data-tile-id]'))
        seen.set(el.dataset.tileId!, el.getBoundingClientRect());
      before.current = seen;
    }
    setLift((l) => (l ? { ...l, order: next } : l));
  };

  // Slide every tile whose place changed from where it showed to where it is now.
  const orderKey = order.join(' ');
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    const g = grid.current;
    if (!was || !g || still()) return;
    for (const el of g.querySelectorAll<HTMLElement>('[data-tile-id]')) {
      const from = was.get(el.dataset.tileId!);
      if (!from) continue;
      for (const a of el.getAnimations()) a.cancel();
      const to = el.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: SLIDE_MS,
        easing: EASE,
      });
    }
  }, [orderKey, grid]);

  // Let go: the lifted copy glides onto the dashed place, then the tile shows there again.
  const settlingId = lift?.settling ? lift.id : null;
  useLayoutEffect(() => {
    if (!settlingId) return;
    const el = liftEl.current;
    const g = grid.current;
    const place = g?.querySelector<HTMLElement>(`[data-tile-id="${CSS.escape(settlingId)}"]`);
    const done = () => setLift(null);
    if (!el || !g || !place || still()) return done();
    const r = g.getBoundingClientRect();
    const glide = el.animate(
      [
        { transform: lifted(at.current.x, at.current.y) },
        { transform: lifted(r.left + place.offsetLeft, r.top + place.offsetTop, 1) },
      ],
      { duration: SLIDE_MS, easing: EASE, fill: 'forwards' },
    );
    glide.onfinish = done;
    glide.oncancel = done;
  }, [settlingId, grid]);

  /** Puts the tile where it now shows; the page keeps the new order before the server answers. */
  const commit = (id: string, next: string[]) => {
    const key = ['dashboard', pageId];
    const now = qc.getQueryData<DashboardView>(key)?.tiles.map((t) => t.id) ?? [];
    const final = reconcile(next, now);
    if (final.every((x, i) => x === now[i])) return;
    const beforeId = final[final.indexOf(id) + 1] ?? null;
    void qc.cancelQueries({ queryKey: key });
    qc.setQueryData<DashboardView>(key, (old) =>
      old
        ? {
            ...old,
            tiles: placeTile(
              old.tiles.map((t) => t.id),
              id,
              beforeId,
            ).map((x) => old.tiles.find((t) => t.id === x)!),
          }
        : old,
    );
    const settle = () => {
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['dashboards'] });
    };
    api.placeDashboardTile(id, beforeId).then(settle, (e: Error) => {
      toast.error(e.message);
      settle();
    });
  };

  const grab = (e: React.PointerEvent<HTMLElement>, tile: DashboardTileView) => {
    if (e.button !== 0 || e.pointerType === 'touch' || lift) return;
    if ((e.target as Element).closest(OWN_PRESS)) return;
    const box = e.currentTarget.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const grabX = startX - box.left;
    const grabY = startY - box.top;
    const original = order;
    let x = startX;
    let y = startY;
    let started = false;
    let current = original;
    /** Where the pointer was, in the page's own terms, when the tiles last shifted. */
    let shiftedAt: { x: number; y: number } | null = null;
    let edge = 0;
    let aimed = 0;

    const place = () => {
      const g = grid.current;
      const s = scroller.current;
      if (!g || !s) return;
      const sr = s.getBoundingClientRect();
      // Off the page altogether the tile would go back, so the others close up again.
      if (x < sr.left || x > sr.right || y < sr.top || y > sr.bottom) {
        if (current !== original) reorder((current = original));
        shiftedAt = null;
        return;
      }
      const gr = g.getBoundingClientRect();
      const px = x - gr.left;
      const py = y - gr.top;
      const sy = py + s.scrollTop;
      if (shiftedAt && Math.hypot(px - shiftedAt.x, sy - shiftedAt.y) < STEADY) return;
      const boxes = new Map<string, Box>();
      for (const el of g.querySelectorAll<HTMLElement>('[data-tile-id]'))
        boxes.set(el.dataset.tileId!, {
          left: el.offsetLeft,
          top: el.offsetTop,
          width: el.offsetWidth,
          height: el.offsetHeight,
        });
      const next = orderAt(current, tile.id, boxes, px, py, g.clientWidth);
      if (!next) return;
      shiftedAt = { x: px, y: sy };
      reorder((current = next));
    };
    // As the page scrolls under a still pointer other tiles pass under it; read the place again,
    // but not on every scrolled pixel, which would reflow the page each time.
    const onScroll = () => {
      const now = performance.now();
      if (now - aimed < 100) return;
      aimed = now;
      place();
    };

    const move = (ev: PointerEvent) => {
      x = ev.clientX;
      y = ev.clientY;
      at.current = { x: x - grabX, y: y - grabY };
      if (!started) {
        if (Math.hypot(x - startX, y - startY) < THRESHOLD) return;
        started = true;
        // The press began selecting the tile's text; the tile moves instead.
        window.getSelection()?.removeAllRanges();
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
        setLift({
          id: tile.id,
          order: original,
          width: box.width,
          height: box.height,
          ...at.current,
          settling: false,
        });
        // A page of tiles runs past the window: held near its top or bottom edge, it keeps
        // scrolling without the pointer moving.
        edge = window.setInterval(() => autoScroll(scroller.current, y), 16);
        scroller.current?.addEventListener('scroll', onScroll);
      }
      ev.preventDefault();
      if (liftEl.current) liftEl.current.style.transform = lifted(at.current.x, at.current.y);
      place();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !started) return;
      // Escape puts the tile back; it must not also close the dashboards.
      ev.preventDefault();
      ev.stopPropagation();
      end(ev);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', onKey, { capture: true });
      window.clearInterval(edge);
      scroller.current?.removeEventListener('scroll', onScroll);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      abort.current = null;
    };
    // Only a release over the page drops; Escape, leaving the window or a release off the page
    // put the tile back where it was.
    function end(ev: Event) {
      cleanup();
      if (!started) return;
      // The release would otherwise click whatever is under the pointer.
      const swallow = (c: MouseEvent) => (c.stopPropagation(), c.preventDefault());
      window.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (ev.type === 'pointerup') commit(tile.id, current);
      else if (current !== original) reorder(original);
      setLift((l) => (l ? { ...l, settling: true } : l));
    }
    abort.current = () => {
      cleanup();
      setLift(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', onKey, { capture: true });
  };

  /** Props for a tile: pressing it lifts it when `movable`; while it is lifted its place is dashed. */
  const itemProps = (tile: DashboardTileView, movable: boolean) => ({
    'data-tile-id': tile.id,
    onPointerDown: movable ? (e: React.PointerEvent<HTMLElement>) => grab(e, tile) : undefined,
    placeholder: lift?.id === tile.id,
  });

  /** The tile in the air for the page to draw (in an element given `liftRef`): which one and its size. */
  const air = lift && {
    tile: tiles.find((t) => t.id === lift.id),
    style: {
      // Pinned to the viewport's top left in every language: the transform moves it by the
      // pointer's and the grid's screen coordinates, which count from the left.
      position: 'fixed',
      top: 0,
      left: 0,
      width: lift.width,
      height: lift.height,
      transform: lifted(lift.x, lift.y),
    } satisfies React.CSSProperties,
  };

  return { tiles: shown, itemProps, air, liftRef: liftEl };
}

function autoScroll(el: HTMLElement | null, y: number) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (y < r.top + EDGE) el.scrollTop -= 12;
  else if (y > r.bottom - EDGE) el.scrollTop += 12;
}
