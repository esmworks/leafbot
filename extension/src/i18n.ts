import { createTranslator, pickLocale, type Catalog, type Params } from '@leafbot/shared/i18n';

/** Text of the side panel. Turkish and English hold every text; other languages show English. */
const tr = {
  'connect.title': 'Leaf Bot’a bağlan',
  'connect.address': 'Sunucu adresi',
  'connect.addressHint': 'Leaf Bot’u açtığın adres, örneğin http://localhost:4319',
  'connect.code': 'Eşleştirme kodu',
  'connect.codeHint':
    'Leaf Bot’ta Ayarlar → Bağlantı → Başka bir cihaz bağla’dan bir kod al. Bu Chrome’da Leaf Bot’a zaten girdiysen boş bırakabilirsin.',
  'connect.go': 'Bağlan',
  'connect.going': 'Bağlanıyor…',
  'connect.badAddress': 'Bu bir web adresi değil.',
  'connect.noPermission': 'Chrome bu adrese bağlanma izni vermedi.',
  'connect.needCode': 'Bu sunucuya girmek için bir eşleştirme kodu gerekli.',
  'connect.unreachable': 'Sunucuya ulaşılamadı: {message}',
  'connect.disconnect': 'Bağlantıyı kes',
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
  'connect.title': 'Connect to Leaf Bot',
  'connect.address': 'Server address',
  'connect.addressHint': 'The address you open Leaf Bot at, such as http://localhost:4319',
  'connect.code': 'Pairing code',
  'connect.codeHint':
    'In Leaf Bot, get a code under Settings → Connection → Connect another device. Leave it empty if you already signed in to Leaf Bot in this Chrome.',
  'connect.go': 'Connect',
  'connect.going': 'Connecting…',
  'connect.badAddress': 'This is not a web address.',
  'connect.noPermission': 'Chrome did not allow connecting to this address.',
  'connect.needCode': 'A pairing code is needed to sign in to this server.',
  'connect.unreachable': 'Could not reach the server: {message}',
  'connect.disconnect': 'Disconnect',
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
