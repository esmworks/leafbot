import { describe, expect, it } from 'vitest';
import {
  CARD_LIMITS,
  cardDefaults,
  cardFields,
  cardLink,
  cardPress,
  cardPresses,
  cardText,
  cardValueText,
  checkCardValues,
  parseCard,
  storedCard,
  type Card,
} from './card';

const ok = (input: unknown): Card => {
  const r = parseCard(input);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.card;
};

const reminder = {
  type: 'Card',
  children: [
    { type: 'Title', value: 'Daily reminder', color: '#ff0000', background: 'red' },
    {
      type: 'Form',
      onSubmitAction: { type: 'save_reminder', payload: { id: 'r1' } },
      children: [
        { type: 'Label', value: 'Time', fieldName: 'time' },
        { type: 'Input', name: 'time', defaultValue: '09:00', required: true },
        {
          type: 'Select',
          name: 'repeat',
          placeholder: 'Repeat',
          options: [
            { value: 'weekdays', label: 'Weekdays' },
            { value: 'daily', label: 'Every day' },
          ],
          defaultValue: 'weekdays',
        },
        { type: 'Checkbox', name: 'sound', label: 'Play a sound' },
        { type: 'Button', label: 'Save', submit: true, style: 'primary' },
      ],
    },
  ],
  cancel: { label: 'Not now', action: { type: 'dismiss' } },
};

describe('parseCard', () => {
  it('keeps the props it draws, numbers the nodes and drops styling it does not', () => {
    const card = ok(reminder);
    expect(card.v).toBe(1);
    expect(card.root.id).toBe('n1');
    const title = card.root.children![0]!;
    expect(title).toEqual({ type: 'Title', id: 'n2', value: 'Daily reminder' });
    expect(card.root.cancel).toEqual({ label: 'Not now', action: { type: 'dismiss' } });
  });

  it('reads a tree sent as a JSON string, and puts a bare component in a card', () => {
    const card = ok(JSON.stringify({ type: 'Text', value: 'hi' }));
    expect(card.root.type).toBe('Card');
    expect(card.root.children![0]).toMatchObject({ type: 'Text', value: 'hi' });
  });

  it('turns a bare word into text and unwraps a transition', () => {
    const card = ok({
      type: 'Card',
      children: ['hello', { type: 'Transition', children: { type: 'Divider' } }],
    });
    expect(card.root.children!.map((c) => c.type)).toEqual(['Text', 'Divider']);
  });

  it('wraps a list row given without ListViewItem, and refuses a row outside a list', () => {
    const list = ok({ type: 'ListView', children: [{ type: 'Text', value: 'a' }] });
    expect(list.root.children![0]!.type).toBe('ListViewItem');
    const r = parseCard({ type: 'Card', children: [{ type: 'ListViewItem', children: [] }] });
    expect(r).toMatchObject({ ok: false, error: { issue: 'listItemOutside', path: 'root.children[0]' } });
  });

  it('refuses unknown and undrawn components with where they are', () => {
    expect(parseCard({ type: 'Card', children: [{ type: 'Video' }] })).toMatchObject({
      ok: false,
      error: { issue: 'unknownType', detail: 'Video', path: 'root.children[0]' },
    });
    expect(parseCard({ type: 'Card', children: [{ type: 'Chart', data: [] }] })).toMatchObject({
      ok: false,
      error: { issue: 'unsupported', detail: 'Chart:show_page' },
    });
  });

  it('refuses a field that asks for a secret', () => {
    for (const f of [
      { type: 'Input', name: 'pw', inputType: 'password' },
      { type: 'Input', name: 'api_key' },
      { type: 'Input', name: 'x', placeholder: 'Your password' },
    ]) {
      expect(parseCard({ type: 'Card', children: [f] })).toMatchObject({
        ok: false,
        error: { issue: 'secret' },
      });
    }
  });

  it('refuses two fields of one name, a bad name and a choice without options', () => {
    const twice = {
      type: 'Card',
      children: [
        { type: 'Input', name: 'a' },
        { type: 'Checkbox', name: 'a' },
      ],
    };
    expect(parseCard(twice)).toMatchObject({ ok: false, error: { issue: 'duplicateName', detail: 'a' } });
    expect(parseCard({ type: 'Card', children: [{ type: 'Input', name: '1 x' }] })).toMatchObject({
      ok: false,
      error: { issue: 'badName' },
    });
    expect(parseCard({ type: 'Card', children: [{ type: 'Select', name: 's' }] })).toMatchObject({
      ok: false,
      error: { issue: 'noOptions' },
    });
  });

  it('refuses an action without a type and one with too large a payload', () => {
    const big = 'x'.repeat(CARD_LIMITS.payloadBytes);
    for (const a of [{}, { type: 'has space' }, { type: 'ok', payload: big }]) {
      expect(
        parseCard({ type: 'Card', children: [{ type: 'Button', label: 'B', onClickAction: a }] }),
      ).toMatchObject({
        ok: false,
        error: { issue: 'badAction' },
      });
    }
  });

  it('refuses a card past its limits', () => {
    const many = {
      type: 'Card',
      children: Array.from({ length: CARD_LIMITS.nodes + 1 }, () => ({ type: 'Spacer' })),
    };
    expect(parseCard(many)).toMatchObject({ ok: false, error: { issue: 'tooManyNodes' } });
    let deep: Record<string, unknown> = { type: 'Text', value: 'x' };
    for (let i = 0; i <= CARD_LIMITS.depth; i++) deep = { type: 'Col', children: [deep] };
    expect(parseCard({ type: 'Card', children: [deep] })).toMatchObject({
      ok: false,
      error: { issue: 'tooDeep' },
    });
    expect(
      parseCard({ type: 'Card', children: [{ type: 'Text', value: 'x'.repeat(CARD_LIMITS.bytes) }] }),
    ).toMatchObject({ ok: false, error: { issue: 'tooLarge' } });
  });

  it('keeps a date picker to days and drops a default that is not an option', () => {
    const card = ok({
      type: 'Card',
      children: [
        { type: 'DatePicker', name: 'd', defaultValue: '2026-12-01T10:00:00Z', min: 'soon' },
        { type: 'RadioGroup', name: 'r', options: ['a', 'b'], defaultValue: 'c' },
      ],
    });
    const [d, r] = card.root.children!;
    expect(d).toMatchObject({ defaultValue: '2026-12-01' });
    expect(d!.min).toBeUndefined();
    expect(r!.defaultValue).toBeUndefined();
    expect(r!.options).toEqual([
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b' },
    ]);
  });

  it('turns a nested card into a plain group', () => {
    const card = ok({ type: 'Card', children: [{ type: 'Card', children: [{ type: 'Text', value: 'x' }] }] });
    expect(card.root.children![0]!.type).toBe('Col');
  });
});

