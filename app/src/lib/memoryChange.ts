import type { Bot, MemoryChange, Translate } from '@leafbot/shared';
// The catalog's keys alone, by a relative path, so the phone app can use these too.
import type { MessageKey } from '../i18n/tr';

type T = Translate<MessageKey>;

/** What a waiting change does, in one line: the note, or the note before and after. */
export function changeLabel(c: MemoryChange): string {
  const text = c.action === 'update' && c.before ? `${c.before} → ${c.content}` : c.content;
  return c.site ? `${c.site} · ${text}` : text;
}

/** Where a waiting change came from and whose note it is. */
export function changeHint(c: MemoryChange, bots: readonly Pick<Bot, 'id' | 'name'>[], t: T): string {
  const name = (id: string | null) => bots.find((b) => b.id === id)?.name ?? t('common.bot');
  const whose =
    c.scope === 'user'
      ? t('memory.staleShared')
      : c.scope === 'room'
        ? t('memory.scopeRoom')
        : c.scope === 'common'
          ? t('memory.scopeCommon')
          : name(c.botId);
  const origin = c.origin.name
    ? t(`memory.origin.${c.origin.kind}`, { name: c.origin.name })
    : t('memory.origin.unknown');
  return `${t(`memory.change.${c.action}`)} · ${whose} · ${name(c.proposedBy)}, ${origin}`;
}
