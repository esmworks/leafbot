import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunInputs } from './RunInputs';

afterEach(cleanup);

/** The window as the routine page draws it: inside the routine's own form, under a canvas that hears Escape. */
function show() {
  const save = vi.fn((e: { preventDefault(): void }) => e.preventDefault());
  const onRun = vi.fn();
  const onOpenChange = vi.fn();
  const heard = vi.fn();
  window.addEventListener('keydown', heard);
  render(
    <form onSubmit={save}>
      <RunInputs open onOpenChange={onOpenChange} inputs={{ topic: 'weekly' }} onRun={onRun} />
    </form>,
  );
  return { save, onRun, onOpenChange, heard, done: () => window.removeEventListener('keydown', heard) };
}

describe('the window that asks a run’s values', () => {
  it('runs with the values typed, starting from the usual ones, and does not save the routine', () => {
    const w = show();
    const field = screen.getByLabelText('topic');
    expect(field).toHaveProperty('value', 'weekly');
    fireEvent.change(field, { target: { value: 'monthly' } });
    fireEvent.submit(field.closest('form')!);
    expect(w.onRun).toHaveBeenCalledWith({ topic: 'monthly' });
    expect(w.save).not.toHaveBeenCalled();
    w.done();
  });

  it('keeps the Escape that closes it from the canvas behind it', () => {
    const w = show();
    fireEvent.keyDown(screen.getByLabelText('topic'), { key: 'Escape' });
    expect(w.onOpenChange).toHaveBeenCalledWith(false);
    expect(w.heard).not.toHaveBeenCalled();
    w.done();
  });
});
