import { beforeEach, describe, expect, it, vi } from 'vitest';

const launchMark = vi.fn(() => Promise.resolve());

describe('page marks', () => {
  beforeEach(() => {
    vi.resetModules();
    launchMark.mockClear();
  });

  it('sends each stage once, and the long-task count with the chat', async () => {
    vi.doMock('./desktop', () => ({ desktop: { launchMark } }));
    const { pageMark } = await import('./launchMarks');
    pageMark('first-paint');
    pageMark('first-paint');
    pageMark('chat');
    expect(launchMark).toHaveBeenCalledTimes(2);
    expect(launchMark).toHaveBeenNthCalledWith(1, 'first-paint');
    expect(launchMark).toHaveBeenNthCalledWith(2, 'chat', { count: 0, totalMs: 0 });
  });

  it('sends nothing outside the desktop app', async () => {
    vi.doMock('./desktop', () => ({ desktop: null }));
    const { pageMark } = await import('./launchMarks');
    pageMark('sidebar');
    expect(launchMark).not.toHaveBeenCalled();
  });
});
