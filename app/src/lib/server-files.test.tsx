// @vitest-environment jsdom
import type { Tunnel } from '@leafbot/client/tunnel';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catchServerLinks, dropServerFiles, useServerMedia } from './server-files';
import { setTunnel } from './transport';

/** A tunnel that answers every path with the given body and type, and records what was asked. */
function fakeTunnel(type: string, headers: Record<string, string> = {}) {
  const asked: string[] = [];
  const tunnel = {
    fetch: (path: string) => {
      asked.push(path);
      return Promise.resolve(new Response('bytes', { headers: { 'content-type': type, ...headers } }));
    },
    has: () => true,
  } as unknown as Tunnel;
  return { tunnel, asked };
}

let made: Blob[] = [];
beforeEach(() => {
  made = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    made.push(b);
    return `blob:test/${made.length}`;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  setTunnel(null);
  dropServerFiles();
});

describe('files from the server on the web app', () => {
  it('leaves paths alone when the server serves the page', () => {
    const { result } = renderHook(() => useServerMedia('/api/bots/b/library/file?path=a.png'));
    expect(result.current).toBe('/api/bots/b/library/file?path=a.png');
  });

  it('shows a picture through the tunnel from a blob of the same type', async () => {
    const { tunnel, asked } = fakeTunnel('image/png');
    setTunnel(tunnel);
    const { result } = renderHook(() => useServerMedia('/api/x.png'));
    await waitFor(() => expect(result.current).toBe('blob:test/1'));
    expect(asked).toEqual(['/api/x.png']);
    expect(made[0]!.type).toBe('image/png');
  });

  it('never makes a blob of something that can run script', async () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'application/pdf']) {
      const { tunnel, asked } = fakeTunnel(type);
      setTunnel(tunnel);
      const { result, unmount } = renderHook(() => useServerMedia(`/api/${type}`));
      await waitFor(() => expect(asked).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(result.current).toBeUndefined();
      unmount();
    }
    expect(made).toEqual([]);
  });

  it('leaves data and blob addresses as they are', () => {
    setTunnel(fakeTunnel('image/png').tunnel);
    const { result } = renderHook(() => useServerMedia('data:image/png;base64,AA=='));
    expect(result.current).toBe('data:image/png;base64,AA==');
  });

  it('saves a linked file through the tunnel instead of following the link', async () => {
    const { tunnel, asked } = fakeTunnel('text/html', {
      'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.html",
    });
    setTunnel(tunnel);
    const saved: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const stop = catchServerLinks(() => {});
    const link = document.createElement('a');
    link.href = '/api/bots/b/library/file?path=r.html';
    document.body.append(link);
    const e = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await waitFor(() => expect(saved).toEqual(['résumé.html']));
    expect(asked).toEqual(['/api/bots/b/library/file?path=r.html']);
    // Saved, never shown: the blob's type is one the browser only downloads.
    expect(made[0]!.type).toBe('application/octet-stream');
    stop();
    click.mockRestore();
    link.remove();
  });

  it('lets links to other sites through', () => {
    const { tunnel, asked } = fakeTunnel('image/png');
    setTunnel(tunnel);
    const stop = catchServerLinks(() => {});
    const link = document.createElement('a');
    link.href = 'https://example.com/api/x';
    document.body.append(link);
    let prevented: boolean | null = null;
    // Runs after the capture listener, before the browser would follow the link.
    link.addEventListener('click', (ev) => {
      prevented = ev.defaultPrevented;
      ev.preventDefault();
    });
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(prevented).toBe(false);
    expect(asked).toEqual([]);
    stop();
    link.remove();
  });
});
