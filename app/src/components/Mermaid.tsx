import { Code2, ImageIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useT } from '@/i18n';

/** Drawn diagrams by theme and source, so a conversation drawn again does not wait for them. */
const cache = new Map<string, string>();
const CACHE_MAX = 50;
/** Each render needs an element id no earlier render used. */
let renderId = 0;

/** The text inside a code element's children (strings, possibly nested). */
export function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

/**
 * A ```mermaid block drawn as a diagram. Mermaid is large, so it loads with the first diagram. It
 * runs in strict mode (no scripts, no clicks, labels sanitised); a diagram it cannot draw (still
 * being written, or wrong) shows its source instead. The source is a click away either way.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const t = useT();
  const dark = document.documentElement.classList.contains('dark');
  const key = `${dark ? 'd' : 'l'}:${code}`;
  // A drawing or a failure belongs to the source and theme it was made for.
  const [drawn, setDrawn] = useState<{ key: string; svg: string | null }>({ key: '', svg: null });
  const [source, setSource] = useState(false);
  const svg = cache.get(key) ?? (drawn.key === key ? drawn.svg : null);
  const failed = drawn.key === key && drawn.svg === null;

  useEffect(() => {
    if (cache.has(key)) return;
    let live = true;
    // While a reply is still coming in, the source changes letter by letter; wait for a pause.
    const timer = setTimeout(() => {
      import('mermaid')
        .then(async ({ default: mermaid }) => {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: dark ? 'dark' : 'default',
            fontFamily: 'inherit',
          });
          const out = await mermaid.render(`leafbot-mermaid-${++renderId}`, code);
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
          cache.set(key, out.svg);
          if (live) setDrawn({ key, svg: out.svg });
        })
        .catch(() => {
          // Mermaid leaves the element of a failed render behind.
          document.getElementById(`dleafbot-mermaid-${renderId}`)?.remove();
          if (live) setDrawn({ key, svg: null });
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, code, dark]);

  const showSource = source || failed || !svg;
  return (
    <div className="group/diagram relative my-2">
      {showSource ? (
        <pre>
          <code>{code}</code>
        </pre>
      ) : (
        <div
          className="overflow-x-auto rounded-xl bg-background/60 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
          role="img"
          aria-label={t('diagram.label')}
          // The SVG comes from Mermaid in strict mode, which sanitises every label.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      {svg && !failed && (
        <button
          type="button"
          onClick={() => setSource((v) => !v)}
          aria-label={source ? t('diagram.showDiagram') : t('diagram.showSource')}
          title={source ? t('diagram.showDiagram') : t('diagram.showSource')}
          className="absolute top-1.5 end-1.5 flex size-7 items-center justify-center rounded-lg bg-background/70 text-muted-foreground opacity-0 transition-opacity group-hover/diagram:opacity-100 hover:text-foreground focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        >
          {source ? <ImageIcon className="size-3.5" /> : <Code2 className="size-3.5" />}
        </button>
      )}
    </div>
  );
}
