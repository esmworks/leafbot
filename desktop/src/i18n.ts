import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createTranslator,
  isLocale,
  pickLocale,
  type Catalog,
  type Locale,
  type Params,
} from '@leafbot/shared/i18n';

/** Text of the menu bar app and its windows. */
const tr = {
  'status.starting': 'Açılıyor…',
  'status.remote': 'Uzak sunucu: {host}',
  'status.serverStarting': 'Sunucu açılıyor…',
  'status.running': 'Bu Mac: çalışıyor',
  'status.restarting': 'Sunucu yeniden başlatılıyor…',
  'status.stopped': 'Sunucu durdu',
  'status.failed': 'Sunucu açılamadı',
  'status.quitting': 'Kapatılıyor…',
  'dialog.gaveUp': 'Leaf Bot sunucusu tekrar tekrar durdu.',
  'dialog.gaveUpDetail': 'Günlükler menü çubuğundaki "Günlükleri göster" ile açılabilir.',
  'dialog.failed': 'Leaf Bot sunucusu açılamadı.',
  'dialog.quitWorking': '{count} bot şu an çalışıyor.',
  'dialog.quitWorkingDetail': 'Çıkarsan sunucu kapanır ve yarım kalan işler durur.',
  'dialog.quitAnyway': 'Yine de çık',
  'dialog.pageCrashed': 'Leaf Bot penceresi tekrar tekrar kapandı.',
  'dialog.pageCrashedDetail':
    'Yeniden yüklemeyi deneyebilir ya da uygulamadan çıkabilirsin. Ayrıntı günlüklerde.',
  'dialog.reload': 'Yeniden yükle',
  'dialog.quit': 'Çık',
  'dialog.retry': 'Tekrar dene',
  'dialog.close': 'Kapat',
  'dialog.useLocal': 'Bu bilgisayardaki sunucuyu kullan',
  'dialog.keychainLocked': '{host} sunucusunun anahtarı okunamıyor.',
  'dialog.keychainLockedDetail':
    'Anahtar, sistemin anahtar zincirinde saklı ve zincir henüz açık değil. Açtıktan sonra tekrar dene. Bu bilgisayardaki sunucuyu seçersen yalnızca bu seferlik kullanılır; uzak sunucu seçimin kalır.',
  'dialog.keepWorking': 'Çalışmaya devam etsin',
  'dialog.stopLocal': 'Yine de kapat',
  'dialog.stopLocalDetail':
    'Bu bilgisayarın sunucusu kapanır ve oradaki yarım işler durur. Öteki sunuculardaki botlar çalışmaya devam eder.',
  'dialog.removeServer': '{host} bu uygulamadan çıkarılsın mı?',
  'dialog.removeServerDetail':
    'Uygulama o sunucuya bağlanmayı bırakır ve anahtarını unutur. Sunucudaki botlar, sohbetler ve rutinler yerinde kalır.',
  'dialog.remove': 'Çıkar',
  'dialog.cancel': 'Vazgeç',
  'menu.open': "Leaf Bot'u aç",
  'menu.quick': 'Bekleyenler',
  'menu.quickKey': 'Bekleyenleri kısayolla aç',
  'menu.connectRemote': 'Uzak sunucuya bağlan…',
  'menu.thisComputer': 'Bu bilgisayar',
  'menu.mainServer': '{name} (ana sunucu)',
  'menu.runLocal': 'Bu bilgisayarın sunucusu da çalışsın',
  'menu.removeServer': 'Sunucuyu çıkar',
  'menu.openAtLogin': 'Girişte aç',
  'menu.showLogs': 'Günlükleri göster',
  'menu.quit': 'Çık',
  'menu.settings': 'Ayarlar…',
  'menu.about': 'Leaf Bot hakkında',
  'menu.hide': "Leaf Bot'u gizle",
  'menu.hideOthers': 'Diğerlerini gizle',
  'menu.unhide': 'Tümünü göster',
  'menu.edit': 'Düzen',
  'menu.view': 'Görünüm',
  'menu.window': 'Pencere',
  'menu.installUpdate': 'Güncellemeyi yükle ({version})',
  'update.readyTitle': 'Leaf Bot {version} hazır',
  'update.readyDetail':
    'Yeni sürüm indirildi. Şimdi yeniden başlatırsanız yüklenir; botlar birkaç saniye durur. Sonraya bırakırsanız Leaf Bot kapanırken yüklenir.',
  'update.restart': 'Yeniden başlat',
  'update.later': 'Sonra',
  'update.workingDetail':
    'Şimdi yeniden başlatırsan sunucu kapanır ve yarım kalan işler durur. Sonraya bırakırsan güncelleme Leaf Bot kapanırken yüklenir.',
  'menu.checkUpdates': 'Güncellemeleri denetle…',
  'update.current': 'Leaf Bot güncel.',
  'update.currentDetail': 'En yeni sürümü kullanıyorsun ({version}).',
  'update.downloading': 'Leaf Bot {version} indiriliyor.',
  'update.downloadingDetail': 'İndirme bitince yeniden başlatmak isteyip istemediğin sorulur.',
  'update.failed': 'Güncellemeler denetlenemedi.',
  'update.failedOffline': 'GitHub’a ulaşılamadı. Ağ bağlantını denetleyip tekrar dene.',
  'move.title': "Leaf Bot'u Uygulamalar klasörüne taşı",
  'move.detail':
    'Leaf Bot şu an Uygulamalar klasörünün dışından çalışıyor; macOS bu durumda uygulamanın kendini güncellemesine izin vermez. Taşırsan güncellemeler kendiliğinden yüklenir.',
  'move.move': 'Taşı',
  'move.notNow': 'Şimdi değil',
  'move.failed': 'Leaf Bot Uygulamalar klasörüne taşınamadı. Elle sürükleyebilirsin.',
  'edit.undo': 'Geri al',
  'edit.redo': 'Yinele',
  'edit.cut': 'Kes',
  'edit.copy': 'Kopyala',
  'edit.paste': 'Yapıştır',
  'edit.selectAll': 'Tümünü seç',
  'edit.copyLink': 'Bağlantıyı kopyala',
  'edit.copyImage': 'Görseli kopyala',
  'spelling.check': 'Yazım denetimi',
  'spelling.none': 'Öneri yok',
  'spelling.learn': 'Sözlüğe ekle',
  'connect.title': 'Uzak sunucuya bağlan',
  'connect.noPermission': 'İzin yok',
  'connect.noResponse': 'Sunucu yanıt vermedi ({status})',
  'error.httpsRequired': 'Uzak sunucu adresi https:// ile başlamalı',
  'error.noKeychain': 'Anahtar güvenli biçimde saklanamıyor (anahtar zinciri yok)',
  'error.startTimeout': 'Sunucu 60 saniyede açılmadı',
  'error.startExit': 'Sunucu açılamadı (çıkış {code}): {stderr}',
  'error.oldAppTitle': 'Önce {name} uygulamasını kapatın',
  'error.oldAppRunning':
    "Leaf Bot, {name} uygulamasının yeni adı. Botlarınız ve sohbetleriniz {name} açıkken taşınamıyor. {name} uygulamasını kapatıp Leaf Bot'u yeniden açın; hepsi buraya gelir.",
  'mac.offer': 'Botlar bu bilgisayarı kullanabilir',
  'mac.stop': 'Bilgisayarı kullanan botu durdur',
  'mac.inUse': 'Bot bilgisayarda',
  'mac.someBot': 'Bir bot',
  'mac.askTitle': '{host} üzerindeki {bot} bu bilgisayarı kullanmak istiyor',
  'mac.askDetail':
    'İzin verirsen bot ekranını görür, fareyi kullanır ve yazar. Ekran görüntüleri sunucuya gider. İzin 2 dakika boyunca bir şey yapılmazsa ya da en geç 15 dakika sonra biter; Leaf Bot simgesinin menüsündeki "Bilgisayarı kullanan botu durdur" ile hemen bitirebilirsin.',
  'mac.allow': 'İzin ver',
  'mac.deny': 'Reddet',
  'mac.commands': 'Botlar bu bilgisayarda komut çalıştırabilir',
  'mac.jobs': 'Çalışan komutlar: {count}',
  'mac.stopJobs': 'Çalışan komutların hepsini durdur',
  'mac.commandAskTitle':
    '{host} üzerindeki {bot}, anahtarların durduğu bir yere ({place}) dokunan bir komut çalıştırmak istiyor',
  'mac.commandAskDetail':
    'Komut:\n{command}\n\nİzin verirsen komut senin haklarınla çalışır ve çıktısı sunucuya gider.',
} satisfies Catalog;

