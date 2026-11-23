import { pickSkill, skillQuery } from '@leafbot/app/src/lib/skillTag';
import { goalCommand, slashMatches, slashQuery, type SlashCommand } from '@leafbot/app/src/lib/slash';
import { hasSecretShape, type Message } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Sheet } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useSkills } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { writeStored, useStored } from '@/lib/stored';
import { useColors } from '@/lib/theme';
import { useAttachments, type Attachment, type Picked, type StagedFile } from './attachments';
import { replyExcerpt } from './text';

/** What goes with a message besides its text. */
export interface SendExtra {
  files: StagedFile[];
  replyTo?: { id: string; text: string };
}

/**
 * The contract the chat and room screens build on. The props marked required stay as they are,
 * and a room passes only those (and, to answer a message, `replyTo` and `onReplyChange`).
 */
export interface ComposerProps {
  /** Where the unsent text is kept on the phone: a conversation's or a room's id. */
  draftKey: string;
  placeholder: string;
  /** A turn is running: the send button becomes a stop button. */
  running: boolean;
  /** Sends the text; resolves to an error to show, or null when sent. */
  onSend: (text: string, extra?: SendExtra) => Promise<string | null>;
  onStop?: () => void;
  /** A bot's own conversation: attachments, `$skill`, `/` commands and goals are offered. */
  bot?: { botId: string; threadId: string };
  /** The color of the send button; the bot's. */
  color?: string;
  /** The message being answered, quoted above the text box until sent or cancelled. */
  replyTo?: Message | null;
  onReplyChange?: (m: Message | null) => void;
  /** Runs a `/` command the box cannot run itself (everything but `/goal` and `/stop`). */
  onCommand?: (c: SlashCommand) => void;
}

/** How long typing pauses before the draft is saved. */
const DRAFT_PAUSE_MS = 400;

type Option =
  { kind: 'command'; id: SlashCommand } | { kind: 'skill'; name: string; description: string; tag: boolean };

