/** Words only the phone app's settings screens use; the rest come from the web app's catalog. */
export const tr = {
  'settings.languageHint':
    'Botların istemi ve sohbete yazılan sistem mesajları bu dilde olur. Uygulamanın kendisi telefonun dilini izler.',
  'about.name': 'Leaf Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} model daha; aramak için yazın',
  'claude.signInPhoneHint':
    'Claude hesabınızla giriş yapar: giriş sayfasını buradan açın, sayfanın gösterdiği kodu buraya yapıştırın. Pro, Max, Team veya Enterprise planı gerekir; hiçbir şey kurmanız gerekmez.',
  'claude.signInPhoneOpened':
    'Giriş sayfasını açın ve Claude hesabınızla giriş yapın. Sayfa ardından buraya yapıştıracağınız bir kod gösterir.',
  'push.hint': 'Uygulama kapalıyken bu telefona gelir.',
  'push.noKey': 'Sunucuda Apple anahtarı yok, bu yüzden bildirim gönderemiyor. Bağlantı bölümünden ekleyin.',
  'push.allow': 'Bildirimlere izin ver',
  'push.blocked': 'Bildirimler kapalı',
  'push.blockedHint': "iPhone Ayarları'nda Leaf Bot için bildirimlere izin verin.",
  'push.testSent': 'Gönderildi; birkaç saniye içinde gelmeli.',
  'phone.title': 'Bu telefon',
  'phone.hint':
    'Açtıklarınızı botlar yalnız sizin mesajınızla başlayan işte ve ilk seferde size sorarak okur, uygulama açık ve bağlıyken. Telefonda hiçbir şey değiştirilmez.',
  'phone.calendar': 'Botlar takvimimi okuyabilsin',
  'phone.contacts': 'Botlar rehberimde arayabilsin',
  'phone.location': 'Botlar konumumu görebilsin',
  'phone.denied': "Telefon izin vermedi; Ayarlar'dan Leaf Bot için açabilirsiniz.",
  'phone.settings': 'Telefonun izin ayarları',
  'update.title': 'Güncellemeler',
  'update.running': 'Çalışan sürüm',
  'update.builtIn': 'Mağazadan gelen',
  'update.from': '{day} güncellemesi',
  'update.check': 'Güncellemeleri denetle',
  'update.hint': 'Yeni bir sürüm, uygulama açılırken ya da öne geldiğinde kendiliğinden iner.',
  'update.none': 'Uygulama güncel.',
  'update.ready': 'Bir güncelleme indi; uygulama yeniden başlayınca kullanılır.',
  'update.restart': 'Yeniden başlat',
  'update.restartHint': 'İnen güncelleme hemen kullanılsın.',
  'update.off': 'Bu kopya güncellemeleri yalnız mağazadan alır.',
  'update.failed': 'Güncelleme denetlenemedi: {error}',
  'liveActivity.title': 'Süren işi kilit ekranında göster',
  'liveActivity.hint':
    'Mesaj gönderdiğiniz botun ne yaptığı, uygulama kapalıyken de kilit ekranında görünür.',
  'activity.working': 'Çalışıyor',
};

export const en: Record<keyof typeof tr, string> = {
  'settings.languageHint':
    "The bots' prompt and the system messages in conversations use this language. The app itself follows the phone's language.",
  'about.name': 'Leaf Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} more models; type to search',
  'claude.signInPhoneHint':
    'Signs in with your Claude account: open the sign-in page from here, then paste back the code it shows. Needs a Pro, Max, Team or Enterprise plan; nothing to install.',
  'claude.signInPhoneOpened':
    'Open the sign-in page and sign in with your Claude account. The page then shows a code to paste here.',
  'push.hint': 'Shown on this phone while the app is closed.',
  'push.noKey': 'The server has no Apple key, so it cannot send notifications. Add one under Connection.',
  'push.allow': 'Allow notifications',
  'push.blocked': 'Notifications are off',
  'push.blockedHint': 'Allow notifications for Leaf Bot in the iPhone Settings.',
  'push.testSent': 'Sent; it should arrive in a few seconds.',
  'phone.title': 'This phone',
  'phone.hint':
    'Bots read what you turn on only in work your own message started, asking you the first time, while the app is open and connected. Nothing on the phone is changed.',
  'phone.calendar': 'Let bots read my calendar',
  'phone.contacts': 'Let bots search my contacts',
  'phone.location': 'Let bots see my location',
  'phone.denied': 'The phone did not allow it; you can turn it on for Leaf Bot in Settings.',
  'phone.settings': "The phone's permission settings",
  'update.title': 'Updates',
  'update.running': 'Running version',
  'update.builtIn': 'From the store',
  'update.from': 'Update of {day}',
  'update.check': 'Check for updates',
  'update.hint': 'A new version comes down on its own when the app opens or comes back to the front.',
  'update.none': 'The app is up to date.',
  'update.ready': 'An update came down; it is used when the app restarts.',
  'update.restart': 'Restart',
  'update.restartHint': 'Use the update that came down now.',
  'update.off': 'This copy takes updates only from the store.',
  'update.failed': 'Could not check for updates: {error}',
  'liveActivity.title': 'Show work on the Lock Screen',
  'liveActivity.hint':
    'What the bot you messaged is doing shows on the Lock Screen, even while the app is closed.',
  'activity.working': 'Working',
};
