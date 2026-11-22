import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Loader2,
  WrapText,
} from 'lucide-react';
import { toast } from 'sonner';
import { useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { copyText } from '@/lib/clipboard';
import { parseCsv } from '@/lib/csv';
import { libraryKey } from '@/lib/fileLink';
import { htmlPreviewDocument, previewKind, readTextStart } from '@/lib/preview';
import { cn } from '@/lib/utils';

/** A bot's file: one in its library, or one sent in a message. */
export interface PreviewFile {
  botId: string;
  path: string;
  name: string;
  /** -1 when not known, as for a file a message only links to. */
  size: number;
}

export const usePreview = create<{
  file: PreviewFile | null;
  /** The files to step through with the arrows: the other files of the same message. */
  set: PreviewFile[];
  open(file: PreviewFile | null, set?: PreviewFile[]): void;
}>((set) => ({
  file: null,
  set: [],
  open: (file, list) => set({ file, set: file ? (list ?? [file]) : [] }),
}));

/** Whether a file opens in the preview rather than downloading. */
export const canPreview = (name: string) => previewKind(name) !== null;

/** A file shown in place: an image, a PDF in the browser's viewer, Markdown, or plain text. */
export function FilePreview() {
  const t = useT();
  const file = usePreview((s) => s.file);
  const list = usePreview((s) => s.set);
  const open = usePreview((s) => s.open);
  const at = file ? list.findIndex((f) => f.botId === file.botId && f.path === file.path) : -1;
  const step = (by: number) => {
    if (at < 0 || list.length < 2) return;
    open(list[(at + by + list.length) % list.length]!, list);
  };
  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && open(null)}>
      <DialogContent
        className="screen-edges flex h-[min(900px,92vh)] max-w-[min(1100px,96vw)] flex-col gap-3 rounded-3xl p-4 sm:max-w-[min(1100px,96vw)] sm:p-5 phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none phone:border-0"
        onKeyDown={(e) => {
          // Not while typing somewhere, nor over a player that seeks with the arrows.
          if ((e.target as HTMLElement).closest('input, textarea, audio, video')) return;
          if (e.key === 'ArrowRight') step(1);
          if (e.key === 'ArrowLeft') step(-1);
        }}
      >
        {file && <PreviewBody key={`${file.botId}:${file.path}`} file={file} />}
        {list.length > 1 && at >= 0 && (
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={t('preview.previous')}
              onClick={() => step(-1)}
            >
              <ChevronLeft className="rtl:-scale-x-100" />
            </Button>
            <span className="tabular-nums">{t('preview.position', { at: at + 1, count: list.length })}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-full"
              aria-label={t('preview.next')}
              onClick={() => step(1)}
            >
              <ChevronRight className="rtl:-scale-x-100" />
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ file }: { file: PreviewFile }) {
  const t = useT();
  const { fileSize } = useFormat();
  const kind = previewKind(file.name);
  const download = api.fileUrl(file.botId, file.path);
  const inline = api.fileUrl(file.botId, file.path, { inline: true });
  return (
    <>
      <div className="flex items-center gap-3 pe-8">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-base">{file.name}</DialogTitle>
          <DialogDescription className="text-xs">
            {file.size >= 0 ? fileSize(file.size) : ' '}
          </DialogDescription>
        </div>
        {kind === 'pdf' && (
          <Button asChild variant="ghost" size="icon-sm" className="shrink-0 rounded-full">
            <a
              href={inline}
              target="_blank"
              rel="noopener"
              aria-label={t('preview.newTab')}
              title={t('preview.newTab')}
            >
              <ExternalLink />
            </a>
          </Button>
        )}
        {kind === 'image' && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 rounded-full"
            aria-label={t('preview.copyImage')}
            title={t('preview.copyImage')}
            onClick={async () => {
              if (await copyImage(inline)) toast.success(t('preview.imageCopied'));
              else toast.error(t('message.copyFailed'));
            }}
          >
            <Copy />
          </Button>
        )}
        <Button asChild variant="secondary" size="sm" className="shrink-0 rounded-full">
          <a href={download} download={file.name}>
            <Download /> {t('preview.download')}
          </a>
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border bg-secondary/40">
        {kind === 'image' ? (
          <ZoomableImage src={inline} alt={file.name} />
        ) : kind === 'audio' ? (
          <div className="flex size-full items-center justify-center p-6">
            <audio src={inline} controls preload="metadata" className="w-full max-w-lg" />
          </div>
        ) : kind === 'video' ? (
          <div className="flex size-full items-center justify-center bg-black">
            <video src={inline} controls preload="metadata" className="max-h-full max-w-full" />
          </div>
        ) : kind === 'pdf' ? (
          // The browser's own PDF viewer, from this server; an <object> would be refused by the page's policy.
          <iframe src={inline} title={file.name} className="size-full bg-white" />
        ) : kind === 'table' ? (
          <TablePreview file={file} />
        ) : kind ? (
          <TextPreview file={file} markdown={kind === 'markdown'} html={kind === 'html'} />
        ) : (
          <FolderOrNone file={file} />
        )}
      </div>
    </>
  );
}

