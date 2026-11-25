import {
  cardDefaults,
  cardLink,
  cardPress,
  checkCardValues,
  storedCard,
  type Card,
  type CardNode,
  type CardOption,
  type CardValues,
  type Message,
} from '@leafbot/shared';
import { INTL_LOCALE } from '@leafbot/shared/i18n';
import Feather from '@expo/vector-icons/Feather';
import { useMutation } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useState, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Markdown } from '@/components/Markdown';
import { toastError } from '@/components/overlay';
import { PillButton, Sheet, type IconName } from '@/components/page';
import { locale, t } from '@/i18n';
import { dayAllowed, monthGrid, monthOf, shiftMonth } from '@/lib/calendar';
import { useApi } from '@/lib/server';
import { useColors, type Colors } from '@/lib/theme';
import { CardChart, CardProgress, CardStat } from './CardChart';

/** ChatKit's icon names drawn with the phone's icon set; the nearest one where it has none. */
const ICONS: Record<string, IconName> = {
  agent: 'cpu',
  analytics: 'bar-chart-2',
  atom: 'aperture',
  batch: 'layers',
  bolt: 'zap',
  'book-open': 'book-open',
  'book-closed': 'book',
  'book-clock': 'book',
  bug: 'alert-octagon',
  calendar: 'calendar',
  chart: 'trending-up',
  check: 'check',
  'check-circle': 'check-circle',
  'check-circle-filled': 'check-circle',
  'chevron-left': 'chevron-left',
  'chevron-right': 'chevron-right',
  'circle-question': 'help-circle',
  clock: 'clock',
  compass: 'compass',
  confetti: 'gift',
  cube: 'box',
  desktop: 'monitor',
  document: 'file-text',
  dot: 'circle',
  'dots-horizontal': 'more-horizontal',
  'dots-vertical': 'more-vertical',
  'empty-circle': 'circle',
  'external-link': 'external-link',
  globe: 'globe',
  keys: 'key',
  lab: 'droplet',
  images: 'image',
  info: 'info',
  lifesaver: 'life-buoy',
  lightbulb: 'sun',
  mail: 'mail',
  'map-pin': 'map-pin',
  maps: 'map',
  mobile: 'smartphone',
  name: 'user',
  notebook: 'book',
  'notebook-pencil': 'edit',
  'page-blank': 'file',
  phone: 'phone',
  play: 'play',
  plus: 'plus',
  profile: 'user',
  'profile-card': 'user',
  reload: 'refresh-cw',
  star: 'star',
  'star-filled': 'star',
  search: 'search',
  sparkle: 'star',
  'sparkle-double': 'star',
  'square-code': 'code',
  'square-image': 'image',
  'square-text': 'file-text',
  suitcase: 'briefcase',
  'settings-slider': 'sliders',
  user: 'user',
  wreath: 'award',
  write: 'edit-2',
  'write-alt': 'edit-3',
  'write-alt2': 'edit',
};

const TEXT_SIZE: Record<string, number> = { xs: 12, sm: 14, md: 15, lg: 16, xl: 18 };
const TITLE_SIZE: Record<string, number> = {
  sm: 14,
  md: 16,
  lg: 18,
  xl: 20,
  '2xl': 22,
  '3xl': 24,
  '4xl': 26,
  '5xl': 28,
};
const WEIGHT: Record<string, TextStyle['fontWeight']> = {
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
};
const ICON_SIZE: Record<string, number> = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, '2xl': 28, '3xl': 32 };
const ALIGN: Record<string, ViewStyle['alignItems']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  baseline: 'baseline',
  stretch: 'stretch',
};
const JUSTIFY: Record<string, ViewStyle['justifyContent']> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
  evenly: 'space-evenly',
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

function textColor(c: Colors, color: unknown): string | undefined {
  switch (color) {
    case 'primary':
    case 'emphasis':
      return c.foreground;
    case 'secondary':
    case 'tertiary':
      return c.mutedForeground;
    case 'success':
      return c.success;
    case 'warning':
      return c.amber;
    case 'danger':
      return c.destructive;
    default:
      return undefined;
  }
}

