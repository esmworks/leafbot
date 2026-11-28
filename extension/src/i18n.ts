import { createTranslator, pickLocale, type Catalog, type Params } from '@leafbot/shared/i18n';

/** Text of the side panel. Turkish and English hold every text; other languages show English. */
const tr = {
  'connect.title': 'Leaf Bot hesabına gir',
  'connect.code': 'Bağlantı kodu',
  'connect.codeHint':
    'Leaf Bot’ta Ayarlar → Bağlantı → Başka bir cihaz bağla’dan bir kod al. Kod iki dakika, bir kez geçer.',
  'connect.go': 'Gir',
  'connect.going': 'Bağlanıyor…',
  'connect.badCode': 'Bu kod geçmiyor ya da süresi doldu; yeni bir kod al.',
  'connect.tooMany': 'Çok fazla deneme oldu; biraz sonra yeniden dene.',
  'connect.accountUnreachable': 'Leaf Bot hesabına ulaşılamadı.',
  'connect.lost': 'Sunucuyla bağlantı koptu.',
  'connect.outdated': 'Bu sunucu eklenti için fazla eski; Leaf Bot’u güncelle.',
  'connect.failed': 'Sunucuya bağlanılamadı ({code}).',
  'connect.retry': 'Yeniden dene',
  'connect.otherServer': 'Başka sunucu',
  'connect.signOut': 'Çıkış yap',
  'connect.disconnect': 'Sunucular',
  'servers.title': 'Sunucuların',
  'servers.empty': 'Hesabında henüz sunucu yok. Leaf Bot’u bir bilgisayara kur ve hesabına bağla.',
  'bots.title': 'Botlar',
  'bots.empty': 'Henüz botun yok. Leaf Bot’ta bir bot oluştur.',
  'bots.back': 'Botlar',
  'chat.placeholder': 'Bir mesaj yaz',
  'chat.send': 'Gönder',
  'chat.stop': 'Durdur',
  'chat.working': 'Çalışıyor…',
  'chat.empty': 'Bir şey sor; paylaşma açıksa bot açık sekmelerini okuyabilir.',
  'chat.openApp': 'Leaf Bot’ta aç',
  'chat.sendFailed': 'Mesaj gönderilemedi: {message}',
  'card.allow': 'İzin ver',
  'card.deny': 'İzin verme',
  'card.inApp': 'Bu kartı Leaf Bot’ta yanıtla.',
  'share.label': 'Bu Chrome’u botlarımla paylaş',
  'share.short': 'Chrome’u paylaş',
  'share.hint':
    'Açıkken, bu panelden yazdığın mesajlarda botlar açık sekmelerinin listesini görebilir ve izin verdiğin sitelerin sayfalarını okuyabilir. Her işte önce sorarlar.',
  'share.offline': 'Sunucuyla bağlantı yok; yeniden bağlanıyor…',
  'site.title': '{bot} {site} sayfasını okumak istiyor',
  'site.hint': 'Chrome bu siteyi okuma iznini bir kez daha soracak.',
  'site.allow': 'İzin ver',
  'site.deny': 'İzin verme',
  'site.someBot': 'Bir bot',
  'error.requestFailed': 'Sunucu isteği yerine getiremedi ({status})',
  'error.noAnswer': 'Sunucu yanıt vermedi',
} as const;

export type Key = keyof typeof tr;

const en: Catalog<Key> = {
  'connect.title': 'Sign in to your Leaf Bot account',
  'connect.code': 'Connection code',
  'connect.codeHint':
    'In Leaf Bot, get a code under Settings → Connection → Connect another device. It works once, for two minutes.',
  'connect.go': 'Sign in',
  'connect.going': 'Connecting…',
  'connect.badCode': 'This code does not work or has run out; get a new one.',
  'connect.tooMany': 'Too many tries; try again in a while.',
  'connect.accountUnreachable': 'Could not reach your Leaf Bot account.',
  'connect.lost': 'The connection to the server ended.',
  'connect.outdated': 'This server is too old for the extension; update Leaf Bot.',
  'connect.failed': 'Could not connect to the server ({code}).',
  'connect.retry': 'Try again',
  'connect.otherServer': 'Another server',
  'connect.signOut': 'Sign out',
  'connect.disconnect': 'Servers',
  'servers.title': 'Your servers',
  'servers.empty':
    'Your account has no servers yet. Install Leaf Bot on a computer and link it to your account.',
  'bots.title': 'Bots',
  'bots.empty': 'You have no bots yet. Make one in Leaf Bot.',
  'bots.back': 'Bots',
  'chat.placeholder': 'Write a message',
  'chat.send': 'Send',
  'chat.stop': 'Stop',
  'chat.working': 'Working…',
  'chat.empty': 'Ask anything; with sharing on, the bot can read your open tabs.',
  'chat.openApp': 'Open in Leaf Bot',
  'chat.sendFailed': 'The message was not sent: {message}',
  'card.allow': 'Allow',
  'card.deny': 'Don’t allow',
  'card.inApp': 'Answer this card in Leaf Bot.',
  'share.label': 'Share this Chrome with my bots',
  'share.short': 'Share Chrome',
  'share.hint':
    'While it is on, in messages you write from this panel, bots can see the list of your open tabs and read pages of the sites you allow. They ask first in each piece of work.',
  'share.offline': 'No connection to the server; reconnecting…',
  'site.title': '{bot} wants to read {site}',
  'site.hint': 'Chrome will ask once more before the extension reads this site.',
  'site.allow': 'Allow',
  'site.deny': 'Don’t allow',
  'site.someBot': 'A bot',
  'error.requestFailed': 'The server could not do this ({status})',
  'error.noAnswer': 'The server did not answer',
};

const locale = pickLocale([chromeLanguage()], 'en');

function chromeLanguage(): string | null {
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    // Outside Chrome (tests): the browser's own language.
    return typeof navigator === 'undefined' ? null : navigator.language;
  }
}

const translate = createTranslator<Key>({ tr, en }, locale);

export const t = (key: Key, params?: Params) => translate(key, params);
export const uiLocale = locale;
