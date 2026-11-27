import { tr as sidebar } from './parts/sidebar';
import { tr as chat } from './parts/chat';
import { tr as message } from './parts/message';
import { tr as panel } from './parts/panel';
import { tr as dialogs } from './parts/dialogs';
import { tr as settings } from './parts/settings';
import { tr as apps } from './parts/apps';
import { tr as link } from './parts/link';

/** Turkish words only the phone app uses; the rest come from the web app's catalog. */
export const tr = {
  ...sidebar,
  ...chat,
  ...message,
  ...panel,
  ...dialogs,
  ...settings,
  ...apps,
  ...link,
  'common.retry': 'Tekrar dene',
  'common.ok': 'Tamam',

  'bots.logout': 'Çıkış',
  'bots.loadFailed': 'Botlar yüklenemedi',

  'chat.back': 'Geri',
  'chat.loadFailed': 'Konuşma yüklenemedi',
  'chat.sendFailed': 'Mesaj gönderilemedi',
};

export type OwnKey = keyof typeof tr;
