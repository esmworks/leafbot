import { describe, expect, it } from 'vitest';
import { botToolArgs, catalogEntry, formHeaders } from './connections';

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
