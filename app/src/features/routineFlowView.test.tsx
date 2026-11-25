import type { FlowLayout, FlowNote, RoutineRun } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render as draw, screen, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineFlow } from './RoutineFlow';
import { StepsEditor, type StepForm } from './RoutineSteps';

vi.mock('@/lib/api', () => ({
  api: { bots: async () => [{ id: 'b2', name: 'Ayşe', archivedAt: null }] },
}));

/** The bot pickers read the bots, as the app does. */
const render = (ui: ReactNode) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return draw(ui, {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  });
};

const agent = (id: string, prompt: string): StepForm => ({ id, kind: 'agent', prompt, model: '' });

/** The routine window's two views over the same steps, side by side. */
function Both({
  initial,
  run = null,
  onLayout,
  onNotes,
}: {
  initial: StepForm[];
  run?: RoutineRun | null;
  onLayout?(next: FlowLayout): void;
  onNotes?(next: FlowNote[]): void;
}) {
  const [notes, setNotes] = useState<FlowNote[]>([]);
  const [steps, setSteps] = useState(initial);
  const [prompt, setPrompt] = useState('Read the news');
  const [layout, setLayout] = useState<FlowLayout | null>(null);
  return (
    <>
      <div data-testid="flow">
        <RoutineFlow
          triggers={['when mail arrives']}
          schedule={<span>Every day at 09:00</span>}
          when="Next run tomorrow"
          run={run}
          prompt={prompt}
          onPrompt={setPrompt}
          steps={steps}
          onSteps={setSteps}
          modelListId="m"
          modelPlaceholder=""
          layout={layout}
          onLayout={(next) => {
            setLayout(next);
            onLayout?.(next);
          }}
          notes={notes}
          onNotes={(next) => {
            setNotes(next);
            onNotes?.(next);
          }}
        />
      </div>
      <div data-testid="list">
        <StepsEditor steps={steps} onChange={setSteps} modelListId="m" modelPlaceholder="" />
      </div>
    </>
  );
}

const flow = () => within(screen.getByTestId('flow'));
const list = () => within(screen.getByTestId('list'));
/** The steps' texts as the list shows them, in order. */
const listed = () =>
  list()
    .queryAllByPlaceholderText(/step before ended with/)
    .map((el) => (el as HTMLTextAreaElement).value);
/** The title bars of the boxes, in order: start, instruction, then each step. */
const titles = () => flow().getAllByTitle('Drag to move the box');
/** The window over the canvas, named after the box open in it. */
const panel = (title: string) => within(screen.getByRole('dialog', { name: title }));
/** Closes it as Escape does. */
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
/** Opens a box by a click on what it says. */
const openBox = (title: string, i = 0) =>
  fireEvent.click(flow().getAllByRole('button', { name: `${title}. Open to edit` })[i]!);
const boxAt = (title: string) => {
  const box = flow().getByRole('region', { name: title });
  return { x: parseInt(box.style.left), y: parseInt(box.style.top) };
};