/**
 * A link that names a folder lists the files in it, each opening in the preview; anything else
 * this preview cannot show says so.
 */
function FolderOrNone({ file }: { file: PreviewFile }) {
  const t = useT();
  const { fileSize } = useFormat();
  const open = usePreview((s) => s.open);
  const { data: library, isPending } = useQuery({
    queryKey: ['library', file.botId],
    queryFn: () => api.library(file.botId),
    staleTime: 10_000,
  });
  const key = libraryKey(file.path).replace(/\/+$/, '');
  const inside = (library ?? []).filter((f) => f.path.startsWith(`${key}/`));
  if (isPending)
    return (
      <Note>
        <Loader2 className="size-5 animate-spin" />
      </Note>
    );
  if (!inside.length) return <Note>{t('preview.none')}</Note>;
  return (
    <div className="scroll-thin size-full overflow-auto bg-background p-2">
      <p className="px-2 py-1 text-xs text-muted-foreground">
        {t('preview.folder', { count: inside.length })}
      </p>
      {inside.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => open({ botId: file.botId, path: f.path, name: f.name, size: f.size })}
          className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-start text-sm hover:bg-accent"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{f.path.slice(key.length + 1)}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{fileSize(f.size)}</span>
        </button>
      ))}
    </div>
  );
}

/** The most rows of a CSV the preview draws; the rest stays in the file. */
const TABLE_ROWS = 2000;

