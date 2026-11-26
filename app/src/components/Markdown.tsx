import { Check, Copy, Download, ImageIcon } from 'lucide-react';
import {
  Children,
  cloneElement,
  Fragment,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ThemedToken } from 'shiki/core';
import { toast } from 'sonner';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Options as MarkdownOptions } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import { leftoverBold } from '@leafbot/shared';
import { useLocale, useT } from '@/i18n';
import { highlight } from '@/lib/highlight';
import { MermaidDiagram, textOf } from './Mermaid';
import { usePreview } from '@/features/FilePreview';
import { copyText } from '@/lib/clipboard';
import { readTable, toCsv, toMarkdown } from '@/lib/tableCopy';
import { api } from '@/lib/api';
import { previewKind } from '@/lib/preview';
import { FileLinks, localFilePath, localFolderPath } from '@/lib/fileLink';
import { useUi } from '@/lib/store';
import { sameServerThread } from '@/lib/threadLink';
import { WebLink } from './LinkPreview';
import { ServerAudio, ServerImg, ServerVideo } from '@/components/ServerMedia';

/**
 * Math is typeset from `$$…$$` (inline when on one line with text, display on its own lines),
 * `\(…\)`, `\[…\]` and ```math blocks. A single `$` is left alone, so prices stay prices. A
 * formula that does not parse shows its source.
 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * Bold the parser left as asterisks, such as a Turkish suffix after a quoted word
 * (`**"Yenile"**ye`; see leftoverBold). Asterisks written escaped stay as they are.
 */
export function remarkLeftoverBold() {
  return (tree: MdNode, file: { value?: unknown }) => {
    const source = typeof file.value === 'string' ? file.value : '';
    const walk = (node: MdNode) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text') {
          walk(child);
          return [child];
        }
        const { start, end } = child.position ?? {};
        const written =
          start?.offset !== undefined && end?.offset !== undefined
            ? source.slice(start.offset, end.offset)
            : '';
        const pieces = written.includes('\\*') ? null : leftoverBold(child.value ?? '');
        if (!pieces) return [child];
        return pieces.map((p) =>
          p.bold
            ? { type: 'strong', children: [{ type: 'text', value: p.text }] }
            : { type: 'text', value: p.text },
        );
      });
    };
    walk(tree);
  };
}

// Only ~~double~~ tildes strike text through: "~5 to ~10 minutes" stays as written.
const REMARK: MarkdownOptions['remarkPlugins'] = [
  [remarkGfm, { singleTilde: false }],
  [remarkMath, { singleDollarTextMath: false }],
  remarkLeftoverBold,
];
const REHYPE: MarkdownOptions['rehypePlugins'] = [[rehypeKatex, { throwOnError: false, strict: 'ignore' }]];

/** `\(x\)` → `$$x$$` and `\[x\]` → a display block, outside code. */
export function mathDelimiters(text: string): string {
  if (!text.includes('\\(') && !text.includes('\\[')) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body: string) => `\n$$\n${body.trim()}\n$$\n`)
            .replace(/\\\(([^\n]+?)\\\)/g, (_m, body: string) => `$$${body.trim()}$$`),
    )
    .join('');
}

/**
 * Turns each single line break into a Markdown hard break, outside fenced code, so text typed on
 * several lines keeps its lines while lists, code and emphasis still render.
 */
const BLOCK_START = /^\s*(([-*+]|\d+[.)])\s|#{1,6}\s|>|\||```|~~~)/;

