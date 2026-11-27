import type { OwnKey } from './tr';
import { en as sidebar } from './parts/sidebar';
import { en as chat } from './parts/chat';
import { en as message } from './parts/message';
import { en as panel } from './parts/panel';
import { en as dialogs } from './parts/dialogs';
import { en as settings } from './parts/settings';
import { en as apps } from './parts/apps';
import { en as link } from './parts/link';

export const en: Record<OwnKey, string> = {
  ...sidebar,
  ...chat,
  ...message,
  ...panel,
  ...dialogs,
  ...settings,
  ...apps,
  ...link,
  'common.retry': 'Try again',
  'common.ok': 'OK',

  'bots.logout': 'Sign out',
  'bots.loadFailed': 'Could not load the bots',

  'chat.back': 'Back',
  'chat.loadFailed': 'Could not load the conversation',
  'chat.sendFailed': 'Could not send the message',
};
