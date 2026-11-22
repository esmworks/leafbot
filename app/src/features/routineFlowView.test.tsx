import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RoutineFlow } from './RoutineFlow';
import { StepsEditor, type StepForm } from './RoutineSteps';

vi.mock('@/lib/api', () => ({ api: {} }));

const agent = (id: string, prompt: string): StepForm => ({ id, kind: 'agent', prompt, model: '' });

/** The routine window's two views over the same steps, side by side. */
function Both({ initial }: { initial: StepForm[] }) {
  const [steps, setSteps] = useState(initial);
  const [prompt, setPrompt] = useState('Read the news');
  return (
    <>
      <div data-testid="flow">
        <RoutineFlow
          triggers={['Every day at 09:00']}
          prompt={prompt}
          onPrompt={setPrompt}
          steps={steps}
          onSteps={setSteps}
          modelListId="m"
          modelPlaceholder=""
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

describe('rutin akışı', () => {
  afterEach(cleanup);

  it('akışta eklenen ve değiştirilen adım listede de görünür', async () => {
    render(<Both initial={[agent('a', 'Summarise it')]} />);
    expect(flow().getByText('Every day at 09:00')).toBeTruthy();
    // The line under the instruction: a step added there comes first.
    const add = flow().getAllByRole('button', { name: 'Add a step here' })[0]!;
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Bot step/ }));
    expect(listed()).toEqual(['', 'Summarise it']);
    // The new step is picked; its fields are in the panel.
    const panel = flow().getAllByPlaceholderText(/step before ended with/);
    expect(panel).toHaveLength(1);
    fireEvent.change(panel[0]!, { target: { value: 'Pick the top three' } });
    expect(listed()).toEqual(['Pick the top three', 'Summarise it']);
  });

  it('Alt ve ok tuşuyla taşır, Delete siler; bir alana yazarken tuşlar alanındır', () => {
    render(<Both initial={[agent('a', 'One'), agent('b', 'Two')]} />);
    const two = flow().getByRole('button', { name: /Two/ });
    fireEvent.click(two);
    fireEvent.keyDown(two, { key: 'ArrowUp', altKey: true });
    expect(listed()).toEqual(['Two', 'One']);
    // Backspace in the step's own text field deletes a letter, not the step.
    const field = flow().getByDisplayValue('Two');
    fireEvent.keyDown(field, { key: 'Backspace' });
    expect(listed()).toEqual(['Two', 'One']);
    fireEvent.keyDown(flow().getByRole('button', { name: /Two/ }), { key: 'Delete' });
    expect(listed()).toEqual(['One']);
  });

  it('tutamaktan sürüklenen adım bırakıldığı çizgiye geçer', () => {
    render(<Both initial={[agent('a', 'One'), agent('b', 'Two'), agent('c', 'Three')]} />);
    const handles = flow().getAllByRole('button', { name: 'Drag to move the step' });
    // jsdom lays nothing out: put the canvas and its lines where a browser would.
    const root = screen.getByTestId('flow');
    const rect = (top: number, height: number) => () =>
      ({ top, height, left: 0, right: 400, bottom: top + height }) as DOMRect;
    root.querySelector<HTMLElement>('[aria-label="Flow"]')!.getBoundingClientRect = rect(0, 600);
    root.querySelectorAll<HTMLElement>('[data-gap]').forEach((el) => {
      el.getBoundingClientRect = rect(100 + Number(el.dataset.gap) * 100, 40);
    });
    fireEvent.pointerDown(handles[0]!);
    // Let go nearest the line below "Two", the third gap, with no move in between.
    fireEvent.pointerUp(window, { clientX: 200, clientY: 318 });
    expect(listed()).toEqual(['Two', 'One', 'Three']);
    // Let go outside the canvas: nothing moves.
    fireEvent.pointerDown(flow().getAllByRole('button', { name: 'Drag to move the step' })[0]!);
    fireEvent.pointerUp(window, { clientX: 900, clientY: 318 });
    expect(listed()).toEqual(['Two', 'One', 'Three']);
  });
});
