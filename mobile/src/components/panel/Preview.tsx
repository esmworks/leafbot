import { parseCsv } from '@leafbot/app/src/lib/csv';
import { libraryKey } from '@leafbot/app/src/lib/fileLink';
import { htmlPreviewDocument, type PreviewKind } from '@leafbot/app/src/lib/preview';
import Feather from '@expo/vector-icons/Feather';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { Markdown } from '@/components/Markdown';
import { Loading } from '@/components/page';
import { t } from '@/i18n';
import { useLibrary } from '@/lib/queries';
import { useServerFile } from '@/lib/serverFiles';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { fileSize, readTextStart } from './files';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** The most rows of a CSV the preview draws; the rest stays in the file. */
const TABLE_ROWS = 2000;
/** Lines drawn as one block of text, so a long file is not one huge view. */
const LINES_PER_BLOCK = 80;
/** Width of one character in the code font at the preview's size. */
const CHAR_WIDTH = 7.9;

/** Reads a text file once and shares it between the views that show it. */
export function useFileText(botId: string, path: string, url: string, enabled: boolean) {
  const { origin } = useServer();
  return useQuery({
    queryKey: ['file-text', origin, botId, path],
    queryFn: ({ signal }) => readTextStart(url, undefined, signal),
    staleTime: 30_000,
    retry: false,
    enabled,
  });
}

export function Message({ text, busy }: { text?: string; busy?: boolean }) {
  const c = useColors();
  if (busy) return <Loading />;
  return (
    <View style={styles.message}>
      <Text style={[styles.messageText, { color: c.mutedForeground }]}>{text}</Text>
    </View>
  );
}

function CutBar({ text }: { text: string }) {
  const c = useColors();
  return <Text style={[styles.cut, { backgroundColor: c.amberSoft, color: c.amber }]}>{text}</Text>;
}

/**
 * A picture at its own size, made smaller only to fit the screen, never blown up past its pixels;
 * on iOS a scroll view zooms it when pinched. Android's scroll
 * view has no pinch, so the picture stays fitted there.
 */
export function ImageView({ path }: { path: string }) {
  const { uri, failed } = useServerFile(path);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => setBox(e.nativeEvent.layout);
  if (failed) return <Message text={t('preview.failed')} />;
  if (!uri) return <Message busy />;
  return (
    <ScrollView
      style={styles.fill}
      onLayout={onLayout}
      maximumZoomScale={5}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      bouncesZoom
    >
      <Image
        source={{ uri }}
        style={{ width: box.width, height: box.height }}
        contentFit="scale-down"
        accessible={false}
      />
    </ScrollView>
  );
}

/**
 * A PDF, a sound or a film, drawn by the phone's own web view. The file is read through the tunnel
 * into the cache first, and the web view is given that local file and no more.
 */
export function WebFile({ path, kind }: { path: string; kind: 'pdf' | 'audio' | 'video' }) {
  const c = useColors();
  const { uri, failed } = useServerFile(path);
  if (failed) return <Message text={t('preview.failed')} />;
  if (!uri) return <Message busy />;
  return (
    <WebView
      source={{ uri }}
      originWhitelist={['file://*']}
      allowFileAccess
      allowingReadAccessToURL={uri}
      style={[styles.fill, { backgroundColor: kind === 'video' ? '#000000' : c.card }]}
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction
      startInLoadingState
      renderLoading={() => <Loading />}
    />
  );
}

/** An HTML page drawn without scripts and without loading anything from outside. */
function HtmlPage({ source }: { source: string }) {
  return (
    <WebView
      originWhitelist={['about:*']}
      source={{ html: htmlPreviewDocument(source) }}
      style={[styles.fill, { backgroundColor: '#FFFFFF' }]}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      // Nothing in a page may take the view somewhere else.
      onShouldStartLoadWithRequest={(r) => r.url === 'about:blank' || r.url.startsWith('about:')}
    />
  );
}

/** Text files: plain text in a code font, Markdown set as text, an HTML page drawn. */
export function TextView({
  botId,
  path,
  url,
  kind,
  wrap,
  source,
}: {
  botId: string;
  path: string;
  url: string;
  kind: Extract<PreviewKind, 'text' | 'markdown' | 'html'>;
  wrap: boolean;
  /** Show an HTML page as its source. */
  source: boolean;
}) {
  const c = useColors();
  const { data, isPending, isError } = useFileText(botId, path, url, true);
  const [width, setWidth] = useState(0);
  const blocks = useMemo(() => {
    if (!data || kind === 'markdown' || (kind === 'html' && !source)) return [];
    const lines = data.text.split('\n');
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += LINES_PER_BLOCK)
      out.push(lines.slice(i, i + LINES_PER_BLOCK).join('\n'));
    return out;
  }, [data, kind, source]);
  const longest = useMemo(
    () => (data && !wrap ? data.text.split('\n').reduce((m, l) => Math.max(m, l.length), 0) : 0),
    [data, wrap],
  );
  if (isPending) return <Message busy />;
  if (isError || !data) return <Message text={t('preview.failed')} />;
  const cut = data.cut ? <CutBar text={t('preview.cut')} /> : null;
  if (kind === 'html' && !source) {
    return (
      <View style={styles.fill}>
        {cut}
        <HtmlPage source={data.text} />
      </View>
    );
  }
  if (kind === 'markdown') {
    return (
      <ScrollView style={styles.fill} contentContainerStyle={styles.markdown}>
        {cut}
        <Markdown text={data.text} palette={{ text: c.foreground, code: c.muted, line: c.border }} />
      </ScrollView>
    );
  }
  const list = (
    <FlatList
      data={blocks}
      keyExtractor={(_, i) => String(i)}
      ListHeaderComponent={cut ?? undefined}
      initialNumToRender={6}
      windowSize={7}
      contentContainerStyle={styles.code}
      renderItem={({ item }) => (
        <Text selectable style={[styles.codeText, { color: c.foreground, fontFamily: MONO }]}>
          {item}
        </Text>
      )}
    />
  );
  return (
    <View style={styles.fill} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {wrap ? (
        list
      ) : (
        <ScrollView horizontal contentContainerStyle={{ width: Math.max(width, longest * CHAR_WIDTH + 32) }}>
          {list}
        </ScrollView>
      )}
    </View>
  );
}