/** A CSV or TSV file as a table, its first row as a header that stays in view. */
function TablePreview({ file }: { file: PreviewFile }) {
  const t = useT();
  const { data, isPending, isError } = useQuery({
    queryKey: ['file-text', file.botId, file.path],
    queryFn: ({ signal }) => readTextStart(api.fileUrl(file.botId, file.path), undefined, signal),
    staleTime: 30_000,
    retry: false,
  });
  const rows = useMemo(() => (data ? parseCsv(data.text, /\.tsv$/i.test(file.name)) : []), [data, file.name]);
  if (isPending)
    return (
      <Note>
        <Loader2 className="size-5 animate-spin" />
      </Note>
    );
  if (isError || !data) return <Note>{t('preview.failed')}</Note>;
  const [head = [], ...body] = rows;
  const shown = body.slice(0, TABLE_ROWS);
  return (
    <div className="scroll-thin size-full overflow-auto bg-background">
      {(data.cut || body.length > TABLE_ROWS) && (
        <p className="sticky top-0 start-0 z-10 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 backdrop-blur dark:text-amber-300">
          {t('preview.rowsCut', { shown: shown.length })}
        </p>
      )}
      <table className="w-max min-w-full border-collapse text-[13px]">
        <thead className="sticky top-0 bg-secondary">
          <tr>
            {head.map((h, i) => (
              <th key={i} className="border-b px-3 py-1.5 text-start font-medium whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i} className="odd:bg-secondary/30">
              {r.map((c, j) => (
                <td key={j} className="max-w-96 truncate border-b px-3 py-1 align-top" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TextPreview({ file, markdown, html }: { file: PreviewFile; markdown: boolean; html?: boolean }) {
  const t = useT();
  // An HTML page opens drawn; its source is a click away.
  const [source, setSource] = useState(false);
  const page = html && !source;
  const wrap = useWrap((s) => s.wrap);
  const setWrap = useWrap((s) => s.setWrap);
  const { data, isPending, isError } = useQuery({
    queryKey: ['file-text', file.botId, file.path],
    queryFn: ({ signal }) => readTextStart(api.fileUrl(file.botId, file.path), undefined, signal),
    staleTime: 30_000,
    retry: false,
  });
  if (isPending)
    return (
      <Note>
        <Loader2 className="size-5 animate-spin" />
      </Note>
    );
  if (isError || !data) return <Note>{t('preview.failed')}</Note>;
  return (
    <div className="relative size-full">
      <div className="scroll-thin size-full overflow-auto bg-background">
        {data.cut && (
          <p className="sticky top-0 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-700 backdrop-blur dark:text-amber-300">
            {t('preview.cut')}
          </p>
        )}
        {page ? (
          <iframe
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={htmlPreviewDocument(data.text)}
            title={file.name}
            className="size-full bg-white"
          />
        ) : markdown ? (
          <div className="mx-auto max-w-3xl px-5 py-4">
            <Markdown text={data.text} />
          </div>
        ) : (
          <pre
            className={cn(
              'px-4 py-3 font-mono text-[13px] leading-relaxed',
              wrap ? 'break-words whitespace-pre-wrap' : 'w-max min-w-full whitespace-pre',
            )}
          >
            {data.text}
          </pre>
        )}
      </div>
      <div className="absolute top-2 end-4 flex gap-1">
        {html && (
          <Button
            variant="secondary"
            size="icon-sm"
            className="rounded-full"
            aria-label={t(source ? 'preview.showPage' : 'preview.showSource')}
            title={t(source ? 'preview.showPage' : 'preview.showSource')}
            onClick={() => setSource(!source)}
          >
            {source ? <Eye /> : <Code />}
          </Button>
        )}
        {!markdown && !page && (
          <Button
            variant="secondary"
            size="icon-sm"
            className={cn('rounded-full', wrap && 'ring-2 ring-primary/40')}
            aria-pressed={wrap}
            aria-label={t('preview.wrap')}
            title={t('preview.wrap')}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText />
          </Button>
        )}
        <Button
          variant="secondary"
          size="icon-sm"
          className="rounded-full"
          aria-label={t('preview.copySource')}
          title={t('preview.copySource')}
          onClick={async () => {
            if (await copyText(data.text)) toast.success(t('preview.copied'));
            else toast.error(t('message.copyFailed'));
          }}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

/**
 * Puts a picture on the clipboard. Browsers take only PNG there, so any other kind is drawn onto a
 * canvas first. False when the clipboard refuses or the picture cannot be read.
 */
async function copyImage(src: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false;
    const png = (async () => {
      const blob = await (await fetch(src, { credentials: 'same-origin' })).blob();
      if (blob.type === 'image/png') return blob;
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      return new Promise<Blob>((done, fail) =>
        canvas.toBlob((b) => (b ? done(b) : fail(new Error('png'))), 'image/png'),
      );
    })();
    // The item is handed over at once with a promise, so Safari still counts it as the click's.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

/** Long lines wrap to the panel or scroll sideways; the choice is kept on this device. */
const WRAP_KEY = 'leafbot.preview.wrap';
const useWrap = create<{ wrap: boolean; setWrap(v: boolean): void }>((set) => ({
  wrap: (() => {
    try {
      return localStorage.getItem(WRAP_KEY) !== '0';
    } catch {
      return true;
    }
  })(),
  setWrap: (wrap) => {
    try {
      localStorage.setItem(WRAP_KEY, wrap ? '1' : '0');
    } catch {
      // Held for this page.
    }
    set({ wrap });
  },
}));

/**
 * A picture fitted to the panel; a double click (or Enter) shows it at its own size to look closer,
 * scrolling to move around, and again fits it back.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const [zoomed, setZoomed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const toggle = (e?: React.MouseEvent) => {
    const el = box.current;
    const next = !zoomed;
    setZoomed(next);
    if (!next || !el || !e) return;
    // Keep the clicked point under the pointer once the picture has its own size.
    const r = el.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    const fy = (e.clientY - r.top) / r.height;
    requestAnimationFrame(() => {
      el.scrollLeft = fx * el.scrollWidth - (e.clientX - r.left);
      el.scrollTop = fy * el.scrollHeight - (e.clientY - r.top);
    });
  };
  return (
    <div
      ref={box}
      className={cn(
        'scroll-thin size-full',
        zoomed ? 'overflow-auto' : 'flex items-center justify-center p-3',
      )}
    >
      <img
        src={src}
        alt={alt}
        tabIndex={0}
        title={zoomed ? t('preview.zoomOut') : t('preview.zoomIn')}
        onDoubleClick={toggle}
        onKeyDown={(e) => e.key === 'Enter' && toggle()}
        className={cn(
          'outline-none',
          zoomed ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain',
        )}
      />
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
