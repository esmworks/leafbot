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
import { useMutation } from '@tanstack/react-query';
import {
  Atom,
  Award,
  Book,
  BookOpen,
  Bot,
  Box,
  Briefcase,
  Bug,
  Calendar,
  ChartColumn,
  ChartLine,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleCheckBig,
  CircleQuestionMark,
  Clock,
  Compass,
  Contact,
  Dot,
  Ellipsis,
  EllipsisVertical,
  ExternalLink,
  File,
  FileText,
  FlaskConical,
  Globe,
  IdCard,
  Image,
  Images,
  Info,
  KeyRound,
  Minus,
  Layers,
  LifeBuoy,
  Lightbulb,
  Mail,
  Map,
  MapPin,
  Monitor,
  Notebook,
  NotebookPen,
  PartyPopper,
  Pencil,
  PenLine,
  Phone,
  Play,
  Plus,
  RotateCw,
  Search,
  SlidersHorizontal,
  Smartphone,
  Sparkle,
  Sparkles,
  SquareCode,
  SquarePen,
  SquareText,
  Star,
  User,
  UserRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CardChart, CardProgress, CardStat } from './CardChart';

/** ChatKit's icon names drawn with this app's icon set. */
const ICONS: Record<string, LucideIcon> = {
  agent: Bot,
  analytics: ChartColumn,
  atom: Atom,
  batch: Layers,
  bolt: Zap,
  'book-open': BookOpen,
  'book-closed': Book,
  'book-clock': Book,
  bug: Bug,
  calendar: Calendar,
  chart: ChartLine,
  check: Check,
  'check-circle': CircleCheck,
  'check-circle-filled': CircleCheckBig,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'circle-question': CircleQuestionMark,
  clock: Clock,
  compass: Compass,
  confetti: PartyPopper,
  cube: Box,
  desktop: Monitor,
  document: FileText,
  dot: Dot,
  'dots-horizontal': Ellipsis,
  'dots-vertical': EllipsisVertical,
  'empty-circle': Circle,
  'external-link': ExternalLink,
  globe: Globe,
  keys: KeyRound,
  lab: FlaskConical,
  images: Images,
  info: Info,
  lifesaver: LifeBuoy,
  lightbulb: Lightbulb,
  mail: Mail,
  'map-pin': MapPin,
  maps: Map,
  mobile: Smartphone,
  name: IdCard,
  notebook: Notebook,
  'notebook-pencil': NotebookPen,
  'page-blank': File,
  phone: Phone,
  play: Play,
  plus: Plus,
  profile: UserRound,
  'profile-card': Contact,
  reload: RotateCw,
  star: Star,
  'star-filled': Star,
  search: Search,
  sparkle: Sparkle,
  'sparkle-double': Sparkles,
  'square-code': SquareCode,
  'square-image': Image,
  'square-text': SquareText,
  suitcase: Briefcase,
  'settings-slider': SlidersHorizontal,
  user: User,
  wreath: Award,
  write: Pencil,
  'write-alt': PenLine,
  'write-alt2': SquarePen,
};

