/**
 * Which webhook calls start a routine: one condition per line, all of which must hold for the
 * call's JSON body. `action=opened` (equal), `action!=closed` (not equal), `subject~=invoice`
 * (contains, ignoring case), `pull_request.draft` (present and not false, null, 0 or empty). Dots
 * go into objects, numbers into lists.
 */
export function parseFilter(
  text: string,
): { path: string[]; op: 'eq' | 'ne' | 'has' | 'contains'; value: string }[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^([^=!~]+?)\s*(!=|~=|=)\s*(.*)$/.exec(l);
      const path = (m ? m[1]! : l).trim().split('.').filter(Boolean);
      if (!m) return { path, op: 'has' as const, value: '' };
      return {
        path,
        op: m[2] === '=' ? ('eq' as const) : m[2] === '~=' ? ('contains' as const) : ('ne' as const),
        value: m[3]!.trim().replace(/^"(.*)"$/, '$1'),
      };
    });
}

/** What sits at `path` in a JSON value: dots go into objects, numbers into lists. */
export function valueAt(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const asText = (v: unknown) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Whether a call's body passes the filter; an empty filter passes everything, a non-JSON body only that. */
export function passesFilter(filter: string, body: string): boolean {
  const rules = parseFilter(filter);
  if (!rules.length) return true;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return false;
  }
  return rules.every((r) => {
    const v = valueAt(json, r.path);
    if (r.op === 'has') return v !== undefined && v !== null && v !== false && v !== 0 && v !== '';
    if (r.op === 'contains')
      return asText(v).toLocaleLowerCase('tr').includes(r.value.toLocaleLowerCase('tr'));
    return r.op === 'eq' ? asText(v) === r.value : asText(v) !== r.value;
  });
}
