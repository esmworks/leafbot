import {
  dashboardText,
  DashboardName,
  DASHBOARD_PERIODS,
  MAX_TILE_ROWS,
  MAX_TILES,
  TILE_BUCKETS,
  TILE_MEASURES,
  TILE_SHOWS,
  TileTitle,
} from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import type { Reader, TileInput } from '../services/dashboards';
import { HttpError } from '../util';
import type { Define } from './index';

/** A tile as the bot writes it, in the words of the other tools' arguments. */
const Tile = z.object({
  title: TileTitle,
  show: z.enum(TILE_SHOWS),
  table: z.string().max(80).optional(),
  filter: z.string().max(2000).optional(),
  period: z.enum(DASHBOARD_PERIODS).optional(),
  date_column: z.string().max(60).optional(),
  measure: z.enum(TILE_MEASURES).optional(),
  column: z.string().max(60).optional(),
  group_by: z.string().max(60).optional(),
  bucket: z.enum(TILE_BUCKETS).optional(),
  goal: z.number().positive().optional(),
  ring: z.boolean().optional(),
  columns: z.array(z.string().max(60)).max(6).optional(),
  limit: z.number().int().min(1).max(MAX_TILE_ROWS).optional(),
  wide: z.boolean().optional(),
  card: z.unknown().optional().describe('For show: card only: a ChatKit widget tree that only shows'),
});

const toInput = ({ date_column, group_by, ...rest }: z.infer<typeof Tile>): TileInput => ({
  ...rest,
  ...(date_column !== undefined && { dateColumn: date_column }),
  ...(group_by !== undefined && { groupBy: group_by }),
});

/**
 * Dashboards, for the bot: read them, and put its own tiles on one. A bot reads the tiles of the
 * bots the person it works for reaches; in a team conversation or for a guest, where others read
 * what it says, only its own. Deleting a whole dashboard is left to the person.
 */
export function dashboardTools(opts: {
  def: Define;
  services: Services;
  botId: string;
  /** The person the bot works for. */
  person: string;
  /** Others read this conversation: the bot reads only its own tiles. */
  onlyOwn: boolean;
  t: T;
}): AppTool[] {
  const { def, services: s, botId, person, onlyOwn, t } = opts;
  const reader: Reader = onlyOwn ? { userId: person, onlyBot: botId } : { userId: person };
  return [
    def(
      'dashboards',
      { name: z.string().max(80).optional() },
      async ({ name }) => {
        if (!name?.trim()) {
          const all = await s.dashboards.list(reader);
          if (!all.length) return t('tool.dashboardsNone');
          return all.map((d) => t('tool.dashboardLine', { name: d.name, count: d.tileCount })).join('\n');
        }
        const { found, names } = await s.dashboards.find(name, reader);
        if (!found)
          return names.length
            ? t('tool.dashboardMissing', { name, names: names.join(', ') })
            : t('tool.dashboardsNone');
        const view = await s.dashboards.view(found.id, reader);
        const bots = new Map((await s.bots.list()).map((b) => [b.id, b.name]));
        return dashboardText(view, (id) => bots.get(id) ?? id);
      },
      'read',
    ),
    def(
      'dashboard_define',
      {
        name: DashboardName,
        tiles: z.array(Tile).max(MAX_TILES).default([]),
        remove: z.array(z.string().max(80)).max(MAX_TILES).default([]),
      },
      async ({ name, tiles, remove }) => {
        try {
          const r = await s.dashboards.define(botId, name, { tiles: tiles.map(toInput), remove }, t);
          return t('tool.dashboardDefined', {
            name: r.name,
            written: r.written.join(', ') || '—',
            removed: r.removed,
          });
        } catch (err) {
          // What is wrong goes back to the bot to fix, rather than failing the call.
          if (err instanceof HttpError && err.status === 400) return err.localized(t);
          throw err;
        }
      },
      'internal',
    ),
  ];
}
