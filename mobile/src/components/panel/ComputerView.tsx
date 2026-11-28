import type { Bot, BrowserInput, BrowserState } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { IconButton, PillButton } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { t } from '@/i18n';
import { useInfo } from '@/lib/queries';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { STATUS } from './ComputerCard';
import { useBrowserLive, useDesktopLive, type Frame } from './live';
import { SCREEN_RATIO, StatusDot } from './parts';

/** How far a finger moves before a touch counts as a drag instead of a tap. */
const TAP_SLOP = 8;

/**
 * The bot's browser: its screen, the address bar and the buttons that take it over. Turned sideways
 * (`wide`) the screen takes the whole height and the controls sit beside it.
 */
export function BrowserView({ bot, wide = false }: { bot: Bot; wide?: boolean }) {
  const c = useColors();
  const api = useApi();
  const { data: info } = useInfo();
  const { state, frame, send, setControl } = useBrowserLive(bot.id);
  const control = state.status === 'user';
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  /** What is typed in the address bar; null shows the page's own address. */
  const [draft, setDraft] = useState<string | null>(null);
  const [typed, setTyped] = useState('');

  const toggle = async () => {
    setBusy(true);
    const r = await setControl(!control);
    setBusy(false);
    if (!r.ok) toast(r.error || t('computer.failed'), { tone: 'error' });
  };
  const openWindow = async () => {
    setOpening(true);
    try {
      await api.openBrowserWindow(bot.id, state.url ?? undefined);
    } catch (e) {
      toast((e as Error).message || t('computer.failed'), { tone: 'error' });
    } finally {
      setOpening(false);
    }
  };
  const go = () => {
    const url = draft?.trim();
    setDraft(null);
    if (url) send({ type: 'open', url });
  };
  const sendTyped = () => {
    if (typed) send({ type: 'text', text: typed });
    setTyped('');
  };

  const hint = control
    ? t('computer.controlHint')
    : state.status === 'window'
      ? t('computer.windowHint')
      : state.status === 'off'
        ? t('computer.offHint')
        : t('computer.watchHint');

  const controls = (
    <>
      <View style={styles.status}>
        <StatusDot status={state.status} />
        <Text style={[styles.statusText, { color: c.mutedForeground }]} numberOfLines={1}>
          {t(STATUS[state.status])} · {hint}
        </Text>
      </View>

      <View style={styles.bar}>
        <IconButton
          icon="arrow-left"
          label={t('computer.back')}
          disabled={!control}
          onPress={() => send({ type: 'nav', action: 'back' })}
        />
        <IconButton
          icon="arrow-right"
          label={t('computer.forward')}
          disabled={!control}
          onPress={() => send({ type: 'nav', action: 'forward' })}
        />
        <IconButton
          icon="rotate-cw"
          label={t('computer.reload')}
          disabled={!control}
          onPress={() => send({ type: 'nav', action: 'reload' })}
        />
        <TextInput
          value={draft ?? state.url ?? ''}
          editable={control}
          onChangeText={setDraft}
          onSubmitEditing={go}
          onBlur={() => setDraft(null)}
          placeholder={t('computer.address')}
          placeholderTextColor={c.mutedForeground}
          accessibilityLabel={t('computer.address')}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          style={[styles.address, { backgroundColor: c.muted, color: c.foreground }]}
        />
      </View>

      <View style={styles.actions}>
        {!control && info?.browser.window ? (
          <PillButton
            icon="external-link"
            label={t('computer.openWindow')}
            busy={opening}
            disabled={state.status === 'window'}
            onPress={() => void openWindow()}
          />
        ) : null}
        <PillButton
          icon="mouse-pointer"
          variant={control ? 'secondary' : 'primary'}
          label={control ? t('computer.release') : t('computer.take')}
          busy={busy}
          disabled={state.status === 'window'}
          onPress={() => void toggle()}
        />
      </View>
    </>
  );
  const typing = control ? (
    <View style={[styles.typeRow, wide && styles.wrap]}>
      <TextInput
        value={typed}
        onChangeText={setTyped}
        onSubmitEditing={sendTyped}
        placeholder={t('computer.typePlaceholder')}
        placeholderTextColor={c.mutedForeground}
        returnKeyType="send"
        style={[styles.typeInput, wide && styles.whole, { backgroundColor: c.muted, color: c.foreground }]}
      />
      <PillButton label={t('computer.typeSend')} onPress={sendTyped} />
      <PillButton
        icon="corner-down-left"
        label={t('computer.enter')}
        onPress={() => {
          send({ type: 'key', action: 'down', key: 'Enter' });
          send({ type: 'key', action: 'up', key: 'Enter' });
        }}
      />
    </View>
  ) : null;
  const screen = <RemoteScreen frame={frame} state={state} control={control} send={send} wide={wide} />;

  if (wide) {
    return (
      <View style={styles.wide}>
        <View style={styles.wideScreen}>{screen}</View>
        <ScrollView
          style={styles.wideSide}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {controls}
          {typing}
        </ScrollView>
      </View>
    );
  }
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      // A drag on the picture scrolls the page in the browser, not this screen.
      scrollEnabled={!control}
    >
      {controls}
      {screen}
      {typing}
    </ScrollView>
  );
}