const COLUMN_WIDTH = 140;

/** A CSV or TSV file as a table, its first row as a header that stays in view. */
export function TableView({
  botId,
  path,
  url,
  name,
}: {
  botId: string;
  path: string;
  url: string;
  name: string;
}) {
  const c = useColors();
  const [width, setWidth] = useState(0);
  const { data, isPending, isError } = useFileText(botId, path, url, true);
  const rows = useMemo(() => (data ? parseCsv(data.text, /\.tsv$/i.test(name)) : []), [data, name]);
  if (isPending) return <Message busy />;
  if (isError || !data) return <Message text={t('preview.failed')} />;
  const [head = [], ...body] = rows;
  const shown = body.slice(0, TABLE_ROWS);
  const columns = Math.max(head.length, ...shown.slice(0, 50).map((r) => r.length));
  // A few columns share the width; many keep a readable width and scroll sideways.
  const column = Math.max(COLUMN_WIDTH, columns ? width / columns : 0);
  const cell = (text: string | undefined, key: number, bold?: boolean) => (
    <Text
      key={key}
      numberOfLines={bold ? 1 : 3}
      style={[
        styles.cell,
        { width: column, color: c.foreground, borderColor: c.border },
        bold && styles.headCell,
      ]}
    >
      {text ?? ''}
    </Text>
  );
  return (
    <View style={styles.fill}>
      {data.cut || body.length > TABLE_ROWS ? (
        <CutBar text={t('preview.rowsCut', { shown: shown.length })} />
      ) : null}
      <View
        style={[styles.tableFrame, { borderColor: c.border }]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        <ScrollView horizontal>
          <FlatList
            data={shown}
            style={{ width: columns * column }}
            keyExtractor={(_, i) => String(i)}
            stickyHeaderIndices={[0]}
            initialNumToRender={30}
            ListHeaderComponent={
              <View style={[styles.rowLine, { backgroundColor: c.muted }]}>
                {Array.from({ length: columns }, (_, i) => cell(head[i], i, true))}
              </View>
            }
            renderItem={({ item, index }) => (
              <View style={[styles.rowLine, index % 2 === 1 && { backgroundColor: c.muted }]}>
                {Array.from({ length: columns }, (_, i) => cell(item[i], i))}
              </View>
            )}
          />
        </ScrollView>
      </View>
    </View>
  );
}

/**
 * A link that names a folder lists the files in it, each opening in the preview; anything else
 * the preview cannot show says so.
 */
export function FolderOrNone({
  botId,
  path,
  onOpen,
}: {
  botId: string;
  path: string;
  onOpen: (path: string) => void;
}) {
  const c = useColors();
  const { data: library, isPending } = useLibrary(botId);
  const key = libraryKey(path).replace(/\/+$/, '');
  const inside = (library ?? []).filter((f) => f.path.startsWith(`${key}/`));
  if (isPending) return <Message busy />;
  if (!inside.length) return <Message text={t('preview.none')} />;
  return (
    <FlatList
      data={inside}
      keyExtractor={(f) => f.path}
      ListHeaderComponent={
        <Text style={[styles.folderHead, { color: c.mutedForeground }]}>
          {t('preview.folder', { count: inside.length })}
        </Text>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpen(item.path)}
          style={({ pressed }) => [styles.folderRow, pressed && { backgroundColor: c.accent }]}
        >
          <Feather name="file-text" size={20} color={c.mutedForeground} />
          <Text style={[styles.folderName, { color: c.foreground }]} numberOfLines={1}>
            {item.path.slice(key.length + 1)}
          </Text>
          <Text style={[styles.folderSize, { color: c.mutedForeground }]}>{fileSize(item.size)}</Text>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  message: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  messageText: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  cut: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  markdown: { paddingHorizontal: 20, paddingVertical: 16 },
  code: { paddingHorizontal: 16, paddingVertical: 12 },
  codeText: { fontSize: 15, lineHeight: 21 },
  rowLine: { flexDirection: 'row' },
  tableFrame: {
    flex: 1,
    margin: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    overflow: 'hidden',
  },
  cell: {
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headCell: { fontWeight: '600' },
  folderHead: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  folderRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, minHeight: 44 },
  folderName: { flex: 1, fontSize: 16 },
  folderSize: { fontSize: 13 },
});
