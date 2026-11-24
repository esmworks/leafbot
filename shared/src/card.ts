/**
 * Interactive cards a bot shows in the conversation with `show_card`. The tree uses the component
 * names and props of OpenAI ChatKit's widgets, because models already know how to write them. The
 * app draws a subset: what it cannot draw is refused here (a component) or left out (a prop),
 * once, so the web and phone renderers and the server read checked trees only.
 */

export const CARD_VERSION = 1;

/** Past any of these a card is refused, with the path of the problem. Strings are cut instead. */
export const CARD_LIMITS = {
  bytes: 24_000,
  nodes: 200,
  depth: 8,
  listItems: 30,
  options: 30,
  fields: 20,
  text: 2_000,
  markdown: 4_000,
  label: 80,
  title: 160,
  actionType: 64,
  payloadBytes: 2_000,
  value: 4_000,
  fallback: 1_500,
} as const;

/** Icon names a card may use; each renderer maps them to its own set. Others are left out. */
export const CARD_ICONS = [
  'agent',
  'analytics',
  'atom',
  'batch',
  'bolt',
  'book-open',
  'book-closed',
  'book-clock',
  'bug',
  'calendar',
  'chart',
  'check',
  'check-circle',
  'check-circle-filled',
  'chevron-left',
  'chevron-right',
  'circle-question',
  'clock',
  'compass',
  'confetti',
  'cube',
  'desktop',
  'document',
  'dot',
  'dots-horizontal',
  'dots-vertical',
  'empty-circle',
  'external-link',
  'globe',
  'keys',
  'lab',
  'images',
  'info',
  'lifesaver',
  'lightbulb',
  'mail',
  'map-pin',
  'maps',
  'mobile',
  'name',
  'notebook',
  'notebook-pencil',
  'page-blank',
  'phone',
  'play',
  'plus',
  'profile',
  'profile-card',
  'reload',
  'star',
  'star-filled',
  'search',
  'sparkle',
  'sparkle-double',
  'square-code',
  'square-image',
  'square-text',
  'suitcase',
  'settings-slider',
  'user',
  'wreath',
  'write',
  'write-alt',
  'write-alt2',
] as const;

export type CardIcon = (typeof CARD_ICONS)[number];

/** What a press asks for: its type and payload reach the bot; `open_url` opens a link instead. */
export interface CardAction {
  type: string;
  payload?: unknown;
}

/** One checked node. `id` is given here ("n1", "n2", ... in document order); a press names it. */
export interface CardNode {
  type: string;
  id: string;
  children?: CardNode[];
  [prop: string]: unknown;
}

export interface Card {
  v: typeof CARD_VERSION;
  root: CardNode;
}

export type CardValue = string | boolean;
export type CardValues = Record<string, CardValue>;

export type CardFieldType = 'Select' | 'RadioGroup' | 'Checkbox' | 'Input' | 'Textarea' | 'DatePicker';

export interface CardOption {
  value: string;
  label: string;
  disabled?: boolean;
  description?: string;
}

/** A field the person fills in, with the words it is known by. */
export interface CardField {
  name: string;
  type: CardFieldType;
  label: string;
  node: CardNode;
}

export type CardIssue =
  | 'notObject'
  | 'tooLarge'
  | 'tooDeep'
  | 'tooManyNodes'
  | 'tooManyFields'
  | 'tooManyItems'
  | 'unknownType'
  | 'unsupported'
  | 'missing'
  | 'badAction'
  | 'badName'
  | 'duplicateName'
  | 'noOptions'
  | 'secret'
  | 'listItemOutside';

/** Why a card was refused: where (`root.children[2]`), what, and the word it is about. */
export interface CardError {
  path: string;
  issue: CardIssue;
  detail?: string;
}