export function hardBreaks(text: string): string {
  let fenced = false;
  return text
    .split('\n')
    .map((line, i, lines) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const next = lines[i + 1];
      if (fenced || next === undefined || !line.trim() || !next.trim()) return line;
      // A break only inside a paragraph: not before a new block (list item, heading, quote,
      // fence, table row), where the mark would show as a backslash.
      if (/^\s*(```|~~~|\|)/.test(line) || BLOCK_START.test(next)) return line;
      return `${line}\\`;
    })
    .join('\n');
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of a `| a | b |` row. */
function cells(row: string): string[] {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

/**
 * Tables models write a little wrong, set right so they draw as tables: a missing or short rule
 * under the header gets one with a dash per column, and a table glued to the paragraph above gets
 * the blank line it needs. Code fences are left as they are.
 */
export function repairTables(text: string): string {
  if (!text.includes('|')) return text;
  const lines = text.split('\n');
  const out: string[] = [];
  // The open fence (its character and length): only a bare fence of the same kind, at least as
  // long, closes it, so a ``` line inside a ```` block stays code.
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const mark = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (!fence) fence = mark[1]!;
      else if (mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = null;
    }
    const fenced = fence !== null || !!mark;
    const prev = lines[i - 1];
    const next = lines[i + 1];
    const starts = !fenced && TABLE_ROW.test(line) && !(prev !== undefined && TABLE_ROW.test(prev));
    if (!starts || next === undefined || !TABLE_ROW.test(next)) {
      out.push(line);
      continue;
    }
    // The first row of a table: a header above at least one more row.
    if (prev !== undefined && prev.trim() && !TABLE_RULE.test(prev)) out.push('');
    out.push(line);
    const width = cells(line).length;
    const rule = `|${' --- |'.repeat(width)}`;
    if (!TABLE_RULE.test(next)) out.push(rule);
    else if (cells(next).length !== width) {
      out.push(rule);
      i++;
    }
  }
  return out.join('\n');
}

/**
 * Addresses as the default keeps them, and the desktop app's own `leafbot://` links too (`yumakbot://`
 * in messages written before the rename).
 */
function keepAppLinks(url: string): string {
  return /^(?:leafbot|yumakbot):\/\/(?:thread|bot|room)\/[\w-]{1,64}\/?$/.test(url)
    ? url
    : defaultUrlTransform(url);
}

/** A web address to open on request, or null for any other scheme. */
export function webLink(src: string | undefined): URL | null {
  if (!src) return null;
  try {
    const url = new URL(src);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Chat text as Markdown. Raw HTML is not rendered, and images do not load by themselves: loading
 * one tells its server the address, so a reply shaped by a page the bot read could carry data out
 * in it without anyone clicking. An image shows as a link the person may open.
 */
/** A picture from the web is offered as a link, so a page cannot load it (and learn of the read) by itself. */
function MarkdownImage({ src, alt }: { src?: unknown; alt?: string }) {
  const t = useT();
  if (typeof src === 'string' && !webLink(src)) return <BotImage src={src} alt={alt ?? ''} />;
  const url = webLink(typeof src === 'string' ? src : undefined);
  const label = alt || url?.hostname || '';
  if (!url) return <span>{label}</span>;
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noopener noreferrer"
      title={t('chat.imageLink')}
      className="inline-flex items-center gap-1 align-bottom"
    >
      <ImageIcon className="size-4 shrink-0" aria-hidden />
      {label}
    </a>
  );
}

/**
 * How each Markdown element is drawn. Defined once: made anew on every render, each would be a new
 * component type to React, so a table would lose its sorting and a code block its colours.
 */
const COMPONENTS: MarkdownOptions['components'] = {
  pre: ({ children }) => {
    const language = codeLanguage(children);
    // A diagram is drawn, not shown as code.
    if (language?.toLowerCase() === 'mermaid') return <MermaidDiagram code={textOf(children)} />;
    return <CodeBlock language={language}>{children}</CodeBlock>;
  },
  // Each paragraph and list item reads in the direction of its own text (Arabic, Hebrew).
  p: ({ children }) => <p dir="auto">{children}</p>,
  li: ({ children, className }) => (
    <li dir="auto" className={className}>
      {children}
    </li>
  ),
  code: ({ className, children }) => <Code className={className}>{children}</Code>,
  table: ({ children }) => <Table>{children}</Table>,
  a: ({ href, children }) => <Link href={href}>{children}</Link>,
  img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} />,
};

export const Markdown = memo(function Markdown({
  text,
  breaks = false,
  className,
}: {
  text: string;
  /** Keeps each line break as typed, as a person's own message is written. */
  breaks?: boolean;
  className?: string;
}) {
  text = mathDelimiters(repairTables(breaks ? hardBreaks(text) : text));
  return (
    <div className={className ?? 'prose-chat text-[15px] leading-relaxed break-words'}>
      <ReactMarkdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={COMPONENTS}
        urlTransform={keepAppLinks}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

/** The language a fenced block names (```ts), from the class Markdown gives its code element. */
export function codeLanguage(children: ReactNode): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string }>(child)) return null;
  const m = /(?:^|\s)language-([\w+#.-]+)/.exec(child.props.className ?? '');
  return m ? m[1]! : null;
}

const EXTENSIONS: Record<string, string> = {
  javascript: 'js',
  js: 'js',
  jsx: 'jsx',
  typescript: 'ts',
  ts: 'ts',
  tsx: 'tsx',
  python: 'py',
  py: 'py',
  bash: 'sh',
  sh: 'sh',
  shell: 'sh',
  zsh: 'sh',
  powershell: 'ps1',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  css: 'css',
  sql: 'sql',
  markdown: 'md',
  md: 'md',
  go: 'go',
  rust: 'rs',
  rs: 'rs',
  java: 'java',
  kotlin: 'kt',
  swift: 'swift',
  ruby: 'rb',
  php: 'php',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  cs: 'cs',
  xml: 'xml',
  csv: 'csv',
  dockerfile: 'Dockerfile',
};

/** The file name a code block saves under: `snippet.py`, or a bare `Dockerfile`. */
export function snippetName(language: string | null): string {
  const ext = language ? EXTENSIONS[language.toLowerCase()] : undefined;
  if (ext === 'Dockerfile') return ext;
  return `snippet.${ext ?? 'txt'}`;
}

/**
 * The code coloured for its language once Shiki has read it; null while that is under way, for a
 * language it does not know, and for text that changed since (a reply still being written).
 */
/**
 * Whether an element is within a screen's height or so of the view, and stays so once it was: a
 * long conversation then colours only the code blocks someone may look at.
 */
function useNearScreen(ref: React.RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    const seen = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && setNear(true),
      {
        rootMargin: '800px 0px',
      },
    );
    seen.observe(el);
    return () => seen.disconnect();
  }, [near, ref]);
  return near;
}

function useHighlight(code: string, language: string | null, near: boolean): ThemedToken[][] | null {
  const [done, setDone] = useState<{ code: string; tokens: ThemedToken[][] } | null>(null);
  useEffect(() => {
    if (!language || !near) return;
    let live = true;
    // While a reply streams in, the code changes letter by letter; colour it once it pauses.
    const timer = setTimeout(() => {
      highlight(code.replace(/\n$/, ''), language)
        .then((tokens) => live && tokens && setDone({ code, tokens }))
        .catch(() => {});
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, language, near]);
  return done && done.code === code ? done.tokens : null;
}

/** A fenced code block with its language, and buttons that copy or save just its code. */
function CodeBlock({ children, language }: { children: ReactNode; language: string | null }) {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const code = ref.current?.textContent ?? '';
    if (await copyText(code.replace(/\n$/, ''))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else toast.error(t('message.copyFailed'));
  };
  const tokens = useHighlight(textOf(children), language, useNearScreen(ref));
  const save = () => {
    const code = (ref.current?.textContent ?? '').replace(/\n$/, '');
    const url = URL.createObjectURL(new Blob([`${code}\n`], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = snippetName(language);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <div className="group/code relative">
      {language && (
        <span className="pointer-events-none absolute top-3.5 start-3 font-mono text-[11px] opacity-60 select-none">
          {language}
        </span>
      )}
      <pre ref={ref} dir="ltr" data-language={language ?? undefined}>
        {tokens ? (
          <code>
            {tokens.map((line, i) => (
              <Fragment key={i}>
                {line.map((tok, j) => (
                  <span key={j} data-tok style={tok.htmlStyle as React.CSSProperties}>
                    {tok.content}
                  </span>
                ))}
                {i < tokens.length - 1 && '\n'}
              </Fragment>
            ))}
          </code>
        ) : (
          children
        )}
      </pre>
      <button
        type="button"
        aria-label={copied ? t('message.copied') : t('message.copyCode')}
        title={copied ? t('message.copied') : t('message.copyCode')}
        onClick={() => void copy()}
        className="absolute top-1.5 end-1.5 flex size-7 items-center justify-center rounded-lg bg-background/70 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label={t('message.saveCode')}
        title={t('message.saveCode')}
        onClick={save}
        className="absolute top-1.5 end-9.5 flex size-7 items-center justify-center rounded-lg bg-background/70 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;

/**
 * A picture from the bot's own folders, shown in place: it comes from this server, unlike a web
 * image, which stays a link so a page cannot see when the message was read. Opens in the preview.
 */
function BotImage({ src, alt }: { src: string; alt: string }) {
  const t = useT();
  const files = useContext(FileLinks);
  const preview = usePreview((s) => s.open);
  const path = files ? localFilePath(src, files.base) : null;
  if (!files || !path || !IMAGE.test(path)) return <span>{alt}</span>;
  const name = path.split('/').pop()!;
  return (
    <button
      type="button"
      title={t('preview.open', { name })}
      onClick={() => preview({ botId: files.botId, path, name, size: -1 })}
      className="my-1 block"
    >
      <ServerImg
        src={api.fileUrl(files.botId, path, { inline: true })}
        alt={alt || name}
        loading="lazy"
        className="max-h-96 max-w-full rounded-xl border"
      />
    </button>
  );
}

/** A web link opens in a new tab; a link to one of the bot's files opens it in the preview. */
/** Kinds of file a bot makes and names in its replies: documents, data, pictures, media, code. */
const FILE_NAME =
  /^[^\s`'"<>|]*[\p{L}\p{N}_-][^\s`'"<>|]*\.(pdf|md|txt|csv|tsv|json|xlsx?|docx?|pptx?|odt|ods|html?|png|jpe?g|gif|webp|svg|zip|mp3|wav|m4a|aac|ogg|oga|opus|flac|mp4|m4v|webm|mov|eml|ics|py|js|ts|sh)$/iu;

/** Whether text written as code is the name or path of a file (`report.pdf`, `out/data.csv`). */
export function looksLikeFile(text: string): boolean {
  return text.length < 300 && !/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && FILE_NAME.test(text);
}

/** Inline code; a file's name or path in it opens the file, as a link to it would. */
function Code({ className, children }: { className?: string; children: ReactNode }) {
  const files = useContext(FileLinks);
  const text = textOf(children);
  if (!className && files && looksLikeFile(text)) {
    return (
      <Link href={text}>
        <code>{children}</code>
      </Link>
    );
  }
  return <code className={className}>{children}</code>;
}

function Link({ href, children }: { href?: string; children: ReactNode }) {
  const t = useT();
  const files = useContext(FileLinks);
  const preview = usePreview((s) => s.open);
  const path = files && href ? (localFilePath(href, files.base) ?? localFolderPath(href, files.base)) : null;
  if (files && path) {
    const name = path.split('/').pop()!;
    const link = (
      <a
        href={href}
        title={t('preview.open', { name })}
        onClick={(e) => {
          e.preventDefault();
          preview({ botId: files.botId, path, name, size: -1 });
        }}
      >
        {children}
      </a>
    );
    // Sound and video play where they are named, from the same URL the preview plays; the link
    // stays to open the preview.
    const media = previewKind(name);
    if (media !== 'audio' && media !== 'video') return link;
    const src = api.fileUrl(files.botId, path, { inline: true });
    return (
      <>
        {link}
        <span className="my-1 block">
          {media === 'audio' ? (
            <ServerAudio src={src} controls preload="metadata" className="w-full max-w-sm" />
          ) : (
            <ServerVideo
              src={src}
              controls
              preload="metadata"
              className="max-h-80 max-w-full rounded-xl bg-black"
            />
          )}
        </span>
      </>
    );
  }
  // A link to a conversation on this server (Copy link) opens it here, not in another tab.
  const thread = href ? sameServerThread(href) : null;
  if (thread) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          api
            .thread(thread)
            .then((th) => {
              useUi.getState().openChat(th.botId);
              useUi.getState().selectThread(th.id);
            })
            .catch(() => toast.error(t('chat.linkGone')));
        }}
      >
        {children}
      </a>
    );
  }
  if (href && /^https?:\/\//i.test(href)) return <WebLink href={href}>{children}</WebLink>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** A table with buttons that copy it as Markdown or as CSV, for a document or a spreadsheet. */
/** A cell read as a number when it is one ("1,234.5", "%12", "$40", "-3"); null otherwise. */
export function cellNumber(text: string): number | null {
  const s = text
    .trim()
    // A typeset minus (−) is a minus: dropped as a leading symbol, -5 would sort as 5.
    .replace(/\u2212/g, '-')
    .replace(/^[^\d+-]{0,3}/, '')
    .replace(/[%\s]|[^\d.,+-]+$/g, '');
  if (!/^[+-]?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  // The last of . or , followed by one or two digits only is the decimal mark.
  const dec = /[.,](\d{1,2})$/.exec(s);
  const whole = dec ? s.slice(0, -dec[0].length) : s;
  const n = Number(`${whole.replace(/[.,]/g, '')}${dec ? `.${dec[1]}` : ''}`);
  return Number.isFinite(n) ? n : null;
}

/** Compares two cells: as numbers when both are, else as words in the app's language. */
export function compareCells(a: string, b: string, locale: string): number {
  const x = cellNumber(a);
  const y = cellNumber(b);
  if (x !== null && y !== null) return x - y;
  return a.localeCompare(b, locale, { numeric: true, sensitivity: 'base' });
}

type Sort = { col: number; dir: 1 | -1 } | null;

/**
 * The table's head and body with the head's cells clickable, and the body's rows in the order
 * chosen: a click sorts by that column, a second reverses, a third goes back to as written.
 */
function sortable(children: ReactNode, sort: Sort, onSort: (col: number) => void, locale: string): ReactNode {
  return Children.map(children, (section) => {
    if (!isValidElement<{ children?: ReactNode }>(section)) return section;
    if (section.type === 'thead') {
      return cloneElement(section, {
        children: Children.map(section.props.children, (row) =>
          isValidElement<{ children?: ReactNode }>(row)
            ? cloneElement(row, {
                children: Children.toArray(row.props.children)
                  .filter(isValidElement)
                  .map((cell, col) =>
                    cloneElement(cell as React.ReactElement<Record<string, unknown>>, {
                      onClick: () => onSort(col),
                      'aria-sort': sort?.col === col ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none',
                      className: 'cursor-pointer select-none',
                      'data-sort': sort?.col === col ? (sort.dir === 1 ? '▲' : '▼') : undefined,
                    }),
                  ),
              })
            : row,
        ),
      });
    }
    if (section.type === 'tbody' && sort) {
      const rows = Children.toArray(section.props.children).filter(isValidElement) as React.ReactElement<{
        children?: ReactNode;
      }>[];
      const cell = (row: React.ReactElement<{ children?: ReactNode }>) =>
        textOf(Children.toArray(row.props.children).filter(isValidElement)[sort.col]);
      const sorted = [...rows].sort((a, b) => sort.dir * compareCells(cell(a), cell(b), locale));
      return cloneElement(section, { children: sorted });
    }
    return section;
  });
}

function Table({ children }: { children: ReactNode }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const ref = useRef<HTMLTableElement>(null);
  const [sort, setSort] = useState<Sort>(null);
  const onSort = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));
  const copy = async (as: 'markdown' | 'csv') => {
    if (!ref.current) return;
    const rows = readTable(ref.current);
    const ok = await copyText(as === 'csv' ? toCsv(rows) : toMarkdown(rows));
    if (ok) toast.success(t(as === 'csv' ? 'message.tableCopiedCsv' : 'message.tableCopiedMd'));
    else toast.error(t('message.copyFailed'));
  };
  return (
    <div className="group/table relative">
      <div className="overflow-x-auto">
        <table ref={ref}>{sortable(children, sort, onSort, locale)}</table>
      </div>
      <div className="absolute top-full end-0 z-10 mt-0.5 flex gap-1 whitespace-nowrap opacity-0 transition-opacity group-hover/table:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        {(['markdown', 'csv'] as const).map((as) => (
          <button
            key={as}
            type="button"
            onClick={() => void copy(as)}
            className="rounded-md border bg-background/90 px-1.5 py-0.5 text-[11px] text-muted-foreground shadow-sm hover:text-foreground"
          >
            {t(as === 'csv' ? 'message.copyCsv' : 'message.copyMarkdown')}
          </button>
        ))}
      </div>
    </div>
  );
}