describe('rutin akışı', () => {
  afterEach(cleanup);

  it('kutu ne yaptığını söyler; tıklanınca alanları yanda açılır', async () => {
    render(<Both initial={[agent('a', 'Summarise it')]} />);
    // The first box says when it runs and what else starts it; its fields are in its panel.
    const start = within(flow().getByRole('region', { name: 'Start' }));
    expect(start.getByText('Next run tomorrow')).toBeTruthy();
    expect(start.getByText('when mail arrives')).toBeTruthy();
    expect(flow().queryByText('Every day at 09:00')).toBeNull();
    // No box holds a field of its own.
    for (const box of flow().getAllByRole('region')) expect(within(box).queryByRole('textbox')).toBeNull();
    openBox('Start');
    expect(panel('Start').getByText('Every day at 09:00')).toBeTruthy();
    expect(panel('Start').getByText('Also starts when mail arrives.')).toBeTruthy();
  });

  it('akışta eklenen adım hemen açılır; panelde değiştirilen adım listede ve kutuda da görünür', async () => {
    render(<Both initial={[agent('a', 'Summarise it')]} />);
    // The line from the instruction to the first step: a step added there comes first.
    const add = flow().getAllByRole('button', { name: 'Add a step here' })[0]!;
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Bot step/ }));
    expect(listed()).toEqual(['', 'Summarise it']);
    // The new step is open in its window, ready to be written.
    fireEvent.change(panel('Bot step').getByRole('textbox', { name: 'Bot step' }), {
      target: { value: 'Pick the top three' },
    });
    expect(listed()).toEqual(['Pick the top three', 'Summarise it']);
    // Escape closes the window; the boxes say what was written.
    escape();
    expect(screen.queryByRole('dialog')).toBeNull();
    const boxes = flow().getAllByRole('region', { name: 'Bot step' });
    expect(boxes[0]!.textContent).toContain('Pick the top three');
    expect(boxes[1]!.textContent).toContain('Summarise it');
  });

  it('talimatın metni kutuda başıyla görünür, tamamı panelde yazılır', async () => {
    render(<Both initial={[]} />);
    const box = within(flow().getByRole('region', { name: 'What should it do?' }));
    expect(box.queryByRole('textbox')).toBeNull();
    expect(box.getByText('Read the news')).toBeTruthy();
    openBox('What should it do?');
    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. Check one more thing`).join('\n');
    fireEvent.change(panel('What should it do?').getByRole('textbox'), { target: { value: long } });
    fireEvent.click(panel('What should it do?').getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(flow().getByRole('region', { name: 'What should it do?' }).textContent).toContain(
      '40. Check one more thing',
    );
  });

  it('adımın koşulu listede açılır, akışın kutusunda da aynı görünür; kapatılınca silinir', () => {
    const changed = vi.fn<(next: StepForm[]) => void>();
    const last = () => changed.mock.lastCall![0];
    function Watch() {
      const [steps, setSteps] = useState([agent('a', 'Summarise it')]);
      return (
        <StepsEditor
          steps={steps}
          onChange={(next) => {
            setSteps(next);
            changed(next);
          }}
          modelListId="m"
          modelPlaceholder=""
        />
      );
    }
    render(<Watch />);
    expect(screen.queryByPlaceholderText(/Text to look for/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Run this step only if…' }));
    fireEvent.change(screen.getByPlaceholderText(/Text to look for/), { target: { value: '[1]' } });
    fireEvent.click(screen.getByRole('radio', { name: 'It lacks' }));
    fireEvent.click(screen.getByRole('radio', { name: 'End the run' }));
    expect(last()[0]!.when).toEqual({ contains: '[1]', filter: '', absent: true, otherwise: 'end' });
    fireEvent.click(screen.getByRole('switch', { name: 'Run this step only if…' }));
    expect(last()[0]!.when).toBeNull();
    cleanup();

    const gated: StepForm = {
      ...agent('b', 'Send it'),
      when: { contains: 'approved', filter: '', absent: false, otherwise: 'skip' },
    };
    render(<Both initial={[gated]} />);
    // The box says the step has a condition; its panel holds it, as the list does.
    expect(within(flow().getByRole('region', { name: 'Bot step' })).getByText('Conditional')).toBeTruthy();
    openBox('Bot step');
    expect(panel('Bot step').getByDisplayValue('approved')).toBeTruthy();
    expect(list().getByDisplayValue('approved')).toBeTruthy();
  });

  it('adımın yolları listede ve akışın kutusunda aynı görünür; akış atlamayı etiketli çizer', () => {
    const steps: StepForm[] = [
      {
        id: 'a',
        kind: 'agent',
        prompt: 'Compare the prices',
        model: '',
        onError: 'c',
        when: { contains: 'changed', filter: '', absent: false, otherwise: 'goto', goto: 'c' },
      },
      { ...agent('b', 'Write a summary'), next: 'end' },
      { id: 'c', kind: 'notify', text: 'Nothing changed', withBefore: false },
    ];
    render(<Both initial={steps} />);
    const first = (view: ReturnType<typeof within>) => {
      expect(view.getByRole('radio', { name: 'Go on at another step' }).getAttribute('aria-checked')).toBe(
        'true',
      );
      const failing = view.getAllByRole('combobox', { name: 'If it fails' })[0]!;
      expect(failing.textContent).toContain('Notify step: Nothing changed');
    };
    first(list());
    expect(list().getAllByRole('combobox', { name: 'Then' })[1]!.textContent).toContain('End the run here');
    // The flow shows the same ways in each step's panel.
    openBox('Bot step', 0);
    first(panel('Bot step'));
    escape();
    openBox('Bot step', 1);
    expect(panel('Bot step').getAllByRole('combobox', { name: 'Then' })[0]!.textContent).toContain(
      'End the run here',
    );
    escape();
    // Two ways leave the first box for the last: the condition's other way and the way on failure.
    expect(flow().getByText('if not')).toBeTruthy();
    expect(flow().getByText('if it fails')).toBeTruthy();
    // The last step has nothing after it, but it may go back to the steps before it.
    const last = list().getAllByRole('combobox', { name: 'Then' });
    expect(last).toHaveLength(3);
    expect(last[2]!.textContent).toContain('Go on to the next step');
  });

  it('Alt ve ok tuşuyla sırayı değiştirir, Delete siler; bir alana yazarken tuşlar alanındır', () => {
    render(<Both initial={[agent('a', 'One'), agent('b', 'Two')]} />);
    fireEvent.keyDown(titles()[3]!, { key: 'ArrowUp', altKey: true });
    expect(listed()).toEqual(['Two', 'One']);
    // Enter opens a box; Backspace in a step's own field deletes a letter, not the step.
    fireEvent.keyDown(titles()[2]!, { key: 'Enter' });
    fireEvent.keyDown(panel('Bot step').getByLabelText("The step's model"), { key: 'Backspace' });
    expect(listed()).toEqual(['Two', 'One']);
    fireEvent.keyDown(titles()[2]!, { key: 'Delete' });
    expect(listed()).toEqual(['One']);
    // The instruction is not a step: Delete leaves everything.
    fireEvent.keyDown(titles()[1]!, { key: 'Delete' });
    expect(listed()).toEqual(['One']);
  });

  it('kutu başlığından sürüklenince yerinde kalır, sıra değişmez', () => {
    const saved = vi.fn();
    render(<Both initial={[agent('a', 'One'), agent('b', 'Two')]} onLayout={saved} />);
    const before = boxAt('Start');
    fireEvent.pointerDown(titles()[0]!, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 300, clientY: 500 });
    fireEvent.pointerUp(window, { clientX: 300, clientY: 500 });
    expect(boxAt('Start')).toEqual({ x: before.x + 200, y: before.y + 400 });
    expect(listed()).toEqual(['One', 'Two']);
    // The click that ends a drag places the box; a click after it opens the box.
    fireEvent.click(titles()[0]!);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(titles()[0]!);
    expect(screen.getByRole('dialog', { name: 'Start' })).toBeTruthy();
    // Every box keeps its place from then on.
    expect(Object.keys(saved.mock.calls[0]![0] as FlowLayout).sort()).toEqual(['a', 'b', 'prompt', 'start']);
    // A press on the title without moving saves nothing.
    fireEvent.pointerDown(titles()[0]!, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it('ok tuşları kutuyu kaydırır', () => {
    render(<Both initial={[]} />);
    const before = boxAt('Start');
    fireEvent.keyDown(titles()[0]!, { key: 'ArrowRight' });
    fireEvent.keyDown(titles()[0]!, { key: 'ArrowDown' });
    expect(boxAt('Start')).toEqual({ x: before.x + 16, y: before.y + 16 });
  });

  it('son çalışmada her kutunun payını adımın kimliğiyle gösterir', () => {
    const step = { reason: null, startedAt: null, finishedAt: null };
    const run: RoutineRun = {
      id: 'r',
      routineId: 'x',
      occurrence: 'o',
      status: 'running',
      reason: null,
      threadId: null,
      startedAt: '2026-11-22T09:00:00.000Z',
      finishedAt: null,
      gate: null,
      steps: [
        { ...step, position: 0, kind: 'prompt', status: 'done', output: 'Three items found' },
        { ...step, position: 1, kind: 'agent', stepId: 'a', status: 'running', output: null },
      ],
    };
    const { unmount } = render(<Both initial={[agent('a', 'Sum it up')]} run={run} />);
    const prompt = within(flow().getByRole('region', { name: 'What should it do?' }));
    expect(prompt.getByText('Three items found')).toBeTruthy();
    expect(prompt.getByText('done')).toBeTruthy();
    expect(within(flow().getByRole('region', { name: 'Bot step' })).getByText('running')).toBeTruthy();
    unmount();
    // The step taken out and another put in its place: the new one has not run.
    render(<Both initial={[agent('b', 'Sum it up')]} run={run} />);
    expect(within(flow().getByRole('region', { name: 'Bot step' })).queryByText('running')).toBeNull();
  });

  it('names the bot that does a step on its box, and lets another bot be picked for it', async () => {
    render(
      <Both
        initial={[
          { id: 'a', kind: 'agent', prompt: 'Research it', model: '', bot: 'b2' },
          agent('b', 'Check it'),
        ]}
      />,
    );
    expect(await flow().findByRole('region', { name: 'Bot step: Ayşe' })).toBeTruthy();
    expect(flow().getByRole('region', { name: 'Bot step' })).toBeTruthy();
    // The step another bot does runs on that bot's model: the routine's are not offered for it.
    expect(list().getAllByRole('combobox', { name: 'Done by' })).toHaveLength(2);
    expect(list().getAllByLabelText("The step's model")).toHaveLength(1);
    openBox('Bot step: Ayşe');
    expect(panel('Bot step: Ayşe').queryByLabelText("The step's model")).toBeNull();
  });

  it('yakınlaştırma düğmeleri ve Ctrl ile + tuvali büyütür, yüzdeye tıklamak gerçek boyuta döndürür', () => {
    render(<Both initial={[agent('a', 'Summarise it')]} />);
    const view = within(flow().getByRole('toolbar', { name: 'View' }));
    expect(view.getByRole('button', { name: /^At 100%/ })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /^Zoom in/ }));
    expect(view.getByRole('button', { name: /^At 120%/ })).toBeTruthy();
    fireEvent.keyDown(flow().getByRole('group', { name: 'Flow' }), { key: '=', ctrlKey: true });
    expect(view.getByRole('button', { name: /^At 144%/ })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /^At 144%/ }));
    expect(view.getByRole('button', { name: /^At 100%/ })).toBeTruthy();
    // Zooming changes only the view: no box gets a place of its own.
    expect(boxAt('Start')).toEqual({ x: 24, y: 24 });
  });

  it('dizmek her kutuya çalışma sırasıyla yeni bir yer verir', () => {
    const onLayout = vi.fn();
    render(<Both initial={[agent('a', 'One'), agent('b', 'Two')]} onLayout={onLayout} />);
    fireEvent.click(flow().getByRole('button', { name: 'Arrange the boxes in the order they run' }));
    const placed = onLayout.mock.calls.at(-1)![0] as FlowLayout;
    expect(Object.keys(placed)).toEqual(['start', 'prompt', 'a', 'b']);
    expect(placed.start!.x).toBeLessThan(placed.prompt!.x);
  });

  it('tuvale not eklenir, yazılır, rengi değişir ve silinir; kutulardan ayrı durur', async () => {
    const onNotes = vi.fn();
    render(<Both initial={[agent('a', 'Summarise it')]} onNotes={onNotes} />);
    fireEvent.click(flow().getByRole('button', { name: 'Add a note' }));
    const note = within(flow().getByRole('note', { name: 'Note' }));
    const text = note.getByRole('textbox', { name: 'Note' });
    // A note just added is ready to be written.
    expect(document.activeElement).toBe(text);
    fireEvent.change(text, { target: { value: 'Weekly, for the team' } });
    expect(onNotes.mock.calls.at(-1)![0]).toMatchObject([{ text: 'Weekly, for the team', color: 'yellow' }]);
    fireEvent.pointerDown(note.getByRole('button', { name: 'Note colour' }), { button: 0 });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Blue' }));
    expect(onNotes.mock.calls.at(-1)![0]).toMatchObject([{ color: 'blue' }]);
    // A note is no box: the boxes still hold no field of their own.
    for (const box of flow().getAllByRole('region')) expect(within(box).queryByRole('textbox')).toBeNull();
    fireEvent.click(within(flow().getByRole('note')).getByRole('button', { name: 'Delete the note' }));
    expect(flow().queryByRole('note')).toBeNull();
    expect(onNotes.mock.calls.at(-1)![0]).toEqual([]);
  });
});
