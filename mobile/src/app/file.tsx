import { useLocalSearchParams } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { toast } from '@/components/overlay';
import { IconButton, Page, Sheet, type SheetItem } from '@/components/page';
import {
  FolderOrNone,
  ImageView,
  Message,
  TableView,
  TextView,
  WebFile,
  useFileText,
} from '@/components/panel/Preview';
import { fileSize, phonePreviewKind, shareFile } from '@/components/panel/files';
import { t } from '@/i18n';
import { useLibrary } from '@/lib/queries';
import { useApi } from '@/lib/server';
import { useStored } from '@/lib/stored';
import { useColors } from '@/lib/theme';

/** The paths to step through, as the caller gave them; the opened path alone when none were. */
function parsePaths(raw: string | undefined, path: string): string[] {
  try {
    const list: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(list) && list.every((p) => typeof p === 'string') && list.length) {
      return list.includes(path) ? (list as string[]) : [path];
    }
  } catch {
    // Falls back to the one file.
  }
  return [path];
}

const nameOf = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path;

/** A file of the bot's folders shown in place, with the ones beside it a swipe of the arrows away. */
export default function FileScreen() {
  const params = useLocalSearchParams<{ botId: string; path: string; paths?: string }>();
  const botId = params.botId;
  const c = useColors();
  const api = useApi();
  const list = useMemo(() => parsePaths(params.paths, params.path), [params.paths, params.path]);
  const [current, setCurrent] = useState(params.path);
  const [menu, setMenu] = useState(false);
  const [source, setSource] = useState(false);
  const [wrap, setWrap] = useStored('leafbot.preview.wrap', true);
  const { data: library } = useLibrary(botId);

  const at = list.indexOf(current);
  const step = (by: number) => {
    if (at < 0 || list.length < 2) return;
    setSource(false);
    setCurrent(list[(at + by + list.length) % list.length]!);
  };
  const name = nameOf(current);
  const kind = phonePreviewKind(name);
  const size = library?.find((f) => f.path === current)?.size ?? -1;
  const download = api.fileUrl(botId, current);
  const inline = api.fileUrl(botId, current, { inline: true });
  const isText = kind === 'text' || kind === 'markdown' || kind === 'html' || kind === 'table';
  // Shares the text query's cache entry, so the copy action never fetches the file twice.
  const text = useFileText(botId, current, download, isText);

  const items: SheetItem[] = [];
  if (isText && text.data) {
    items.push({
      icon: 'copy',
      label: t('preview.copySource'),
      onPress: () => {
        Clipboard.setStringAsync(text.data!.text).then(
          () => toast(t('preview.copied')),
          () => toast(t('message.copyFailed'), { tone: 'error' }),
        );
      },
    });
  }
  if (kind === 'html') {
    items.push({
      icon: source ? 'eye' : 'code',
      label: t(source ? 'preview.showPage' : 'preview.showSource'),
      onPress: () => setSource(!source),
    });
  }
  if (kind === 'text' || (kind === 'html' && source)) {
    items.push({
      icon: 'corner-down-left',
      label: t('preview.wrap'),
      selected: wrap,
      onPress: () => setWrap(!wrap),
    });
  }

  const body = () => {
    if (kind === 'image') return <ImageView path={inline} />;
    if (kind === 'audio' || kind === 'video') return <WebFile path={inline} kind={kind} />;
    // Android's web view does not draw PDFs itself.
    if (kind === 'pdf')
      return Platform.OS === 'android' ? (
        <Message text={t('preview.none')} />
      ) : (
        <WebFile path={inline} kind="pdf" />
      );
    if (kind === 'table') return <TableView botId={botId} path={current} url={download} name={name} />;
    if (kind)
      return <TextView botId={botId} path={current} url={download} kind={kind} wrap={wrap} source={source} />;
    return (
      <FolderOrNone
        botId={botId}
        path={current}
        onOpen={(p) => {
          setCurrent(p);
          setSource(false);
        }}
      />
    );
  };

  return (
    <Page
      title={name}
      scroll={false}
      right={
        <View style={styles.right}>
          {items.length ? (
            <IconButton icon="more-horizontal" label={t('preview.more')} onPress={() => setMenu(true)} />
          ) : null}
          {kind ? (
            <IconButton
              icon="share"
              label={t('message.download', { name })}
              onPress={() => void shareFile(download, name)}
            />
          ) : null}
        </View>
      }
    >
      {size >= 0 ? <Text style={[styles.size, { color: c.mutedForeground }]}>{fileSize(size)}</Text> : null}
      <View key={current} style={[styles.body, { borderColor: c.border, backgroundColor: c.card }]}>
        {body()}
      </View>
      {list.length > 1 && at >= 0 ? (
        <View style={styles.stepper}>
          <IconButton icon="chevron-left" label={t('preview.previous')} onPress={() => step(-1)} />
          <Text style={[styles.position, { color: c.mutedForeground }]}>
            {t('preview.position', { at: at + 1, count: list.length })}
          </Text>
          <IconButton icon="chevron-right" label={t('preview.next')} onPress={() => step(1)} />
        </View>
      ) : null}
      <Sheet open={menu} onClose={() => setMenu(false)} items={items} />
    </Page>
  );
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row' },
  size: { fontSize: 13, textAlign: 'center', paddingBottom: 6 },
  body: { flex: 1, overflow: 'hidden', borderTopWidth: StyleSheet.hairlineWidth },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, height: 52 },
  position: { fontSize: 16, minWidth: 56, textAlign: 'center' },
});
