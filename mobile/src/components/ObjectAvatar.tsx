import { activityOf, botState, type BotActivity } from '@leafbot/app/src/lib/activity';
import { gazeOf, lookTarget, sharedClock, swayAt } from '@leafbot/app/src/lib/gaze';
import { objectDefinition } from '@leafbot/app/src/lib/object-avatars';
import { CELEBRATE_MS, finishes, OBJECT_EYES, objectLook, steered } from '@leafbot/app/src/lib/object-motion';
import { Canvas, Picture, type SkPicture } from '@shopify/react-native-skia';
import { avatarFrame, createAnimator } from 'open-bot-avatar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, AppState, StyleSheet, View } from 'react-native';
import { framePicture } from '@/lib/object-paint';
import { useSummaries } from '@/lib/queries';
import { useLiveState, useStream } from '@/lib/realtime';

/**
 * - `always`: breathes, blinks and looks around while the app is open. For the bot's large avatars.
 * - `busy`: rests until the bot is at work. For lists, where the web moves an avatar on hover.
 */
export type AvatarMotion = 'always' | 'busy';

/**
 * The square of the engine's 0 0 100 100 box an avatar may paint, larger than the box: a hop, a
 * ribbon and a turned body reach past it. It holds the farthest reach of every object the app offers
 * (the sprout's, whose ribbons go furthest), so no avatar is cut off at its edge.
 */
const EXTENT = { x: -43, y: -43, size: 186 };

/** Frames per second: plenty at avatar size, and a screen of avatars stays cheap. */
const FPS = 30;

/** One clock for every moving avatar, running only while one is on screen. */
const ticks = new Set<() => void>();
let frame = 0;
let lastTick = 0;

function loop(now: number) {
  frame = requestAnimationFrame(loop);
  if (now - lastTick < 1000 / FPS - 2) return;
  lastTick = now;
  for (const tick of ticks) tick();
}

function onTick(tick: () => void) {
  ticks.add(tick);
  if (ticks.size === 1) frame = requestAnimationFrame(loop);
  return () => {
    ticks.delete(tick);
    if (!ticks.size) cancelAnimationFrame(frame);
  };
}

/** Whether the app is in front; a moving avatar rests while it is not. */
function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** The phone's Reduce Motion setting; with it on the avatar holds still. */
function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => live && setReduce(on));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** What a bot is doing in the conversation it opens to, the same for each of its avatars. */
function useBotActivity(botId: string | undefined): BotActivity {
  const summary = useSummaries().data?.find((s) => s.botId === botId);
  const threadId = summary?.threadId ?? undefined;
  const live = useLiveState(threadId);
  const stream = useStream(threadId);
  return activityOf({
    state: botState(live, summary?.state),
    pendingApprovals: summary?.pendingApprovals ?? 0,
    streaming: !!stream,
    // The phone does not follow the bot's browser; a turn that browses shows as thinking.
    browsing: false,
  });
}

/** True for a moment after the bot finishes its work, while it shows it is done. */
function useCelebration(activity: BotActivity) {
  const [previous, setPrevious] = useState(activity);
  const [celebrating, setCelebrating] = useState(false);
  if (previous !== activity) {
    setPrevious(activity);
    setCelebrating(finishes(previous, activity));
  }
  useEffect(() => {
    if (!celebrating) return;
    const timer = setTimeout(() => setCelebrating(false), CELEBRATE_MS);
    return () => clearTimeout(timer);
  }, [celebrating]);
  return celebrating;
}

type Props = {
  /** The object's id, as in `object:<id>`; one the phone does not know is drawn as the circle. */
  id: string;
  color: string;
  size: number;
  motion?: AvatarMotion;
  /** The bot's id: its avatars share one gaze, and act out what it is doing. */
  seed?: string;
  /** What the bot is doing; left out, a bot's is read from its conversation. */
  activity?: BotActivity;
};

/**
 * A bot drawn as a thing with eyes (a circle, a mug, a sprout), with volume, as the web app draws it.
 * While the bot works it acts it out: ribbons while it writes, an exclamation mark when it needs
 * someone, a look over the page while it thinks, a happy hop when it is done. A large avatar also
 * breathes and looks around at rest. The app's own mascot is no bot: it shows before a server is
 * chosen, so it reads nothing from one.
 */
export function ObjectAvatar(props: Props) {
  // Only a moving avatar acts out what its bot is doing; one that only names the bot rests, as on the web.
  return props.seed && props.motion ? (
    <BotObject {...props} />
  ) : (
    <Body {...props} activity={props.activity ?? 'idle'} />
  );
}

function BotObject(props: Props) {
  const own = useBotActivity(props.seed);
  return <Body {...props} activity={props.activity ?? own} />;
}

function Body({ id, color, size, motion, seed, activity }: Props & { activity: BotActivity }) {
  const definition = objectDefinition(id) ?? objectDefinition('circle')!;
  const [gaze] = useState(() => gazeOf(seed, activity));
  const celebrating = useCelebration(activity);
  const active = useAppActive();
  const reduce = useReduceMotion();
  const moving = !!motion && active && !reduce && (motion === 'always' || activity !== 'idle' || celebrating);
  const { state, mood } = objectLook(activity, celebrating);
  const steering = steered(activity);

  useEffect(() => gaze.setActivity(activity), [gaze, activity]);

  // At rest it is one picture, drawn again only when what it shows changes; it also stands in until a
  // moving avatar's first frame.
  const still = useMemo(
    () =>
      framePicture(
        avatarFrame(definition, { color, eyeColor: OBJECT_EYES, state, mood, reducedMotion: true }),
        size,
        EXTENT,
      ),
    [definition, color, state, mood, size],
  );

  // What the avatar acts out, read by each frame: a change eases from the pose on screen rather than
  // starting the animation again.
  const look = useRef({ state, mood, steering });
  useEffect(() => {
    look.current = { state, mood, steering };
  }, [state, mood, steering]);
  const [animator] = useState(createAnimator);

  const [live, setLive] = useState<SkPicture | null>(null);
  useEffect(() => {
    if (!moving) return;
    const draw = () => {
      const t = sharedClock();
      const { state, mood, steering } = look.current;
      // A thinking bot's look and sway, from the gaze its other avatars share.
      const steer = steering ? { look: lookTarget(gaze.look(t)), view: swayAt(t) } : null;
      const step = animator.step({
        now: t * 1000,
        state,
        mood,
        target: steer?.look ?? null,
        reducedMotion: false,
      });
      const frame = avatarFrame(definition, {
        color,
        eyeColor: OBJECT_EYES,
        state,
        mood,
        stateAge: step.stateAge,
        motionBlend: step.motionBlend,
        gaze: step.gaze,
        view: steer?.view,
        time: t,
      });
      setLive(framePicture(frame, size, EXTENT));
    };
    draw();
    const stop = onTick(draw);
    return () => {
      stop();
      // Moving again later, it starts from the picture at rest, not from where it stopped.
      setLive(null);
    };
  }, [moving, gaze, animator, definition, color, size]);

  const picture = (moving && live) || still;
  const scale = size / 100;
  // The picture reaches past the avatar's box, where a hop or a ribbon goes.
  const reach = {
    left: EXTENT.x * scale,
    top: EXTENT.y * scale,
    width: EXTENT.size * scale,
    height: EXTENT.size * scale,
  };
  return (
    <View style={{ width: size, height: size }} accessible={false} pointerEvents="none">
      <Canvas style={[styles.canvas, reach]}>
        <Picture picture={picture} />
      </Canvas>
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: { position: 'absolute' },
});
