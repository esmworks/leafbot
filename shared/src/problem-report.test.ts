import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { problemReport, REPORT_FIELDS, REPORT_LIMITS, REPORT_URL_MAX } from './problem-report';

const params = (url: string) => new URL(url).searchParams;

describe('problem report link', () => {
  it('fills only fields the issue form has', () => {
    const form = readFileSync(
      new URL('../../.github/ISSUE_TEMPLATE/bug_report.yml', import.meta.url),
      'utf8',
    );
    const ids = [...form.matchAll(/^\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    expect([...REPORT_FIELDS].sort()).toEqual([...ids].sort());
  });

  it("opens the form with the report's fields and leaves out the empty ones", () => {
    const { url, report } = problemReport({
      title: 'Card button does nothing',
      description: 'Pressing Save on a card does nothing.',
      reproduction: '  ',
      version: '0.9.1',
    });
    expect(url.startsWith('https://github.com/esmworks/leafbot/issues/new?')).toBe(true);
    const q = params(url);
    expect(q.get('template')).toBe('bug_report.yml');
    expect(q.get('title')).toBe('Card button does nothing');
    expect(q.get('description')).toBe('Pressing Save on a card does nothing.');
    expect(q.get('version')).toBe('0.9.1');
    expect(q.has('reproduction')).toBe(false);
    expect(report).toEqual({
      title: 'Card button does nothing',
      description: 'Pressing Save on a card does nothing.',
      version: '0.9.1',
    });
  });

  it('keeps a GitHub name in the text from notifying anyone', () => {
    const { report, url } = problemReport({
      title: 'x',
      description: 'Ask @octocat about it, or mail a@b.c',
    });
    expect(report.description).toBe('Ask @\u200boctocat about it, or mail a@\u200bb.c');
    expect(params(url).get('description')).toBe(report.description);
  });

  it('cuts a long field to its limit', () => {
    const { report } = problemReport({ title: 't'.repeat(500) });
    expect(Array.from(report.title!)).toHaveLength(REPORT_LIMITS.title);
    expect(report.title!.endsWith('…')).toBe(true);
  });

  it('keeps the link short enough to open, cutting the errors before the description, and shows what it sends', () => {
    // Letters outside ASCII take up to twelve characters each once encoded.
    const { report, url } = problemReport({
      title: 'Görsel üretimi düştü',
      description: 'ğ'.repeat(REPORT_LIMITS.description),
      reproduction: 'ş'.repeat(REPORT_LIMITS.reproduction),
      errors: 'ı'.repeat(REPORT_LIMITS.errors),
      version: '0.9.1',
    });
    expect(url.length).toBeLessThanOrEqual(REPORT_URL_MAX);
    expect(report.errors).toBeUndefined();
    expect(report.version).toBe('0.9.1');
    expect(report.title).toBe('Görsel üretimi düştü');
    const q = params(url);
    for (const field of REPORT_FIELDS) expect(q.get(field) ?? undefined).toBe(report[field]);
  });
});
