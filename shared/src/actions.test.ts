import { describe, expect, it } from 'vitest';
import { describeAction, joinPicks, questionItems, splitPicks, typedPicks } from './actions';

describe('araç isteklerinin düz dili', () => {
  it('komut, dosya ve sayfa isteklerini araç adı ve kod göstermeden anlatır', () => {
    const bash = describeAction('Bash', { command: 'rm -rf build' }, { bot: 'Katip' });
    expect(bash.want).toBe('Katip bilgisayarda bir komut çalıştırmak istiyor.');
    expect(bash.once).toBe('Katip bu seferlik bilgisayarda komut çalıştırabilir');
    expect(bash.always).toBe('Katip artık sormadan bilgisayarda komut çalıştırabilir');
    expect(bash.detail).toBe('rm -rf build');

    const write = describeAction(
      'Write',
      { file_path: '/veri/bots/a/files/rapor.md', content: 'x' },
      { bot: 'Katip' },
    );
    expect(write.want).toBe('Katip "rapor.md" dosyasını yazmak istiyor.');
    expect(write.wont).toBe('Katip "rapor.md" dosyasını yazmayacak');

    expect(describeAction('WebFetch', { url: 'https://ornek.com/a?b=1' }, { bot: 'Katip' }).want).toBe(
      'Katip ornek.com sayfasını açmak istiyor.',
    );
    expect(describeAction('mcp__leafbot__bot_create', { name: 'Posta' }, { bot: 'Kahya' }).want).toBe(
      'Kahya "Posta" adında yeni bir bot kurmak istiyor.',
    );
  });

  it('İngilizce cümleler kurar', () => {
    const opts = { bot: 'Katip', locale: 'en' as const };
    const bash = describeAction('Bash', { command: 'ls' }, opts);
    expect(bash.want).toBe('Katip wants to run a command on the computer.');
    expect(bash.once).toBe('Katip can run this command this time');
    expect(bash.always).toBe('Katip can now run commands on the computer without asking');
    expect(bash.wont).toBe("Katip won't run this command");
    expect(describeAction('Write', { file_path: '/a/rapor.md' }, opts).want).toBe(
      'Katip wants to write "rapor.md".',
    );
    expect(describeAction('mcp__leafbot__bot_send', { bot: 'Posta' }, opts).want).toBe(
      'Katip wants to send a task to "Posta".',
    );
  });

  it('bilinmeyen araçta adını göstermez', () => {
    for (const locale of ['tr', 'en'] as const) {
      const a = describeAction('mcp__baska__gizli_arac', { x: 1 }, { bot: 'Katip', locale });
      expect(JSON.stringify(a)).not.toContain('gizli_arac');
    }
    expect(describeAction('mcp__baska__gizli_arac', {}, { bot: 'Katip' }).want).toBe(
      'Katip bir araç kullanmak istiyor.',
    );
  });

  it('bağlantı aracını servisi ve adıyla anar: aynı servisin iki aracı ayrı görünür', () => {
    const opts = { bot: 'Paşa', service: 'Leafdesk' };
    const a = describeAction('mcp__leafdesk__create_database', { name: 'Kasa' }, opts);
    const b = describeAction('mcp__leafdesk__create_database_row', {}, opts);
    expect(a.want).toBe('Paşa “create_database” adlı bir Leafdesk aracı kullanmak istiyor.');
    expect(a.always).toBe('Paşa artık sormadan “create_database” adlı Leafdesk aracını kullanabilir');
    expect(a.detail).toBe('{"name":"Kasa"}');
    expect(b.want).not.toBe(a.want);
    expect(b.detail).toBeNull();
    const en = describeAction('mcp__leafdesk__create_database', {}, { ...opts, locale: 'en' });
    expect(en.want).toBe('Paşa wants to use the Leafdesk tool “create_database”.');
    expect(en.always).toBe('Paşa can now use the Leafdesk tool “create_database” without asking');
  });

  it('tarayıcı adımlarını düz dille anlatır', () => {
    const open = describeAction(
      'mcp__leafbot__browser_open',
      { url: 'https://www.sahibinden.com/ara' },
      { bot: 'Paşa' },
    );
    expect(open.want).toBe('Paşa tarayıcıda www.sahibinden.com sitesini açmak istiyor.');
    expect(open.detail).toBe('https://www.sahibinden.com/ara');
    const send = describeAction(
      'mcp__leafbot__browser_click',
      { ref: 'e4', element: 'Siparişi onayla', sends: true },
      { bot: 'Paşa', locale: 'en' },
    );
    expect(send.want).toBe('Paşa wants to send something with "Siparişi onayla" in the browser.');
    expect(send.detail).toBe('Siparişi onayla');
    const drag = describeAction(
      'mcp__leafbot__browser_drag',
      { from_ref: 'e4', to_ref: 'e9', element: 'Kartı Bitti listesine', sends: true },
      { bot: 'Paşa' },
    );
    expect(drag.want).toBe('Paşa tarayıcıda "Kartı Bitti listesine" ile bir şey göndermek istiyor.');
    const upload = describeAction(
      'mcp__leafbot__browser_upload',
      { ref: 'e2', element: 'Özgeçmiş', paths: ['belgeler/cv.pdf'] },
      { bot: 'Paşa' },
    );
    expect(upload.want).toBe('Paşa "cv.pdf" dosyasını tarayıcıdaki siteye yüklemek istiyor.');
    expect(upload.detail).toBe('belgeler/cv.pdf');
    const many = describeAction(
      'mcp__leafbot__browser_upload',
      { ref: 'e2', element: 'Fotoğraflar', paths: ['a.png', 'b.png'] },
      { bot: 'Paşa', locale: 'en' },
    );
    expect(many.want).toBe('Paşa wants to upload files to a site in the browser.');
    expect(many.wont).toContain('upload these files');
  });
});

describe('multiple-choice questions', () => {
  const card = (questions: unknown) => ({ input: { questions }, summary: 'Q', options: [] as string[] });

  it('marks a question multi only when it has options to tick and is not secret', () => {
    const { items } = questionItems(
      card([
        { question: 'a', options: ['x', 'y'], multi: true },
        { question: 'b', multi: true },
        { question: 'c', options: ['x'], multi: true, secret: true },
        { question: 'd', options: ['x'] },
      ]),
    );
    expect(items.map((q) => q.multi)).toEqual([true, false, false, false]);
  });

  it('lists every pick in one answer and reads it back', () => {
    const answer = joinPicks(['Mail', 'Calendar', 'my own words']);
    expect(answer).toBe('Mail; Calendar; my own words');
    expect(splitPicks(answer)).toEqual(['Mail', 'Calendar', 'my own words']);
  });

  it('turns option numbers typed in a chat app into the options', () => {
    const options = ['Mail', 'Calendar', 'Files'];
    expect(typedPicks(options, '1, 3')).toBe('Mail; Files');
    expect(typedPicks(options, '2 2')).toBe('Calendar');
    expect(typedPicks(options, '4')).toBe('4');
    expect(typedPicks(options, 'only the mail')).toBe('only the mail');
  });
});
