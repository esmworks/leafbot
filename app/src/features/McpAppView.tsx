import type { Message } from '@leafbot/shared';
import { useEffect, useRef, useState } from 'react';
import { LiveFrame, type FrameMessage } from '@/components/LiveFrame';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';

interface AppProps {
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** The protocol version this host speaks; an app asking for another is answered with its own. */
const PROTOCOL = '2026-01-26';

/**
 * A connected app's own view of a tool call (an MCP app), running in the app's sandboxed frame.
 * It is told the call's input and result once it is ready; the tools it calls go through the
 * server to its own connection only, as the bot that showed it may.
 */
export function McpAppView({ m }: { m: Message }) {
  const app = m.props.app as AppProps;
  const post = useRef<((msg: FrameMessage) => void) | null>(null);
  const dark = usePageDark();
  const intl = useLocale((s) => s.intl);
  const t = useT();
  const theme = dark ? 'dark' : 'light';
  useEffect(() => {
    post.current?.({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } });
  }, [theme]);
  const onRequest = async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'ui/initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          hostInfo: { name: 'LeafBot', version: '0.9.0' },
          hostCapabilities: { openLinks: {}, serverTools: {} },
          hostContext: {
            theme,
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            locale: intl,
            platform: 'web',
          },
        };
      case 'tools/call':
        return api.appCall(
          m.id,
          String(params.name ?? ''),
          (params.arguments ?? {}) as Record<string, unknown>,
        );
      case 'ui/open-link': {
        const url = String(params.url ?? '');
        if (!/^https?:\/\//i.test(url)) return {};
        // A click inside the app's frame also counts for this page (user activation reaches a frame's
        // ancestors), so a link the person just clicked opens at once. Without one the app is opening a
        // page by itself, which the desktop app would do without a browser's popup blocker, so the
        // person sees the address and decides.
        if (navigator.userActivation?.isActive || confirm(t('message.openLinkConfirm', { url }))) {
          window.open(url, '_blank', 'noopener,noreferrer');
        }
        return {};
      }
      case 'ping':
        return {};
      default:
        throw new Error(`${method} is not supported`);
    }
  };
  const onNotify = (method: string) => {
    if (method !== 'ui/notifications/initialized') return;
    post.current?.({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: app.input },
    });
    post.current?.({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: app.result });
  };
  return (
    <div className="w-full max-w-(--bubble-width) space-y-2">
      <div className="px-1 text-sm text-muted-foreground">{m.text}</div>
      <LiveFrame
        title={m.text}
        src={`/api/apps/${m.id}/frame`}
        initialHeight={320}
        postRef={post}
        onRequest={onRequest}
        onNotify={onNotify}
      />
    </div>
  );
}

/** Whether the app shows dark now, following the class the theme sets on the page. */
function usePageDark(): boolean {
  const read = () => document.documentElement.classList.contains('dark');
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const watch = new MutationObserver(() => setDark(read()));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => watch.disconnect();
  }, []);
  return dark;
}
