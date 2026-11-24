import { BRAND_COLOR, DEFAULT_AVATAR, type BotMaterial, type ObjectAvatar } from '@leafbot/shared';
import type { AvatarDefinition } from 'open-bot-avatar';
import { mountAvatar, type MountedAvatar } from 'open-bot-avatar/dom';
import { useEffect, useRef, useState } from 'react';
import type { BotActivity } from '@/lib/botActivity';
import { gazeOf, lookTarget, pointerLook, sharedClock, swayAt } from '@/lib/gaze';
import { objectDefinition } from '@/lib/object-avatars';
import { CELEBRATE_MS, finishes, OBJECT_EYES, objectLook, steered } from '@/lib/object-motion';
import { cn } from '@/lib/utils';

/**
 * True for a moment after the bot finishes its work, while it shows it is done (see `finishes`).
 */
function useCelebration(activity: BotActivity) {
  const [previous, setPrevious] = useState(activity);
  const [celebrating, setCelebrating] = useState(false);
  if (previous !== activity) {
    setPrevious(activity);
    setCelebrating(finishes(previous, activity));
  }
  useEffect(() => {
    if (!celebrating) return;
    const timer = window.setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => window.clearTimeout(timer);
  }, [celebrating]);
  return celebrating;
}

/**
 * - `still`: a picture; it draws one moment and starts no clock.
 * - `hover`: moves while the window has focus: breathing, blinks, eyes on the pointer.
 * - `always`: moves as `hover` does and, large enough to hold, can be turned round by hand.
 */
export type AvatarMotion = 'still' | 'hover' | 'always';

/** The engine takes a hex colour; a CSS variable such as the brand colour is read from the page. */
function hexColor(color: string) {
  const m = /^var\((--[\w-]+)\)$/.exec(color.trim());
  if (!m) return color;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim() || BRAND_COLOR;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Radians an object avatar turns for each pixel it is dragged. */
const TURN_PER_PX = 0.012;
/** How far it tips up or down by hand: past this it would show its underside. */
const TIP_LIMIT = 1.1;
/** How long a let-go avatar takes to turn back to the person. */
const SETTLE_MS = 700;

/**
 * Lets a large object avatar be turned round by dragging it, as a thing in the hand: it follows the
 * pointer in 3D and, let go, turns back to face the person the short way round. A drag does not count
 * as a click on the button the avatar sits in.
 */
function useTurnByHand(
  host: React.RefObject<HTMLSpanElement | null>,
  avatar: React.RefObject<MountedAvatar | null>,
  on: boolean,
  /** What the avatar is drawn from: a new drawing mounts a new avatar to turn. */
  drawing: unknown,
) {
  useEffect(() => {
    const el = host.current;
    const mounted = avatar.current;
    if (!on || !el || !mounted) return;
    let view = { yaw: 0, pitch: 0 };
    let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
    let settling = 0;
    const show = (next: typeof view, holding: boolean) => {
      view = next;
      mounted.update({ view: next, holdGaze: holding });
    };
    const swallow = (e: Event) => {
      e.stopPropagation();
      e.preventDefault();
    };
    const settle = () => {
      // The short way back: a few turns round count as none.
      const from = { yaw: Math.atan2(Math.sin(view.yaw), Math.cos(view.yaw)), pitch: view.pitch };
      const start = performance.now();
      const step = (now: number) => {
        const p = reducedMotion() ? 1 : Math.min(1, (now - start) / SETTLE_MS);
        const left = (1 - p) ** 3;
        show({ yaw: from.yaw * left, pitch: from.pitch * left }, false);
        if (p < 1) settling = requestAnimationFrame(step);
      };
      settling = requestAnimationFrame(step);
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      cancelAnimationFrame(settling);
      drag = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch, moved: false };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // A pointer the page no longer knows; the drag still works while it stays over the avatar.
      }
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      show(
        {
          yaw: drag.yaw + dx * TURN_PER_PX,
          pitch: Math.min(TIP_LIMIT, Math.max(-TIP_LIMIT, drag.pitch - dy * TURN_PER_PX)),
        },
        true,
      );
    };
    const up = () => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      if (!moved) return;
      el.addEventListener('click', swallow, { capture: true, once: true });
      // A drag that ends off the avatar brings no click to swallow.
      window.setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
      settle();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return () => {
      cancelAnimationFrame(settling);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      mounted.update({ view: { yaw: 0, pitch: 0 }, holdGaze: false });
    };
    // `drawing` stands for the avatar mounted from it.
  }, [host, avatar, on, drawing]);
}

/**
 * Points an object avatar's eyes and body at the pointer anywhere on the page, the way its engine's own
 * following does, but measured against the avatar's own size (see `pointerLook`). It hands the engine a
 * look on each pointer move, at most once a frame; the engine eases towards it. When the pointer leaves
 * the window the avatar goes back to its own idle looks.
 */
