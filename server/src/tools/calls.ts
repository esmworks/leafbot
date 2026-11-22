import type { Bot } from '@leafbot/shared';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { CallService, CallSummary } from '../services/calls';
import { HttpError } from '../util';
import type { Define } from './index';

const summaryText = (s: CallSummary, t: T) =>
  [
    t('call.summary', { file: s.file, count: s.lines, minutes: s.minutes }),
    ...(s.state
      ? [
          t('call.voices', { count: s.state.tracks }),
          ...(s.state.audio === 'suspended' ? [t('call.suspended')] : []),
        ]
      : []),
    ...(s.missed ? [t('call.missed', { count: s.missed })] : []),
    ...(s.cut ? [t('call.cut', { file: s.file })] : []),
    '',
    s.text || t('call.nothingHeard'),
  ].join('\n');

/**
 * Listening to a call the bot takes part in through its browser (a Jitsi, Meet or Teams page it
 * opened and joins with its usual browser steps). Starting asks the person on a card every time,
 * since the other people's voices go to the speech-to-text service; checking and stopping do not.
 */
export function callTools(opts: {
  def: Define;
  t: T;
  calls: CallService;
  bot: Bot;
  threadId: string;
  person: string;
}): AppTool[] {
  const { def, t, calls, bot, threadId, person } = opts;
  return [
    def('call_listen', {}, async () => {
      try {
        const { file } = await calls.start({ bot, threadId, userId: person });
        return t('call.listening', { file });
      } catch (err) {
        if (err instanceof HttpError) return t(err.key, err.params);
        throw err;
      }
    }),
    def(
      'call_status',
      {},
      async () => {
        const s = await calls.status(bot.id);
        return s ? summaryText(s, t) : t('call.notListening');
      },
      'read',
    ),
    def(
      'call_stop',
      {},
      async () => {
        const s = await calls.stop(bot.id, 'bot');
        return s ? summaryText(s, t) : t('call.notListening');
      },
      'internal',
    ),
  ];
}
