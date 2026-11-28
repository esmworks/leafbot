/** Words only the phone app's dialogs screens use; the rest come from the web app's catalog. */
export const tr = {
  'dialogs.discard': 'Değişiklikleri sil',
  'dialogs.botNotFound': 'Bot bulunamadı.',
  'dialogs.routineNotFound': 'Rutin bulunamadı.',
  'dialogs.routineBotRequired': 'Bir bot seç',
  'dialogs.routineOlderServer':
    'Sunucu bu sürümden eski: rutinin kaç haftada bir çalışacağı ya da son günü kaydedilmedi. Sunucu güncellenince yeniden kaydet.',
  'dialogs.routineEnabled': 'Açık',
  'dialogs.routineEnabledHint': 'Kapalıyken zamanı gelse de çalışmaz.',
  'dialogs.routineDeleteConfirm': 'Bu rutin silinsin mi?',
  'dialogs.routineNoRuns': 'Henüz çalışmadı.',
  'dialogs.timeHint': '24 saat, örn. 09:30',
  'dialogs.dateHint': 'Yıl-ay-gün, örn. 2026-01-31',
  'routine.setElsewhere':
    'Bu rutinin telefonda değiştirilemeyen kısımları da var: {parts}. Onlar bilgisayardaki uygulamadan değiştirilir; burada kaydetmek onları olduğu gibi bırakır.',
};

export const en: Record<keyof typeof tr, string> = {
  'dialogs.discard': 'Discard changes',
  'dialogs.botNotFound': 'Bot not found.',
  'dialogs.routineNotFound': 'Routine not found.',
  'dialogs.routineBotRequired': 'Choose a bot',
  'dialogs.routineOlderServer':
    'The server is older than this app: how many weeks apart the routine runs, or its last day, was not saved. Save it again once the server is updated.',
  'dialogs.routineEnabled': 'On',
  'dialogs.routineEnabledHint': 'While off, it does not run when its time comes.',
  'dialogs.routineDeleteConfirm': 'Delete this routine?',
  'dialogs.routineNoRuns': 'It has not run yet.',
  'dialogs.timeHint': '24-hour, e.g. 09:30',
  'dialogs.dateHint': 'Year-month-day, e.g. 2026-01-31',
  'routine.setElsewhere':
    'This routine also has parts the phone cannot change: {parts}. Change them in the app on the computer; saving here leaves them as they are.',
};
