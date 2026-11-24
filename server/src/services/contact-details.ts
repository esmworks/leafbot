import type { ContactDetailsCreate, ContactDetailsUpdate, ContactPart } from '@leafbot/shared';
import {
  CONTACT_PARTS,
  type ContactDetails,
  ContactDetailsCreate as CreateSchema,
  ContactDetailsUpdate as UpdateSchema,
} from '@leafbot/shared';
import { asc, eq, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import type { VaultService } from './vault';

type Row = typeof schema.contactDetails.$inferSelect;
export type ContactValues = Record<ContactPart, string>;

/** What a row's sealed values are bound to: its row. Moved to another row, they do not open. */
const secretBinding = (id: string) => ['contact_details.secret', id];
const sitesBinding = (id: string) => ['contact_details.sites', id];

const empty = (): ContactValues => Object.fromEntries(CONTACT_PARTS.map((p) => [p, ''])) as ContactValues;

/** Contact details as a bot's form step needs them: their name, values and agreed sites. */
export interface OpenContact extends ContactValues {
  id: string;
  label: string;
  sites: string[];
  /** The team's details rather than the person's own. */
  team: boolean;
}

const usableBy = (userId: string) =>
  or(isNull(schema.contactDetails.userId), eq(schema.contactDetails.userId, userId))!;

/**
 * Contact details, sealed like the vault's passwords so a copy of the database alone does not
 * show them. A bot fills them into a form on the server, for the person they belong to (or the
 * team's, for anyone in it), on a site that person agreed to.
 */
export class ContactDetailsService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  private sites(r: Row): string[] {
    if (!r.sites) return [];
    try {
      const list = JSON.parse(this.vault.open(r.sites, sitesBinding(r.id))) as unknown;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      // Not sealed for this row: no site is taken as agreed to.
      return [];
    }
  }

  private values(r: Row): ContactValues {
    const raw = JSON.parse(this.vault.open(r.secret, secretBinding(r.id))) as Partial<ContactValues>;
    const out = empty();
    for (const p of CONTACT_PARTS) if (typeof raw[p] === 'string') out[p] = raw[p];
    return out;
  }

  private seal(id: string, values: ContactValues) {
    return this.vault.seal(JSON.stringify(values), secretBinding(id));
  }

  /** As its owner sees it: whole. A row that does not open shows empty rather than failing the list. */
  private toDetails(r: Row): ContactDetails {
    let values: ContactValues;
    try {
      values = this.values(r);
    } catch {
      values = empty();
    }
    return {
      id: r.id,
      label: r.label,
      ...values,
      sites: this.sites(r),
      botIds: r.botIds ?? null,
      userId: r.userId,
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.contactDetails)
      .where(eq(schema.contactDetails.id, id))
      .limit(1);
    if (!row) throw notFound('vault');
    return row;
  }

  /** The team's details and, with `userId`, that person's own. */
  async list(userId?: string): Promise<ContactDetails[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.contactDetails)
      .where(userId ? usableBy(userId) : undefined)
      .orderBy(asc(schema.contactDetails.createdAt));
    return rows.map((r) => this.toDetails(r));
  }

  async get(id: string): Promise<ContactDetails> {
    return this.toDetails(await this.row(id));
  }

  async create(raw: ContactDetailsCreate, owner: string | null): Promise<ContactDetails> {
    const v = CreateSchema.parse(raw);
    const id = newId();
    const values = empty();
    for (const p of CONTACT_PARTS) values[p] = v[p];
    const [row] = await this.ctx.db
      .insert(schema.contactDetails)
      .values({
        id,
        userId: owner,
        label: v.label,
        secret: this.seal(id, values),
        botIds: v.botIds ?? null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'vault' });
    return this.toDetails(row!);
  }

  async update(id: string, raw: ContactDetailsUpdate, owner?: string | null): Promise<ContactDetails> {
    const v = UpdateSchema.parse(raw);
    const old = await this.row(id);
    const changed = CONTACT_PARTS.filter((p) => v[p] !== undefined);
    let secret: string | undefined;
    if (changed.length) {
      const values = this.values(old);
      for (const p of changed) values[p] = v[p]!;
      // Emptied of everything, nothing is left to fill: the person removes it instead.
      if (!CONTACT_PARTS.some((p) => values[p])) throw new HttpError(400, 'error.contactEmpty');
      secret = this.seal(id, values);
    }
    const sites = v.forgetSites
      ? this.vault.seal(
          JSON.stringify(this.sites(old).filter((x) => !v.forgetSites!.includes(x))),
          sitesBinding(id),
        )
      : undefined;
    const [row] = await this.ctx.db
      .update(schema.contactDetails)
      .set({
        ...(v.label !== undefined && { label: v.label }),
        ...(secret !== undefined && { secret }),
        ...(sites !== undefined && { sites }),
        ...(v.botIds !== undefined && { botIds: v.botIds }),
        ...(owner !== undefined && { userId: owner }),
        updatedAt: new Date(),
      })
      .where(eq(schema.contactDetails.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'vault' });
    return this.toDetails(row!);
  }

  async remove(id: string) {
    await this.ctx.db.delete(schema.contactDetails).where(eq(schema.contactDetails.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  /**
   * The details a bot may fill while it works for `userId`, with their values. Server-side only.
   * A row that does not open for itself is left out.
   */
  async forBot(botId: string, userId: string): Promise<OpenContact[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.contactDetails)
      .where(usableBy(userId))
      .orderBy(asc(schema.contactDetails.createdAt));
    return rows
      .filter((r) => !r.botIds || r.botIds.includes(botId))
      .flatMap((r): OpenContact[] => {
        try {
          return [{ id: r.id, label: r.label, sites: this.sites(r), team: !r.userId, ...this.values(r) }];
        } catch {
          return [];
        }
      });
  }

  /** Lets the details be filled on `site` from now on without asking. */
  async allowSite(id: string, site: string) {
    const r = await this.row(id);
    const sites = [...new Set([...this.sites(r), site])].sort();
    await this.ctx.db
      .update(schema.contactDetails)
      .set({ sites: this.vault.seal(JSON.stringify(sites), sitesBinding(id)) })
      .where(eq(schema.contactDetails.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  async used(id: string) {
    await this.ctx.db
      .update(schema.contactDetails)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.contactDetails.id, id));
    this.ctx.bus.refresh({ scope: 'vault' });
  }
}