function badgeColors(c: Colors, color: unknown): { bg: string; fg: string } {
  switch (color) {
    case 'success':
      return { bg: 'rgba(52,211,153,0.15)', fg: c.success };
    case 'danger':
      return { bg: 'rgba(239,68,68,0.15)', fg: c.destructive };
    case 'warning':
      return { bg: c.amberSoft, fg: c.amber };
    case 'info':
      return { bg: 'rgba(14,165,233,0.15)', fg: c.unread };
    case 'discovery':
      return { bg: 'rgba(139,92,246,0.15)', fg: '#8B5CF6' };
    default:
      return { bg: c.muted, fg: c.foreground };
  }
}

interface Answer {
  node: string;
  label: string;
  values: CardValues;
}

interface Ctx {
  card: Card;
  values: CardValues;
  set(name: string, v: string | boolean): void;
  press(ref: string): void;
  locked: boolean;
  pressed?: string;
  c: Colors;
}

/**
 * A card a bot showed with show_card, drawn with the phone's own views. A press checks the
 * fields it sends, then goes to the server; the answer arrives as the person's next message and
 * the card shows what was sent.
 */
export function ChatCard({ m }: { m: Message }) {
  const card = storedCard(m.props.card);
  if (!card) return null;
  const rev = Number(m.props.cardRev ?? 1);
  return <CardBody key={rev} m={m} card={card} rev={rev} />;
}

