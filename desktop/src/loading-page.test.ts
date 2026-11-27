import { describe, expect, it } from 'vitest';
import { isLoadingPage, loadingPageHtml, loadingPageUrl } from './loading-page';

const page = {
  background: '#1b1b1b',
  text: 'Starting <the> server…',
  name: 'Leaf Bot',
  dark: true,
  frameless: true,
};

describe('loading page', () => {
  it('shows the name and the text, escaped, on the window background', () => {
    const html = loadingPageHtml(page);
    expect(html).toContain('<h1>Leaf Bot</h1>');
    expect(html).toContain('Starting &lt;the&gt; server…');
    expect(html).toContain('background:#1b1b1b');
  });

  it('drags the window only when it has no title bar', () => {
    expect(loadingPageHtml(page)).toContain('-webkit-app-region:drag');
    expect(loadingPageHtml({ ...page, frameless: false })).not.toContain('-webkit-app-region');
  });

  it('is a data URL the window can tell apart from a server page', () => {
    const url = loadingPageUrl(page);
    expect(isLoadingPage(url)).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(loadingPageHtml(page));
    expect(isLoadingPage('http://127.0.0.1:4319/')).toBe(false);
  });
});
