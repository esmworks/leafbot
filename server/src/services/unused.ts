import { UNUSED_DAYS, type UnusedReport } from '@leafbot/shared';
import { and, eq, gte, inArray, isNull, lt, max, notExists, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { managesServer, type Viewer } from './access';
import type { Services } from '.';

const DAY_MS = 86_400_000;

/**
 * Lists what sat unused, from what is recorded and with no AI, so the person can clear it away by
 * the usual ways (remove a skill or a connection, archive a bot). Only what the person may change
 * is listed. A connection's reads are not recorded anywhere, so a connection is listed only when no
 * bot can use it at all, never for going unread.
 */
export class UnusedService {
  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  async list(viewer: Viewer): Promise<UnusedReport> {
    const since = new Date(this.clock().getTime() - UNUSED_DAYS * DAY_MS);
    const [skills, connections, bots] = await Promise.all([
      this.skills(viewer, since),
      this.connections(viewer),
      this.bots(viewer, since),
    ]);
    return { skills, connections, bots };
  }

  /** Skills no bot read for a task in the days, made before them; only those the person may remove. */
  private async skills(viewer: Viewer, since: Date): Promise<UnusedReport['skills']> {
    const admin = managesServer(viewer.role);
    const rows = await this.ctx.db
      .select()
      .from(schema.skills)
      .where(
        and(
          lt(schema.skills.createdAt, since),
          or(isNull(schema.skills.lastUsedAt), lt(schema.skills.lastUsedAt, since)),
          admin ? undefined : eq(schema.skills.createdByUserId, viewer.userId),
        ),
      )
      .orderBy(schema.skills.name);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      uses: r.uses,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Connections open to no bot, or waiting for a sign-in. One a routine checks, reads for its
   * condition or waits on is left out: removing it would break the routine.
   */
  private async connections(viewer: Viewer): Promise<UnusedReport['connections']> {
    const mine = managesServer(viewer.role)
      ? or(eq(schema.connections.userId, viewer.userId), isNull(schema.connections.userId))
      : eq(schema.connections.userId, viewer.userId);
    const noBot = and(
      eq(schema.connections.allBots, false),
      notExists(
        this.ctx.db
          .select({ id: schema.botConnections.botId })
          .from(schema.botConnections)
          .where(eq(schema.botConnections.connectionId, schema.connections.id)),
      ),
    );
    const rows = await this.ctx.db
      .select({
        id: schema.connections.id,
        name: schema.connections.name,
        status: schema.connections.status,
        allBots: schema.connections.allBots,
      })
      .from(schema.connections)
      .where(and(mine, or(noBot, eq(schema.connections.status, 'signed-out'))))
      .orderBy(schema.connections.name);
    if (!rows.length) return [];
    const needed = await this.neededByRoutines();
    return rows
      .filter((r) => !needed.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, reason: r.status === 'signed-out' ? 'signedOut' : 'noBot' }));
  }

  /** The connections some routine checks, reads for its condition, or waits for a sign-in to. */
  private async neededByRoutines(): Promise<Set<string>> {
    const rows = await this.ctx.db
      .select({
        check: schema.routines.check,
        condition: schema.routines.condition,
        signInWait: schema.routines.signInWait,
      })
      .from(schema.routines);
    const out = new Set<string>();
    for (const r of rows) {
      const check = r.check as { connectionId?: unknown } | null;
      if (typeof check?.connectionId === 'string') out.add(check.connectionId);
      if (r.signInWait) out.add(r.signInWait);
      const checks = (r.condition as { checks?: unknown } | null)?.checks;
      if (Array.isArray(checks))
        for (const c of checks as { connectionId?: unknown }[])
          if (typeof c?.connectionId === 'string') out.add(c.connectionId);
    }
    return out;
  }

  /**
   * Bots with no turn in the days, made before them, that the person may archive. A bot that
   * still has work waiting to come is left out: a routine switched on, a chat app it answers in,
   * or bots it looks after.
   */
  private async bots(viewer: Viewer, since: Date): Promise<UnusedReport['bots']> {
    const editable = await this.services.access.botIds(viewer, 'edit');
    if (!editable.length) return [];
    const candidates = await this.ctx.db
      .select({ id: schema.bots.id, name: schema.bots.name })
      .from(schema.bots)
      .where(
        and(
          inArray(schema.bots.id, editable),
          isNull(schema.bots.archivedAt),
          eq(schema.bots.isManager, false),
          lt(schema.bots.createdAt, since),
          notExists(
            this.ctx.db
              .select({ id: schema.routines.id })
              .from(schema.routines)
              .where(and(eq(schema.routines.botId, schema.bots.id), eq(schema.routines.enabled, true))),
          ),
          notExists(
            this.ctx.db
              .select({ id: schema.channels.id })
              .from(schema.channels)
              .where(eq(schema.channels.botId, schema.bots.id)),
          ),
        ),
      )
      .orderBy(schema.bots.name);
    if (!candidates.length) return [];
    const ids = candidates.map((b) => b.id);
    const recent = new Set(
      (
        await this.ctx.db
          .selectDistinct({ botId: schema.turns.botId })
          .from(schema.turns)
          .where(and(inArray(schema.turns.botId, ids), gte(schema.turns.createdAt, since)))
      ).map((r) => r.botId),
    );
    const idle = candidates.filter((b) => !recent.has(b.id));
    if (!idle.length) return [];
    const last = new Map(
      (
        await this.ctx.db
          .select({ botId: schema.turns.botId, at: max(schema.turns.createdAt) })
          .from(schema.turns)
          .where(
            inArray(
              schema.turns.botId,
              idle.map((b) => b.id),
            ),
          )
          .groupBy(schema.turns.botId)
      ).map((r) => [r.botId, r.at]),
    );
    return idle.map((b) => ({ id: b.id, name: b.name, lastTurnAt: last.get(b.id)?.toISOString() ?? null }));
  }
}