function useFollowPointer(
  host: React.RefObject<HTMLSpanElement | null>,
  avatar: React.RefObject<MountedAvatar | null>,
  on: boolean,
  drawing: AvatarDefinition | undefined,
) {
  useEffect(() => {
    const el = host.current;
    const mounted = avatar.current;
    if (!on || !el || !mounted || !drawing) return;
    const eyes = { x: drawing.eyes.x / 100, y: drawing.eyes.y / 100 };
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const aim = () => {
      frame = 0;
      if (!pointer) return;
      mounted.update({ lookAt: pointerLook(pointer, el.getBoundingClientRect(), eyes) });
    };
    const move = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      if (!frame) frame = requestAnimationFrame(aim);
    };
    const leave = () => {
      pointer = null;
      mounted.update({ lookAt: null });
    };
    // Leaving the window shows up as an `out` with no related target.
    const out = (e: PointerEvent) => {
      if (!e.relatedTarget) leave();
    };
    window.addEventListener('pointermove', move, { passive: true });
    window.addEventListener('pointerdown', move, { passive: true });
    window.addEventListener('pointerout', out);
    window.addEventListener('blur', leave);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', move);
      window.removeEventListener('pointerout', out);
      window.removeEventListener('blur', leave);
      mounted.update({ lookAt: null });
    };
  }, [host, avatar, on, drawing]);
}

/**
 * A bot drawn as a thing with eyes (a circle, a mug, a lightbulb), with volume. It does not wait to be
 * pointed at: while the window has the focus it breathes, blinks and looks at the pointer wherever it
 * is on the page, which is what makes these avatars feel alive. The engine itself stops
 * one that is off screen and follows the system's reduced motion setting; `still` draws one picture.
 * A fluffy body is a coat of fur; where the page can't draw one (no WebGL2) it comes out flat.
 */
export function ObjectArt({
  id,
  color,
  activity = 'idle',
  motion = 'still',
  seed,
  turnable = false,
  material = 'flat',
}: {
  id: ObjectAvatar;
  color: string;
  /** How the body is finished: a plain fill or a coat of fur. */
  material?: BotMaterial;
  activity?: BotActivity;
  motion?: AvatarMotion;
  /** The bot's id: its avatars share one gaze, so they look the same way at once. */
  seed?: string;
  /** Can be turned round by dragging it; for a large avatar. */
  turnable?: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const avatar = useRef<MountedAvatar | null>(null);
  const [focused, setFocused] = useState(true);
  const [gaze] = useState(() => gazeOf(seed, activity));
  const moving = motion !== 'still' && focused;
  const definition = objectDefinition(id);
  const steering = moving && steered(activity);
  const celebrating = useCelebration(activity);
  const turning = turnable && moving && !steering;

  useEffect(() => gaze.setActivity(activity), [gaze, activity]);

  // It rests while another app has the focus.
  useEffect(() => {
    if (motion === 'still') return;
    const sync = () => setFocused(document.hasFocus());
    sync();
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    };
  }, [motion]);

  useEffect(() => {
    const el = host.current;
    if (!el || !definition) return;
    avatar.current = mountAvatar(el, { definition, eyeColor: OBJECT_EYES, label: '' });
    return () => {
      avatar.current?.destroy();
      avatar.current = null;
    };
  }, [definition]);

  // After the mount above, so the avatar it turns is there.
  useTurnByHand(host, avatar, turning, definition);
  useFollowPointer(host, avatar, moving && !steering, definition);

  useEffect(() => {
    avatar.current?.update({
      color: hexColor(color),
      eyeColor: OBJECT_EYES,
      ...objectLook(activity, celebrating),
      material,
      still: !moving,
      // Followed by `useFollowPointer`, which reaches further for a small avatar.
      followPointer: false,
    });
  });

  // A thinking bot's look and sway, frame by frame, from the gaze its other avatars share.
  useEffect(() => {
    if (!steering || reducedMotion()) return;
    let frame = 0;
    const step = () => {
      const t = sharedClock();
      avatar.current?.update({ lookAt: lookTarget(gaze.look(t)), view: swayAt(t) });
      frame = requestAnimationFrame(step);
    };
    step();
    return () => {
      cancelAnimationFrame(frame);
      avatar.current?.update({ lookAt: null, view: { yaw: 0, pitch: 0 } });
    };
  }, [steering, gaze]);

  return (
    <span
      ref={host}
      className={cn('block size-full', turning && 'cursor-grab touch-none active:cursor-grabbing')}
      aria-hidden
    />
  );
}

export function BotAvatar({
  avatar,
  color,
  size = 40,
  className,
  badge,
  activity,
  motion = 'hover',
  seed,
  material,
}: {
  avatar: string;
  color: string;
  /** How an object avatar's body is finished; an uploaded picture has no body to finish. */
  material?: BotMaterial;
  size?: number;
  className?: string;
  badge?: React.ReactNode;
  /** Animates the avatar; leave out where the avatar only identifies the bot. */
  activity?: BotActivity;
  /** How an animated avatar moves; see `AvatarMotion`. */
  motion?: Exclude<AvatarMotion, 'still'>;
  /** The bot's id: its avatars share one gaze, so they look the same way at once. */
  seed?: string;
}) {
  const lively = activity !== undefined;
  const isImage = avatar.startsWith('data:image/');
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {isImage ? (
        <img
          src={avatar}
          alt=""
          className={cn(
            'av-img size-full rounded-full object-cover',
            activity && activity !== 'idle' && `av-${activity}`,
          )}
          draggable={false}
        />
      ) : (
        <ObjectArt
          // An old shape the server has not turned into the round object yet is drawn as one.
          id={(avatar.startsWith('object:') ? avatar : DEFAULT_AVATAR).slice(7) as ObjectAvatar}
          color={color}
          activity={activity}
          motion={lively ? motion : 'still'}
          seed={seed}
          turnable={lively && motion === 'always'}
          material={material}
        />
      )}
      {badge}
    </span>
  );
}