function CardBody({ m, card, rev }: { m: Message; card: Card; rev: number }) {
  const c = useColors();
  const api = useApi();
  const answer = m.props.cardAnswered === true ? (m.props.cardAnswer as Answer | undefined) : undefined;
  const [values, setValues] = useState<CardValues>(() => ({ ...cardDefaults(card), ...answer?.values }));
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (o: { node: string; values: CardValues }) =>
      api.answerCard(m.id, { node: o.node, rev, values: o.values }),
    onError: toastError,
  });
  const locked = m.props.cardAnswered === true || send.isPending;
  const press = (ref: string) => {
    if (locked) return;
    const p = cardPress(card, ref);
    if (!p) return;
    const link = cardLink(p.action);
    if (link) {
      void WebBrowser.openBrowserAsync(link);
      return;
    }
    const checked = checkCardValues(p, values);
    if (!checked.ok) {
      setProblem(t(`card.value.${checked.issue}`, { field: checked.field.label }));
      return;
    }
    setProblem(null);
    send.mutate({ node: ref, values: checked.values });
  };
  const ctx: Ctx = {
    card,
    values,
    // A change may fix what the last press found missing, so its message goes; the next press checks again.
    set: (name, v) => {
      setProblem(null);
      setValues((s) => ({ ...s, [name]: v }));
    },
    press,
    locked,
    pressed: answer?.node,
    c,
  };
  const root = card.root;
  const ends = (['confirm', 'cancel'] as const)
    .map((key) => ({ key, b: root[key] as { label: string } | undefined }))
    .filter((x): x is { key: 'confirm' | 'cancel'; b: { label: string } } => !!x.b);
  return (
    <View style={[styles.card, { borderColor: c.border, backgroundColor: c.card }]}>
      {root.type === 'ListView' ? <ListView node={root} ctx={ctx} /> : <Children node={root} ctx={ctx} />}
      {ends.length ? (
        <View style={styles.ends}>
          {ends.map(({ key, b }) => (
            <PillButton
              key={key}
              label={b.label}
              variant={key === 'cancel' ? 'ghost' : 'primary'}
              icon={ctx.pressed === key ? 'check' : undefined}
              busy={send.isPending && send.variables?.node === key}
              disabled={locked && ctx.pressed !== key}
              onPress={() => press(key)}
            />
          ))}
        </View>
      ) : null}
      {problem && !locked ? <Text style={[styles.small, { color: c.destructive }]}>{problem}</Text> : null}
      {answer ? (
        <View style={styles.answered}>
          <Feather name="check" size={13} color={c.mutedForeground} />
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {t('card.answered', { label: answer.label })}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Children({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  return (
    <>
      {(node.children ?? []).map((ch) => (
        <Part key={ch.id} node={ch} ctx={ctx} />
      ))}
    </>
  );
}

function boxStyle(node: CardNode, dir: 'row' | 'col'): ViewStyle {
  return {
    flexDirection: dir === 'row' ? 'row' : 'column',
    alignItems: ALIGN[str(node.align)] ?? (dir === 'row' ? 'center' : undefined),
    justifyContent: JUSTIFY[str(node.justify)],
    flexWrap: node.wrap === 'wrap' ? 'wrap' : node.wrap === 'wrap-reverse' ? 'wrap-reverse' : undefined,
    gap: (typeof node.gap === 'number' ? node.gap : dir === 'row' ? 2 : 3) * 4,
    ...(typeof node.flex === 'number' && { flex: node.flex }),
    minWidth: 0,
  };
}

function ListView({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const rows = node.children ?? [];
  const limit = typeof node.limit === 'number' ? node.limit : rows.length;
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <View>
      {shown.map((row, i) => {
        const inner = (
          <View style={boxStyle({ ...row, align: row.align ?? 'center' }, 'row')}>
            <Children node={row} ctx={ctx} />
          </View>
        );
        const line =
          i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: ctx.c.border } : null;
        return row.onClickAction ? (
          <Pressable
            key={row.id}
            accessibilityRole="button"
            disabled={ctx.locked}
            onPress={() => ctx.press(row.id)}
            style={({ pressed }) => [
              styles.row,
              line,
              (pressed || ctx.pressed === row.id) && { backgroundColor: ctx.c.accent },
            ]}
          >
            {inner}
          </Pressable>
        ) : (
          <View key={row.id} style={[styles.row, line]}>
            {inner}
          </View>
        );
      })}
      {shown.length < rows.length ? (
        <PillButton label={t('card.showMore')} variant="ghost" onPress={() => setAll(true)} />
      ) : null}
    </View>
  );
}

function Part({ node, ctx }: { node: CardNode; ctx: Ctx }): ReactNode {
  const { c } = ctx;
  switch (node.type) {
    case 'Row':
    case 'Col':
    case 'Box':
    case 'Form':
      return (
        <View style={boxStyle(node, node.type === 'Row' || node.direction === 'row' ? 'row' : 'col')}>
          <Children node={node} ctx={ctx} />
        </View>
      );
    case 'Spacer':
      return <View style={styles.spacer} />;
    case 'Divider':
      return (
        <View style={[styles.divider, { backgroundColor: c.border }, node.flush === true && styles.flush]} />
      );
    case 'Text':
    case 'Title':
    case 'Caption': {
      const title = node.type === 'Title';
      const caption = node.type === 'Caption';
      const size = title
        ? (TITLE_SIZE[str(node.size)] ?? 16)
        : caption
          ? node.size === 'lg'
            ? 14
            : 12
          : (TEXT_SIZE[str(node.size)] ?? 15);
      return (
        <Text
          numberOfLines={
            typeof node.maxLines === 'number' ? node.maxLines : node.truncate === true ? 1 : undefined
          }
          style={[
            {
              fontSize: size,
              lineHeight: Math.round(size * 1.4),
              color: textColor(c, node.color) ?? (caption ? c.mutedForeground : c.foreground),
              fontWeight: WEIGHT[str(node.weight)] ?? (title ? '600' : undefined),
              textAlign:
                node.textAlign === 'center' ? 'center' : node.textAlign === 'end' ? 'right' : undefined,
              fontStyle: node.italic === true ? 'italic' : undefined,
              textDecorationLine: node.lineThrough === true ? 'line-through' : undefined,
            },
            styles.shrink,
          ]}
        >
          {str(node.value)}
        </Text>
      );
    }
    case 'Markdown':
      return (
        <Markdown text={str(node.value)} palette={{ text: c.foreground, code: c.muted, line: c.border }} />
      );
    case 'Badge': {
      const tone = badgeColors(c, node.color);
      const outline = node.variant === 'outline';
      return (
        <View
          style={[
            styles.badge,
            node.pill === true && styles.pill,
            outline ? { borderWidth: 1, borderColor: c.outline } : { backgroundColor: tone.bg },
          ]}
        >
          <Text style={[styles.badgeText, { color: outline ? c.foreground : tone.fg }]}>
            {str(node.label)}
          </Text>
        </View>
      );
    }
    case 'Icon':
      return (
        <Feather
          name={ICONS[str(node.name)] ?? 'circle'}
          size={ICON_SIZE[str(node.size)] ?? 16}
          color={textColor(c, node.color) ?? c.foreground}
        />
      );
    case 'Label':
      return <Text style={[styles.label, { color: c.foreground }]}>{str(node.value)}</Text>;
    case 'Button': {
      const pressed = ctx.pressed === node.id;
      const variant =
        node.variant === 'ghost'
          ? 'ghost'
          : node.color === 'danger'
            ? 'destructive'
            : node.style === 'secondary' || node.variant === 'outline' || node.variant === 'soft'
              ? 'secondary'
              : 'primary';
      const icon = pressed ? 'check' : ICONS[str(node.iconStart)];
      return (
        <View style={node.block === true ? styles.block : styles.shrink}>
          <PillButton
            label={str(node.label)}
            variant={variant}
            icon={icon}
            disabled={node.disabled === true || (ctx.locked && !pressed)}
            onPress={() => ctx.press(node.id)}
          />
        </View>
      );
    }
    case 'Chart':
      return <CardChart node={node} c={c} />;
    case 'Stat':
      return <CardStat node={node} icon={ICONS[str(node.icon)]} c={c} />;
    case 'Progress':
      return <CardProgress node={node} c={c} />;
    default:
      return <Field node={node} ctx={ctx} />;
  }
}

const KEYBOARD = { number: 'numeric', email: 'email-address', tel: 'phone-pad', url: 'url' } as const;

function Field({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const { c } = ctx;
  const name = str(node.name);
  const disabled = ctx.locked || node.disabled === true;
  const value = ctx.values[name];
  const text = typeof value === 'string' ? value : '';
  const [open, setOpen] = useState(false);
  const input = [styles.input, { borderColor: c.outline, color: c.foreground, opacity: disabled ? 0.6 : 1 }];
  switch (node.type) {
    case 'Input':
    case 'Textarea': {
      if (node.inputType === 'number' && node.variant === 'stepper') return <Stepper node={node} ctx={ctx} />;
      const multi = node.type === 'Textarea';
      const kind = str(node.inputType) as keyof typeof KEYBOARD;
      return (
        <TextInput
          value={text}
          editable={!disabled}
          onChangeText={(v) => ctx.set(name, v)}
          placeholder={str(node.placeholder) || undefined}
          placeholderTextColor={c.mutedForeground}
          keyboardType={KEYBOARD[kind] ?? 'default'}
          autoCapitalize={kind === 'email' || kind === 'url' ? 'none' : 'sentences'}
          multiline={multi}
          numberOfLines={multi ? (typeof node.rows === 'number' ? node.rows : 3) : 1}
          style={[...input, multi && styles.multiline]}
        />
      );
    }
    case 'Checkbox':
      if (node.variant === 'chip') {
        const on = value === true;
        return (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled }}
            disabled={disabled}
            onPress={() => ctx.set(name, !on)}
            style={[
              styles.chip,
              { borderColor: on ? c.primary : c.outline, opacity: disabled ? 0.6 : 1 },
              on && { backgroundColor: c.muted },
            ]}
          >
            {on ? <Feather name="check" size={14} color={c.foreground} /> : null}
            <Text style={[styles.body, { color: c.foreground }, on && styles.strong]}>{str(node.label)}</Text>
          </Pressable>
        );
      }
      return (
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: value === true, disabled }}
          disabled={disabled}
          onPress={() => ctx.set(name, value !== true)}
          style={styles.check}
        >
          <Feather name={value === true ? 'check-square' : 'square'} size={20} color={c.foreground} />
          <Text style={[styles.body, { color: c.foreground }]}>{str(node.label)}</Text>
        </Pressable>
      );
    case 'RadioGroup': {
      const options = (node.options as CardOption[]) ?? [];
      if (node.variant === 'segmented') {
        return (
          <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: c.muted }]}>
            {options.map((o) => {
              const on = text === o.value;
              return (
                <Pressable
                  key={o.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, disabled: disabled || o.disabled }}
                  disabled={disabled || o.disabled}
                  onPress={() => ctx.set(name, o.value)}
                  style={[styles.segment, on && { backgroundColor: c.card }, disabled && { opacity: 0.6 }]}
                >
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.body,
                      { color: on ? c.foreground : c.mutedForeground },
                      on && styles.strong,
                    ]}
                  >
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        );
      }
      return (
        <View
          accessibilityRole="radiogroup"
          style={node.direction === 'row' ? styles.radioRow : styles.radioCol}
        >
          {options.map((o) => (
            <Pressable
              key={o.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: text === o.value, disabled: disabled || o.disabled }}
              disabled={disabled || o.disabled}
              onPress={() => ctx.set(name, o.value)}
              style={styles.check}
            >
              <Feather name={text === o.value ? 'disc' : 'circle'} size={18} color={c.foreground} />
              <View style={styles.shrink}>
                <Text style={[styles.body, { color: c.foreground }]}>{o.label}</Text>
                {o.description ? (
                  <Text style={[styles.small, { color: c.mutedForeground }]}>{o.description}</Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      );
    }
    case 'Select': {
      const options = (node.options as CardOption[]) ?? [];
      const chosen = options.find((o) => o.value === text);
      return (
        <>
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => setOpen(true)}
            style={[...input, styles.picker]}
          >
            <Text style={[styles.body, { color: chosen ? c.foreground : c.mutedForeground }]}>
              {chosen?.label ?? (str(node.placeholder) || t('card.choose'))}
            </Text>
            <Feather name="chevron-down" size={16} color={c.mutedForeground} />
          </Pressable>
          <Sheet
            open={open}
            onClose={() => setOpen(false)}
            title={str(node.placeholder) || undefined}
            items={options
              .filter((o) => !o.disabled)
              .map((o) => ({
                label: o.label,
                selected: o.value === text,
                onPress: () => {
                  ctx.set(name, o.value);
                  setOpen(false);
                },
              }))}
          />
        </>
      );
    }
    case 'DatePicker':
      return (
        <>
          <Pressable
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => setOpen(true)}
            style={[...input, styles.picker]}
          >
            <Text style={[styles.body, { color: text ? c.foreground : c.mutedForeground }]}>
              {text ? readDay(text) : str(node.placeholder) || t('card.choose')}
            </Text>
            <Feather name="calendar" size={16} color={c.mutedForeground} />
          </Pressable>
          <DaySheet
            open={open}
            value={text}
            min={str(node.min) || undefined}
            max={str(node.max) || undefined}
            onClose={() => setOpen(false)}
            onPick={(d) => {
              ctx.set(name, d);
              setOpen(false);
            }}
          />
        </>
      );
    default:
      return null;
  }
}

