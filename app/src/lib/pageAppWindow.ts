/** The saved app this page is the desktop app's window for (`?app=<id>`); null for any other page. */
export function pageAppWindowOf(
  search = typeof location === 'undefined' ? '' : location.search,
): string | null {
  const id = new URLSearchParams(search).get('app');
  return id && /^[\w-]{1,64}$/.test(id) ? id : null;
}
