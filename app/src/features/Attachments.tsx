import {
  MAX_MESSAGE_FILES,
  MAX_UPLOAD_BYTES,
  newUploadId,
  startUpload,
  type MessageFile,
} from '@leafbot/shared';
import {
  AlertCircle,
  Download,
  File as FileIcon,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  PenLine,
  Presentation,
  RotateCw,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { fileFamily, previewKind, type FileFamily } from '@/lib/preview';
import { usePreview } from './FilePreview';
import { cn } from '@/lib/utils';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { ImageMarkup } from './ImageMarkup';

/** An upload waiting on the server for its message; sending moves it into the conversation folder. */
export interface StagedFile {
  name: string;
  size: number;
}

/** A file in the composer: uploading, or waiting on the server. */
export interface Attachment {
  key: string;
  name: string;
  size: number;
  /** Local preview for images, until the message is sent. */
  preview: string | null;
  saved: StagedFile | null;
  /** When it was added; the server removes uploads left unsent for a day. */
  addedAt: number;
  /** How much has gone up, 0 to 1, while uploading. */
  progress: number;
  /** Why the upload failed; the file stays in the composer to be tried again or taken off. */
  error: string | null;
}

/**
 * What a file not yet on the server needs and the composer's list does not keep: the file
 * itself, for another try, the id the server knows its tries by, and the way to call it off.
 */
const uploads = new Map<
  string,
  { threadId: string; file: File; uploadId: string; ctrl: AbortController | null }
>();

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
export const isImage = (name: string) => IMAGE.test(name);

/**
 * The composer's files, per conversation. They live outside the composer so that, like the
 * typed draft, they are still there after visiting another conversation and coming back.
 */
const useComposerFiles = create<{ byThread: Record<string, Attachment[]> }>(() => ({ byThread: {} }));
const EMPTY: Attachment[] = [];

const filesOf = (threadId: string) => useComposerFiles.getState().byThread[threadId] ?? EMPTY;
const setFiles = (threadId: string, change: (list: Attachment[]) => Attachment[]) =>
  useComposerFiles.setState((s) => {
    const list = change(s.byThread[threadId] ?? EMPTY);
    const byThread = { ...s.byThread };
    if (list.length) byThread[threadId] = list;
    else delete byThread[threadId];
    return { byThread };
  });

/** Files left in a composer are dropped well before the server's sweep would take them away. */
const KEEP_MS = 20 * 60 * 60 * 1000;

const revoke = (url: string | null) => {
  if (url) URL.revokeObjectURL(url);
};
const discard = (threadId: string, name: string, keepalive = false) =>
  void api.removeFile(threadId, name, { keepalive }).catch(() => {});

/**
 * Calls off a file that is not on the server yet. Its upload may get through all the same (it
 * was all sent and only the answer is missing); the server removes it then, by its upload id.
 */
const cancel = (key: string, keepalive = false) => {
  const u = uploads.get(key);
  if (!u) return;
  uploads.delete(key);
  u.ctrl?.abort();
  void api.cancelUpload(u.threadId, u.uploadId, { keepalive }).catch(() => {});
};

// Closing or reloading the page: files never sent are removed, and the request must outlive it.
if (typeof window !== 'undefined')
  window.addEventListener('pagehide', (e) => {
    // Kept for the back-forward cache: the page may come back as it was.
    if (e.persisted) return;
    for (const [threadId, list] of Object.entries(useComposerFiles.getState().byThread))
      for (const a of list) {
        if (a.saved) discard(threadId, a.saved.name, true);
        else cancel(a.key, true);
      }
  });

/**
 * Files attached in the composer of one conversation. Each is uploaded as soon as it is added,
 * so sending only names files already on the server. Files never sent stay with the conversation
 * until they are taken off or the page closes (the server sweeps what is missed).
 */
export function useAttachments(threadId: string) {
  const t = useT();
  const items = useComposerFiles((s) => s.byThread[threadId] ?? EMPTY);

  // Files left too long ago may already be gone from the server.
  useEffect(() => {
    const old = filesOf(threadId).filter((a) => a.saved && Date.now() - a.addedAt > KEEP_MS);
    if (!old.length) return;
    for (const a of old) {
      revoke(a.preview);
      discard(threadId, a.saved!.name);
    }
    setFiles(threadId, (list) => list.filter((a) => !old.includes(a)));
  }, [threadId]);

  const patch = (key: string, change: Partial<Attachment>) =>
    setFiles(threadId, (list) => list.map((a) => (a.key === key ? { ...a, ...change } : a)));

  /** Sends one file up, once more on a passing failure; a failure leaves it in the composer. */
  const upload = (key: string) => {
    const u = uploads.get(key);
    if (!u) return;
    patch(key, { error: null, progress: 0 });
    let last = 0;
    u.ctrl = startUpload({
      attempt: (signal) =>
        api.uploadFile(threadId, u.file, {
          uploadId: u.uploadId,
          signal,
          // Redrawn at each whole percent, not at every chunk.
          onProgress: (part) => {
            const pct = Math.floor(part * 100);
            if (pct === last) return;
            last = pct;
            patch(key, { progress: part });
          },
        }),
      onDone: (saved) => {
        uploads.delete(key);
        // Taken off while it was uploading.
        if (!filesOf(threadId).some((a) => a.key === key)) return discard(threadId, saved.name);
        patch(key, { saved, name: saved.name, addedAt: Date.now(), progress: 1 });
      },
      onFail: (message) => {
        // Taken off already: nothing left to undo.
        if (!filesOf(threadId).some((a) => a.key === key)) return;
        u.ctrl = null;
        patch(key, { error: message });
        toast.error(t('chat.uploadFailed', { name: u.file.name, error: message }));
      },
    });
  };

  const add = (files: File[]) => {
    const room = MAX_MESSAGE_FILES - filesOf(threadId).length;
    if (files.length > room) toast.error(t('chat.tooManyFiles', { max: MAX_MESSAGE_FILES }));
    for (const file of files.slice(0, Math.max(room, 0))) {
      if (file.size === 0) {
        toast.error(t('chat.fileEmpty', { name: file.name }));
        continue;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error(t('chat.fileTooLarge', { name: file.name, max: MAX_UPLOAD_BYTES / 1024 / 1024 }));
        continue;
      }
      const key = crypto.randomUUID();
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      const item: Attachment = {
        key,
        name: file.name,
        size: file.size,
        preview,
        saved: null,
        addedAt: Date.now(),
        progress: 0,
        error: null,
      };
      setFiles(threadId, (list) => [...list, item]);
      uploads.set(key, { threadId, file, uploadId: newUploadId(), ctrl: null });
      upload(key);
    }
  };

  /** Tries a failed file again, under the same upload id. */
  const retry = (a: Attachment) => {
    if (a.saved || !a.error) return;
    upload(a.key);
  };

  const remove = (a: Attachment) => {
    revoke(a.preview);
    setFiles(threadId, (list) => list.filter((x) => x.key !== a.key));
    if (a.saved) discard(threadId, a.saved.name);
    else cancel(a.key);
  };

  /** Hands the uploaded files to a message and empties the composer. */
  const take = (): StagedFile[] => {
    const list = filesOf(threadId);
    for (const a of list) {
      revoke(a.preview);
      uploads.delete(a.key);
    }
    setFiles(threadId, () => EMPTY);
    return list.flatMap((a) => (a.saved ? [a.saved] : []));
  };

  /** Puts files back after a failed send; they are still on the server. */
  const restore = (files: StagedFile[]) => {
    const now = Date.now();
    setFiles(threadId, (list) => [
      ...files.map((f) => ({
        key: crypto.randomUUID(),
        name: f.name,
        size: f.size,
        preview: null,
        saved: f,
        addedAt: now,
        progress: 1,
        error: null,
      })),
      ...list,
    ]);
  };

  // A file that failed counts as not there yet: the message waits until it is tried again or taken off.
  return { items, uploading: items.some((a) => !a.saved), add, remove, retry, take, restore };
}

/** Whether any conversation has files waiting in its composer. */
export const useAnyAttachments = () => useComposerFiles((s) => Object.keys(s.byThread).length > 0);

/** Pictures that can be drawn on: not a vector drawing or an animation, which a copy would flatten. */
const MARKABLE = /\.(png|jpe?g|webp)$/i;

export function AttachmentChips({
  items,
  onRemove,
  onRetry,
  onMarkUp,
}: {
  items: Attachment[];
  onRemove(a: Attachment): void;
  onRetry(a: Attachment): void;
  /** A marked copy of a picture, and the notes left on it; the picture itself stays. */
  onMarkUp?(a: Attachment, png: Blob, notes: string): void;
}) {
  const t = useT();
  const { fileSize } = useFormat();
  // A picture about to be sent, seen at full size before sending.
  const [looking, setLooking] = useState<Attachment | null>(null);
  const [marking, setMarking] = useState<Attachment | null>(null);
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap gap-2 px-2 pt-2">
      {marking?.preview && onMarkUp && (
        <ImageMarkup
          src={marking.preview}
          name={marking.name}
          onClose={() => setMarking(null)}
          onSave={(png, notes) => {
            onMarkUp(marking, png, notes);
            setMarking(null);
          }}
        />
      )}
      <Dialog open={!!looking} onOpenChange={(o) => !o && setLooking(null)}>
        <DialogContent className="flex max-h-[90vh] w-auto max-w-[min(1100px,96vw)] items-center justify-center rounded-3xl p-3 sm:max-w-[min(1100px,96vw)]">
          <DialogTitle className="sr-only">{looking?.name}</DialogTitle>
          {looking?.preview && (
            <img
              src={looking.preview}
              alt={looking.name}
              className="max-h-[85vh] max-w-full rounded-2xl object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
      {items.map((a) => (
        <div
          key={a.key}
          className={cn(
            'flex max-w-60 items-center gap-2 rounded-xl border bg-background py-1.5 pe-1.5 ps-1.5 text-sm',
            !a.saved && !a.error && 'opacity-70',
            a.error && 'border-destructive/50',
          )}
          title={a.error ?? undefined}
        >
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-secondary">
            {a.error ? (
              <AlertCircle className="size-4 text-destructive" aria-hidden />
            ) : !a.saved ? (
              <Loader2 className="size-4 animate-spin" aria-label={t('chat.uploading')} />
            ) : a.preview ? (
              <button
                type="button"
                onClick={() => setLooking(a)}
                title={t('preview.open', { name: a.name })}
                className="size-full cursor-zoom-in"
              >
                <img src={a.preview} alt="" className="size-full object-cover" />
              </button>
            ) : (
              <FileText className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate font-medium">{a.name}</span>
            {a.error ? (
              <span className="block truncate text-xs text-destructive">{t('chat.uploadNotDone')}</span>
            ) : (
              <span className="block text-xs text-muted-foreground tabular-nums">
                {a.saved
                  ? fileSize(a.size)
                  : t('chat.uploadProgress', {
                      size: fileSize(a.size),
                      percent: Math.floor(a.progress * 100),
                    })}
              </span>
            )}
          </span>
          {onMarkUp && a.saved && a.preview && MARKABLE.test(a.name) && (
            <button
              type="button"
              onClick={() => setMarking(a)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('markup.open', { name: a.name })}
              title={t('markup.open', { name: a.name })}
            >
              <PenLine className="size-3.5" />
            </button>
          )}
          {a.error && (
            <button
              type="button"
              onClick={() => onRetry(a)}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={t('chat.retryUpload', { name: a.name })}
              title={t('chat.retryUpload', { name: a.name })}
            >
              <RotateCw className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => onRemove(a)}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={t('chat.removeFile', { name: a.name })}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Each family's icon and tint, so a report, a page and a sheet tell apart before their names are read. */
const FAMILY_LOOK: Record<FileFamily, { icon: LucideIcon; tint: string }> = {
  pdf: { icon: FileText, tint: 'bg-red-500/15 text-red-700 dark:text-red-300' },
  document: { icon: FileText, tint: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  web: { icon: FileCode, tint: 'bg-orange-500/15 text-orange-700 dark:text-orange-300' },
  code: { icon: FileCode, tint: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  sheet: { icon: FileSpreadsheet, tint: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' },
  slides: { icon: Presentation, tint: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  archive: { icon: FileArchive, tint: 'bg-secondary text-muted-foreground' },
  image: { icon: FileImage, tint: 'bg-pink-500/15 text-pink-700 dark:text-pink-300' },
  audio: { icon: FileMusic, tint: 'bg-secondary text-muted-foreground' },
  video: { icon: FileVideo, tint: 'bg-secondary text-muted-foreground' },
  other: { icon: FileIcon, tint: 'bg-secondary text-muted-foreground' },
};

/**
 * Files on a sent message: images as pictures, the rest as cards. One the app can show opens in
 * the preview from its card and downloads from the button beside it; any other file downloads.
 */
export function MessageFiles({
  files,
  botId,
  align = 'end',
}: {
  files: MessageFile[];
  botId?: string;
  /** The person's files sit on the right, a bot's on the left. */
  align?: 'start' | 'end';
}) {
  const t = useT();
  const { fileSize } = useFormat();
  const preview = usePreview((s) => s.open);
  // Three or more saved files can also come down as one archive.
  const saved = botId ? files.filter((f) => f.path) : [];
  // The preview steps through the message's other files it can show.
  const viewable = saved
    .filter((f) => previewKind(f.name))
    .map((f) => ({ botId: botId!, path: f.path, name: f.name, size: f.size }));
  const zip = saved.length >= 3 && (
    <a
      href={api.zipUrl(
        botId!,
        saved.map((f) => f.path),
        t('message.zipName'),
      )}
      download
      title={t('message.downloadAll')}
      className="flex items-center gap-2 rounded-2xl border border-dashed px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Download className="size-4" />
      {t('message.downloadAll')}
    </a>
  );
  const one = (f: MessageFile) => {
    const href = botId ? api.fileUrl(botId, f.path) : undefined;
    const label = t('message.download', { name: f.name });
    // A message still being sent has no saved path yet: nothing to show until it has one.
    const open =
      botId && f.path && previewKind(f.name)
        ? () => preview({ botId, path: f.path, name: f.name, size: f.size }, viewable)
        : null;
    // Sound and video play where they are; the name above still opens the preview.
    const media = href ? previewKind(f.name) : null;
    if (href && (media === 'audio' || media === 'video')) {
      const src = api.fileUrl(botId!, f.path, { inline: true });
      return (
        <div
          key={f.path || f.name}
          className="flex w-72 max-w-full min-w-0 flex-col gap-1.5 rounded-2xl border bg-card p-2"
        >
          <button
            type="button"
            onClick={open ?? undefined}
            title={t('preview.open', { name: f.name })}
            className="truncate px-1 text-start text-xs text-muted-foreground hover:text-foreground"
          >
            {f.name} · {fileSize(f.size)}
          </button>
          {media === 'audio' ? (
            <audio src={src} controls preload="metadata" className="w-full" />
          ) : (
            <video src={src} controls preload="metadata" className="max-h-64 w-full rounded-xl bg-black" />
          )}
        </div>
      );
    }
    if (href && isImage(f.name)) {
      const picture = (
        <img
          src={api.fileUrl(botId!, f.path, { inline: true })}
          alt={f.name}
          className="max-h-56 max-w-full rounded-2xl border object-cover"
        />
      );
      return open ? (
        <button
          key={f.path || f.name}
          type="button"
          onClick={open}
          title={t('preview.open', { name: f.name })}
          className="block max-w-64 min-w-0 cursor-zoom-in"
        >
          {picture}
        </button>
      ) : (
        <a
          key={f.path || f.name}
          href={href}
          download={f.name}
          title={label}
          className="block max-w-64 min-w-0"
        >
          {picture}
        </a>
      );
    }
    const look = FAMILY_LOOK[fileFamily(f.name)];
    const card = (
      <>
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', look.tint)}
          data-family={fileFamily(f.name)}
        >
          <look.icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 text-start leading-tight">
          <span className="block truncate text-sm font-medium">{f.name}</span>
          <span className="block text-xs text-muted-foreground">{fileSize(f.size)}</span>
        </span>
      </>
    );
    const cardClass =
      'flex w-72 max-w-full min-w-0 items-center rounded-2xl border bg-card transition-colors hover:bg-accent';
    // The card opens the preview; the button beside it saves the file without going through it.
    if (open)
      return (
        <div key={f.path || f.name} className={cardClass}>
          <button
            type="button"
            onClick={open}
            title={t('preview.open', { name: f.name })}
            className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-3 pe-1"
          >
            {card}
          </button>
          <a
            href={href}
            download={f.name}
            title={label}
            aria-label={label}
            className="me-2 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
          >
            <Download className="size-4" />
          </a>
        </div>
      );
    return (
      <a
        key={f.path || f.name}
        href={href}
        download={f.name}
        title={href ? label : undefined}
        className={cn(cardClass, 'gap-3 py-2 ps-3 pe-4')}
      >
        {card}
        {/* A file still on its way has nothing to save yet. */}
        {href && <Download className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      </a>
    );
  };
  // Pictures and players sit side by side; other files go one under another, as a list reads.
  const media = (f: MessageFile) => {
    const kind = botId && f.path ? previewKind(f.name) : null;
    return kind === 'image' || kind === 'audio' || kind === 'video';
  };
  const pictures = files.filter(media);
  return (
    <div className={cn('flex max-w-[80%] flex-col gap-2', align === 'end' ? 'items-end' : 'items-start')}>
      {pictures.length > 0 && (
        <div className={cn('flex flex-wrap gap-2', align === 'end' ? 'justify-end' : 'justify-start')}>
          {pictures.map(one)}
        </div>
      )}
      {files.filter((f) => !media(f)).map(one)}
      {zip}
    </div>
  );
}

/**
 * Files from a paste or a drop. Text copied from an office app comes as plain text, HTML and a
 * picture of it: the text wins then. A file copied in the file manager may carry its name as
 * plain text, and a copied image may carry HTML alone; both paste as files.
 */
export function filesFrom(data: DataTransfer | null, { paste = false } = {}): File[] {
  if (!data) return [];
  if (paste && data.types.includes('text/plain') && data.types.includes('text/html')) return [];
  return [...data.files];
}
