import type { Bot, DashboardSummary, DashboardTileView } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ChartColumnBig, MoreHorizontal, TriangleAlert, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ShownCard } from './ChatCard';
import { useTileDrag } from './tileDrag';

/**
 * Dashboards: pages of tiles the bots keep filled. A tile from a table is worked out again from
 * its rows each time the page is read, and the page reads again whenever a bot writes a row, so
 * what shows is always as the tables stand. The list sits beside the open page; on a phone the
 * list comes first and a page opens over it.
 */
export function DashboardsDialog() {
  const t = useT();
  const open = useUi((s) => s.dashboardsOpen);
  const setOpen = useUi((s) => s.setDashboardsOpen);
  const { data: pages = [], isPending } = useQuery({
    queryKey: ['dashboards'],
    queryFn: api.dashboards,
    enabled: open,
  });
  const [chosen, setChosen] = useState<string | null>(null);
  // The page the person chose while it is still there, else the most recently changed one.
  const current = pages.find((p) => p.id === chosen) ?? pages[0];
  const [listOnPhone, setListOnPhone] = useState(true);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        // The whole window: a page of figures and charts reads best with all the room there is.
        className="screen-edges flex h-dvh max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:max-w-none"
      >
        <DialogDescription className="sr-only">{t('dashboards.description')}</DialogDescription>
        {/* In the desktop app the window buttons sit over its top left corner, their middle 24px from
            the top (desktop/src/main.ts): the row is centred on that line, as the sidebar's top row is. */}
        <header className="window-drag flex items-center gap-3 border-b px-5 py-3.5 frameless:py-1.5 frameless:ps-[88px] phone:px-4">
          {current && !listOnPhone && (
            <Button
              variant="ghost"
              size="icon"
              className="hidden phone:inline-flex"
              aria-label={t('dashboards.list')}
              onClick={() => setListOnPhone(true)}
            >
              <ArrowLeft />
            </Button>
          )}
          <DialogTitle className="min-w-0 flex-1 truncate text-lg font-semibold">
            {t('dashboards.title')}
          </DialogTitle>
          <DialogClose asChild>
            <Button variant="ghost" size="icon" aria-label={t('common.close')}>
              <X />
            </Button>
          </DialogClose>
        </header>
        {!isPending && !pages.length ? (
          <Empty />
        ) : (
          <div className="flex min-h-0 flex-1">
            <nav
              aria-label={t('dashboards.list')}
              className={cn(
                'flex w-64 shrink-0 flex-col gap-0.5 overflow-y-auto border-e p-2 phone:w-full phone:border-e-0',
                !listOnPhone && 'phone:hidden',
              )}
            >
              {pages.map((p) => (
                <PageLink
                  key={p.id}
                  page={p}
                  active={p.id === current?.id}
                  onClick={() => {
                    setChosen(p.id);
                    setListOnPhone(false);
                  }}
                />
              ))}
            </nav>
            {current && (
              <Page key={current.id} page={current} className={cn(listOnPhone && 'phone:hidden')} />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Empty() {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <ChartColumnBig className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{t('dashboards.emptyTitle')}</p>
      <p className="max-w-md text-sm text-muted-foreground">{t('dashboards.empty')}</p>
    </div>
  );
}

function PageLink({ page, active, onClick }: { page: DashboardSummary; active: boolean; onClick(): void }) {
  const t = useT();
  const { data: bots = [] } = useBots();
  const by = page.botIds.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex flex-col gap-1 rounded-lg px-3 py-2 text-start hover:bg-accent',
        active && 'bg-accent',
      )}
    >
      <span className="truncate text-sm font-medium">{page.name}</span>
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex -space-x-1">
          {by.slice(0, 4).map((b) => (
            <BotAvatar
              key={b.id}
              avatar={b.avatar}
              material={b.material}
              color={b.color}
              seed={b.id}
              size={16}
            />
          ))}
        </span>
        <span className="tabular-nums">{t('dashboards.tiles', { count: page.tileCount })}</span>
      </span>
    </button>
  );
}

function Page({ page, className }: { page: DashboardSummary; className?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: view } = useQuery({
    queryKey: ['dashboard', page.id],
    queryFn: () => api.dashboard(page.id),
  });
  const [asking, setAsking] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['dashboards'] });
    void qc.invalidateQueries({ queryKey: ['dashboard', page.id] });
  };
  const remove = useMutation({
    mutationFn: () => api.removeDashboard(page.id),
    onSuccess: () => {
      setAsking(false);
      refresh();
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const scroller = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const { tiles, itemProps, air, liftRef } = useTileDrag(page.id, view?.tiles ?? [], scroller, grid);
  const { data: bots = [] } = useBots();
  return (
    <section
      ref={scroller}
      className={cn('@container flex min-w-0 flex-1 flex-col overflow-y-auto', className)}
      aria-label={page.name}
    >
      <div className="flex items-center gap-2 px-5 pt-4 pb-2 phone:px-4">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{page.name}</h2>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t('dashboards.menu')}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setAsking(true)}>
              {t('dashboards.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {view && !tiles.length && (
        <p className="px-5 text-sm text-muted-foreground">{t('dashboards.noTiles')}</p>
      )}
      {/* Rows that wrap and grow rather than a grid: a wide tile that does not fit beside the ones
          before it would leave an empty column at the end of their row; here they stretch over it,
          and the tiles in a row share its height. */}
      <div ref={grid} className="relative flex flex-wrap items-stretch gap-4 px-5 pb-6 phone:px-4">
        {tiles.map((tile, i) => (
          <Tile
            key={tile.id}
            tile={tile}
            first={i === 0}
            last={i === tiles.length - 1}
            onChanged={refresh}
            // Moving a tile takes being allowed to change its bot; others only make room.
            drag={itemProps(tile, (bots.find((b) => b.id === tile.botId)?.yourLevel ?? 'edit') === 'edit')}
          />
        ))}
      </div>
      {air?.tile && (
        <div
          ref={liftRef}
          aria-hidden
          // The copy is moved by a translate of the pointer's screen position, which counts from the
          // physical left in both directions, so it is pinned to the physical left (start-0 would be
          // the right edge in Arabic and throw it off by the window's width).
          style={{ top: 0, left: 0, ...air.style }}
          className="pointer-events-none fixed z-50 flex flex-col gap-3 rounded-2xl border bg-card p-4 shadow-2xl ring-1 ring-primary/25 will-change-transform"
        >
          <TileFace tile={air.tile} menu={<MoreHorizontal className="m-1.5 size-4" />} />
        </div>
      )}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dashboards.removeTitle', { name: page.name })}</DialogTitle>
            <DialogDescription>{t('dashboards.removeBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost">{t('common.cancel')}</Button>
            </DialogClose>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function Tile({
  tile,
  first,
  last,
  onChanged,
  drag,
}: {
  tile: DashboardTileView;
  first: boolean;
  last: boolean;
  onChanged(): void;
  drag: ReturnType<ReturnType<typeof useTileDrag>['itemProps']>;
}) {
  const t = useT();
  const fail = (err: Error) => toast.error(err.message);
  const remove = useMutation({
    mutationFn: () => api.removeDashboardTile(tile.id),
    onSuccess: onChanged,
    onError: fail,
  });
  const move = useMutation({
    mutationFn: (direction: 'earlier' | 'later') => api.moveDashboardTile(tile.id, direction),
    onSuccess: onChanged,
    onError: fail,
  });
  return (
    <article
      data-tile-id={drag['data-tile-id']}
      aria-label={tile.title}
      onPointerDown={drag.onPointerDown}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-2xl border bg-card p-4',
        tile.wide ? 'grow-[2] basis-[min(100%,38rem)]' : 'grow basis-[min(100%,20rem)]',
        // A tile that moves shows it by the hand; what is pressed inside it keeps its own pointer.
        drag.onPointerDown && 'cursor-grab [&_:is(button,a,input,select,textarea,[role=button])]:cursor-auto',
        // Where the lifted tile will land: its own size, outlined, with nothing in it.
        drag.placeholder &&
          'border-transparent bg-primary/[0.04] outline-2 -outline-offset-2 outline-primary/50 outline-dashed [&>*]:invisible',
      )}
    >
      <TileFace
        tile={tile}
        menu={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7" aria-label={t('dashboards.tileMenu')}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!first && (
                <DropdownMenuItem onSelect={() => move.mutate('earlier')}>
                  {t('dashboards.moveEarlier')}
                </DropdownMenuItem>
              )}
              {!last && (
                <DropdownMenuItem onSelect={() => move.mutate('later')}>
                  {t('dashboards.moveLater')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem variant="destructive" onSelect={() => remove.mutate()}>
                {t('dashboards.removeTile')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />
    </article>
  );
}

/** What a tile shows, in its place and while it is lifted: its card, or why it has none, and whose it is. */
function TileFace({ tile, menu }: { tile: DashboardTileView; menu: React.ReactNode }) {
  const t = useT();
  const intl = useLocale((s) => s.intl);
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === tile.botId);
  const when = new Intl.DateTimeFormat(intl, { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(tile.updatedAt),
  );
  return (
    <>
      {tile.card ? (
        <ShownCard card={tile.card} id={tile.id} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-semibold">{tile.title}</p>
          <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
            <TriangleAlert
              className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            {tile.error}
          </p>
        </div>
      )}
      <footer className="mt-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        {bot && (
          <BotAvatar avatar={bot.avatar} material={bot.material} color={bot.color} seed={bot.id} size={16} />
        )}
        <span className="min-w-0 flex-1 truncate">
          {[bot?.name, tile.show === 'card' ? t('dashboards.written', { time: when }) : t('dashboards.live')]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {menu}
      </footer>
    </>
  );
}
