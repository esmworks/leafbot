import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Ctx } from '../context';
import { schema } from '../db';
import {
  contentSealed,
  openStored,
  setMatchInServer,
  setSealing,
  staleWhere,
  type SealKind,
} from '../db/sealed';

const SETTING = 'setting.contentEncryption';
/** Rows converted per query, so a large history does not hold the database for long. */
const BATCH = 200;

interface Sealed {
  table: PgTable;
  id: PgColumn;
  /** Each sealed column: its property name in the table's definition, the column, and its kind. */
  columns: [string, PgColumn, SealKind][];
}

const SEALED: Sealed[] = [
  {
    table: schema.messages,
    id: schema.messages.id,
    columns: [
      ['text', schema.messages.text, 'text'],
      ['props', schema.messages.props, 'props'],
    ],
  },
  { table: schema.threads, id: schema.threads.id, columns: [['title', schema.threads.title, 'text']] },
  {
    table: schema.turns,
    id: schema.turns.id,
    columns: [
      ['prompt', schema.turns.prompt, 'text'],
      ['steps', schema.turns.steps, 'json'],
    ],
  },
  {
    table: schema.memories,
    id: schema.memories.id,
    columns: [
      ['content', schema.memories.content, 'text'],
      ['sourceUrl', schema.memories.sourceUrl, 'text'],
    ],
  },
  {
    table: schema.memoryChanges,
    id: schema.memoryChanges.id,
    columns: [
      ['content', schema.memoryChanges.content, 'text'],
      ['before', schema.memoryChanges.before, 'text'],
      ['sourceUrl', schema.memoryChanges.sourceUrl, 'text'],
    ],
  },
  {
    table: schema.auditLog,
    id: schema.auditLog.id,
    columns: [
      ['before', schema.auditLog.before, 'json'],
      ['after', schema.auditLog.after, 'json'],
    ],
  },
  {
    table: schema.botTableRows,
    id: schema.botTableRows.id,
    columns: [['values', schema.botTableRows.values, 'json']],
  },
  {
    table: schema.botActions,
    id: schema.botActions.id,
    columns: [['summary', schema.botActions.summary, 'text']],
  },
  {
    table: schema.approvals,
    id: schema.approvals.id,
    columns: [
      ['summary', schema.approvals.summary, 'text'],
      ['input', schema.approvals.input, 'json'],
    ],
  },
  {
    table: schema.jobs,
    id: schema.jobs.id,
    columns: [
      ['request', schema.jobs.request, 'text'],
      ['reply', schema.jobs.reply, 'text'],
    ],
  },
  {
    table: schema.meetings,
    id: schema.meetings.id,
    columns: [
      ['minutes', schema.meetings.minutes, 'json'],
      ['reminders', schema.meetings.reminders, 'json'],
    ],
  },
  {
    table: schema.routineRuns,
    id: schema.routineRuns.id,
    columns: [
      ['payload', schema.routineRuns.payload, 'text'],
      ['triggerInput', schema.routineRuns.triggerInput, 'text'],
    ],
  },
  {
    table: schema.skillSuggestions,
    id: schema.skillSuggestions.id,
    columns: [
      ['description', schema.skillSuggestions.description, 'text'],
      ['body', schema.skillSuggestions.body, 'text'],
      ['signature', schema.skillSuggestions.signature, 'text'],
    ],
  },
  {
    // A rehearsal holds the instruction as tried, what the bot wrote and the steps it would take.
    table: schema.routineRehearsals,
    id: schema.routineRehearsals.id,
    columns: [
      ['prompt', schema.routineRehearsals.prompt, 'text'],
      ['report', schema.routineRehearsals.report, 'text'],
      ['steps', schema.routineRehearsals.steps, 'json'],
      ['error', schema.routineRehearsals.error, 'text'],
    ],
  },
  {
    table: schema.emails,
    id: schema.emails.id,
    columns: [
      ['subject', schema.emails.subject, 'text'],
      ['text', schema.emails.text, 'text'],
    ],
  },
  {
    table: schema.tickets,
    id: schema.tickets.id,
    columns: [
      ['title', schema.tickets.title, 'text'],
      ['description', schema.tickets.description, 'text'],
    ],
  },
  {
    table: schema.ticketComments,
    id: schema.ticketComments.id,
    columns: [['text', schema.ticketComments.text, 'text']],
  },
  {
    // A promise is lifted from the conversation's words, so it is sealed with them.
    table: schema.promises,
    id: schema.promises.id,
    columns: [
      ['text', schema.promises.text, 'text'],
      ['toWhom', schema.promises.toWhom, 'text'],
      ['condition', schema.promises.condition, 'text'],
    ],
  },
  {
    // A suggested routine is written from the person's own requests, so it is sealed with them.
    table: schema.routineSuggestions,
    id: schema.routineSuggestions.id,
    columns: [
      ['name', schema.routineSuggestions.name, 'text'],
      ['instructions', schema.routineSuggestions.instructions, 'text'],
      ['signature', schema.routineSuggestions.signature, 'text'],
    ],
  },
  {
    // The sites a turn had read before a trip-wire; they say where the person has been.
    table: schema.canaryAlarms,
    id: schema.canaryAlarms.id,
    columns: [['sources', schema.canaryAlarms.sources, 'json']],
  },
  {
    // What a turn changed, with the words and file contents as they were before.
    table: schema.turnChanges,
    id: schema.turnChanges.id,
    columns: [
      ['label', schema.turnChanges.label, 'text'],
      ['before', schema.turnChanges.before, 'json'],
      ['after', schema.turnChanges.after, 'json'],
    ],
  },
];