const TEXT_COLOR: Record<string, string> = {
  primary: 'text-foreground',
  emphasis: 'text-foreground font-medium',
  secondary: 'text-muted-foreground',
  tertiary: 'text-muted-foreground/70',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive',
};
const TEXT_SIZE: Record<string, string> = {
  xs: 'text-xs',
  sm: 'text-sm',
  md: 'text-[15px]',
  lg: 'text-base',
  xl: 'text-lg',
};
const TITLE_SIZE: Record<string, string> = {
  sm: 'text-sm',
  md: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
  '3xl': 'text-2xl',
  '4xl': 'text-3xl',
  '5xl': 'text-3xl',
};
const WEIGHT: Record<string, string> = {
  normal: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
};
const ALIGN_TEXT: Record<string, string> = { start: 'text-start', center: 'text-center', end: 'text-end' };
const ALIGN: Record<string, string> = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  baseline: 'items-baseline',
  stretch: 'items-stretch',
};
const JUSTIFY: Record<string, string> = {
  start: 'justify-start',
  center: 'justify-center',
  end: 'justify-end',
  between: 'justify-between',
  around: 'justify-around',
  evenly: 'justify-evenly',
  stretch: 'justify-stretch',
};
const BADGE: Record<string, string> = {
  secondary: 'bg-secondary text-secondary-foreground',
  success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  danger: 'bg-destructive/15 text-destructive',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  info: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  discovery: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
};
const ICON_SIZE: Record<string, string> = {
  xs: 'size-3',
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
  xl: 'size-6',
  '2xl': 'size-7',
  '3xl': 'size-8',
};
const CARD_WIDTH: Record<string, string> = {
  sm: 'max-w-xs',
  md: 'max-w-md',
  lg: 'max-w-lg',
  full: 'max-w-full',
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

interface Answer {
  node: string;
  label: string;
  values: CardValues;
}

/** What every part of a card reads and does while it is drawn. */
interface Ctx {
  card: Card;
  values: CardValues;
  set(name: string, v: string | boolean): void;
  press(ref: string): void;
  /** Answered or being sent: nothing more can be changed or pressed. */
  locked: boolean;
  /** The part the person pressed, once answered. */
  pressed?: string;
  fieldId(name: string): string;
}

/**
 * A card a bot showed with show_card, drawn with the app's own controls. A press checks the
 * fields it sends, then goes to the server; the answer arrives as the person's next message and
 * the card shows what was sent.
 */
export function ChatCard({ m }: { m: Message }) {
  const card = storedCard(m.props.card);
  if (!card) return null;
  const rev = Number(m.props.cardRev ?? 1);
  // A new revision starts from its own defaults.
  return <CardBody key={rev} m={m} card={card} rev={rev} />;
}

function CardBody({ m, card, rev }: { m: Message; card: Card; rev: number }) {
  const t = useT();
  const answer = m.props.cardAnswered === true ? (m.props.cardAnswer as Answer | undefined) : undefined;
  const [values, setValues] = useState<CardValues>(() => ({ ...cardDefaults(card), ...answer?.values }));
  const [problem, setProblem] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (o: { node: string; values: CardValues }) =>
      api.answerCard(m.id, { node: o.node, rev, values: o.values }),
    onError: (err: Error) => toast.error(err.message),
  });
  const locked = !!answer || m.props.cardAnswered === true || send.isPending;
  const press = (ref: string) => {
    if (locked) return;
    const p = cardPress(card, ref);
    if (!p) return;
    const link = cardLink(p.action);
    if (link) {
      window.open(link, '_blank', 'noopener,noreferrer');
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
    fieldId: (name) => `card-${m.id}-${name}`,
  };
  const root = card.root;
  const ends = (['confirm', 'cancel'] as const)
    .map((key) => ({ key, b: root[key] as { label: string } | undefined }))
    .filter((x): x is { key: 'confirm' | 'cancel'; b: { label: string } } => !!x.b);
  return (
    <div
      className={cn(
        'wallpaper-frost flex w-full flex-col gap-3 self-start rounded-2xl border bg-card/60 p-4 text-[15px]',
        CARD_WIDTH[str(root.size)] ?? 'max-w-(--bubble-width)',
      )}
      data-card-rev={rev}
    >
      {root.type === 'ListView' ? <ListView node={root} ctx={ctx} /> : <Children node={root} ctx={ctx} />}
      {ends.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {ends.map(({ key, b }) => (
            <Button
              key={key}
              size="sm"
              variant={key === 'cancel' ? 'ghost' : 'default'}
              disabled={locked && ctx.pressed !== key}
              className={cn(ctx.pressed === key && 'ring-2 ring-ring/50')}
              onClick={() => press(key)}
            >
              {b.label}
            </Button>
          ))}
        </div>
      )}
      {problem && !locked && <div className="text-xs text-destructive">{problem}</div>}
      {answer && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3.5" aria-hidden /> {t('card.answered', { label: answer.label })}
        </div>
      )}
    </div>
  );
}

