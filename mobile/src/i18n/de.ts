import type { OwnKey } from './tr';

/** German for the phone app's own wording; the rest comes from the web app's German. */
export const de: Partial<Record<OwnKey, string>> = {
  'chat.attachPhoto': 'Foto auswählen',
  'chat.attachCamera': 'Foto aufnehmen',
  'chat.attachFile': 'Datei auswählen',
  'chat.cameraDenied':
    'Der Kamerazugriff wurde nicht erlaubt. Du kannst ihn in den Einstellungen einschalten.',
  'panel.sched.hourly': 'Jede Stunde um :{minute}',
  'panel.sched.daily': 'Jeden Tag um {time}',
  'panel.sched.weekdays': 'Werktags um {time}',
  'panel.sched.weekly': '{days} um {time}',
  'panel.sched.monthly': 'Monatlich am {day}. um {time}',
  'panel.sched.once': 'Einmalig am {date} um {time}',
  'panel.sched.hours': 'Alle {count} Stunden',
  'panel.sched.minutes': 'Alle {count} Minuten',
  'panel.sched.between': 'zwischen {from} und {to}',
  'panel.sched.cron': 'Cron: {expr}',
  'panel.shareFailed': 'Die Datei konnte nicht heruntergeladen werden',
  'panel.loadFailed': 'Der Bot konnte nicht geladen werden',
  'panel.filesFailed': 'Die Dateien konnten nicht geladen werden',
  'preview.more': 'Weitere Aktionen',
  'computer.desktopNoScreen':
    'Der Live-Bildschirm des Computers des Bots wird in der Desktop-App gezeigt, nicht auf dem Handy. Hier siehst du seinen Zustand und kannst ihn wecken.',
  'computer.unavailable': 'Dieser Server hat keinen Browser und keinen Computer für den Bot.',
  'computer.windowHint': 'In einem eigenen Fenster auf deinem Computer öffnen; der Bot wartet.',
  'dialogs.discard': 'Änderungen verwerfen',
  'dialogs.botNotFound': 'Bot nicht gefunden.',
  'dialogs.routineNotFound': 'Routine nicht gefunden.',
  'dialogs.routineBotRequired': 'Bot auswählen',
  'dialogs.routineEnabled': 'An',
  'dialogs.routineEnabledHint': 'Solange sie aus ist, läuft sie nicht, wenn ihre Zeit kommt.',
  'dialogs.routineDeleteConfirm': 'Diese Routine löschen?',
  'dialogs.routineNoRuns': 'Sie ist noch nicht gelaufen.',
  'dialogs.timeHint': '24-Stunden-Format, z. B. 09:30',
  'dialogs.dateHint': 'Jahr-Monat-Tag, z. B. 2026-01-31',
  'settings.languageHint':
    'Der Prompt der Bots und die Systemnachrichten in Chats nutzen diese Sprache. Die App selbst folgt der Sprache des Handys.',
  'about.name': 'Leaf Bot',
  'about.copyright': 'Copyright © 2026 esmworks (Erhan Erbaş)',
  'provider.modelMore': '{count} weitere Modelle; tippe zum Suchen',
  'claude.signInPhoneHint':
    'Meldet dich mit deinem Claude-Konto an: Öffne hier die Anmeldeseite und füge danach den Code ein, den sie zeigt. Erfordert einen Pro-, Max-, Team- oder Enterprise-Plan; nichts zu installieren.',
  'claude.signInPhoneOpened':
    'Öffne die Anmeldeseite und melde dich mit deinem Claude-Konto an. Die Seite zeigt danach einen Code, den du hier einfügst.',
  'push.hint': 'Wird auf diesem Handy angezeigt, während die App geschlossen ist.',
  'push.noKey':
    'Der Server hat keinen Apple-Schlüssel und kann daher keine Benachrichtigungen senden. Füge unter Verbindung einen hinzu.',
  'push.allow': 'Benachrichtigungen erlauben',
  'push.blocked': 'Benachrichtigungen sind aus',
  'push.blockedHint': 'Erlaube Benachrichtigungen für Leaf Bot in den iPhone-Einstellungen.',
  'push.testSent': 'Gesendet; sie sollte in ein paar Sekunden ankommen.',
  'phone.title': 'Dieses Handy',
  'phone.hint':
    'Bots lesen, was du einschaltest, nur bei Arbeit, die deine eigene Nachricht gestartet hat, und fragen dich beim ersten Mal, solange die App geöffnet und verbunden ist. Auf dem Handy wird nichts geändert.',
  'phone.calendar': 'Bots dürfen meinen Kalender lesen',
  'phone.contacts': 'Bots dürfen meine Kontakte durchsuchen',
  'phone.location': 'Bots dürfen meinen Standort sehen',
  'phone.denied':
    'Das Handy hat es nicht erlaubt; du kannst es in den Einstellungen für Leaf Bot einschalten.',
  'phone.settings': 'Berechtigungseinstellungen des Handys',
  'apps.loadFailed': 'Die Apps konnten nicht geladen werden',
  'apps.catalogUnknown': 'Diese App steht nicht in der Liste.',
  'common.retry': 'Erneut versuchen',
  'common.ok': 'OK',
  'bots.logout': 'Abmelden',
  'bots.loadFailed': 'Die Bots konnten nicht geladen werden',
  'chat.back': 'Zurück',
  'chat.loadFailed': 'Der Chat konnte nicht geladen werden',
  'chat.sendFailed': 'Die Nachricht konnte nicht gesendet werden',
  'instructionsDoc.nothingWaits': 'Im Anweisungsdokument wartet keine Änderung.',
  'tables.phoneHint':
    'Einträge, die der Bot führt. Tippe auf eine Zelle, um sie zu korrigieren; der Bot liest dieselbe Tabelle.',
  'routine.setElsewhere':
    'Diese Routine hat auch Teile, die das Handy nicht ändern kann: {parts}. Ändere sie in der App auf dem Computer; Speichern hier lässt sie, wie sie sind.',
};
