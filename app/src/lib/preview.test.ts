import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileFamily, htmlPreviewDocument, previewKind, readTextStart } from './preview';

afterEach(() => vi.unstubAllGlobals());

describe('file preview', () => {
  it('knows which files it can show', () => {
    expect(previewKind('a.PNG')).toBe('image');
    expect(previewKind('rapor.pdf')).toBe('pdf');
    expect(previewKind('notlar.md')).toBe('markdown');
    expect(previewKind('tablo.csv')).toBe('table');
    expect(previewKind('veri.TSV')).toBe('table');
    expect(previewKind('Dockerfile')).toBe('text');
    // Its source is shown, never the page it would draw.
    expect(previewKind('sayfa.html')).toBe('html');
    // A picture, served with no scripts.
    expect(previewKind('logo.svg')).toBe('image');
    // An e-mail file is shown as its raw text: headers, then the body.
    expect(previewKind('fatura.eml')).toBe('text');
    expect(previewKind('kayit.MP3')).toBe('audio');
    expect(previewKind('klip.webm')).toBe('video');
    expect(previewKind('tablo.xlsx')).toBe('workbook');
    expect(previewKind('makrolu.XLSM')).toBe('workbook');
    // The older binary format is not read.
    for (const name of ['eski.xls', 'sunum.pptx', 'arsiv.zip', 'adsiz']) expect(previewKind(name)).toBeNull();
  });

  it('names the family a file belongs to, for its card', () => {
    expect(fileFamily('rapor.PDF')).toBe('pdf');
    expect(fileFamily('workflow.md')).toBe('document');
    expect(fileFamily('teklif.docx')).toBe('document');
    expect(fileFamily('ozet.html')).toBe('web');
    expect(fileFamily('satislar.xlsx')).toBe('sheet');
    expect(fileFamily('veri.csv')).toBe('sheet');
    expect(fileFamily('sunum.pptx')).toBe('slides');
    expect(fileFamily('dosyalar.tar.gz')).toBe('archive');
    expect(fileFamily('logo.svg')).toBe('image');
    expect(fileFamily('ayar.json')).toBe('code');
    expect(fileFamily('script.py')).toBe('code');
    expect(fileFamily('kayit.m4a')).toBe('audio');
    expect(fileFamily('klip.mov')).toBe('video');
    expect(fileFamily('Dockerfile')).toBe('other');
    expect(fileFamily('cizim.dwg')).toBe('other');
  });

  it('reads only the start of a large file', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('abcdef'));
        c.enqueue(new TextEncoder().encode('ghijkl'));
        c.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body)),
    );
    expect(await readTextStart('/x', 8)).toEqual({ text: 'abcdefgh', cut: true });
  });

  it('reads a small file whole, accented letters included', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Çalışma özeti')),
    );
    expect(await readTextStart('/x')).toEqual({ text: 'Çalışma özeti', cut: false });
  });
});

describe('HTML önizlemesi', () => {
  it('sayfayı hiçbir şey yüklemeyen bir politikayla sarar', () => {
    const doc = htmlPreviewDocument('<p>merhaba</p>');
    expect(doc.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(doc).toContain("default-src 'none'");
    expect(doc).not.toContain('script-src');
    expect(doc.endsWith('<p>merhaba</p>')).toBe(true);
  });
});
