import { INTL_LOCALE } from '@leafbot/shared/i18n';
import type { Message } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { shareFile } from '@/components/panel/files';
import { locale, t } from '@/i18n';
import { serverFetch } from '@/lib/connection';
import { useApi } from '@/lib/server';
import { useColors, useIsDark } from '@/lib/theme';

export interface FrameMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

/** Whether the question about opening a link is on screen; a page asking again meanwhile is ignored. */
let asking = false;

/**
 * Opens an http(s) address a page in the conversation (a bot's page, a connected app) asked for,
 * once the person has seen it and agreed. The phone cannot tell a tap on a link from the page's own
 * script navigating, so without asking a page could open sites by itself; one question at a time, so
 * it cannot stack them either.
 */
function openAfterAsking(url: string) {
  if (asking || !/^https?:\/\//i.test(url)) return;
  asking = true;
  const done = () => {
    asking = false;
  };
  Alert.alert(
    t('message.openLinkTitle'),
    url,
    [
      { text: t('common.cancel'), style: 'cancel', onPress: done },
      {
        text: t('message.openLink'),
        onPress: () => {
          done();
          void WebBrowser.openBrowserAsync(url);
        },
      },
    ],
    { cancelable: true, onDismiss: done },
  );
}

/**
 * Inside the web view the page is the top window, so what it sends to `parent` lands on its own
 * `postMessage`; that is handed to the app instead.
 */
const BRIDGE = `(function(){window.postMessage=function(m){window.ReactNativeWebView.postMessage(JSON.stringify(m))};})();true;`;

/**
 * A page that runs its own scripts inside the conversation (see shared/frame). Requests from the
 * page (messages with an id) go to `onRequest`, whose answer or error goes back; other messages to
 * `onNotify`. The page is read through the tunnel and shown as a document of its own: it cannot load
 * anything else from the server, only what it carries.
 */
export function LiveFrame({
  src,
  initialHeight = 360,
  maxHeight = 900,
  onRequest,
  onNotify,
  postRef,
}: {
  /** The frame document's path on the server; it is read through the tunnel and shown from the page's own text. */
  src: string;
  initialHeight?: number;
  maxHeight?: number;
  onRequest?(method: string, params: Record<string, unknown>): Promise<unknown>;
  onNotify?(method: string, params: Record<string, unknown>): void;
  /** Filled with a function that sends a message to the page. */
  postRef?: RefObject<((m: FrameMessage) => void) | null>;
}) {
  const c = useColors();
  const view = useRef<WebView<object>>(null);
  const [height, setHeight] = useState(initialHeight);
  // What came for one `src`; an answer for an earlier `src` counts as none.
  const [answer, setAnswer] = useState<{ src: string; html: string | null } | null>(null);
  const html = answer?.src === src ? answer.html : null;
  const failed = answer?.src === src && answer.html === null;
  useEffect(() => {
    const ctrl = new AbortController();
    serverFetch(src, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) {
          res.cancel();
          throw new Error(String(res.status));
        }
        const text = await res.text();
        if (!ctrl.signal.aborted) setAnswer({ src, html: text });
      })
      .catch(() => !ctrl.signal.aborted && setAnswer({ src, html: null }));
    return () => ctrl.abort();
  }, [src]);
  const handlers = useRef({ onRequest, onNotify });
  useEffect(() => {
    handlers.current = { onRequest, onNotify };
  });
  const send = useRef((m: FrameMessage) => {
    view.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify(m)},source:window}));true;`,
    );
  });
  useEffect(() => {
    const fn = send.current;
    if (postRef) postRef.current = fn;
    return () => {
      if (postRef) postRef.current = null;
    };
  }, [postRef]);

  const onMessage = (e: WebViewMessageEvent) => {
    let m: FrameMessage | null;
    try {
      m = JSON.parse(e.nativeEvent.data) as FrameMessage | null;
    } catch {
      return;
    }
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return;
    const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>;
    if (m.method === 'ui/notifications/size-changed') {
      const h = Number(params.height);
      if (Number.isFinite(h) && h > 0) setHeight(Math.min(Math.max(Math.ceil(h), 60), maxHeight));
      return;
    }
    if (m.id === undefined) return handlers.current.onNotify?.(m.method, params);
    const ask = handlers.current.onRequest;
    const id = m.id;
    if (!ask) {
      return send.current({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: 'Method not found' },
      } as never);
    }
    ask(m.method, params).then(
      (result) => send.current({ jsonrpc: '2.0', id, result } as never),
      (err: Error) =>
        send.current({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } } as never),
    );
  };

  return (
    <View style={[styles.frame, { height, borderColor: c.border }]}>
      {failed ? (
        <Text style={[styles.caption, { color: c.mutedForeground }]}>{t('preview.failed')}</Text>
      ) : null}
      {html === null ? null : (
        <WebView<object>
          ref={view}
          source={{ html }}
          originWhitelist={['about:*']}
          injectedJavaScriptBeforeContentLoaded={BRIDGE}
          onMessage={onMessage}
          scrollEnabled={false}
          nestedScrollEnabled
          // Links the page offers open in the browser, after asking, so the conversation never
          // navigates away.
          onShouldStartLoadWithRequest={(req) => {
            if (req.url.startsWith('about:') || req.isTopFrame === false) return true;
            openAfterAsking(req.url);
            return false;
          }}
          style={styles.web}
        />
      )}
    </View>
  );
}

/**
 * A page a bot made (show_page), running in the conversation. It is read fresh from the bot's
 * folder, so the card shows the file as it is now.
 */
export function BotPage({
  botId,
  path,
  name,
  title,
  height,
}: {
  botId: string;
  path: string;
  name: string;
  title: string;
  /** The height the bot asked for, for a page laid out to the window (a map, a canvas). */
  height?: number;
}) {
  const api = useApi();
  const c = useColors();
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
          {title || name}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('message.download', { name })}
          hitSlop={8}
          onPress={() => void shareFile(api.fileUrl(botId, path), name)}
          style={styles.link}
        >
          <Feather name="download" size={16} color={c.mutedForeground} />
          <Text style={[styles.linkText, { color: c.mutedForeground }]} numberOfLines={1}>
            {name}
          </Text>
        </Pressable>
      </View>
      <LiveFrame src={api.pageUrl(botId, path, height)} initialHeight={height ?? 360} />
    </View>
  );
}

interface AppProps {
  input: Record<string, unknown>;
  result: Record<string, unknown>;
}

/** The protocol version this host speaks; an app asking for another is answered with its own. */
const PROTOCOL = '2026-01-26';

/**
 * A connected app's own view of a tool call (an MCP app). It is told the call's input and result
 * once it is ready; the tools it calls go through the server to its own connection only, as the bot
 * that showed it may.
 */
export function McpAppView({ m }: { m: Message }) {
  const api = useApi();
  const c = useColors();
  const app = m.props.app as AppProps;
  const post = useRef<((msg: FrameMessage) => void) | null>(null);
  const theme = useIsDark() ? 'dark' : 'light';
  useEffect(() => {
    post.current?.({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme } });
  }, [theme]);
  const onRequest = async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'ui/initialize':
        return {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
          hostInfo: { name: 'LeafBot', version: Constants.expoConfig?.version ?? '0' },
          hostCapabilities: { openLinks: {}, serverTools: {} },
          hostContext: {
            theme,
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            locale: INTL_LOCALE[locale],
            platform: 'mobile',
          },
        };
      case 'tools/call':
        return api.appCall(
          m.id,
          String(params.name ?? ''),
          (params.arguments ?? {}) as Record<string, unknown>,
        );
      case 'ui/open-link': {
        openAfterAsking(String(params.url ?? ''));
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
    <View style={styles.card}>
      <Text style={[styles.caption, { color: c.mutedForeground }]}>{m.text}</Text>
      <LiveFrame
        src={`/api/apps/${m.id}/frame`}
        initialHeight={320}
        postRef={post}
        onRequest={onRequest}
        onNotify={onNotify}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { alignSelf: 'stretch', gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  title: { flex: 1, fontSize: 16, fontWeight: '500' },
  link: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '45%' },
  linkText: { fontSize: 13, flexShrink: 1 },
  caption: { fontSize: 16, paddingHorizontal: 4 },
  frame: { borderRadius: 16, borderWidth: 1, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  web: { flex: 1, backgroundColor: 'transparent' },
});
