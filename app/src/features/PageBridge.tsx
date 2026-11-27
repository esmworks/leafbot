import { useCallback, useRef, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';

/*
 * The app's side of `window.leafbot` in a bot's page: the page's requests go to the server as the
 * person viewing it, and a connected-app call that changes something waits for the person's yes
 * here first. The page runs sandboxed and cannot reach the server itself; this is its only way.
 */

/** Which page asks: one in a conversation, or a saved app. */
export type PageTarget = { kind: 'page'; botId: string; path: string } | { kind: 'app'; id: string };

interface ToolInfo {
  name: string;
  available: boolean;
  app?: string;
  tool?: string;
  title?: string | null;
  description?: string;
  read?: boolean;
}

interface Ask {
  page: string;
  tool: ToolInfo;
  args: Record<string, unknown>;
  answer(yes: boolean): void;
}

/** The connected-app call waiting for the person's yes, one at a time. */
const useAsk = create<{ asks: Ask[] }>(() => ({ asks: [] }));

function ask(page: string, tool: ToolInfo, args: Record<string, unknown>): Promise<boolean> {
  return new Promise((answer) => {
    const entry: Ask = {
      page,
      tool,
      args,
      answer: (yes) => {
        useAsk.setState((s) => ({ asks: s.asks.filter((a) => a !== entry) }));
        answer(yes);
      },
    };
    useAsk.setState((s) => ({ asks: [...s.asks, entry] }));
  });
}

/** The theme the app shows, for the page to match. */
export function useAppTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    (fn) => {
      const watch = new MutationObserver(fn);
      watch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => watch.disconnect();
    },
    () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'),
  );
}

/**
 * Answers a page's requests. `name` is what the person knows the page by, shown when it asks to
 * change something.
 */
export function usePageBridge(target: PageTarget, name: string) {
  const tools = useRef<Promise<ToolInfo[]> | null>(null);
  // Its parts, not the object, which is made anew on every render.
  const appId = target.kind === 'app' ? target.id : null;
  const botId = target.kind === 'page' ? target.botId : null;
  const path = target.kind === 'page' ? target.path : null;
  const send = useCallback(
    async (method: string, params: Record<string, unknown>, confirmed?: boolean) =>
      (appId
        ? await api.pageAppCall(appId, method, params, confirmed)
        : await api.pageCall(botId!, path!, method, params, confirmed)
      ).result,
    [appId, botId, path],
  );
  return useCallback(
    async (rpc: string, params: Record<string, unknown>): Promise<unknown> => {
      if (!rpc.startsWith('leafbot/')) throw new Error('Method not found');
      const method = rpc.slice('leafbot/'.length);
      if (method !== 'connectors.call') return send(method, params);
      tools.current ??= (send('connectors.list', {}) as Promise<ToolInfo[]>).catch((err: unknown) => {
        tools.current = null;
        throw err;
      });
      const info = (await tools.current).find((x) => x.name === params.tool);
      // A tool it did not declare, or one that only reads: the server decides alone.
      if (!info || info.read !== false) return send(method, params);
      const args =
        params.args && typeof params.args === 'object' ? (params.args as Record<string, unknown>) : {};
      if (!(await ask(name, info, args))) throw new Error('The person said no to this.');
      return send(method, params, true);
    },
    [send, name],
  );
}

/** What a page is about to send, shortened for the question. */
function argsText(args: Record<string, unknown>): string {
  const text = JSON.stringify(args, null, 2);
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}

/** Asks the person before a page changes something through a connected app. Mounted once. */
export function PageCallQuestion() {
  const t = useT();
  const current = useAsk((s) => s.asks[0]);
  return (
    <Dialog open={!!current} onOpenChange={(o) => !o && current?.answer(false)}>
      <DialogContent className="rounded-2xl sm:max-w-md">
        {current && (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('pageCall.askTitle', {
                  page: current.page,
                  app: current.tool.app ?? '',
                })}
              </DialogTitle>
              <DialogDescription>
                {t('pageCall.askBody', {
                  tool: current.tool.title || current.tool.tool || current.tool.name,
                })}
              </DialogDescription>
            </DialogHeader>
            {current.tool.description && (
              <p className="text-sm text-muted-foreground">{current.tool.description}</p>
            )}
            {Object.keys(current.args).length > 0 && (
              <pre className="max-h-60 overflow-auto rounded-xl bg-secondary p-3 font-mono text-xs whitespace-pre-wrap">
                {argsText(current.args)}
              </pre>
            )}
            <DialogFooter>
              <Button variant="ghost" className="rounded-xl" onClick={() => current.answer(false)}>
                {t('pageCall.deny')}
              </Button>
              <Button autoFocus className="rounded-xl" onClick={() => current.answer(true)}>
                {t('pageCall.allow')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
