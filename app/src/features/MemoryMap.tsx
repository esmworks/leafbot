import type { Bot, Memory, MemoryGraph, Room } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { placeLabel } from '@/lib/memoryNotes';
import { placeNotes } from '@/lib/memoryMap';
import { cn } from '@/lib/utils';
import { NoteRow } from './MemoryNote';

/** The most notes drawn at once; a search narrows the rest down. */
const MAP_NOTES = 300;
const WIDTH = 800;
const HEIGHT = 520;
/** The person's own notes, drawn in the brand's neutral colour; a place's in another. */
const USER_COLOR = 'var(--color-primary)';
const PLACE_COLOR = 'var(--color-muted-foreground)';

/** How each kind of link is drawn: near in meaning solid, same site dashed, same conversation dotted. */
const DASH: Record<MemoryGraph['edges'][number]['kind'], string | undefined> = {
  similar: undefined,
  site: '6 4',
  conversation: '2 4',
};

/**
 * The memory as a map: each note a dot, coloured by whose it is (a bot's, the person's own, a
 * place's), clustered by owner, and linked to notes about the same site, written in the same
 * conversation, or, when search by meaning is on, near it in meaning. A dot opens the note below
 * the map, to fix or forget it as in the list.
 */
export function MemoryMap({
  notes: all,
  bots,
  rooms,
  noteProps,
}: {
  notes: Memory[];
  bots: Bot[];
  rooms: Pick<Room, 'id' | 'title'>[];
  noteProps: Pick<Parameters<typeof NoteRow>[0], 'onSave' | 'onPin' | 'onForget'>;
}) {
  const t = useT();
  const { data: graph } = useQuery({ queryKey: ['memory', 'graph'], queryFn: api.memoryGraph });
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const botOf = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const groupOf = (m: Memory) =>
    m.scope === 'user' ? 'user' : m.scope === 'room' ? `room:${m.place ?? ''}` : `bot:${m.botId ?? ''}`;
  const colorOf = (m: Memory) =>
    m.scope === 'user'
      ? USER_COLOR
      : m.scope === 'room'
        ? PLACE_COLOR
        : (botOf.get(m.botId ?? '')?.color ?? PLACE_COLOR);
  const ownerOf = (m: Memory) =>
    m.scope === 'user'
      ? t('memory.user')
      : m.scope === 'room'
        ? placeLabel(m.place, t, rooms)
        : (botOf.get(m.botId ?? '')?.name ?? t('common.bot'));
  // A map of thousands of dots reads as nothing and takes long to lay out: the notes with links
  // come first, then the ones bots look up most.
  const notes = useMemo(() => {
    if (all.length <= MAP_NOTES) return all;
    const linked = new Set((graph?.edges ?? []).flatMap((e) => [e.a, e.b]));
    return [...all]
      .sort((x, y) => Number(linked.has(y.id)) - Number(linked.has(x.id)) || y.useCount - x.useCount)
      .slice(0, MAP_NOTES);
  }, [all, graph]);
  const ids = useMemo(() => new Set(notes.map((m) => m.id)), [notes]);
  // Only links between notes on the map: a search leaves some out.
  const edges = useMemo(() => (graph?.edges ?? []).filter((e) => ids.has(e.a) && ids.has(e.b)), [graph, ids]);
  // Laid out again only when the dots or links change, not on every render of the page around it
  // (the memory page hands a new array on each render, so the key, not the array, decides).
  const shape = useMemo(
    () => ({
      key: `${notes.map((m) => `${m.id}:${groupOf(m)}`).join(',')}|${edges.map((e) => `${e.a}-${e.b}`).join(',')}`,
      nodes: notes.map((m) => ({ id: m.id, group: groupOf(m) })),
      links: edges.map((e) => ({ a: e.a, b: e.b, weight: e.kind === 'similar' ? (e.score ?? 0.6) : 0.5 })),
    }),
    [notes, edges],
  );
  const layoutKey = shape.key;
  const placed = useMemo(
    () => placeNotes(shape.nodes, shape.links, WIDTH, HEIGHT),
    // The key stands for the nodes and links.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layoutKey],
  );
  const shown = notes.find((m) => m.id === picked) ?? null;
  const focus = hover ?? picked;
  const near = useMemo(() => {
    if (!focus) return null;
    const s = new Set([focus]);
    for (const e of edges) {
      if (e.a === focus) s.add(e.b);
      if (e.b === focus) s.add(e.a);
    }
    return s;
  }, [focus, edges]);
  const label = hover ? notes.find((m) => m.id === hover) : null;

  if (!notes.length) return <p className="px-1 py-3 text-sm text-muted-foreground">{t('memory.empty')}</p>;
  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-2xl border bg-card">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          className="block h-auto w-full touch-manipulation"
          role="img"
          aria-label={t('memory.mapTitle')}
          onClick={() => setPicked(null)}
        >
          {edges.map((e) => {
            const a = placed.get(e.a);
            const b = placed.get(e.b);
            if (!a || !b) return null;
            const lit = !near || (near.has(e.a) && near.has(e.b));
            return (
              <line
                key={`${e.a}-${e.b}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="currentColor"
                className="text-muted-foreground"
                strokeOpacity={
                  lit ? (e.kind === 'similar' ? 0.25 + (0.5 * ((e.score ?? 0.6) - 0.6)) / 0.4 : 0.45) : 0.06
                }
                strokeWidth={1.2}
                strokeDasharray={DASH[e.kind]}
              />
            );
          })}
          {notes.map((m) => {
            const p = placed.get(m.id);
            if (!p) return null;
            const r = 5 + Math.min(m.useCount, 12) * 0.5;
            const dim = near && !near.has(m.id);
            return (
              <g
                key={m.id}
                className="cursor-pointer"
                onMouseEnter={() => setHover(m.id)}
                onMouseLeave={() => setHover(null)}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setPicked(m.id);
                }}
              >
                <circle cx={p.x} cy={p.y} r={r + 6} fill="transparent" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill={colorOf(m)}
                  fillOpacity={dim ? 0.2 : 0.9}
                  stroke={m.pinned || m.id === picked ? 'currentColor' : 'none'}
                  strokeWidth={2}
                  className="text-foreground"
                />
              </g>
            );
          })}
        </svg>
        {label && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-xl bg-background/90 px-3 py-2 text-xs shadow-sm backdrop-blur">
            <span className="font-medium">{ownerOf(label)}</span> ·{' '}
            <span className="line-clamp-2">{label.content}</span>
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        {(['similar', 'site', 'conversation'] as const).map((k) => (
          <span
            key={k}
            className={cn('flex items-center gap-1.5', k === 'similar' && !graph?.meaning && 'hidden')}
          >
            <svg width="22" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="22"
                y2="3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray={DASH[k]}
              />
            </svg>
            {t(`memory.mapLink.${k}`)}
          </span>
        ))}
        <span>{t('memory.mapSize')}</span>
      </div>
      {graph && !graph.meaning && (
        <p className="px-1 text-xs text-muted-foreground">{t('memory.mapNoMeaning')}</p>
      )}
      {graph?.truncated && <p className="px-1 text-xs text-muted-foreground">{t('memory.mapTruncated')}</p>}
      {all.length > notes.length && (
        <p className="px-1 text-xs text-muted-foreground">
          {t('memory.mapCapped', { shown: notes.length, total: all.length })}
        </p>
      )}
      {shown ? (
        <div className="rounded-2xl border">
          <NoteRow m={shown} hint={ownerOf(shown)} {...noteProps} />
        </div>
      ) : (
        <p className="px-1 text-xs text-muted-foreground">{t('memory.mapHint')}</p>
      )}
    </div>
  );
}