export type DesktopKey = keyof typeof tr;

const en: Catalog<DesktopKey> = {
  'status.starting': 'Starting…',
  'status.remote': 'Remote server: {host}',
  'status.serverStarting': 'Starting the server…',
  'status.running': 'This Mac: running',
  'status.restarting': 'Restarting the server…',
  'status.stopped': 'Server stopped',
  'status.failed': 'Server could not start',
  'status.quitting': 'Quitting…',
  'dialog.gaveUp': 'The Leaf Bot server keeps stopping.',
  'dialog.gaveUpDetail': 'Open the logs with "Show logs" in the menu bar.',
  'dialog.failed': 'The Leaf Bot server could not start.',
  'dialog.quitWorking': '{count} bots are working right now.',
  'dialog.quitWorkingDetail': 'Quitting stops the server, and the work in progress stops with it.',
  'dialog.quitAnyway': 'Quit anyway',
  'dialog.pageCrashed': 'The Leaf Bot window keeps crashing.',
  'dialog.pageCrashedDetail': 'You can try reloading it or quit the app. The logs have the details.',
  'dialog.reload': 'Reload',
  'dialog.quit': 'Quit',
  'dialog.retry': 'Try again',
  'dialog.close': 'Close',
  'dialog.useLocal': 'Use the server on this computer',
  'dialog.keychainLocked': 'The key for {host} cannot be read.',
  'dialog.keychainLockedDetail':
    "The key is kept in the system keychain, which is not open yet. Open it, then try again. Choosing this computer's server uses it for this run only; your remote server stays chosen.",
  'dialog.keepWorking': 'Keep working',
  'dialog.stopLocal': 'Turn it off anyway',
  'dialog.stopLocalDetail':
    "This computer's server stops, and the work in progress there stops with it. Bots on the other servers keep working.",
  'dialog.removeServer': 'Remove {host} from this app?',
  'dialog.removeServerDetail':
    'The app stops connecting to that server and forgets its key. The bots, chats and routines on the server stay where they are.',
  'dialog.remove': 'Remove',
  'dialog.cancel': 'Cancel',
  'menu.open': 'Open Leaf Bot',
  'menu.quick': 'Waiting for you',
  'menu.quickKey': 'Open with a shortcut',
  'menu.connectRemote': 'Connect to a remote server…',
  'menu.thisComputer': 'This computer',
  'menu.mainServer': '{name} (main server)',
  'menu.runLocal': "Also run this computer's server",
  'menu.removeServer': 'Remove a server',
  'menu.openAtLogin': 'Open at login',
  'menu.showLogs': 'Show logs',
  'menu.quit': 'Quit',
  'menu.settings': 'Settings…',
  'menu.about': 'About Leaf Bot',
  'menu.hide': 'Hide Leaf Bot',
  'menu.hideOthers': 'Hide Others',
  'menu.unhide': 'Show All',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.installUpdate': 'Install update ({version})',
  'update.readyTitle': 'Leaf Bot {version} is ready',
  'update.readyDetail':
    'The new version has been downloaded. Restart now to install it; the bots stop for a few seconds. Otherwise it installs when Leaf Bot quits.',
  'update.restart': 'Restart now',
  'update.later': 'Later',
  'update.workingDetail':
    'Restarting now stops the server, and the work in progress stops with it. If you wait, the update installs when Leaf Bot quits.',
  'menu.checkUpdates': 'Check for Updates…',
  'update.current': 'Leaf Bot is up to date.',
  'update.currentDetail': 'You have the newest version ({version}).',
  'update.downloading': 'Downloading Leaf Bot {version}.',
  'update.downloadingDetail': 'When it is done, you will be asked whether to restart into it.',
  'update.failed': 'Could not check for updates.',
  'update.failedOffline': 'GitHub could not be reached. Check your network connection and try again.',
  'move.title': 'Move Leaf Bot to the Applications folder',
  'move.detail':
    'Leaf Bot is running from outside the Applications folder, and macOS does not let an app update itself from there. Once it is moved, updates install on their own.',
  'move.move': 'Move',
  'move.notNow': 'Not now',
  'move.failed': 'Leaf Bot could not be moved to the Applications folder. You can drag it there yourself.',
  'edit.undo': 'Undo',
  'edit.redo': 'Redo',
  'edit.cut': 'Cut',
  'edit.copy': 'Copy',
  'edit.paste': 'Paste',
  'edit.selectAll': 'Select all',
  'edit.copyLink': 'Copy link address',
  'edit.copyImage': 'Copy image',
  'spelling.check': 'Check spelling',
  'spelling.none': 'No suggestions',
  'spelling.learn': 'Add to dictionary',
  'connect.title': 'Connect to a remote server',
  'connect.noPermission': 'Not allowed',
  'connect.noResponse': 'The server did not respond ({status})',
  'error.httpsRequired': 'The remote server address must start with https://',
  'error.noKeychain': 'The key cannot be stored securely (no keychain)',
  'error.startTimeout': 'The server did not start within 60 seconds',
  'error.startExit': 'The server could not start (exit {code}): {stderr}',
  'error.oldAppTitle': 'Quit {name} first',
  'error.oldAppRunning':
    'Leaf Bot is the new name of {name}. Your bots and chats cannot be moved over while {name} is open. Quit {name} and open Leaf Bot again; everything comes along.',
  'mac.offer': 'Bots may use this computer',
  'mac.stop': 'Stop the bot using this computer',
  'mac.inUse': 'Bot at work here',
  'mac.someBot': 'A bot',
  'mac.askTitle': '{bot} on {host} wants to use this computer',
  'mac.askDetail':
    'If you allow it, the bot sees your screen, uses the mouse and types. Screenshots go to the server. The permission ends after 2 minutes with nothing done, or after 15 minutes at the latest; "Stop the bot using this computer" in the menu of the Leaf Bot icon ends it at once.',
  'mac.allow': 'Allow',
  'mac.deny': "Don't allow",
  'mac.commands': 'Bots may run commands on this computer',
  'mac.jobs': 'Commands running: {count}',
  'mac.stopJobs': 'Stop all running commands',
  'mac.commandAskTitle':
    '{bot} on {host} wants to run a command that touches a place where keys are kept ({place})',
  'mac.commandAskDetail':
    'Command:\n{command}\n\nIf you allow it, the command runs with your rights and its output goes to the server.',
};

const CATALOGS = { tr, en };
let current: Locale = pickLocale([]);
let translate = createTranslator(CATALOGS, current);

export function t(key: DesktopKey, params?: Params): string {
  return translate(key, params);
}

export function locale(): Locale {
  return current;
}

/** The app's last language, else the system's preferred languages. */
export function loadLocale(dir: string, systemLanguages: string[]): Locale {
  const file = join(dir, 'locale');
  let saved: string | null = null;
  try {
    if (existsSync(file)) saved = readFileSync(file, 'utf8').trim();
  } catch {
    // Unreadable: use the system's languages.
  }
  return setLocale(isLocale(saved) ? saved : pickLocale(systemLanguages));
}

export function setLocale(next: Locale): Locale {
  current = next;
  translate = createTranslator(CATALOGS, next);
  return next;
}

export function saveLocale(dir: string, next: Locale) {
  writeFileSync(join(dir, 'locale'), `${next}\n`);
}
