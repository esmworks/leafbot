/** Lower case without accents, the dotless ı as i: "Sınır" and "sinir" read the same. */
function fold(s: string): string {
  return s.toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** Whether every word typed is in a section's name or keywords, ignoring case and accents. */
export function settingsMatch(query: string, haystack: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const text = fold(haystack);
  return words.every((w) => text.includes(w));
}

/**
 * What a search in the settings finds in the apps page: the page itself by its keywords, or
 * an app by name (the catalog's and the person's own connections). `catalogId` is the catalog app
 * the typed text names, so the window can open on it; null when it only matched a keyword.
 */
export function appsHit(
  query: string,
  keywords: string,
  catalog: readonly { id: string; name: string }[],
  connectionNames: readonly string[],
): { catalogId: string | null; name: string | null } | null {
  const q = fold(query).trim();
  if (!q) return null;
  // Three letters at least, or "a" would name whichever app comes first.
  const named = q.length >= 3 ? catalog.find((e) => fold(e.name).includes(q)) : undefined;
  if (named) return { catalogId: named.id, name: named.name };
  const own = q.length >= 3 ? connectionNames.find((n) => fold(n).includes(q)) : undefined;
  if (own) return { catalogId: null, name: own };
  return settingsMatch(query, keywords) ? { catalogId: null, name: null } : null;
}