/** A small count changed with minus and plus, kept within the card's bounds. */
function Stepper({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const { c } = ctx;
  const name = str(node.name);
  const disabled = ctx.locked || node.disabled === true;
  const min = typeof node.min === 'number' ? node.min : undefined;
  const max = typeof node.max === 'number' ? node.max : undefined;
  const step = typeof node.step === 'number' && node.step > 0 ? node.step : 1;
  const raw = ctx.values[name];
  const current = typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const shown = current ?? min ?? 0;
  const move = (dir: 1 | -1) => {
    let next = Number((shown + dir * step).toPrecision(12));
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    ctx.set(name, String(next));
  };
  const button = (dir: 1 | -1, off: boolean) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dir < 0 ? t('card.less') : t('card.more')}
      disabled={disabled || off}
      onPress={() => move(dir)}
      style={[styles.stepButton, { borderColor: c.outline, opacity: disabled || off ? 0.4 : 1 }]}
    >
      <Feather name={dir < 0 ? 'minus' : 'plus'} size={18} color={c.foreground} />
    </Pressable>
  );
  return (
    <View style={styles.stepper}>
      {button(-1, min !== undefined && shown <= min)}
      <TextInput
        value={typeof raw === 'string' ? raw : String(shown)}
        editable={!disabled}
        onChangeText={(v) => ctx.set(name, v)}
        keyboardType="numeric"
        style={[styles.stepValue, { color: c.foreground }]}
      />
      {button(1, max !== undefined && shown >= max)}
    </View>
  );
}

