import type { FlowLayout, RoutineRun } from '@leafbot/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineFlow } from './RoutineFlow';
import { StepsEditor, type StepForm } from './RoutineSteps';

vi.mock('@/lib/api', () => ({ api: {} }));

const agent = (id: string, prompt: string): StepForm => ({ id, kind: 'agent', prompt, model: '' });

/** The routine window's two views over the same steps, side by side. */
function Both({
  initial,
  run = null,
  onLayout,
}: {
  initial: StepForm[];
  run?: RoutineRun | null;
  onLayout?(next: FlowLayout): void;
}) {
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
const boxAt = (title: string) => {
  const box = flow().getByRole('region', { name: title });
  return { x: parseInt(box.style.left), y: parseInt(box.style.top) };
};

describe('rutin akışı', () => {
  afterEach(cleanup);

  it('akışta eklenen ve kutuda değiştirilen adım listede de görünür', async () => {
    render(<Both initial={[agent('a', 'Summarise it')]} />);
    expect(flow().getByText('Every day at 09:00')).toBeTruthy();
    expect(flow().getByText('Also starts when mail arrives.')).toBeTruthy();
    // The line from the instruction to the first step: a step added there comes first.
    const add = flow().getAllByRole('button', { name: 'Add a step here' })[0]!;
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Bot step/ }));
    expect(listed()).toEqual(['', 'Summarise it']);
    // Each box edits its step where it is.
    const fields = flow().getAllByPlaceholderText(/step before ended with/);
    expect(fields).toHaveLength(2);
    fireEvent.change(fields[0]!, { target: { value: 'Pick the top three' } });
    expect(listed()).toEqual(['Pick the top three', 'Summarise it']);
  });

  it('adımın koşulu listede açılır, akışın kutusunda da aynı görünür; kapatılınca silinir', () => {
    let last: StepForm[] = [];
    function Watch() {
      const [steps, setSteps] = useState([agent('a', 'Summarise it')]);
      last = steps;
      return <StepsEditor steps={steps} onChange={setSteps} modelListId="m" modelPlaceholder="" />;
    }
    render(<Watch />);
    expect(screen.queryByPlaceholderText(/Text to look for/)).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Run this step only if…' }));
    fireEvent.change(screen.getByPlaceholderText(/Text to look for/), { target: { value: '[1]' } });
    fireEvent.click(screen.getByRole('radio', { name: 'It lacks' }));
    fireEvent.click(screen.getByRole('radio', { name: 'End the run' }));
    expect(last[0]!.when).toEqual({ contains: '[1]', filter: '', absent: true, otherwise: 'end' });
    fireEvent.click(screen.getByRole('switch', { name: 'Run this step only if…' }));
    expect(last[0]!.when).toBeNull();
    cleanup();

    const gated: StepForm = {
      ...agent('b', 'Send it'),
      when: { contains: 'approved', filter: '', absent: false, otherwise: 'skip' },
    };
    render(<Both initial={[gated]} />);
    expect(flow().getByDisplayValue('approved')).toBeTruthy();
    expect(list().getByDisplayValue('approved')).toBeTruthy();
  });

  it('Alt ve ok tuşuyla sırayı değiştirir, Delete siler; bir alana yazarken tuşlar alanındır', () => {
    render(<Both initial={[agent('a', 'One'), agent('b', 'Two')]} />);
    fireEvent.keyDown(titles()[3]!, { key: 'ArrowUp', altKey: true });
    expect(listed()).toEqual(['Two', 'One']);
    // Backspace in a step's own text field deletes a letter, not the step.
    fireEvent.keyDown(flow().getByDisplayValue('Two'), { key: 'Backspace' });
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
});
