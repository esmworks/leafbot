/**
 * A bug report the person sends themselves: the app opens GitHub's issue form with the report
 * filled in, and the person reads it there and submits it. Nothing is sent from the server, so a
 * report never leaves without the person seeing every word of it.
 */

export const REPORT_REPO_URL = 'https://github.com/esmworks/leafbot';

/** The issue form in `.github/ISSUE_TEMPLATE`; its field ids are the keys of `ProblemReport`. */
export const REPORT_TEMPLATE = 'bug_report.yml';

/** The form's fields the link fills, by their ids in the template. */
export const REPORT_FIELDS = [
  'description',
  'reproduction',
  'errors',
  'version',
  'system',
  'engine',
] as const;
export type ReportField = (typeof REPORT_FIELDS)[number];

export type ProblemReport = { title?: string } & Partial<Record<ReportField, string>>;

/** Past these a field is cut, so a bot's long text cannot push the others out of the link. */
export const REPORT_LIMITS = {
  title: 200,
  description: 2_000,
  reproduction: 2_000,
  errors: 1_500,
  version: 100,
  system: 200,
  engine: 200,
} as const satisfies Record<keyof ProblemReport, number>;

/**
 * Longest link the app opens. Browsers and GitHub refuse much longer addresses, and the text is
 * percent-encoded, so a letter outside ASCII takes up to twelve characters of it.
 */
export const REPORT_URL_MAX = 7_000;

/** Cut first when the link is too long: the collected errors, then the steps, then the description. */
const CUT_ORDER = ['errors', 'reproduction', 'description', 'title'] as const;

const ELLIPSIS = '…';

/**
 * GitHub turns `@someone` in an issue into a mention and tells that account. An invisible
 * zero-width space after the sign leaves the text reading the same and tells nobody.
 */
function quietMentions(text: string): string {
  return text.replace(/@(?=[A-Za-z0-9])/g, '@\u200b');
}

/** `text` at most `max` characters, counted as the person sees them, ending with … when cut. */
function cut(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return (
    chars
      .slice(0, Math.max(0, max - 1))
      .join('')
      .trimEnd() + ELLIPSIS
  );
}

function url(r: ProblemReport): string {
  const query = new URLSearchParams({ template: REPORT_TEMPLATE });
  if (r.title) query.set('title', r.title);
  for (const field of REPORT_FIELDS) {
    const value = r[field];
    if (value) query.set(field, value);
  }
  return `${REPORT_REPO_URL}/issues/new?${query.toString()}`;
}

/**
 * The report as it will stand on GitHub, and the link that opens the form with it. Show the
 * returned report, not the input: fields may have been cut to keep the link short enough to open.
 */
export function problemReport(input: ProblemReport): { report: ProblemReport; url: string } {
  const report: ProblemReport = {};
  for (const key of Object.keys(REPORT_LIMITS) as (keyof ProblemReport)[]) {
    const value = input[key]?.trim();
    if (value) report[key] = cut(quietMentions(value), REPORT_LIMITS[key]);
  }
  let link = url(report);
  for (const key of CUT_ORDER) {
    while (link.length > REPORT_URL_MAX && report[key]) {
      const value = report[key] ?? '';
      const chars = Array.from(value).length;
      // Encoded characters per character of this field, to cut about as much as is over.
      const perChar = Math.max(1, new URLSearchParams({ v: value }).toString().length / chars);
      const keep = chars - Math.ceil((link.length - REPORT_URL_MAX) / perChar) - 1;
      if (keep < 20) delete report[key];
      else report[key] = cut(value, keep);
      link = url(report);
    }
  }
  return { report, url: link };
}