describe('presses and values', () => {
  const card = ok(reminder);

  it('names each field by its label, else its placeholder, else its name', () => {
    expect(cardFields(card).map((f) => [f.name, f.label])).toEqual([
      ['time', 'Time'],
      ['repeat', 'Repeat'],
      ['sound', 'Play a sound'],
    ]);
    expect(cardDefaults(card)).toEqual({ time: '09:00', repeat: 'weekdays', sound: false });
  });

  it("gives a form's submit button the form's action and fields", () => {
    const save = cardPresses(card).find((p) => p.label === 'Save')!;
    expect(save.action).toEqual({ type: 'save_reminder', payload: { id: 'r1' } });
    expect(save.fields.map((f) => f.name)).toEqual(['time', 'repeat', 'sound']);
    const cancel = cardPress(card, 'cancel')!;
    expect(cancel).toMatchObject({ cancel: true, fields: [], action: { type: 'dismiss' } });
  });

  it('sends only the fields outside forms from a button outside a form', () => {
    const c = ok({
      type: 'Card',
      children: [
        { type: 'Input', name: 'outside' },
        { type: 'Form', children: [{ type: 'Input', name: 'inside' }] },
        { type: 'Button', label: 'Go' },
      ],
    });
    const go = cardPresses(c).find((p) => p.label === 'Go')!;
    expect(go.fields.map((f) => f.name)).toEqual(['outside']);
    expect(go.action).toBeUndefined();
  });

  it('checks values against the fields and drops the rest', () => {
    const save = cardPresses(card).find((p) => p.label === 'Save')!;
    expect(checkCardValues(save, { time: ' 10:30 ', repeat: 'daily', sound: true, extra: 'x' })).toEqual({
      ok: true,
      values: { time: '10:30', repeat: 'daily', sound: true },
    });
    expect(checkCardValues(save, { time: '', repeat: 'daily' })).toMatchObject({
      ok: false,
      issue: 'required',
    });
    expect(checkCardValues(save, { time: '1', repeat: 'hourly' })).toMatchObject({
      ok: false,
      issue: 'notOption',
    });
    expect(checkCardValues(cardPress(card, 'cancel')!, {})).toEqual({ ok: true, values: {} });
  });

  it('checks dates, numbers and mail addresses', () => {
    const c = ok({
      type: 'Card',
      children: [
        { type: 'DatePicker', name: 'd', min: '2026-01-01', max: '2026-12-31' },
        { type: 'Input', name: 'n', inputType: 'number' },
        { type: 'Input', name: 'e', inputType: 'email' },
      ],
      confirm: { label: 'OK' },
    });
    const press = cardPress(c, 'confirm')!;
    expect(checkCardValues(press, { d: '2026-02-30' })).toMatchObject({ issue: 'badDate' });
    expect(checkCardValues(press, { d: '2027-01-01' })).toMatchObject({ issue: 'outOfRange' });
    expect(checkCardValues(press, { n: 'ten' })).toMatchObject({ issue: 'notNumber' });
    expect(checkCardValues(press, { e: 'nope' })).toMatchObject({ issue: 'badEmail' });
    expect(checkCardValues(press, { d: '2026-05-05', n: 3, e: 'a@b.co' })).toEqual({
      ok: true,
      values: { d: '2026-05-05', n: '3', e: 'a@b.co' },
    });
  });

  it('reads a value by its option label and a checkbox in the words given', () => {
    const [, repeat, sound] = cardFields(card);
    expect(cardValueText(repeat!, 'daily', { yes: 'Yes', no: 'No' })).toBe('Every day');
    expect(cardValueText(sound!, false, { yes: 'Yes', no: 'No' })).toBe('No');
  });

  it('lets a list row be pressed by the words it shows', () => {
    const list = ok({
      type: 'ListView',
      children: [
        {
          type: 'ListViewItem',
          onClickAction: { type: 'pick', payload: { id: 7 } },
          children: [
            { type: 'Text', value: 'Standing desk' },
            { type: 'Badge', label: '$299' },
          ],
        },
      ],
    });
    expect(cardPresses(list)).toEqual([
      {
        ref: 'n2',
        label: 'Standing desk · $299',
        cancel: false,
        action: { type: 'pick', payload: { id: 7 } },
        fields: [],
      },
    ]);
  });

  it('opens only http(s) links', () => {
    expect(cardLink({ type: 'open_url', payload: { url: 'https://example.com/a' } })).toBe(
      'https://example.com/a',
    );
    expect(cardLink({ type: 'open_url', payload: { url: 'javascript:alert(1)' } })).toBeNull();
    expect(cardLink({ type: 'other', payload: { url: 'https://example.com' } })).toBeNull();
  });
});

describe('cardText', () => {
  it('writes a card as lines a chat app can show', () => {
    expect(cardText(ok(reminder))).toBe(
      [
        'Daily reminder',
        'Time: 09:00',
        'Repeat: Weekdays / Every day',
        '☐ Play a sound',
        '[Save]',
        '[Not now]',
      ].join('\n'),
    );
  });

  it('writes a list row on one line', () => {
    const list = ok({
      type: 'ListView',
      children: [
        {
          type: 'ListViewItem',
          children: [
            { type: 'Title', value: 'A' },
            { type: 'Caption', value: 'b' },
          ],
        },
      ],
    });
    expect(cardText(list)).toBe('• A · b');
  });
});

describe('storedCard', () => {
  it('reads back only a card', () => {
    const card = ok(reminder);
    expect(storedCard(JSON.parse(JSON.stringify(card)))).toEqual(card);
    expect(storedCard({ v: 2, root: {} })).toBeNull();
    expect(storedCard('x')).toBeNull();
  });
});