/** Root components: one card, or a list of rows to choose from. */
const ROOTS = new Set(['Card', 'ListView']);
const FIELDS = new Set<string>(['Select', 'RadioGroup', 'Checkbox', 'Input', 'Textarea', 'DatePicker']);
/** ChatKit components this app does not draw, and what the bot should use instead. */
const UNSUPPORTED: Record<string, string> = { Image: 'send_file', Chart: 'show_page' };
/** A field that asks for a secret: those go through the vault's own card, never a chat card. */
const SECRET = /pass(word|wd|code)?\b|secret|token|api[\s_-]?key|cvv|cvc|iban|card[\s_-]?number|\bpin\b/i;
const NAME = /^[A-Za-z_][\w.-]{0,63}$/;
const ACTION_TYPE = /^[\w.:-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

type Read = (v: unknown) => unknown;

const str =
  (max: number): Read =>
  (v) =>
    typeof v === 'string'
      ? clip(v, max)
      : typeof v === 'number' && Number.isFinite(v)
        ? String(v)
        : undefined;
const oneOf =
  (...xs: string[]): Read =>
  (v) =>
    typeof v === 'string' && xs.includes(v) ? v : undefined;
const bool: Read = (v) => (typeof v === 'boolean' ? v : undefined);
const int =
  (min: number, max: number): Read =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : undefined;
const icon: Read = (v) =>
  typeof v === 'string' && (CARD_ICONS as readonly string[]).includes(v) ? v : undefined;
/** A day as `YYYY-MM-DD`; a full date and time keeps its day. */
const day: Read = (v) => {
  if (typeof v !== 'string') return undefined;
  const d = v.slice(0, 10);
  if (!DATE.test(d)) return undefined;
  // A day that does not exist (February 30) rolls over into another one when read.
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d ? d : undefined;
};

const TEXT_COLORS = ['prose', 'primary', 'emphasis', 'secondary', 'tertiary', 'success', 'warning', 'danger'];
const SIZES = ['xs', 'sm', 'md', 'lg', 'xl'];
const WEIGHTS = ['normal', 'medium', 'semibold', 'bold'];
const ALIGN = ['start', 'center', 'end'];
const FLEX_ALIGN = ['start', 'center', 'end', 'baseline', 'stretch'];
const JUSTIFY = ['start', 'center', 'end', 'between', 'around', 'evenly', 'stretch'];

const box = {
  gap: int(0, 16),
  align: oneOf(...FLEX_ALIGN),
  justify: oneOf(...JUSTIFY),
  wrap: oneOf('nowrap', 'wrap', 'wrap-reverse'),
  flex: int(0, 12),
};
const field = { name: str(64), disabled: bool, required: bool };

interface Spec {
  props: Record<string, Read>;
  required?: string[];
  /** `any`: child components; none when absent. */
  children?: 'any';
}

const SPECS: Record<string, Spec> = {
  Card: {
    props: {
      size: oneOf('sm', 'md', 'lg', 'full'),
      collapsed: bool,
      asForm: bool,
    },
    children: 'any',
  },
  ListView: { props: { limit: int(1, CARD_LIMITS.listItems) }, children: 'any' },
  ListViewItem: { props: { gap: box.gap, align: box.align }, children: 'any' },
  Box: { props: { ...box, direction: oneOf('row', 'col') }, children: 'any' },
  Row: { props: box, children: 'any' },
  Col: { props: box, children: 'any' },
  Form: { props: { ...box, direction: oneOf('row', 'col') }, children: 'any' },
  Spacer: { props: {} },
  Divider: { props: { flush: bool } },
  Text: {
    props: {
      value: str(CARD_LIMITS.text),
      size: oneOf(...SIZES),
      weight: oneOf(...WEIGHTS),
      color: oneOf(...TEXT_COLORS),
      italic: bool,
      lineThrough: bool,
      textAlign: oneOf(...ALIGN),
      truncate: bool,
      maxLines: int(1, 20),
    },
    required: ['value'],
  },
  Title: {
    props: {
      value: str(CARD_LIMITS.title),
      size: oneOf('sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'),
      weight: oneOf(...WEIGHTS),
      color: oneOf(...TEXT_COLORS),
      textAlign: oneOf(...ALIGN),
      maxLines: int(1, 10),
    },
    required: ['value'],
  },
  Caption: {
    props: {
      value: str(CARD_LIMITS.text),
      size: oneOf('sm', 'md', 'lg'),
      weight: oneOf(...WEIGHTS),
      color: oneOf(...TEXT_COLORS),
      textAlign: oneOf(...ALIGN),
      maxLines: int(1, 20),
    },
    required: ['value'],
  },
  Markdown: { props: { value: str(CARD_LIMITS.markdown) }, required: ['value'] },
  Badge: {
    props: {
      label: str(CARD_LIMITS.label),
      color: oneOf('secondary', 'success', 'danger', 'warning', 'info', 'discovery'),
      variant: oneOf('solid', 'soft', 'outline'),
      pill: bool,
    },
    required: ['label'],
  },
  Icon: {
    props: {
      name: icon,
      size: oneOf('xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'),
      color: oneOf(...TEXT_COLORS),
    },
    required: ['name'],
  },
  Label: { props: { value: str(CARD_LIMITS.label), fieldName: str(64) }, required: ['value'] },
  Button: {
    props: {
      label: str(CARD_LIMITS.label),
      submit: bool,
      style: oneOf('primary', 'secondary'),
      color: oneOf('primary', 'secondary', 'info', 'discovery', 'success', 'caution', 'warning', 'danger'),
      variant: oneOf('solid', 'soft', 'outline', 'ghost'),
      iconStart: icon,
      iconEnd: icon,
      block: bool,
      disabled: bool,
    },
  },
  Select: { props: { ...field, placeholder: str(CARD_LIMITS.label), defaultValue: str(CARD_LIMITS.label) } },
  RadioGroup: {
    props: {
      ...field,
      ariaLabel: str(CARD_LIMITS.label),
      defaultValue: str(CARD_LIMITS.label),
      direction: oneOf('row', 'col'),
    },
  },
  Checkbox: { props: { ...field, label: str(CARD_LIMITS.title), defaultChecked: bool } },
  Input: {
    props: {
      ...field,
      inputType: oneOf('text', 'number', 'email', 'tel', 'url'),
      placeholder: str(CARD_LIMITS.label),
      defaultValue: str(CARD_LIMITS.value),
    },
  },
  Textarea: {
    props: {
      ...field,
      placeholder: str(CARD_LIMITS.label),
      defaultValue: str(CARD_LIMITS.value),
      rows: int(2, 12),
    },
  },
  DatePicker: {
    props: { ...field, placeholder: str(CARD_LIMITS.label), defaultValue: day, min: day, max: day },
  },
};

/** The components a card may hold. */
export const CARD_COMPONENTS: readonly string[] = Object.keys(SPECS);

class Refused extends Error {
  constructor(readonly error: CardError) {
    super(error.issue);
  }
}

const refuse = (path: string, issue: CardIssue, detail?: string): never => {
  throw new Refused({ path, issue, ...(detail !== undefined && { detail }) });
};

function action(raw: unknown, path: string): CardAction {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !ACTION_TYPE.test(raw.type)) {
    return refuse(path, 'badAction');
  }
  if (raw.payload === undefined || raw.payload === null) return { type: raw.type };
  const json = JSON.stringify(raw.payload);
  if (json === undefined || json.length > CARD_LIMITS.payloadBytes) return refuse(path, 'badAction');
  return { type: raw.type, payload: JSON.parse(json) as unknown };
}

