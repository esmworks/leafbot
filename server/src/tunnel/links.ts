import type { TicketClaims } from '@leafbot/shared/account';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '../db';
import { OWNER_ID } from '../users';
import { newId } from '../util';

/**
 * Who an account is on this server. The account service decides who may use the server and with
 * which role (its memberships); this keeps a person here for each of those accounts, so their
 * bots, threads and settings have someone to belong to.
 */
export class AccountLinks {
  constructor(private db: Db) {}

  /**
   * The person for a checked ticket, made on the account's first visit. The server's owner is the
   * account that owns it at the account service; anyone else gets the role their membership has,
   * kept in step on every visit. Null when the person was removed or disabled here, or when the
   * ticket's owner account is not the one already linked to the owner here.
   */
  async resolve(claims: TicketClaims): Promise<{ userId: string } | null> {
    const role = claims.role;
    if (!role) return null;
    const [link] = await this.db
      .select({
        userId: schema.accountLinks.userId,
        role: schema.users.role,
        disabledAt: schema.users.disabledAt,
      })
      .from(schema.accountLinks)
      .leftJoin(schema.users, eq(schema.users.id, schema.accountLinks.userId))
      .where(eq(schema.accountLinks.accountUserId, claims.sub))
      .limit(1);
    if (link) {
      // Removed here (the link outlives the person) or disabled: the account stays out.
      if (!link.userId || !link.role || link.disabledAt) return null;
      const userId = link.userId;
      // Ownership changes only by linking the server again, never by a role in a ticket: an
      // owner account that is no longer the owner there, or a member that became it, is refused.
      if (link.role === 'owner' || role === 'owner') return link.role === role ? { userId } : null;
      if (link.role !== role) {
        await this.db.update(schema.users).set({ role }).where(eq(schema.users.id, userId));
      }
      return { userId };
    }
    if (role === 'owner') {
      const [taken] = await this.db
        .select({ accountUserId: schema.accountLinks.accountUserId })
        .from(schema.accountLinks)
        .where(eq(schema.accountLinks.userId, OWNER_ID))
        .limit(1);
      if (taken) return null;
      const linked = await this.db
        .insert(schema.accountLinks)
        .values({ accountUserId: claims.sub, userId: OWNER_ID })
        .onConflictDoNothing()
        .returning();
      return linked.length ? { userId: OWNER_ID } : null;
    }
    const userId = newId();
    return this.db
      .transaction(async (tx) => {
        await tx.insert(schema.users).values({ id: userId, role });
        const linked = await tx
          .insert(schema.accountLinks)
          .values({ accountUserId: claims.sub, userId })
          .onConflictDoNothing()
          .returning();
        if (linked.length) return { userId };
        // Two first visits at once: the other one made the person; this one's is not needed.
        tx.rollback();
        return null;
      })
      .catch(async () => {
        const [again] = await this.db
          .select({ userId: schema.accountLinks.userId })
          .from(schema.accountLinks)
          .where(eq(schema.accountLinks.accountUserId, claims.sub))
          .limit(1);
        return again?.userId ? { userId: again.userId } : null;
      });
  }
}
