import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lazyScreen, preloadWhenIdle, servedLocally } from './lazyScreen';

function Page({ name }: { name: string }) {
  return <p>page {name}</p>;
}

afterEach(() => vi.restoreAllMocks());

describe('lazyScreen', () => {
  it('draws nothing while loading, then the page; later renders are synchronous', async () => {
    const load = vi.fn(() => Promise.resolve(Page));
    const Lazy = lazyScreen(load);
    const first = render(<Lazy name="a" />);
    expect(first.container.textContent).toBe('');
    await screen.findByText('page a');
    first.unmount();
    // Loaded: the page is there in the very first render, with nothing to wait for.
    const second = render(<Lazy name="b" />);
    expect(second.container.textContent).toBe('page b');
    expect(load).toHaveBeenCalledTimes(1);
    expect(Lazy.loaded()).toBe(true);
  });

  it('shows a retry line when the import fails and imports afresh when asked', async () => {
    const load = vi
      .fn<() => Promise<typeof Page>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(Page);
    const Lazy = lazyScreen(load);
    render(<Lazy name="c" />);
    const retry = await screen.findByRole('button');
    fireEvent.click(retry);
    await screen.findByText('page c');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('preload fetches once, never rejects, and shares the import with a render', async () => {
    let resolve!: (c: typeof Page) => void;
    const load = vi.fn(() => new Promise<typeof Page>((r) => (resolve = r)));
    const Lazy = lazyScreen(load);
    const a = Lazy.preload();
    const b = Lazy.preload();
    render(<Lazy name="d" />);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(Page);
      await Promise.all([a, b]);
    });
    await screen.findByText('page d');

    const Broken = lazyScreen(() => Promise.reject(new Error('x')));
    await expect(Broken.preload()).resolves.toBeUndefined();
    expect(Broken.loaded()).toBe(false);
  });
});

describe('preloadWhenIdle', () => {
  it('does nothing on a local address', () => {
    expect(servedLocally('127.0.0.1')).toBe(true);
    expect(servedLocally('[::1]')).toBe(true);
    expect(servedLocally('app.localhost')).toBe(true);
    expect(servedLocally('example.com')).toBe(false);
    const preload = vi.fn(() => Promise.resolve());
    // jsdom's own address is localhost.
    preloadWhenIdle([{ preload }]);
    expect(preload).not.toHaveBeenCalled();
  });

  it('fetches one screen per idle slot elsewhere', async () => {
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, hostname: 'example.com' });
    const idle: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb));
    vi.stubGlobal('cancelIdleCallback', () => {});
    const one = vi.fn(() => Promise.resolve());
    const two = vi.fn(() => Promise.resolve());
    preloadWhenIdle([{ preload: one }, { preload: two }]);
    expect(one).not.toHaveBeenCalled();
    idle.shift()!();
    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
    await waitFor(() => expect(idle).toHaveLength(1));
    idle.shift()!();
    expect(two).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