const intl = () => INTL_LOCALE[locale];

/** A day as the phone's language writes it. */
function readDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(intl(), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** A month of days to pick from, sliding up like the phone's other menus. */
function DaySheet({
  open,
  value,
  min,
  max,
  onClose,
  onPick,
}: {
  open: boolean;
  value: string;
  min?: string;
  max?: string;
  onClose: () => void;
  onPick: (day: string) => void;
}) {
  const c = useColors();
  const [at, setAt] = useState(() => monthOf(value || min));
  const title = new Date(Date.UTC(at.year, at.month, 1)).toLocaleDateString(intl(), {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
  // 5 January 2026 is a Monday: the names of a week from it.
  const names = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 5 + i)).toLocaleDateString(intl(), { timeZone: 'UTC', weekday: 'narrow' }),
  );
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel={t('common.close')} />
      <View style={[styles.month, { backgroundColor: c.card, borderColor: c.border }]}>
        <View style={styles.monthHead}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('card.prevMonth')}
            onPress={() => setAt((a) => shiftMonth(a, -1))}
            hitSlop={8}
          >
            <Feather name="chevron-left" size={20} color={c.foreground} />
          </Pressable>
          <Text style={[styles.label, { color: c.foreground }]}>{title}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('card.nextMonth')}
            onPress={() => setAt((a) => shiftMonth(a, 1))}
            hitSlop={8}
          >
            <Feather name="chevron-right" size={20} color={c.foreground} />
          </Pressable>
        </View>
        <View style={styles.week}>
          {names.map((n, i) => (
            <Text key={i} style={[styles.dayName, { color: c.mutedForeground }]}>
              {n}
            </Text>
          ))}
        </View>
        {monthGrid(at.year, at.month).map((week, w) => (
          <View key={w} style={styles.week}>
            {week.map((day, i) => {
              if (!day) return <View key={i} style={styles.day} />;
              const ok = dayAllowed(day, min, max);
              const on = day === value;
              return (
                <Pressable
                  key={day}
                  accessibilityRole="button"
                  accessibilityLabel={readDay(day)}
                  accessibilityState={{ selected: on, disabled: !ok }}
                  disabled={!ok}
                  onPress={() => onPick(day)}
                  style={[styles.day, on && { backgroundColor: c.primary }]}
                >
                  <Text
                    style={[
                      styles.body,
                      { color: on ? c.primaryForeground : c.foreground, opacity: ok ? 1 : 0.3 },
                    ]}
                  >
                    {Number(day.slice(8))}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 12,
  },
  ends: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
  answered: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  small: { fontSize: 12, lineHeight: 16 },
  body: { fontSize: 15, lineHeight: 21 },
  label: { fontSize: 14, fontWeight: '600' },
  shrink: { flexShrink: 1 },
  block: { alignSelf: 'stretch' },
  spacer: { flex: 1 },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  flush: { marginHorizontal: -14 },
  row: { paddingVertical: 10, paddingHorizontal: 4, borderRadius: 8 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  pill: { borderRadius: 999 },
  badgeText: { fontSize: 12, fontWeight: '500' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    alignSelf: 'stretch',
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  picker: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  radioRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 16 },
  radioCol: { gap: 2 },
  strong: { fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: 'flex-start',
  },
  segments: { flexDirection: 'row', alignSelf: 'stretch', borderRadius: 10, padding: 3 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 10, alignSelf: 'flex-start' },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepValue: {
    minWidth: 44,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  scrim: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0,0,0,0.4)' },
  month: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: '25%',
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
    gap: 6,
  },
  monthHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 },
  week: { flexDirection: 'row' },
  dayName: { flex: 1, textAlign: 'center', fontSize: 12 },
  day: { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
});
