import type { BrowserAck, BrowserInput, BrowserState, ComputerAck, ComputerState } from '@leafbot/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { tunnelSocket, type AppSocket } from '@/lib/tunnelSocket';
import { useServer } from '@/lib/server';

export interface Frame {
  /** A data: address of the latest JPEG picture. */
  uri: string;
  width: number;
  height: number;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 of some bytes; the phone's JS engine has no Buffer. */
function base64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? '=' : ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? '=' : ALPHABET[c & 63]!;
  }
  return out;
}

const OFF = (botId: string): BrowserState => ({ botId, status: 'off', url: null, title: null, tabs: 0 });
const ASLEEP = (botId: string): ComputerState => ({ botId, status: 'off', user: false, busy: false });

/** Closes a socket after a last message (giving control back) has had time to leave. */
function closeLater(s: AppSocket) {
  s.removeAllListeners();
  setTimeout(() => s.close(), 400);
}

/**
 * Follows a bot's browser: its state and, while watched, its screen as pictures. `enabled` false
 * closes the line, as when another screen is on top.
 */
export function useBrowserLive(botId: string, enabled = true) {
  const { origin } = useServer();
  const sock = useRef<AppSocket | null>(null);
  const control = useRef(false);
  const [state, setState] = useState<BrowserState>(() => OFF(botId));
  const [frame, setFrame] = useState<Frame | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!origin || !enabled) return;
    const s = tunnelSocket();
    sock.current = s;
    s.on('browser:state', (e) => e.botId === botId && setState(e));
    s.on('browser:frame', (f) => {
      if (f.botId !== botId) return;
      const bytes = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data);
      setFrame({ uri: `data:image/jpeg;base64,${base64(bytes)}`, width: f.width, height: f.height });
    });
    // On every (re)connect: the server forgets what this socket watched.
    s.on('connect', () => {
      setConnected(true);
      s.emit('browser:watch', botId, (e) => {
        if (e) setState(e);
      });
    });
    s.on('disconnect', () => setConnected(false));
    return () => {
      s.emit('browser:unwatch', botId);
      // The server may have kept control for this person; hand it back when the screen closes.
      if (control.current) s.emit('browser:control', { botId, on: false }, () => undefined);
      control.current = false;
      sock.current = null;
      closeLater(s);
      setConnected(false);
      setFrame(null);
    };
  }, [origin, enabled, botId]);

  const send = useCallback(
    (input: BrowserInput) => sock.current?.emit('browser:input', { botId, input }),
    [botId],
  );

  const setControl = useCallback(
    (on: boolean) =>
      new Promise<BrowserAck>((resolve) => {
        const s = sock.current;
        if (!s?.connected) return resolve({ ok: false, error: '' });
        s.timeout(45_000).emit('browser:control', { botId, on }, (err, r) => {
          if (!err && r.ok) control.current = on;
          resolve(err ? { ok: false, error: '' } : r);
        });
      }),
    [botId],
  );

  return { state, frame, connected, send, setControl };
}

/** Follows a bot's desktop state, with the two things a phone can do to it: wake it, take control. */
export function useDesktopLive(botId: string, enabled = true) {
  const { origin } = useServer();
  const sock = useRef<AppSocket | null>(null);
  const [state, setState] = useState<ComputerState>(() => ASLEEP(botId));
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!origin || !enabled) return;
    const s = tunnelSocket();
    sock.current = s;
    s.on('computer:state', (e) => e.botId === botId && setState(e));
    s.on('connect', () => {
      setConnected(true);
      s.emit('computer:watch', botId, (e) => {
        if (e) setState(e);
      });
    });
    s.on('disconnect', () => setConnected(false));
    return () => {
      s.emit('computer:unwatch', botId);
      sock.current = null;
      closeLater(s);
      setConnected(false);
    };
  }, [origin, enabled, botId]);

  const wake = useCallback(
    () =>
      new Promise<ComputerAck>((resolve) => {
        const s = sock.current;
        if (!s?.connected) return resolve({ ok: false, error: '' });
        s.timeout(120_000).emit('computer:wake', botId, (err, r) =>
          resolve(err ? { ok: false, error: '' } : r),
        );
      }),
    [botId],
  );

  return { state, connected, wake };
}