function options(raw: unknown, path: string): CardOption[] {
  if (!Array.isArray(raw) || !raw.length) return refuse(path, 'noOptions');
  if (raw.length > CARD_LIMITS.options) return refuse(path, 'tooManyItems', String(CARD_LIMITS.options));
  const out: CardOption[] = [];
  const seen = new Set<string>();
  raw.forEach((o, i) => {
    const at = `${path}[${i}]`;
    // A bare word is an option whose value and label are the same.
    const rec: Record<string, unknown> = isRecord(o) ? o : { value: o };
    const value = str(CARD_LIMITS.label)(rec.value) as string | undefined;
    if (value === undefined || !value.trim()) return refuse(at, 'missing', 'value');
    if (seen.has(value)) return refuse(at, 'duplicateName', value);
    seen.add(value);
    const label = (str(CARD_LIMITS.label)(rec.label) as string | undefined) ?? value;
    const description = str(CARD_LIMITS.title)(rec.description) as string | undefined;
    out.push({
      value,
      label,
      ...(rec.disabled === true && { disabled: true }),
      ...(description && { description }),
    });
  });
  return out;
}

interface Walk {
  nodes: number;
  names: Set<string>;
}

function children(raw: unknown): unknown[] {
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function walk(raw: unknown, path: string, depth: number, w: Walk, parent: string): CardNode[] {
  // A bare word among the children is a line of text.
  if (typeof raw === 'string') raw = { type: 'Text', value: raw };
  if (!isRecord(raw)) return refuse(path, 'notObject');
  let type = typeof raw.type === 'string' ? raw.type : '';
  if (!type) return refuse(path, 'missing', 'type');
  // An animation wrapper: only what it holds is drawn.
  if (type === 'Transition') {
    return children(raw.children).flatMap((c, i) => walk(c, `${path}.children[${i}]`, depth, w, parent));
  }
  if (type in UNSUPPORTED) return refuse(path, 'unsupported', `${type}:${UNSUPPORTED[type]}`);
  // A card or list inside another is a plain group.
  if (ROOTS.has(type) && depth > 0) type = 'Col';
  if (type === 'ListViewItem' && parent !== 'ListView') return refuse(path, 'listItemOutside');
  // A row of a list given without its wrapper.
  if (parent === 'ListView' && type !== 'ListViewItem') {
    return walk({ type: 'ListViewItem', children: [raw] }, path, depth, w, parent);
  }
  const spec = SPECS[type];
  if (!spec) return refuse(path, 'unknownType', type);
  if (depth > CARD_LIMITS.depth) return refuse(path, 'tooDeep', String(CARD_LIMITS.depth));
  if (++w.nodes > CARD_LIMITS.nodes) return refuse(path, 'tooManyNodes', String(CARD_LIMITS.nodes));
  const node: CardNode = { type, id: `n${w.nodes}` };
  for (const [key, read] of Object.entries(spec.props)) {
    const v = read(raw[key]);
    if (v !== undefined) node[key] = v;
  }
  for (const key of spec.required ?? []) {
    if (node[key] === undefined || node[key] === '') refuse(path, 'missing', key);
  }
  if (type === 'Button') {
    if (!node.label && !node.iconStart && !node.iconEnd) refuse(path, 'missing', 'label');
    if (raw.onClickAction !== undefined && raw.onClickAction !== null) {
      node.onClickAction = action(raw.onClickAction, `${path}.onClickAction`);
    }
  }
  if ((type === 'ListViewItem' && raw.onClickAction) || (type === 'Form' && raw.onSubmitAction)) {
    const key = type === 'Form' ? 'onSubmitAction' : 'onClickAction';
    node[key] = action(raw[key], `${path}.${key}`);
  }
  if (type === 'Card') {
    for (const key of ['confirm', 'cancel'] as const) {
      const b = raw[key];
      if (b === undefined || b === null) continue;
      if (!isRecord(b)) refuse(`${path}.${key}`, 'notObject');
      const rec = b as Record<string, unknown>;
      const label = str(CARD_LIMITS.label)(rec.label) as string | undefined;
      if (!label) refuse(`${path}.${key}`, 'missing', 'label');
      node[key] = {
        label,
        ...(rec.action !== undefined &&
          rec.action !== null && { action: action(rec.action, `${path}.${key}.action`) }),
      };
    }
  }
  if (FIELDS.has(type)) {
    const name = node.name;
    if (typeof name !== 'string' || !NAME.test(name)) refuse(path, 'badName', String(raw.name ?? ''));
    if (w.names.has(name as string)) refuse(path, 'duplicateName', name as string);
    w.names.add(name as string);
    if (w.names.size > CARD_LIMITS.fields) refuse(path, 'tooManyFields', String(CARD_LIMITS.fields));
    if (type === 'Input' && raw.inputType === 'password') refuse(path, 'secret', name as string);
    const words = [name, node.label, node.placeholder, node.ariaLabel].filter((x) => typeof x === 'string');
    if (words.some((x) => SECRET.test(x as string))) refuse(path, 'secret', name as string);
    if (type === 'Select' || type === 'RadioGroup') {
      node.options = options(raw.options, `${path}.options`);
      const chosen = node.defaultValue;
      if (chosen !== undefined && !(node.options as CardOption[]).some((o) => o.value === chosen)) {
        delete node.defaultValue;
      }
    }
  }
  if (spec.children) {
    const list = children(raw.children);
    if (type === 'ListView' && list.length > CARD_LIMITS.listItems) {
      refuse(path, 'tooManyItems', String(CARD_LIMITS.listItems));
    }
    node.children = list.flatMap((c, i) => walk(c, `${path}.children[${i}]`, depth + 1, w, type));
  }
  return [node];
}

/**
 * Checks what a bot wrote and returns the card the app draws. A root other than a card or a list
 * is put in a card. A string is read as JSON first: some models send the tree that way.
 */
export function parseCard(input: unknown): { ok: true; card: Card } | { ok: false; error: CardError } {
  try {
    let raw = input;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        return refuse('root', 'notObject');
      }
    }
    if (!isRecord(raw)) return refuse('root', 'notObject');
    const size = JSON.stringify(raw).length;
    if (size > CARD_LIMITS.bytes) return refuse('root', 'tooLarge', String(CARD_LIMITS.bytes));
    const rooted = ROOTS.has(String(raw.type)) ? raw : { type: 'Card', children: [raw] };
    const [root] = walk(rooted, 'root', 0, { nodes: 0, names: new Set() }, '');
    return { ok: true, card: { v: CARD_VERSION, root: root! } };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, error: err.error };
    throw err;
  }
}

