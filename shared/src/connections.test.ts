import { describe, expect, it } from 'vitest';
import {
  CATALOG_CATEGORIES,
  CATALOG_GROUPS,
  botToolArgs,
  catalogEntry,
  formHeaders,
  serviceText,
} from './connections';

describe('yeni bağlantı formunun başlıkları', () => {
  it('eklenenlere yazılı ama eklenmemiş başlığı da katar; aynı ad büyük-küçük harf farkıyla bir kez gider', () => {
    const added = [
      { name: 'X-Api-Key', value: 'eski' },
      { name: 'X-Team', value: 'ekip' },
    ];
    expect(formHeaders(added, { name: ' x-api-key ', value: 'yeni' })).toEqual([
      { name: 'x-api-key', value: 'yeni' },
      { name: 'X-Team', value: 'ekip' },
    ]);
  });

  it('adı ya da değeri boş olanı göndermez', () => {
    expect(formHeaders([], { name: 'X-Api-Key', value: '' })).toEqual([]);
    expect(formHeaders([], { name: '  ', value: 'deger' })).toEqual([]);
  });
});

describe('botun bağlantı aracı çağrısı', () => {
  const github = catalogEntry('github')!;

  it("GitHub'da PR ve issue açan araçlar formda beklemeden çalışsın diye gönderilmiş işaretini taşır", () => {
    for (const tool of ['create_pull_request', 'update_pull_request', 'issue_write']) {
      expect(botToolArgs(github, tool, { title: 'x' })).toEqual({ title: 'x', _ui_submitted: true });
    }
  });

  it('başka araca ve başka servise dokunmaz', () => {
    expect(botToolArgs(github, 'list_pull_requests', { a: 1 })).toEqual({ a: 1 });
    expect(botToolArgs({ url: 'https://evil.example/mcp' }, 'create_pull_request', { a: 1 })).toEqual({
      a: 1,
    });
  });
});

describe('bağlantı cevabındaki HTML kaçışları', () => {
  const posts = {
    content: [{ type: 'text', text: '{"text":"-&gt; Sayfalar &amp; tablolar, &quot;a&quot;"}' }],
    structuredContent: { data: [{ text: 'a &lt; b, &amp;gt; yazıldı' }], meta: { result_count: 2 } },
  };

  it("X'in gönderi metnindeki &gt;, &lt; ve &amp; yazılan karakterlere döner; JSON metni bozulmaz", () => {
    const r = serviceText({ url: 'https://api.x.com/mcp/' }, posts);
    expect(r.content[0]!.text).toBe('{"text":"-> Sayfalar & tablolar, &quot;a&quot;"}');
    expect(JSON.parse(r.content[0]!.text)).toEqual({ text: '-> Sayfalar & tablolar, &quot;a&quot;' });
    expect(r.structuredContent).toEqual({
      data: [{ text: 'a < b, &gt; yazıldı' }],
      meta: { result_count: 2 },
    });
  });

  it('başka servisin cevabına dokunmaz', () => {
    expect(serviceText(catalogEntry('github')!, posts)).toBe(posts);
  });
});

describe('uygulama kataloğunun sekmeleri', () => {
  it('her kategori tam bir sekmede yer alır, böylece hiçbir uygulama sekmelerde kaybolmaz', () => {
    const grouped = Object.values(CATALOG_GROUPS).flat();
    expect([...grouped].sort()).toEqual([...CATALOG_CATEGORIES].sort());
  });
});
