import type { Locale } from '@leafbot/shared';

/** How a choice that declines reads in each language: the card shows it less loudly. */
const REFUSALS: Record<Locale, string[]> = {
  tr: ['hayır', 'iptal', 'vazgeç', 'istemiyorum', 'gerek yok', 'şimdilik değil', 'reddet', 'atla'],
  en: ['no', 'cancel', 'not now', "don't", 'do not', 'skip', 'decline', 'none'],
  de: ['nein', 'abbrechen', 'nicht jetzt', 'überspringen', 'ablehnen', 'keine', 'kein'],
  ar: ['لا', 'إلغاء', 'ليس الآن', 'تخطي', 'رفض', 'لا شكرًا', 'تجاهل'],
  es: ['no', 'cancelar', 'ahora no', 'omitir', 'saltar', 'rechazar', 'ninguno', 'ninguna'],
  fr: ['non', 'annuler', 'pas maintenant', 'ignorer', 'refuser', 'aucun', 'aucune', 'plus tard'],
  hi: ['नहीं', 'रद्द करें', 'अभी नहीं', 'छोड़ें', 'मना करें', 'कोई नहीं'],
  id: ['tidak', 'batal', 'nanti saja', 'lewati', 'tolak', 'tidak ada'],
  it: ['no', 'annulla', 'non ora', 'salta', 'rifiuta', 'nessuno', 'nessuna'],
  pl: ['nie', 'anuluj', 'nie teraz', 'pomiń', 'odrzuć', 'żaden', 'brak'],
  pt: ['não', 'cancelar', 'agora não', 'pular', 'recusar', 'nenhum', 'nenhuma'],
  ru: ['нет', 'отмена', 'не сейчас', 'пропустить', 'отклонить', 'ничего'],
  uk: ['ні', 'скасувати', 'не зараз', 'пропустити', 'відхилити', 'немає'],
  vi: ['không', 'hủy', 'để sau', 'bỏ qua', 'từ chối', 'không có'],
  zh: ['不', '否', '取消', '现在不要', '跳过', '拒绝', '无'],
};

/** Whether an offered answer declines (No, Cancel, Not now), in any of the languages. */
export function isRefusal(label: string): boolean {
  // Turkish casing turns I into ı, so both casings are tried: the label may be Turkish or not.
  const variants = [label.trim().toLocaleLowerCase('tr'), label.trim().toLowerCase()].map((text) =>
    text.replace(/[.!…,;:]+$/u, ''),
  );
  return Object.values(REFUSALS).some((words) =>
    words.some((w) =>
      variants.some((text) => text === w || text.startsWith(`${w},`) || text.startsWith(`${w} `)),
    ),
  );
}