/** Reads a card kept on a message; anything else is not one. */
export function storedCard(v: unknown): Card | null {
  return isRecord(v) && v.v === CARD_VERSION && isRecord(v.root) && typeof v.root.type === 'string'
    ? (v as unknown as Card)
    : null;
}

function visit(node: CardNode, fn: (n: CardNode, up: CardNode[]) => void, up: CardNode[] = []) {
  fn(node, up);
  for (const c of node.children ?? []) visit(c, fn, [...up, node]);
}

/** Every field of a card in order, with the words it is known by. */
export function cardFields(card: Card): CardField[] {
  const labels = new Map<string, string>();
  visit(card.root, (n) => {
    if (n.type === 'Label' && typeof n.fieldName === 'string') labels.set(n.fieldName, String(n.value));
  });
  const out: CardField[] = [];
  visit(card.root, (n) => {
    if (!FIELDS.has(n.type)) return;
    const name = String(n.name);
    const label =
      labels.get(name) ??
      [n.label, n.ariaLabel, n.placeholder].find((x): x is string => typeof x === 'string' && !!x.trim()) ??
      name;
    out.push({ name, type: n.type as CardFieldType, label, node: n });
  });
  return out;
}

/** The words a row of a list or a group shows, joined on one line. */
function inlineText(node: CardNode): string {
  const parts: string[] = [];
  visit(node, (n) => {
    if ((n.type === 'Text' || n.type === 'Title' || n.type === 'Caption') && typeof n.value === 'string') {
      parts.push(n.value);
    }
    if (n.type === 'Badge') parts.push(String(n.label));
  });
  return parts.join(' · ');
}