export function Composer({
  draftKey,
  placeholder,
  running,
  onSend,
  onStop,
  bot,
  color,
  replyTo = null,
  onReplyChange,
  onCommand,
}: ComposerProps) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardShown();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const attachments = useAttachments(bot?.threadId);
  const [attachOpen, setAttachOpen] = useState(false);

  // The unsent text stays with its conversation: leaving and coming back, or closing the app, keeps it.
  const storeKey = `leafbot.draft.${origin}.${draftKey}`;
  const [stored, , loaded] = useStored<string>(storeKey, '');
  const [text, setText] = useState('');
  // The box is not handed its text back on every keystroke: iOS's predictive text, autocorrect and
  // swipe typing lose their place when a box being typed in has its text set again. What the app
  // writes into the box itself (a saved draft, a picked skill, a command) remounts it with that text.
  const [box, setBox] = useState({ key: 0, text: '', focus: false });
  const [fitHeight, setFitHeight] = useState(0);
  const write = (next: string, focus = false) => {
    setText(next);
    setBox((b) => ({ key: b.key + 1, text: next, focus }));
  };
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState(false);
  if (loaded && !seeded) {
    setSeeded(true);
    if (stored && !text) write(stored);
  }
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
    if (!seeded) return;
    const timer = setTimeout(() => writeStored(storeKey, text.trim() ? text : undefined), DRAFT_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [text, seeded, storeKey]);
  const wasSeeded = useRef(false);
  useEffect(() => {
    wasSeeded.current = seeded;
  }, [seeded]);
  useEffect(
    () => () => {
      if (wasSeeded.current) writeStored(storeKey, latest.current.trim() ? latest.current : undefined);
    },
    [storeKey],
  );

  // Picking a message to answer is asking to write, so the text box takes focus.
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [closed, setClosed] = useState(false);
  const { data: allSkills = [] } = useSkills();
  const botSkills = useMemo(
    () => (bot ? allSkills.filter((k) => k.botIds.includes(bot.botId)) : []),
    [allSkills, bot],
  );

  // Typing `$` lists the bot's skills; the picked one is named in the message for the bot to read.
  const caret = selection
    ? selection.start === selection.end
      ? Math.min(selection.start, text.length)
      : null
    : text.length;
  const tag = bot && caret !== null ? skillQuery(text, caret) : null;
  // A text of just `/` and letters lists what the box can do itself, without asking the bot.
  const slash = bot && onCommand ? slashQuery(text) : null;

  const options = useMemo((): Option[] => {
    if (slash !== null) {
      const commands = slashMatches(
        slash,
        (cmd) => t(`slash.${cmd}`),
        // Shortcuts are for a keyboard.
        (cmd) => cmd !== 'shortcuts' && (cmd !== 'stop' || running),
      ).map((id) => ({ kind: 'command' as const, id }));
      const skills = botSkills
        .filter((k) => k.name.includes(slash))
        .slice(0, 5)
        .map((k) => ({ kind: 'skill' as const, name: k.name, description: k.description, tag: false }));
      return [...commands, ...skills];
    }
    if (!tag) return [];
    const q = tag.query.toLocaleLowerCase();
    return botSkills
      .filter(
        (k) => k.name.toLocaleLowerCase().includes(q) || k.description.toLocaleLowerCase('tr').includes(q),
      )
      .sort(
        (a, b) =>
          Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name),
      )
      .slice(0, 8)
      .map((k) => ({ kind: 'skill' as const, name: k.name, description: k.description, tag: true }));
  }, [slash, tag, botSkills, running]);
  const menu = !closed && options.length > 0;

  const run = (o: Option) => {
    if (o.kind === 'skill') {
      if (o.tag && caret !== null) {
        const next = pickSkill(text, caret, o.name);
        if (next) {
          write(next.text, true);
          setSelection({ start: next.caret, end: next.caret });
        }
      } else {
        write(`$${o.name} `, true);
      }
      return;
    }
    if (o.id === 'goal') {
      // The goal itself is typed after the command, then sent.
      write('/goal ', true);
      return;
    }
    clear();
    if (o.id === 'stop') onStop?.();
    else onCommand?.(o.id);
  };

  /** Empties the box in place, so the keyboard stays up after sending. */
  const clear = () => {
    setText('');
    input.current?.clear();
  };

  const empty = text.trim().length === 0;
  const ready = attachments.items.length > 0 && !attachments.uploading;
  const canSend = !attachments.uploading && (!empty || ready);
  const stopping = running && empty && attachments.items.length === 0;
  // A bot's conversation sends in its colour; a room in the plain primary colour.
  const tint = color ?? c.primary;

  const submit = async () => {
    const value = text.trim();
    if (!canSend) return;
    // `/goal …` sets what the conversation is for instead of being sent.
    const goal = bot ? goalCommand(value) : null;
    if (bot && goal !== null && attachments.items.length === 0) {
      clear();
      try {
        await api.setGoal(bot.threadId, goal);
        void qc.invalidateQueries({ queryKey: ['threads', origin, bot.botId] });
        void qc.invalidateQueries({ queryKey: ['main-thread', origin, bot.botId] });
        void qc.invalidateQueries({ queryKey: ['thread', origin, bot.threadId] });
        toast(goal ? t('goal.set') : t('goal.cleared'));
      } catch (e) {
        toastError(e);
      }
      return;
    }
    const files = attachments.take();
    const answered = replyTo;
    clear();
    setError(null);
    onReplyChange?.(null);
    const failed = await onSend(value, {
      files,
      replyTo: answered ? { id: answered.id, text: replyExcerpt(answered) } : undefined,
    });
    if (failed) {
      // Put it all back so nothing typed or attached is lost.
      if (!latest.current) write(value);
      attachments.restore(files);
      if (answered) onReplyChange?.(answered);
      setError(failed);
    }
  };

  const picked = (files: Picked[]) => attachments.add(files);
  const pickPhotos = async () => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: 10,
      });
      if (!r.canceled)
        picked(
          r.assets.map((a) => ({
            uri: a.uri,
            name: a.fileName || photoName(a.uri),
            size: a.fileSize,
            mimeType: a.mimeType ?? 'image/jpeg',
          })),
        );
    } catch (e) {
      toastError(e);
    }
  };
  const takePhoto = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) return toast(t('chat.cameraDenied'), { tone: 'error' });
      const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'] });
      if (!r.canceled)
        picked(
          r.assets.map((a) => ({
            uri: a.uri,
            name: a.fileName || photoName(a.uri),
            size: a.fileSize,
            mimeType: a.mimeType ?? 'image/jpeg',
          })),
        );
    } catch (e) {
      toastError(e);
    }
  };
  const pickFiles = async () => {
    try {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
      if (!r.canceled)
        picked(r.assets.map((a) => ({ uri: a.uri, name: a.name, size: a.size, mimeType: a.mimeType })));
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <View style={[styles.wrap, { paddingBottom: keyboard ? 8 : Math.max(insets.bottom, 8) }]}>
      {menu ? (
        <View style={[styles.menu, { backgroundColor: c.card, borderColor: c.border }]}>
          <ScrollView keyboardShouldPersistTaps="always" style={styles.menuScroll}>
            {options.map((o) => (
              <Pressable
                key={o.kind === 'command' ? o.id : `skill:${o.name}`}
                accessibilityRole="button"
                onPress={() => run(o)}
                style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.accent }]}
              >
                {o.kind === 'command' ? (
                  <>
                    <Text style={[styles.optionTag, { color: c.mutedForeground }]}>/{o.id}</Text>
                    <Text style={[styles.optionText, { color: c.foreground }]} numberOfLines={1}>
                      {t(`slash.${o.id}`)}
                    </Text>
                  </>
                ) : (
                  <>
                    <Feather name="zap" size={16} color={c.mutedForeground} />
                    <Text style={[styles.optionText, { color: c.foreground }]} numberOfLines={1}>
                      <Text style={styles.optionName}>{o.tag ? `$${o.name}` : o.name}</Text>
                      {o.description ? (
                        <Text style={{ color: c.mutedForeground }}> · {o.description}</Text>
                      ) : null}
                    </Text>
                  </>
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
      {error ? <Text style={[styles.error, { color: c.destructive }]}>{error}</Text> : null}
      {hasSecretShape(text) ? (
        // A key typed here reaches the model and stays in the conversation; the vault keeps it
        // where no bot sees it. Sending is still the person's call.
        <Pressable
          accessibilityRole="button"
          accessibilityHint={t('chat.secretToVault')}
          onPress={() => nav.settings('vault')}
          style={[styles.secret, { borderColor: '#f59e0b66', backgroundColor: '#f59e0b14' }]}
        >
          <Feather name="shield" size={18} color="#f59e0b" />
          <Text style={[styles.secretText, { color: c.foreground }]}>{t('chat.secretWarning')}</Text>
          <Text style={[styles.secretText, { color: c.primary, flex: 0 }]}>{t('chat.secretToVault')}</Text>
        </Pressable>
      ) : null}
      <View style={[styles.card, { borderColor: c.border, backgroundColor: c.card }]}>
        {replyTo ? (
          <View style={[styles.reply, { backgroundColor: c.muted }]}>
            <Feather name="corner-up-left" size={20} color={c.mutedForeground} />
            <Text style={[styles.replyText, { color: c.mutedForeground }]} numberOfLines={1}>
              {replyExcerpt(replyTo)}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.cancelReply')}
              onPress={() => onReplyChange?.(null)}
              hitSlop={8}
              style={styles.replyClose}
            >
              <Feather name="x" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>
        ) : null}
        {attachments.items.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            {attachments.items.map((a) => (
              <Chip
                key={a.key}
                item={a}
                onRemove={() => attachments.remove(a)}
                onRetry={() => attachments.retry(a)}
              />
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.row}>
          {bot ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('chat.attach')}
              onPress={() => setAttachOpen(true)}
              style={styles.round}
            >
              <Feather name="paperclip" size={24} color={c.mutedForeground} />
            </Pressable>
          ) : null}
          {/* The box takes its height from this hidden copy of its text rather than from the text box itself:
              on iPhones a box that is not handed its text back (see `box` above) stayed one line high while
              its text wrapped. A text that ends in a line break gets a zero-width character, so the empty last
              line counts too. */}
          <Text
            aria-hidden
            onLayout={(e) => setFitHeight(e.nativeEvent.layout.height)}
            style={[
              styles.input,
              !bot && styles.inputPlain,
              styles.mirror,
              { left: bot ? styles.round.width : 0, right: styles.round.width },
            ]}
          >
            {(text || (replyTo ? t('chat.replyPlaceholder') : placeholder)) +
              (text.endsWith('\n') ? '\u200b' : '')}
          </Text>
          <TextInput
            key={box.key}
            ref={input}
            defaultValue={box.text}
            autoFocus={box.focus}
            onChangeText={(v) => {
              setText(v);
              setClosed(false);
              setError(null);
            }}
            onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
            onBlur={() => setSelection(null)}
            placeholder={replyTo ? t('chat.replyPlaceholder') : placeholder}
            placeholderTextColor={c.mutedForeground}
            style={[
              styles.input,
              !bot && styles.inputPlain,
              { color: c.foreground },
              fitHeight ? { height: Math.min(fitHeight, INPUT_MAX_HEIGHT) } : null,
            ]}
            multiline
            accessibilityLabel={placeholder}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={stopping ? t('chat.stop') : t('chat.send')}
            onPress={() => (stopping ? onStop?.() : void submit())}
            disabled={stopping ? false : !canSend}
            style={[
              styles.round,
              stopping ? { backgroundColor: c.muted } : { backgroundColor: tint, opacity: canSend ? 1 : 0.5 },
            ]}
          >
            {stopping ? (
              <View style={[styles.stopSquare, { backgroundColor: c.foreground }]} />
            ) : (
              <Feather name="arrow-up" size={24} color={color ? '#FFFFFF' : c.primaryForeground} />
            )}
          </Pressable>
        </View>
      </View>
      {bot ? (
        <Sheet
          open={attachOpen}
          onClose={() => setAttachOpen(false)}
          title={t('chat.attach')}
          items={[
            { icon: 'image', label: t('chat.attachPhoto'), onPress: () => void pickPhotos() },
            { icon: 'camera', label: t('chat.attachCamera'), onPress: () => void takePhoto() },
            { icon: 'file', label: t('chat.attachFile'), onPress: () => void pickFiles() },
          ]}
        />
      ) : null}
    </View>
  );
}

function Chip({ item, onRemove, onRetry }: { item: Attachment; onRemove: () => void; onRetry: () => void }) {
  const c = useColors();
  return (
    <View
      style={[
        styles.chip,
        { borderColor: item.error ? c.destructive : c.border, backgroundColor: c.background },
        !item.saved && !item.error && { opacity: 0.7 },
      ]}
    >
      <View style={[styles.thumb, { backgroundColor: c.muted }]}>
        {item.error ? (
          <Feather name="alert-circle" size={20} color={c.destructive} />
        ) : !item.saved ? (
          <ActivityIndicator
            size="small"
            color={c.mutedForeground}
            accessibilityLabel={t('chat.uploading')}
          />
        ) : item.preview ? (
          <Image source={{ uri: item.preview }} style={styles.thumbImage} contentFit="cover" />
        ) : (
          <Feather name="file-text" size={20} color={c.mutedForeground} />
        )}
      </View>
      <Text style={[styles.chipName, { color: c.foreground }]} numberOfLines={1}>
        {item.name}
      </Text>
      {item.error ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('chat.retryUpload', { name: item.name })}
          accessibilityHint={t('chat.uploadNotDone')}
          onPress={onRetry}
          hitSlop={8}
          style={styles.chipRemove}
        >
          <Feather name="rotate-cw" size={16} color={c.mutedForeground} />
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('chat.removeFile', { name: item.name })}
        onPress={onRemove}
        hitSlop={8}
        style={styles.chipRemove}
      >
        <Feather name="x" size={16} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

/** A name for a photo that came without one, keeping the picture's own extension. */
function photoName(uri: string): string {
  const ext = /\.([A-Za-z0-9]{2,5})(?:\?|$)/.exec(uri)?.[1]?.toLowerCase() ?? 'jpg';
  return `photo-${Date.now()}.${ext}`;
}

/** Whether the on-screen keyboard is up, so the box drops the home-indicator gap under it. */
function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setShown(true));
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setShown(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return shown;
}

/** The text box grows with its text up to this height, then scrolls. */
const INPUT_MAX_HEIGHT = 160;

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 12, paddingTop: 4, gap: 6 },
  error: { fontSize: 15, textAlign: 'center' },
  secret: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
  },
  secretText: { flex: 1, fontSize: 13 },
  menu: { borderWidth: 1, borderRadius: 16, overflow: 'hidden' },
  menuScroll: { maxHeight: 232 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 14 },
  optionTag: { width: 78, fontSize: 15, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  optionText: { flex: 1, fontSize: 17 },
  optionName: { fontWeight: '600' },
  card: {
    borderWidth: 1,
    borderRadius: 24,
    padding: 4,
    shadowColor: '#000000',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  reply: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    margin: 4,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    borderRadius: 16,
  },
  replyText: { flex: 1, fontSize: 16 },
  replyClose: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  chips: { gap: 8, paddingHorizontal: 8, paddingTop: 6, paddingBottom: 2 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: 220,
    padding: 5,
    paddingRight: 6,
    borderWidth: 1,
    borderRadius: 14,
  },
  thumb: {
    width: 32,
    height: 32,
    borderRadius: 9,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbImage: { width: 32, height: 32 },
  chipName: { flexShrink: 1, fontSize: 16 },
  chipRemove: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  round: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    fontSize: 17,
    lineHeight: 23,
    maxHeight: INPUT_MAX_HEIGHT,
    paddingHorizontal: 8,
    paddingTop: 7,
    paddingBottom: 7,
  },
  inputPlain: { paddingHorizontal: 12 },
  mirror: { position: 'absolute', top: 0, maxHeight: undefined, opacity: 0 },
  stopSquare: { width: 12, height: 12, borderRadius: 2 },
});
