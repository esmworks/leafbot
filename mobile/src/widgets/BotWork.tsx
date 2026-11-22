import { HStack, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import { font, foregroundStyle, padding } from '@expo/ui/swift-ui/modifiers';
import { LIVE_ACTIVITY_NAME, type LiveActivityProps } from '@leafbot/shared';
import { createLiveActivity, type LiveActivityEnvironment } from 'expo-widgets';

/**
 * A bot's work on the lock screen and in the Dynamic Island: the bot's name, what it is doing and
 * how long it has been at it. The words arrive already in the person's language (the app starts it,
 * the server moves it along); the layout itself holds none. It runs apart from the app, so it uses
 * nothing from outside this function.
 */
function BotWork(props: LiveActivityProps, environment: LiveActivityEnvironment) {
  'widget';
  const dim = environment.isLuminanceReduced || environment.isStale;
  const symbol =
    props.phase === 'waiting'
      ? 'hand.raised.fill'
      : props.phase === 'done'
        ? 'checkmark.circle.fill'
        : props.phase === 'failed'
          ? 'exclamationmark.triangle.fill'
          : 'ellipsis.bubble.fill';
  // The app's green, the amber of a card that waits, and red; white when the screen is dimmed.
  const color = dim
    ? '#FFFFFF'
    : props.phase === 'waiting'
      ? '#F59E0B'
      : props.phase === 'failed'
        ? '#EF4444'
        : '#34A36A';
  const going = props.phase === 'working' || props.phase === 'waiting';
  const timer = <Text date={new Date(props.since)} dateStyle="timer" modifiers={[font({ size: 15 })]} />;
  return {
    banner: (
      <HStack modifiers={[padding({ all: 16 })]}>
        <Image systemName={symbol} color={color} size={28} />
        <VStack alignment="leading" modifiers={[padding({ leading: 10 })]}>
          <Text modifiers={[font({ weight: 'semibold', size: 17 })]}>{props.bot}</Text>
          <Text modifiers={[font({ size: 15 }), foregroundStyle(color)]}>{props.state}</Text>
        </VStack>
        <Spacer />
        {going ? timer : null}
      </HStack>
    ),
    compactLeading: <Image systemName={symbol} color={color} />,
    compactTrailing: going ? timer : <Text modifiers={[font({ size: 15 })]}>{props.state}</Text>,
    minimal: <Image systemName={symbol} color={color} />,
    expandedLeading: <Image systemName={symbol} color={color} size={28} />,
    expandedCenter: <Text modifiers={[font({ weight: 'semibold', size: 17 })]}>{props.bot}</Text>,
    expandedTrailing: going ? timer : null,
    expandedBottom: <Text modifiers={[font({ size: 15 }), foregroundStyle(color)]}>{props.state}</Text>,
  };
}

export default createLiveActivity(LIVE_ACTIVITY_NAME, BotWork);