/** What pressing a part of a card does: the words it is known by, its action, the fields it sends. */
export interface CardPress {
  ref: string;
  label: string;
  /** A card's cancel button: it sends no fields and needs none filled in. */
  cancel: boolean;
  action?: CardAction;
  fields: CardField[];
}

/** The fields a press sends: those of its form, or, outside a form, every field not in one. */
function fieldsFor(card: Card, form: CardNode | undefined): CardField[] {
  const all = cardFields(card);
  if (form) {
    const inside = new Set<string>();
    visit(form, (n) => {
      if (FIELDS.has(n.type)) inside.add(n.id);
    });
    return all.filter((f) => inside.has(f.node.id));
  }
  const inForms = new Set<string>();
  visit(card.root, (n, up) => {
    if (FIELDS.has(n.type) && up.some((a) => a.type === 'Form')) inForms.add(n.id);
  });
  return all.filter((f) => !inForms.has(f.node.id));
}

/** The parts of a card that can be pressed, by the `ref` a press names. */
export function cardPresses(card: Card): CardPress[] {
  const out: CardPress[] = [];
  visit(card.root, (n, up) => {
    const form = [...up].reverse().find((a) => a.type === 'Form');
    if (n.type === 'Button') {
      const label = String(n.label ?? n.iconStart ?? n.iconEnd ?? '');
      const act =
        form && n.submit === true
          ? (form.onSubmitAction as CardAction | undefined)
          : (n.onClickAction as CardAction | undefined);
      out.push({
        ref: n.id,
        label,
        cancel: false,
        ...(act && { action: act }),
        fields: fieldsFor(card, form),
      });
    } else if (n.type === 'ListViewItem' && n.onClickAction) {
      out.push({
        ref: n.id,
        label: clip(inlineText(n), CARD_LIMITS.label),
        cancel: false,
        action: n.onClickAction as CardAction,
        fields: [],
      });
    }
  });
  const root = card.root;
  for (const key of ['confirm', 'cancel'] as const) {
    const b = root[key] as { label: string; action?: CardAction } | undefined;
    if (!b) continue;
    out.push({
      ref: key,
      label: b.label,
      cancel: key === 'cancel',
      ...(b.action && { action: b.action }),
      fields: key === 'cancel' ? [] : fieldsFor(card, undefined),
    });
  }
  return out;
}

