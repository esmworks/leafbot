import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * A page that runs its own scripts inside the app (see shared/frame). The frame is sandboxed
 * without allow-same-origin, so it has an opaque origin: it cannot read the app's cookies, storage
 * or pages, call its API, navigate it or open windows.
 */
export const FRAME_SANDBOX = 'allow-scripts allow-forms';

export interface FrameMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A live page. Requests from the frame (messages with an id) go to `onRequest`, whose answer or
 * error goes back; other messages to `onNotify`. Only messages from this frame's own window count.
 */
export function LiveFrame({
  src,
  title,
  initialHeight = 360,
  maxHeight = 900,
  onRequest,
  onNotify,
  postRef,
  fill,
  className,
}: {
  /** The frame document's address on this server, which serves it sandboxed. */
  src: string;
  title: string;
  initialHeight?: number;
  maxHeight?: number;
  onRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;
  onNotify?(method: string, params: Record<string, unknown>): void;
  /** Filled with a function that sends a message to the frame. */
  postRef?: RefObject<((m: FrameMessage) => void) | null>;
  /** Fills the space it is given instead of growing with the page (a saved app's view). */
  fill?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const handlers = useRef({ onRequest, onNotify });
  useEffect(() => {
    handlers.current = { onRequest, onNotify };
  });
  useEffect(() => {
    const send = (m: FrameMessage) => ref.current?.contentWindow?.postMessage(m, '*');
    if (postRef) postRef.current = send;
    const listen = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const m = e.data as FrameMessage | null;
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
      const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
      if (m.method === 'ui/notifications/size-changed') {
        const h = Number(params.height);
        if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(Math.ceil(h), 60), maxHeight));
        return;
      }
      if (m.id === undefined) return handlers.current.onNotify?.(m.method, params);
      const ask = handlers.current.onRequest;
      if (!ask)
        return send({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: 'Method not found' },
        } as never);
      ask(m.method, params).then(
        (result) => send({ jsonrpc: '2.0', id: m.id, result } as never),
        (err: Error) =>
          send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: err.message } } as never),
      );
    };
    window.addEventListener('message', listen);
    return () => {
      window.removeEventListener('message', listen);
      if (postRef) postRef.current = null;
    };
  }, [maxHeight, postRef]);
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox={FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      src={src}
      style={fill ? undefined : { height }}
      className={className ?? 'w-full rounded-2xl border bg-white'}
    />
  );
}