function Children({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  return (
    <>
      {(node.children ?? []).map((c) => (
        <Part key={c.id} node={c} ctx={ctx} />
      ))}
    </>
  );
}

const flex = (node: CardNode, dir: 'row' | 'col'): { className: string; style: CSSProperties } => ({
  className: cn(
    'flex min-w-0',
    dir === 'row' ? 'flex-row' : 'flex-col',
    ALIGN[str(node.align)] ?? (dir === 'row' ? 'items-center' : undefined),
    JUSTIFY[str(node.justify)],
    node.wrap === 'wrap' && 'flex-wrap',
    node.wrap === 'wrap-reverse' && 'flex-wrap-reverse',
  ),
  style: {
    gap: `${(typeof node.gap === 'number' ? node.gap : dir === 'row' ? 2 : 3) * 4}px`,
    ...(typeof node.flex === 'number' && { flex: node.flex }),
  },
});

function ListView({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const t = useT();
  const rows = node.children ?? [];
  const limit = typeof node.limit === 'number' ? node.limit : rows.length;
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className="-mx-2 flex flex-col">
      {shown.map((row) => {
        const box = flex({ ...row, align: row.align ?? 'center' }, 'row');
        const pressable = !!row.onClickAction;
        const inner = (
          <div className={box.className} style={box.style}>
            <Children node={row} ctx={ctx} />
          </div>
        );
        return pressable ? (
          <button
            key={row.id}
            type="button"
            disabled={ctx.locked}
            onClick={() => ctx.press(row.id)}
            className={cn(
              'rounded-lg px-2 py-2 text-start hover:bg-accent disabled:cursor-default disabled:hover:bg-transparent',
              ctx.pressed === row.id && 'bg-accent',
            )}
          >
            {inner}
          </button>
        ) : (
          <div key={row.id} className="px-2 py-2">
            {inner}
          </div>
        );
      })}
      {shown.length < rows.length && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setAll(true)}>
          {t('card.showMore')}
        </Button>
      )}
    </div>
  );
}

const clamp = (n: unknown): CSSProperties | undefined =>
  typeof n === 'number'
    ? { display: '-webkit-box', WebkitLineClamp: n, WebkitBoxOrient: 'vertical', overflow: 'hidden' }
    : undefined;

