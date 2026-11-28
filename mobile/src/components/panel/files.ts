import { INTL_LOCALE } from '@leafbot/shared/i18n';
import { previewKind, TEXT_PREVIEW_BYTES } from '@leafbot/app/src/lib/preview';
import * as Sharing from 'expo-sharing';
import { locale, t } from '@/i18n';
import { serverFetch } from '@/lib/connection';
import { saveServerFile } from '@/lib/serverFiles';
import { toast, toastError } from '@/components/overlay';

const decimal = new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: 1 });

/**
 * How the phone shows a file, or null to share it instead. A workbook is left out: the web app
 * reads it with browser parts (DOMParser, DecompressionStream) the phone does not have.
 */
export function phonePreviewKind(name: string) {
  const kind = previewKind(name);
  return kind === 'workbook' ? null : kind;
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${decimal.format(n / 1024)} KB`;
  return `${decimal.format(n / 1024 / 1024)} MB`;
}

/**
 * Reads a file of the bot's folders through the tunnel into the phone's cache and opens the share
 * sheet on it, which is where the person saves it to Files or hands it to another app. `path` is
 * the file's path on the server.
 */
export async function shareFile(path: string, name: string): Promise<void> {
  try {
    const uri = await saveServerFile(path, name);
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
    else toast(t('panel.shareFailed'), { tone: 'error' });
  } catch (e) {
    toastError(e instanceof Error && e.message ? e : new Error(t('panel.shareFailed')));
  }
}

/**
 * The start of a text file, at most `max` characters. It asks for just that range; a server that
 * answers with the whole file is cut here instead. `cut` says whether there was more.
 */
export async function readTextStart(
  path: string,
  max = TEXT_PREVIEW_BYTES,
  signal?: AbortSignal,
): Promise<{ text: string; cut: boolean }> {
  const res = await serverFetch(path, { headers: { range: `bytes=0-${max - 1}` }, signal });
  if (!res.ok) {
    res.cancel();
    throw new Error(String(res.status));
  }
  let text = await res.text();
  let cut = false;
  if (res.status === 206) {
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1]);
    cut = Number.isFinite(total) && total > max;
    // A range can end inside a character; drop the broken one.
    text = text.replace(/�$/, '');
  } else if (text.length > max) {
    text = text.slice(0, max);
    cut = true;
  }
  return { text, cut };
}
