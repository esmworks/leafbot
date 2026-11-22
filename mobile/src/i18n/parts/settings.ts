/** Words only the phone app's settings screens use; the rest come from the web app's catalog. */
export const tr = {
  'settings.languageHint':
    'Botların istemi ve sohbete yazılan sistem mesajları bu dilde olur. Uygulamanın kendisi telefonun dilini izler.',
  'about.name': 'Leaf Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} model daha; aramak için yazın',
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
};

export const en: Record<keyof typeof tr, string> = {
  'settings.languageHint':
    "The bots' prompt and the system messages in conversations use this language. The app itself follows the phone's language.",
  'about.name': 'Leaf Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} more models; type to search',
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
};