export interface SealStatus {
  on: boolean;
  /** Stored values not yet as the switch says. */
  pending: number;
  /** Sealed values the last pass could not open (sealed with another key); left untouched. */
  unreadable: number;
  converting: boolean;
}

/**
 * Turns sealing of content at rest on or off, and converts what is already stored to match: each
 * value not yet as the switch says is opened and written back, sealed or not. Reads open sealed
 * values whatever the switch says, so the app keeps working while rows are converted.
 *
 * A value that cannot be opened (sealed with another key) is never written over; a value changed
 * since it was read is left for the next pass instead of being put back as it was.
 */
export class ContentSealService {
  private converting: Promise<void> | null = null;
  /** The switch changed during a pass: another pass runs from the start. */
  private again = false;
  private unreadable = 0;

  constructor(private ctx: Ctx) {}

  async enabled(): Promise<boolean> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, SETTING)).limit(1);
    return row?.value === true;
  }

  /**
   * Applies the saved switch at start, and converts in the background whatever a restart or a
   * restore left in the other state. A pass reads only the rows that need it.
   */
  async start() {
    setSealing(await this.enabled());
    this.convert();
  }

  async status(): Promise<SealStatus> {
    const on = contentSealed();
    const counts = await Promise.all(
      SEALED.map(async ({ table, columns }) => {
        const [row] = await this.ctx.db
          .select({
            n: sql<number>`${sql.join(
              columns.map(([, c, kind]) => sql`count(*) filter (where ${staleWhere(kind, c, on)})`),
              sql` + `,
            )}`.mapWith(Number),
          })
          .from(table);
        return row?.n ?? 0;
      }),
    );
    return {
      on,
      pending: counts.reduce((a, b) => a + b, 0),
      unreadable: this.unreadable,
      converting: !!this.converting,
    };
  }

  async set(on: boolean) {
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: SETTING, value: on })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: on } });
    setSealing(on);
    this.convert();
    this.ctx.bus.refresh({ scope: 'info' });
  }

  private convert() {
    if (this.converting) {
      this.again = true;
      return;
    }
    setMatchInServer(true);
    this.converting = (async () => {
      do {
        this.again = false;
        await this.pass();
      } while (this.again);
    })()
      .catch((err) => console.error('Converting content at rest failed', err))
      .finally(() => {
        this.converting = null;
        // Every value that can be opened is now as the switch says.
        setMatchInServer(contentSealed());
        this.ctx.bus.refresh({ scope: 'info' });
      });
  }

  /** Waits for a conversion under way. */
  async settled() {
    while (this.converting) await this.converting;
  }

  private async pass() {
    let unreadable = 0;
    for (const { table, id, columns } of SEALED) {
      for (const [name, c, kind] of columns) {
        let after = '';
        for (;;) {
          if (this.again) return;
          const on = contentSealed();
          const rows = await this.ctx.db
            .select({ id: sql<string>`${id}`, raw: sql<string>`${c}::text` })
            .from(table)
            .where(and(gt(id, after), staleWhere(kind, c, on)))
            .orderBy(asc(id))
            .limit(BATCH);
          if (!rows.length) break;
          for (const r of rows) {
            const value = openStored(kind, r.raw);
            if (value === undefined) {
              unreadable++;
              continue;
            }
            // Written back only if it is still what was read: an edit since then stands.
            await this.ctx.db
              .update(table)
              .set({ [name]: value })
              .where(and(eq(id, r.id), sql`${c}::text = ${r.raw}`));
          }
          after = rows.at(-1)!.id;
        }
      }
    }
    this.unreadable = unreadable;
  }
}