function Part({ node, ctx }: { node: CardNode; ctx: Ctx }): ReactNode {
  switch (node.type) {
    case 'Row':
    case 'Col':
    case 'Box':
    case 'Form': {
      const dir = node.type === 'Row' || node.direction === 'row' ? 'row' : 'col';
      const box = flex(node, dir);
      const inner = <Children node={node} ctx={ctx} />;
      return node.type === 'Form' ? (
        <form
          className={box.className}
          style={box.style}
          onSubmit={(e) => {
            e.preventDefault();
            // Enter in a field sends the form through its first submit button.
            const submit = findNode(node, (n) => n.type === 'Button' && n.submit === true);
            if (submit) ctx.press(submit.id);
          }}
        >
          {inner}
        </form>
      ) : (
        <div className={box.className} style={box.style}>
          {inner}
        </div>
      );
    }
    case 'Spacer':
      return <div className="flex-1" />;
    case 'Divider':
      return <hr className={cn('border-border', node.flush === true && '-mx-4')} />;
    case 'Text':
      return (
        <p
          className={cn(
            'leading-relaxed [overflow-wrap:anywhere]',
            TEXT_SIZE[str(node.size)],
            WEIGHT[str(node.weight)],
            TEXT_COLOR[str(node.color)],
            ALIGN_TEXT[str(node.textAlign)],
            node.italic === true && 'italic',
            node.lineThrough === true && 'line-through',
            node.truncate === true && 'truncate',
          )}
          style={clamp(node.maxLines)}
        >
          {str(node.value)}
        </p>
      );
    case 'Title':
      return (
        <h3
          className={cn(
            'leading-snug [overflow-wrap:anywhere]',
            TITLE_SIZE[str(node.size)] ?? 'text-base',
            WEIGHT[str(node.weight)] ?? 'font-semibold',
            TEXT_COLOR[str(node.color)],
            ALIGN_TEXT[str(node.textAlign)],
          )}
          style={clamp(node.maxLines)}
        >
          {str(node.value)}
        </h3>
      );
    case 'Caption':
      return (
        <p
          className={cn(
            '[overflow-wrap:anywhere]',
            node.size === 'lg' ? 'text-sm' : 'text-xs',
            WEIGHT[str(node.weight)],
            TEXT_COLOR[str(node.color)] ?? 'text-muted-foreground',
            ALIGN_TEXT[str(node.textAlign)],
          )}
          style={clamp(node.maxLines)}
        >
          {str(node.value)}
        </p>
      );
    case 'Markdown':
      return <Markdown text={str(node.value)} className="prose-chat leading-relaxed break-words" />;
    case 'Badge':
      return (
        <span
          className={cn(
            'inline-flex w-fit shrink-0 items-center px-2 py-0.5 text-xs font-medium',
            node.pill === true ? 'rounded-full' : 'rounded-md',
            node.variant === 'outline' ? 'border' : (BADGE[str(node.color)] ?? BADGE.secondary),
          )}
        >
          {str(node.label)}
        </span>
      );
    case 'Icon': {
      const Glyph = ICONS[str(node.name)] ?? Dot;
      return (
        <Glyph
          aria-hidden
          className={cn('shrink-0', ICON_SIZE[str(node.size)] ?? 'size-4', TEXT_COLOR[str(node.color)])}
          fill={node.name === 'star-filled' ? 'currentColor' : 'none'}
        />
      );
    }
    case 'Label':
      return (
        <label htmlFor={ctx.fieldId(str(node.fieldName))} className="text-sm font-medium">
          {str(node.value)}
        </label>
      );
    case 'Button':
      return <CardButton node={node} ctx={ctx} />;
    case 'Chart':
      return <CardChart node={node} />;
    case 'Stat':
      return <CardStat node={node} icon={ICONS[str(node.icon)]} />;
    case 'Progress':
      return <CardProgress node={node} />;
    default:
      return <Field node={node} ctx={ctx} />;
  }
}

function findNode(node: CardNode, test: (n: CardNode) => boolean): CardNode | undefined {
  if (test(node)) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, test);
    if (hit) return hit;
  }
  return undefined;
}