export function cardPress(card: Card, ref: string): CardPress | undefined {
  return cardPresses(card).find((p) => p.ref === ref);
}

/** The values a card starts with, from its fields' defaults. */
export function cardDefaults(card: Card): CardValues {
  const out: CardValues = {};
  for (const f of cardFields(card)) {
    if (f.type === 'Checkbox') out[f.name] = f.node.defaultChecked === true;
    else if (typeof f.node.defaultValue === 'string') out[f.name] = f.node.defaultValue;
  }
  return out;
}

export type CardValueIssue =
  'required' | 'notOption' | 'badDate' | 'outOfRange' | 'tooLong' | 'notNumber' | 'badEmail';

/**
 * The values a press sends, read against the fields it covers: a choice must be one of the
 * options, a date a real day in range, a checkbox true or false. Values for other fields are
 * dropped. A cancel sends none.
 */
export function checkCardValues(
  press: CardPress,
  values: Record<string, unknown>,
): { ok: true; values: CardValues } | { ok: false; field: CardField; issue: CardValueIssue } {
  const out: CardValues = {};
  if (press.cancel) return { ok: true, values: out };
  for (const f of press.fields) {
    const raw = values[f.name];
    const required = f.node.required === true;
    if (f.type === 'Checkbox') {
      const v = raw === true || raw === 'true';
      if (required && !v) return { ok: false, field: f, issue: 'required' };
      out[f.name] = v;
      continue;
    }
    const v = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (!v) {
      if (required) return { ok: false, field: f, issue: 'required' };
      out[f.name] = '';
      continue;
    }
    if (v.length > CARD_LIMITS.value) return { ok: false, field: f, issue: 'tooLong' };
    if (f.type === 'Select' || f.type === 'RadioGroup') {
      const opts = (f.node.options as CardOption[]) ?? [];
      if (!opts.some((o) => o.value === v && !o.disabled)) return { ok: false, field: f, issue: 'notOption' };
    } else if (f.type === 'DatePicker') {
      if (day(v) !== v) return { ok: false, field: f, issue: 'badDate' };
      const { min, max } = f.node as { min?: string; max?: string };
      if ((min && v < min) || (max && v > max)) return { ok: false, field: f, issue: 'outOfRange' };
    } else if (f.type === 'Input' && f.node.inputType === 'number') {
      if (!Number.isFinite(Number(v))) return { ok: false, field: f, issue: 'notNumber' };
    } else if (f.type === 'Input' && f.node.inputType === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, field: f, issue: 'badEmail' };
    }
    out[f.name] = v;
  }
  return { ok: true, values: out };
}

