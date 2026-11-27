import { randomBytes } from 'node:crypto';
import type { PageApp } from '@leafbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';

type Row = typeof schema.pageApps.$inferSelect;

const toApp = (r: Row): PageApp => ({
  id: r.id,
  botId: r.botId,
  path: r.path,
  name: r.name,
  threadId: r.threadId,
  createdAt: r.createdAt.toISOString(),
});

/**
 * An app's id. It goes into `leafbot://app/<id>` links and launcher files, so it keeps to letters,
 * digits, `-` and `_`.
 */
export const pageAppId = () => randomBytes(12).toString('base64url');

/**
 * Pages people saved as apps. Each person keeps their own: saving a page again gives the same app,
 * and nobody sees, renames or removes another person's. Whether the person may still open the
 * page is checked against the bot's folder each time it opens, not here.
 */
export class PageAppService {
  constructor(private ctx: Ctx) {}

  /** A person's apps, newest first. */
  async list(userId: string): Promise<PageApp[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.pageApps)
      .where(eq(schema.pageApps.userId, userId))
      .orderBy(desc(schema.pageApps.createdAt));
    return rows.map(toApp);
  }

  /** One of a person's apps; null for another person's, or one that is not there. */
  async get(userId: string, id: string): Promise<PageApp | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.pageApps)
      .where(and(eq(schema.pageApps.id, id), eq(schema.pageApps.userId, userId)))
      .limit(1);
    return row ? toApp(row) : null;
  }

  /** The app a person made of a page, if they saved it. */
  async find(userId: string, botId: string, path: string): Promise<PageApp | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.pageApps)
      .where(
        and(
          eq(schema.pageApps.userId, userId),
          eq(schema.pageApps.botId, botId),
          eq(schema.pageApps.path, path),
        ),
      )
      .limit(1);
    return row ? toApp(row) : null;
  }

  async save(
    userId: string,
    page: { botId: string; path: string; name: string; threadId?: string | null },
  ): Promise<PageApp> {
    const existing = await this.find(userId, page.botId, page.path);
    if (existing) return existing;
    const [row] = await this.ctx.db
      .insert(schema.pageApps)
      .values({
        id: pageAppId(),
        userId,
        botId: page.botId,
        path: page.path,
        name: page.name,
        threadId: page.threadId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    // Saved twice at once: the first one stands.
    return row ? toApp(row) : (await this.find(userId, page.botId, page.path))!;
  }

  async rename(userId: string, id: string, name: string): Promise<PageApp | null> {
    const [row] = await this.ctx.db
      .update(schema.pageApps)
      .set({ name })
      .where(and(eq(schema.pageApps.id, id), eq(schema.pageApps.userId, userId)))
      .returning();
    return row ? toApp(row) : null;
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const rows = await this.ctx.db
      .delete(schema.pageApps)
      .where(and(eq(schema.pageApps.id, id), eq(schema.pageApps.userId, userId)))
      .returning({ id: schema.pageApps.id });
    return rows.length > 0;
  }
}