function CardButton({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const Start = ICONS[str(node.iconStart)];
  const End = ICONS[str(node.iconEnd)];
  const danger = node.color === 'danger';
  const variant =
    node.variant === 'ghost'
      ? 'ghost'
      : node.variant === 'outline' || node.style === 'secondary'
        ? 'outline'
        : danger
          ? 'destructive'
          : node.variant === 'soft'
            ? 'secondary'
            : 'default';
  const pressed = ctx.pressed === node.id;
  return (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={node.disabled === true || (ctx.locked && !pressed)}
      className={cn(node.block === true ? 'w-full' : 'w-fit', pressed && 'ring-2 ring-ring/50')}
      onClick={() => ctx.press(node.id)}
      aria-label={node.label ? undefined : str(node.iconStart ?? node.iconEnd)}
    >
      {Start && <Start aria-hidden />}
      {str(node.label)}
      {End && <End aria-hidden />}
    </Button>
  );
}

function Field({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const t = useT();
  const name = str(node.name);
  const id = ctx.fieldId(name);
  const disabled = ctx.locked || node.disabled === true;
  const value = ctx.values[name];
  const text = typeof value === 'string' ? value : '';
  const required = node.required === true;
  switch (node.type) {
    case 'Select': {
      const options = (node.options as CardOption[]) ?? [];
      return (
        <Select value={text || undefined} onValueChange={(v) => ctx.set(name, v)} disabled={disabled}>
          <SelectTrigger id={id} className="w-full" aria-label={str(node.placeholder) || name}>
            <SelectValue placeholder={str(node.placeholder) || t('card.choose')} />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    case 'RadioGroup': {
      const options = (node.options as CardOption[]) ?? [];
      if (node.variant === 'segmented') {
        return (
          <div
            role="radiogroup"
            id={id}
            aria-label={str(node.ariaLabel) || undefined}
            className="flex w-full min-w-0 rounded-lg bg-muted p-1"
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="radio"
                aria-checked={text === o.value}
                disabled={disabled || o.disabled}
                onClick={() => ctx.set(name, o.value)}
                title={o.description}
                className={cn(
                  'min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors enabled:hover:text-foreground disabled:opacity-60',
                  text === o.value && 'bg-background font-medium text-foreground shadow-sm',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        );
      }
      return (
        <div
          role="radiogroup"
          id={id}
          aria-label={str(node.ariaLabel) || undefined}
          className={cn('flex gap-x-4 gap-y-2', node.direction === 'row' ? 'flex-row flex-wrap' : 'flex-col')}
        >
          {options.map((o) => (
            <label key={o.value} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={id}
                value={o.value}
                checked={text === o.value}
                disabled={disabled || o.disabled}
                onChange={() => ctx.set(name, o.value)}
                className="mt-0.5 accent-primary"
              />
              <span>
                {o.label}
                {o.description && (
                  <span className="block text-xs text-muted-foreground">{o.description}</span>
                )}
              </span>
            </label>
          ))}
        </div>
      );
    }
    case 'Checkbox':
      if (node.variant === 'chip') {
        return (
          <button
            id={id}
            type="button"
            aria-pressed={value === true}
            disabled={disabled}
            onClick={() => ctx.set(name, value !== true)}
            className={cn(
              'flex w-fit shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors enabled:hover:bg-accent disabled:opacity-60',
              value === true && 'border-primary bg-primary/10 font-medium enabled:hover:bg-primary/15',
            )}
          >
            {value === true && <Check className="size-3.5" aria-hidden />}
            {str(node.label)}
          </button>
        );
      }
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            required={required}
            onChange={(e) => ctx.set(name, e.target.checked)}
            className="size-4 accent-primary"
          />
          {str(node.label)}
        </label>
      );
    case 'Textarea':
      return (
        <Textarea
          id={id}
          value={text}
          rows={typeof node.rows === 'number' ? node.rows : 3}
          placeholder={str(node.placeholder) || undefined}
          required={required}
          disabled={disabled}
          onChange={(e) => ctx.set(name, e.target.value)}
        />
      );
    case 'DatePicker':
      return (
        <Input
          id={id}
          type="date"
          value={text}
          min={str(node.min) || undefined}
          max={str(node.max) || undefined}
          required={required}
          disabled={disabled}
          onChange={(e) => ctx.set(name, e.target.value)}
          className="w-fit"
        />
      );
    case 'Input':
      if (node.inputType === 'number' && node.variant === 'stepper') return <Stepper node={node} ctx={ctx} />;
      return (
        <Input
          id={id}
          type={str(node.inputType) || 'text'}
          value={text}
          placeholder={str(node.placeholder) || undefined}
          required={required}
          disabled={disabled}
          onChange={(e) => ctx.set(name, e.target.value)}
        />
      );
    default:
      return null;
  }
}

/** A small count changed with minus and plus, kept within the card's bounds. */
function Stepper({ node, ctx }: { node: CardNode; ctx: Ctx }) {
  const t = useT();
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
  return (
    <div className="flex w-fit items-center gap-2">
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label={t('card.less')}
        disabled={disabled || (min !== undefined && shown <= min)}
        onClick={() => move(-1)}
      >
        <Minus />
      </Button>
      <input
        id={ctx.fieldId(name)}
        inputMode="decimal"
        value={typeof raw === 'string' ? raw : String(shown)}
        disabled={disabled}
        onChange={(e) => ctx.set(name, e.target.value)}
        className="w-12 bg-transparent text-center text-lg font-semibold tabular-nums outline-none"
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        aria-label={t('card.more')}
        disabled={disabled || (max !== undefined && shown >= max)}
        onClick={() => move(1)}
      >
        <Plus />
      </Button>
    </div>
  );
}
