import { describe, expect, it } from 'vitest';
import { appsHit, settingsMatch } from './settingsMatch';

describe('ayarlarda arama', () => {
  it('yazılan her sözcüğü adda ya da anahtar sözcüklerde arar', () => {
    expect(settingsMatch('', 'Genel')).toBe(true);
    expect(settingsMatch('koyu tema', 'Genel tema, koyu, açık')).toBe(true);
    expect(settingsMatch('İŞARET', 'işaret')).toBe(true);
    expect(settingsMatch('sinir', 'Kullanım sınır, bütçe')).toBe(true);
    expect(settingsMatch('webhook', 'Genel tema')).toBe(false);
  });
});

describe('search finds the apps page', () => {
  const catalog = [
    { id: 'notion', name: 'Notion' },
    { id: 'github', name: 'GitHub' },
  ];
  const keywords = 'apps, connections, mcp, bağlantılar';

  it('opens on the app a name matches, or on the window for a keyword', () => {
    expect(appsHit('notion', keywords, catalog, [])).toEqual({ catalogId: 'notion', name: 'Notion' });
    expect(appsHit('GİTHUB', keywords, catalog, [])).toEqual({ catalogId: 'github', name: 'GitHub' });
    expect(appsHit('mcp', keywords, catalog, [])).toEqual({ catalogId: null, name: null });
    expect(appsHit('bağlantı', keywords, catalog, [])).toEqual({ catalogId: null, name: null });
  });

  it('finds one of the person’s own servers by its name', () => {
    expect(appsHit('crm', keywords, catalog, ['Company CRM'])).toEqual({
      catalogId: null,
      name: 'Company CRM',
    });
  });

  it('finds nothing for an empty or unrelated search', () => {
    expect(appsHit('', keywords, catalog, [])).toBeNull();
    expect(appsHit('theme', keywords, catalog, [])).toBeNull();
    expect(appsHit('no', keywords, catalog, [])).toBeNull();
  });
});
