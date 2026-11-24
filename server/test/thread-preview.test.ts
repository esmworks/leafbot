import { describe, expect, it } from 'vitest';
import { previewOf } from '../src/services/threads';

describe('sidebar preview of a message', () => {
  it('shows the words without Markdown marks', () => {
    expect(previewOf('**Done**, see [the report](https://x.y/r)')).toBe('Done, see the report');
  });

  it('names a reply that is only a picture by its file name, not an empty row', () => {
    expect(previewOf('![](files/chart%20q3.png)')).toBe('chart q3.png');
    expect(previewOf('![](https://x.y/a/plot.png?v=2)')).toBe('plot.png');
    expect(previewOf('![](data:image/png;base64,AAAA)')).toBe('');
  });

  it('keeps the alt text and attachment names when there are some', () => {
    expect(previewOf('![Sales chart](files/c.png)')).toBe('Sales chart');
    expect(previewOf('', [{ name: 'a.pdf' }, { name: 'b.pdf' }])).toBe('a.pdf, b.pdf');
  });
});
