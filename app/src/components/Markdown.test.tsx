import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  cellNumber,
  compareCells,
  hardBreaks,
  looksLikeFile,
  repairTables,
  Markdown,
  mathDelimiters,
  mayHaveMath,
  snippetName,
  webLink,
} from './Markdown';
import { textOf } from './Mermaid';
import { FileLinks } from '@/lib/fileLink';

// Counts how often the formula typesetter is brought in; the factory runs on its first import.
const loads = vi.hoisted(() => ({ katex: 0 }));
vi.mock('rehype-katex', async (original) => {
  loads.katex++;
  return await original();
});

describe('Markdown', () => {
  it('leaves a table inside a longer code fence alone', () => {
    const text = ['````md', '```', 'a | b', 'c | d', '```', '````'].join('\n');
    expect(repairTables(text)).toBe(text);
  });

  it('reads a typeset minus as a minus', () => {
    expect(cellNumber('\u22125')).toBe(-5);
    expect(cellNumber('\u20ba\u22121.250,50')).toBe(-1250.5);
  });

  it('strikes text only between double tildes', () => {
    const html = renderToStaticMarkup(<Markdown text="~5 ile ~10 dakika arası, ~~eski plan~~" />);
    expect(html).toContain('~5 ile ~10 dakika');
    expect(html).toContain('<del>eski plan</del>');
  });

  it('does not load an image from another address; it offers it as a link', () => {
    const html = renderToStaticMarkup(
      <Markdown text="Bak: ![grafik](https://evil.example/p.gif?d=gizli) ve ![](https://cdn.example/a.png)" />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://evil.example/p.gif?d=gizli"');
    expect(html).toContain('>grafik</a>');
    expect(html).toContain('>cdn.example</a>');
  });

  it('shows only the description of an image it cannot link to', () => {
    const html = renderToStaticMarkup(
      <Markdown text="![resim](data:image/gif;base64,R0lGOD) ![js](javascript:alert(1)) ![yol](/api/x)" />,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('resim');
    expect(html).toContain('yol');
  });

  it('links only web addresses', () => {
    expect(webLink('https://a.example/x')?.hostname).toBe('a.example');
    expect(webLink('http://a.example')).not.toBeNull();
    for (const bad of [
      undefined,
      '',
      '/api/x',
      'data:image/png;base64,AA',
      'javascript:alert(1)',
      'file:///etc',
    ]) {
      expect(webLink(bad)).toBeNull();
    }
  });

  it('kişinin satırlarını korur; kod bloğunun içine dokunmaz', () => {
    expect(hardBreaks('bir\niki\n\n- a\n- b')).toBe('bir\\\niki\n\n- a\n- b');
    expect(hardBreaks('Liste:\n1. a')).toBe('Liste:\n1. a');
    expect(hardBreaks('```\nx\ny\n```\nson')).toBe('```\nx\ny\n```\nson');
  });

  it('formül olmayan metinde matematik kodunu yüklemez', async () => {
    const { container } = render(<Markdown text={'Toplam $5 ve $10; **kalın** metin.'} />);
    await new Promise((r) => setTimeout(r, 50));
    expect(loads.katex).toBe(0);
    expect(container.textContent).toContain('Toplam $5 ve $10');
    expect(mayHaveMath('düz metin')).toBe(false);
    expect(mayHaveMath('Alan $$x$$')).toBe(true);
    expect(mayHaveMath('```math\nx\n```')).toBe(true);
  });

  it('formülü yüklendikten sonra dizer; tek dolar işaretini fiyat olarak bırakır', async () => {
    const { container } = render(
      <Markdown text={'Toplam $5 ve $10. Alan $$\\pi r^2$$ olur.\n\n```math\nE = mc^2\n```'} />,
    );
    await waitFor(() => expect(container.querySelectorAll('.katex')).toHaveLength(2));
    expect(loads.katex).toBe(1);
    expect(container.textContent).toContain('Toplam $5 ve $10.');
    expect(mathDelimiters('a \\(x+1\\) b')).toBe('a $$x+1$$ b');
    expect(mathDelimiters('\\[y\\]')).toBe('\n$$\ny\n$$\n');
    expect(mathDelimiters('`\\(kod\\)`')).toBe('`\\(kod\\)`');
  });
});

describe('kod bloğu dosya adı', () => {
  it('dile göre uzantı verir', () => {
    expect(snippetName('Python')).toBe('snippet.py');
    expect(snippetName('ts')).toBe('snippet.ts');
    expect(snippetName('dockerfile')).toBe('Dockerfile');
    expect(snippetName('brainfuck')).toBe('snippet.txt');
    expect(snippetName(null)).toBe('snippet.txt');
  });
});

describe('Mermaid', () => {
  it('çizilene kadar kaynağı kod olarak gösterir', () => {
    const html = renderToStaticMarkup(<Markdown text={'```mermaid\ngraph TD\n  A --> B\n```'} />);
    expect(html).toContain('graph TD');
    expect(html).not.toContain('data-language');
  });
  it('kod öğesinin metnini toplar', () => {
    expect(textOf(<code>{['graph ', <span key="x">TD</span>]}</code>)).toBe('graph TD');
  });
});

describe('tablo sıralama', () => {
  it('hücreyi sayı olarak okur', () => {
    expect(cellNumber('1,234.5')).toBe(1234.5);
    expect(cellNumber('1.234,5')).toBe(1234.5);
    expect(cellNumber('$40')).toBe(40);
    expect(cellNumber('%12')).toBe(12);
    expect(cellNumber('12%')).toBe(12);
    expect(cellNumber('-3')).toBe(-3);
    expect(cellNumber('abc')).toBeNull();
    expect(cellNumber('1-2')).toBeNull();
  });
  it('sayıları sayı, sözcükleri dile göre karşılaştırır', () => {
    expect(['10', '9', '100'].sort((a, b) => compareCells(a, b, 'tr'))).toEqual(['9', '10', '100']);
    expect(['Zeynep', 'çınar', 'Ali'].sort((a, b) => compareCells(a, b, 'tr'))).toEqual([
      'Ali',
      'çınar',
      'Zeynep',
    ]);
  });
});

describe('düz metindeki dosya adı', () => {
  it('belge, veri ve görsel adlarını tanır; komut ve adresleri tanımaz', () => {
    for (const ok of [
      'rapor.pdf',
      'out/data.csv',
      '/data/workspaces/bots/b/files/özet.md',
      'Bütçe 2026.xlsx'.replace(' ', '_'),
    ])
      expect(looksLikeFile(ok), ok).toBe(true);
    for (const no of ['npm install', 'https://ornek.com/a.pdf', 'v1.2', 'config', '.env', 'a b.pdf'])
      expect(looksLikeFile(no), no).toBe(false);
  });
});

describe('tablo onarımı', () => {
  it('başlığın altına eksik ya da kısa ayraç satırını koyar', () => {
    expect(repairTables('| Ad | Tutar |\n| Ali | 9 |')).toBe('| Ad | Tutar |\n| --- | --- |\n| Ali | 9 |');
    expect(repairTables('| A | B | C |\n|---|\n| 1 | 2 | 3 |')).toBe(
      '| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |',
    );
  });
  it('paragrafa yapışık tabloyu ayırır, doğru tabloya ve koda dokunmaz', () => {
    expect(repairTables('Sonuçlar:\n| A | B |\n|---|---|\n| 1 | 2 |')).toBe(
      'Sonuçlar:\n\n| A | B |\n|---|---|\n| 1 | 2 |',
    );
    const ok = '| A | B |\n| :-- | --: |\n| 1 | 2 |';
    expect(repairTables(ok)).toBe(ok);
    const code = '```\n| a | b |\n| c | d |\n```';
    expect(repairTables(code)).toBe(code);
  });
  it('onarılan tablo tablo olarak çizilir', () => {
    expect(renderToStaticMarkup(<Markdown text={'| Ad | Tutar |\n| Ali | 9 |'} />)).toContain('<table');
  });
});

describe('leftover bold', () => {
  it('bolds a quoted word that a Turkish suffix follows', () => {
    const html = renderToStaticMarkup(
      <Markdown text={'Sonra **"Yenile"**ye bas, **@esmworksdev**\'e tıkla.'} />,
    );
    expect(html).toContain('<strong>&quot;Yenile&quot;</strong>ye bas');
    expect(html).toContain('<strong>@esmworksdev</strong>&#x27;e');
    expect(html).not.toContain('**');
  });

  it('keeps asterisks written escaped and those inside code', () => {
    const html = renderToStaticMarkup(<Markdown text={'\\*\\*"a"\\*\\*b ve `**"c"**d`'} />);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('**&quot;a&quot;**b');
    expect(html).toContain('<code');
  });

  it('draws a task list item as one block with its checkbox and no bullet class', () => {
    const html = renderToStaticMarkup(<Markdown text={'- [x] done\n- [ ] to do'} />);
    expect(html).toContain('contains-task-list');
    expect(html).toContain('task-list-item');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('checked');
  });

  it('plays an audio or video file a reply names in place, and keeps the link', () => {
    const html = renderToStaticMarkup(
      <FileLinks.Provider value={{ botId: 'b1', base: 'threads/t1' }}>
        <Markdown text={'Listen: [voice](voice.mp3) and `clip.webm`, report: [r](r.pdf)'} />
      </FileLinks.Provider>,
    );
    expect(html).toContain('<audio');
    expect(html).toContain('<video');
    expect(html).toContain('/api/bots/b1/library/file');
    expect(html.match(/<audio/g)).toHaveLength(1);
    expect(html).toContain('href="voice.mp3"');
  });

  it('shows no player for media outside the bot folders or without a file context', () => {
    // A web link asks the server what the page is, which needs the app's query client.
    const files = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <FileLinks.Provider value={{ botId: 'b1', base: 'threads/t1' }}>
          <Markdown text="[x](https://example.com/a.mp3)" />
        </FileLinks.Provider>
      </QueryClientProvider>,
    );
    expect(files).not.toContain('<audio');
    expect(files).toContain('target="_blank"');
    expect(renderToStaticMarkup(<Markdown text="[x](a.mp3)" />)).not.toContain('<audio');
  });
});