/**
 * The live picture. With control a tap clicks and a drag scrolls, as on the web app's phone view;
 * the position is sent as a fraction of the picture so any screen size works.
 */
function RemoteScreen({
  frame,
  state,
  control,
  send,
  wide,
}: {
  frame: Frame | null;
  state: BrowserState;
  control: boolean;
  send: (input: BrowserInput) => void;
  /** Sized by the height it is given rather than by the width. */
  wide: boolean;
}) {
  const c = useColors();
  const api = useApi();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [closing, setClosing] = useState(false);
  const touch = useRef<{ x: number; y: number; lastY: number; moved: boolean } | null>(null);

  // The picture is drawn contained, so a frame of another shape than the box leaves bars; a touch
  // maps onto the picture itself, not the box.
  const fit = (() => {
    if (!frame || !frame.width || !frame.height || !size.width || !size.height) {
      return { left: 0, top: 0, width: size.width, height: size.height, scale: 2 };
    }
    const k = Math.min(size.width / frame.width, size.height / frame.height);
    const width = frame.width * k;
    const height = frame.height * k;
    return { left: (size.width - width) / 2, top: (size.height - height) / 2, width, height, scale: 1 / k };
  })();
  const point = (x: number, y: number) => {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return {
      x: clamp(fit.width ? (x - fit.left) / fit.width : 0),
      y: clamp(fit.height ? (y - fit.top) / fit.height : 0),
    };
  };
  const onTouchStart = (e: GestureResponderEvent) => {
    const { locationX: x, locationY: y } = e.nativeEvent;
    touch.current = { x, y, lastY: y, moved: false };
  };
  const onTouchMove = (e: GestureResponderEvent) => {
    const tc = touch.current;
    if (!tc) return;
    const { locationX: x, locationY: y } = e.nativeEvent;
    if (Math.hypot(x - tc.x, y - tc.y) > TAP_SLOP) tc.moved = true;
    if (!tc.moved) return;
    // A finger's travel on the picture, scaled to the browser's own pixels.
    const scale = fit.scale;
    send({
      type: 'wheel',
      ...point(x, y),
      dx: 0,
      dy: Math.max(-5000, Math.min(5000, (tc.lastY - y) * scale)),
    });
    tc.lastY = y;
  };
  const onTouchEnd = () => {
    const tc = touch.current;
    touch.current = null;
    if (!tc || tc.moved) return;
    const p = point(tc.x, tc.y);
    send({ type: 'mouse', action: 'down', ...p, button: 'left' });
    send({ type: 'mouse', action: 'up', ...p, button: 'left' });
  };

  const closeWindow = async () => {
    setClosing(true);
    try {
      await api.closeBrowserWindow(state.botId);
    } catch (e) {
      toast((e as Error).message || t('computer.failed'), { tone: 'error' });
    } finally {
      setClosing(false);
    }
  };

  return (
    <View
      style={[
        styles.screen,
        wide && styles.screenWide,
        { backgroundColor: c.muted, borderColor: control ? c.amber : c.border },
        control && styles.screenControlled,
      ]}
    >
      {/* Measured inside the border, where the touch positions are counted from. */}
      <View style={styles.inner} onLayout={(e: LayoutChangeEvent) => setSize(e.nativeEvent.layout)}>
        {state.status === 'window' ? (
          <View style={styles.note}>
            <Feather name="external-link" size={28} color={c.mutedForeground} />
            <Text style={[styles.noteText, { color: c.mutedForeground }]}>{t('computer.windowNote')}</Text>
            <PillButton
              variant="primary"
              label={closing ? t('computer.windowClosing') : t('computer.windowDone')}
              busy={closing}
              onPress={() => void closeWindow()}
            />
          </View>
        ) : frame ? (
          <Image
            source={{ uri: frame.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            // Every frame is a new address; keeping them would fill the picture cache.
            cachePolicy="none"
            accessibilityLabel={state.title ?? undefined}
          />
        ) : (
          <View style={styles.note}>
            <Feather name="monitor" size={32} color={c.mutedForeground} />
            <Text style={[styles.noteText, { color: c.mutedForeground }]}>
              {state.status === 'off' ? t('computer.offHint') : t('computer.waiting')}
            </Text>
          </View>
        )}
        {control && state.status !== 'window' ? (
          <View
            style={StyleSheet.absoluteFill}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={() => (touch.current = null)}
          />
        ) : null}
      </View>
    </View>
  );
}

const PHASE = {
  asleep: 'computer.desktop.asleep',
  starting: 'computer.desktop.starting',
  running: 'computer.desktop.running',
} as const;

/**
 * The bot's own desktop. Its live screen is a remote-desktop stream only the web viewer draws, from
 * a page of the server's own web app. The phone reaches the server only through the tunnel, which
 * carries requests and Socket.IO but cannot give a web view a page to load and sign in on, so the
 * phone shows the desktop's state and wakes it, and the screen is for the computer's app.
 */
export function DesktopView({ bot }: { bot: Bot }) {
  return <DesktopState bot={bot} />;
}

/** The desktop's state and a way to wake it. */
function DesktopState({ bot }: { bot: Bot }) {
  const c = useColors();
  const { state, wake } = useDesktopLive(bot.id);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const phase = state.status === 'off' ? 'asleep' : state.status === 'starting' ? 'starting' : 'running';
  const doWake = async () => {
    setPending(true);
    const r = await wake();
    if (mounted.current) setPending(false);
    if (!r.ok) toastError(new Error(r.error || t('computer.desktop.wakeFailed')));
  };
  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={[styles.screen, { backgroundColor: c.muted, borderColor: c.border }]}>
        <View style={styles.note}>
          <Feather name={phase === 'asleep' ? 'moon' : 'monitor'} size={32} color={c.mutedForeground} />
          <Text style={[styles.noteText, { color: c.foreground }]}>{t(PHASE[phase])}</Text>
          {phase !== 'running' ? (
            <Text style={[styles.noteText, { color: c.mutedForeground }]}>
              {t(phase === 'starting' ? 'computer.desktop.startingHint' : 'computer.desktop.asleepHint')}
            </Text>
          ) : null}
        </View>
      </View>
      {phase === 'asleep' ? (
        <View style={styles.actions}>
          <PillButton
            variant="primary"
            label={t('computer.desktop.wake')}
            busy={pending}
            onPress={() => void doWake()}
          />
        </View>
      ) : null}
      <Text style={[styles.noteText, { color: c.mutedForeground }]}>{t('computer.desktopNoScreen')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 12, paddingBottom: 32, gap: 12 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  statusText: { flex: 1, fontSize: 13, lineHeight: 18 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  address: { flex: 1, height: 36, borderRadius: 18, paddingHorizontal: 14, fontSize: 16, marginLeft: 4 },
  // On a phone the buttons take the whole width, one under the other.
  actions: { gap: 8 },
  screen: {
    width: '100%',
    aspectRatio: SCREEN_RATIO,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  screenControlled: { borderWidth: 2 },
  screenWide: { width: undefined, height: '100%', maxWidth: '100%' },
  wide: { flex: 1, flexDirection: 'row' },
  wideScreen: { flex: 1, padding: 8, alignItems: 'center', justifyContent: 'center' },
  wideSide: { width: 300, flexGrow: 0 },
  wrap: { flexWrap: 'wrap' },
  whole: { flexBasis: '100%' },
  inner: { flex: 1 },
  note: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20 },
  noteText: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeInput: { flex: 1, height: 36, borderRadius: 18, paddingHorizontal: 14, fontSize: 16 },
});
