import { PHONE_CALENDAR_MAX_DAYS, type PhoneAnswer, type PhoneAsk, type PhoneKind } from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import { type PhoneBridge, PhoneUnreachable } from '../phone/bridge';
import type { Define } from './index';

const DAY_MS = 86_400_000;

/** What the phone said, as the bot reads it; a refusal says why in the turn's language. */
export function phoneAnswerText(answer: PhoneAnswer, t: T): string {
  if (!answer.ok) return t(`phone.${answer.reason}`);
  if (answer.kind === 'calendar')
    return answer.events.length ? JSON.stringify(answer.events, null, 2) : t('phone.noEvents');
  if (answer.kind === 'contacts')
    return answer.contacts.length ? JSON.stringify(answer.contacts, null, 2) : t('phone.noContacts');
  return JSON.stringify(answer.location, null, 2);
}

/**
 * The person's own phone, read through the phone app while it is open: their calendar, their
 * contacts and where the phone is. Only the kinds the person switched on in the app are offered.
 * Each goes through the turn's permission check, which asks once in a turn at every level (the
 * name prefix `person_phone_` marks them), and what comes back is outside text.
 */
export function personPhoneTools(opts: {
  def: Define;
  t: T;
  phones: PhoneBridge;
  person: string;
  kinds: ReadonlySet<PhoneKind>;
  now?: () => Date;
}): AppTool[] {
  const { def, t, phones, person, kinds } = opts;
  const now = opts.now ?? (() => new Date());

  const ask = async (q: PhoneAsk): Promise<ToolResult> => {
    try {
      return phoneAnswerText(await phones.ask(person, q), t);
    } catch (err) {
      if (err instanceof PhoneUnreachable) return t('phone.unreachable');
      throw err;
    }
  };

  const tools: AppTool[] = [];
  if (kinds.has('calendar'))
    tools.push(
      def(
        'person_phone_calendar',
        {
          from: z.string().datetime({ offset: true }).optional(),
          days: z.number().int().min(1).max(PHONE_CALENDAR_MAX_DAYS).default(7),
        },
        async (a) => {
          const from = a.from ? new Date(a.from) : now();
          const to = new Date(from.getTime() + a.days * DAY_MS);
          return ask({ kind: 'calendar', from: from.toISOString(), to: to.toISOString() });
        },
      ),
    );
  if (kinds.has('contacts'))
    tools.push(
      def('person_phone_contacts', { query: z.string().trim().min(1).max(100) }, async (a) =>
        ask({ kind: 'contacts', query: a.query }),
      ),
    );
  if (kinds.has('location'))
    tools.push(def('person_phone_location', {}, async () => ask({ kind: 'location' })));
  return tools;
}