/** How a value reads for people: a choice by its option's label; true/false in the words given. */
export function cardValueText(
  field: CardField,
  value: CardValue,
  words: { yes: string; no: string },
): string {
  if (typeof value === 'boolean') return value ? words.yes : words.no;
  if (field.type === 'Select' || field.type === 'RadioGroup') {
    return (field.node.options as CardOption[]).find((o) => o.value === value)?.label ?? value;
  }
  return value;
}

/** An `open_url` press opens this address on the device; anything but http(s) is not one. */
export function cardLink(act: CardAction | undefined): string | null {
  if (act?.type !== 'open_url' || !isRecord(act.payload)) return null;
  const url = act.payload.url;
  return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

/**
 * The card as plain text, for chat apps that cannot draw it, search, and the bot reading back the
 * card an answer replies to: titles and text as lines, fields as `label: …`, buttons as `[label]`.
 */
export function cardText(card: Card): string {
  const fields = new Map(cardFields(card).map((f) => [f.node.id, f]));
  const lines: string[] = [];
  const line = (n: CardNode): string | null => {
    switch (n.type) {
      case 'Title':
      case 'Text':
      case 'Caption':
      case 'Markdown':
        return String(n.value);
      case 'Badge':
        return `[${String(n.label)}]`;
      case 'Button':
        return n.label ? `[${String(n.label)}]` : null;
      case 'Checkbox':
        return `☐ ${fields.get(n.id)?.label ?? String(n.name)}`;
      case 'Select':
      case 'RadioGroup': {
        const opts = (n.options as CardOption[]).map((o) => o.label).join(' / ');
        return `${fields.get(n.id)?.label ?? String(n.name)}: ${opts}`;
      }
      case 'Input':
      case 'Textarea':
      case 'DatePicker': {
        const v = typeof n.defaultValue === 'string' && n.defaultValue ? n.defaultValue : '…';
        return `${fields.get(n.id)?.label ?? String(n.name)}: ${v}`;
      }
      default:
        return null;
    }
  };
  const walkText = (n: CardNode) => {
    if (n.type === 'ListViewItem' || n.type === 'Row') {
      const inline = inlineText(n);
      const buttons = (n.children ?? []).flatMap((c) => {
        const out: string[] = [];
        visit(c, (x) => {
          if (x.type === 'Button' && x.label) out.push(`[${String(x.label)}]`);
        });
        return out;
      });
      const joined = [inline, ...buttons].filter(Boolean).join(' ');
      if (joined) lines.push(n.type === 'ListViewItem' ? `• ${joined}` : joined);
      // Fields in a row still read one per line.
      visit(n, (x) => {
        if (FIELDS.has(x.type)) lines.push(line(x)!);
      });
      return;
    }
    if (n.type === 'Label' && typeof n.fieldName === 'string') return;
    const own = line(n);
    if (own) lines.push(own);
    for (const c of n.children ?? []) walkText(c);
  };
  walkText(card.root);
  const root = card.root as { confirm?: { label: string }; cancel?: { label: string } };
  const ends = [root.confirm, root.cancel].filter(Boolean).map((b) => `[${b!.label}]`);
  if (ends.length) lines.push(ends.join(' '));
  return clip(lines.filter((l) => l.trim()).join('\n'), CARD_LIMITS.fallback);
}
