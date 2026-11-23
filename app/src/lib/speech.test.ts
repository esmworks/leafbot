import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { clampRate, pickVoice, speakable, speakAndWait, speechLanguage, useSpeech } from './speech';

vi.mock('./api', () => ({ api: { speech: vi.fn() } }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const voice = (name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ name, lang, localService: true, default: false, voiceURI: name, ...extra }) as SpeechSynthesisVoice;

describe('sesli okuma', () => {
  it('Markdown işaretlerini ve kodu okumaz, her satırın sonunda durur', () => {
    expect(
      speakable('## Özet\n\n- **Satış** arttı, [rapor](https://x.y) hazır\n\n```js\nx()\n```\nBitti.'),
    ).toBe('Özet.\nSatış arttı, rapor hazır.\nBitti.');
  });

  it('emoji, çıplak adres, tablo çizgisi ve oku sesli okumaz', () => {
    expect(
      speakable(
        '✅ Tamam 🎉\n\n---\n\n| Ürün | Adet |\n|---|---:|\n| Elma | 3 |\n\nAyrıntı → https://ornek.com/a?b=1',
      ),
    ).toBe('Tamam.\nÜrün, Adet.\nElma, 3.\nAyrıntı.');
  });

  it('formül bloklarını ve HTML etiketlerini okumaz', () => {
    expect(speakable('Sonuç:\n$$\\frac{a}{b}$$\n<br>Son')).toBe('Sonuç:\nSon.');
  });

  it('metnin dilini sezer', () => {
    expect(speechLanguage('Bugün satışlar arttı.', 'en')).toBe('tr');
    expect(speechLanguage('The report is ready and you can open it.', 'tr')).toBe('en');
    expect(speechLanguage('Tamam', 'tr')).toBe('tr');
  });

  it('oyuncak sesleri değil, en doğal sesi seçer', () => {
    const voices = [
      voice('Albert', 'en-US', { default: true }),
      voice('Eddy (English (US))', 'en-US'),
      voice('Samantha', 'en-US'),
      voice('Ava (Premium)', 'en-US'),
      voice('Yelda', 'tr-TR'),
    ];
    expect(pickVoice(voices, 'en')?.name).toBe('Ava (Premium)');
    expect(pickVoice(voices.slice(0, 3), 'en')?.name).toBe('Samantha');
    expect(pickVoice(voices, 'tr')?.name).toBe('Yelda');
    expect(
      pickVoice([voice('Google Türkçe', 'tr-TR', { localService: false }), voice('Yelda', 'tr_TR')], 'tr')
        ?.name,
    ).toBe('Google Türkçe');
    expect(pickVoice(voices, 'tr')).toBeDefined();
    expect(pickVoice([voice('Anna', 'de-DE')], 'tr')).toBeUndefined();
  });

  it('hızı çubuğun aralığında ve yüzde bir hassasiyetle tutar', () => {
    expect(clampRate(0.837)).toBe(0.84);
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(5)).toBe(2);
    expect(clampRate(Number.NaN)).toBe(1);
  });
});

describe('sesli okumayı bekleme', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useSpeech.setState({ speaking: null });
  });

  /** The system voice, read out until `finish` is called. */
  function systemVoice() {
    const said: { onend: (() => void) | null }[] = [];
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
    );
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [voice('Yelda', 'tr-TR')],
      speak: (u: { onend: (() => void) | null }) => said.push(u),
      cancel: vi.fn(),
    });
    return { said, finish: () => said.at(-1)?.onend?.() };
  }

  it('sunucunun sesi bozulunca sistem sesine geçer ve okuma bitmeden bitmiş saymaz', async () => {
    const voiceOut = systemVoice();
    vi.mocked(api.speech).mockRejectedValue(new Error('down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    toastError.mockReset();
    let done = false;
    const p = speakAndWait('m1', 'Merhaba', 'tr', true).then(() => (done = true));
    await vi.waitFor(() => expect(voiceOut.said).toHaveLength(1));
    expect(done).toBe(false);
    // The person is told why the server's voice is not the one they hear.
    expect(toastError).toHaveBeenCalledOnce();
    expect(toastError.mock.calls[0]![0]).toContain('down');
    expect(useSpeech.getState().speaking).toBe('m1');
    voiceOut.finish();
    await p;
    expect(done).toBe(true);
  });

  it('bitti demeyen bir okumayı süresi dolunca keser', async () => {
    vi.useFakeTimers();
    systemVoice();
    const p = speakAndWait('m2', 'Kısa', 'tr', false);
    await vi.advanceTimersByTimeAsync(15_000);
    await p;
    expect(useSpeech.getState().speaking).toBeNull();
  });
});
