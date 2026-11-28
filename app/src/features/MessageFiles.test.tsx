import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageFiles } from './Attachments';
import { usePreview } from './previewStore';

vi.mock('@/lib/api', () => ({
  api: {
    fileUrl: (botId: string, path: string) => `/files/${botId}/${path}`,
    zipUrl: () => '/zip',
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

afterEach(cleanup);

const files = [
  { name: 'rapor.md', size: 9000, path: 'demo/rapor.md' },
  { name: 'cizim.dwg', size: 2000, path: 'demo/cizim.dwg' },
];

describe('mesajdaki dosya kartları', () => {
  it('önizlenebilen dosya karttan açılır, yanındaki düğmeyle doğrudan iner', () => {
    const { container } = render(<MessageFiles files={files} botId="b1" align="start" />);
    const save = container.querySelector('a[href="/files/b1/demo/rapor.md"]')!;
    expect(save.getAttribute('download')).toBe('rapor.md');
    // The download is its own control, not part of the button that opens the preview.
    expect(save.closest('button')).toBeNull();

    const open = screen.getByText('rapor.md').closest('button')!;
    fireEvent.click(open);
    expect(usePreview.getState().file?.path).toBe('demo/rapor.md');
  });

  it('önizlenemeyen dosyanın kartı tümüyle indirir', () => {
    const { container } = render(<MessageFiles files={files} botId="b1" align="start" />);
    const card = screen.getByText('cizim.dwg').closest('a')!;
    expect(card.getAttribute('href')).toBe('/files/b1/demo/cizim.dwg');
    expect(card.getAttribute('download')).toBe('cizim.dwg');
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('kartın ikonu dosyanın türünü gösterir', () => {
    const { container } = render(<MessageFiles files={files} botId="b1" align="start" />);
    const families = [...container.querySelectorAll('[data-family]')].map((e) =>
      e.getAttribute('data-family'),
    );
    expect(families).toEqual(['document', 'other']);
  });

  it('video oynatıcı olarak değil ilk karesiyle durur ve tıklanınca önizlemede açılır', () => {
    const withVideo = [{ name: 'tanitim.mp4', size: 5000, path: 'demo/tanitim.mp4' }, files[0]!];
    const { container } = render(<MessageFiles files={withVideo} botId="b1" align="start" />);
    const video = container.querySelector('video')!;
    // A player this small would be all controls; the controls belong to the preview.
    expect(video.hasAttribute('controls')).toBe(false);

    fireEvent.click(video.closest('button')!);
    const shown = usePreview.getState();
    expect(shown.file?.path).toBe('demo/tanitim.mp4');
    // The preview steps on to the message's other files from the video as well.
    expect(shown.set.map((f) => f.path)).toEqual(['demo/tanitim.mp4', 'demo/rapor.md']);
  });

  it('henüz gönderilmekte olan dosyanın indirilecek bir şeyi yoktur', () => {
    const { container } = render(<MessageFiles files={[{ ...files[0]!, path: '' }]} />);
    expect(container.querySelector('a[download]')?.getAttribute('href')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });
});
