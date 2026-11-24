import type { Message } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';
import { speakAndWait, stopSpeech } from './speech';
import { answerAfter, answerIds, loudness, TurnDetector, useVoiceCall } from './voiceCall';

vi.mock('./speech', () => ({ speakAndWait: vi.fn(), stopSpeech: vi.fn() }));
vi.mock('./api', () => ({ api: { transcribeStatus: vi.fn(), transcribe: vi.fn() } }));

const msg = (id: string, role: Message['role'], text = 'x'): Message => ({
  id,
  threadId: 't',
  role,
  author: role === 'user' ? 'user' : 'bot:b',
  text,
  props: {},
  clientId: null,
  turnId: null,
  createdAt: new Date().toISOString(),
});

describe('sesli görüşme', () => {
  it('sesin yüksekliğini ölçer', () => {
    expect(loudness(new Float32Array([0, 0, 0]))).toBe(0);
    expect(loudness(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5);
    expect(loudness(new Float32Array([]))).toBe(0);
  });

  it('konuşmanın başını kısa bir sesten sonra, sonunu sessizlikten sonra bulur', () => {
    const d = new TurnDetector({ threshold: 0.1, silenceMs: 500, minSpeechMs: 200 });
    // A short knock is not speech.
    expect(d.feed(0.5, 0)).toBeNull();
    expect(d.feed(0, 100)).toBeNull();
    expect(d.feed(0.5, 1000)).toBeNull();
    expect(d.feed(0.5, 1150)).toBeNull();
    expect(d.feed(0.5, 1200)).toBe('start');
    // A breath between words does not end it.
    expect(d.feed(0, 1300)).toBeNull();
    expect(d.feed(0.5, 1600)).toBeNull();
    expect(d.feed(0, 1700)).toBeNull();
    expect(d.feed(0, 2100)).toBeNull();
    expect(d.feed(0, 2200)).toBe('end');
    // And starts over.
    expect(d.feed(0, 2300)).toBeNull();
    expect(d.feed(0.5, 2400)).toBeNull();
    expect(d.feed(0.5, 2600)).toBe('start');
  });

  it('cevabı gönderilenden sonra gelen ve tur bitince alınan son mesaj sayar', () => {
    const before = answerIds([msg('a1', 'assistant'), msg('u1', 'user')]);
    const now = [
      msg('a1', 'assistant'),
      msg('u1', 'user'),
      msg('u2', 'user'),
      msg('a2', 'assistant', 'Merhaba'),
    ];
    expect(answerAfter(now, before, true)).toBeNull();
    expect(answerAfter(now, before, false)?.id).toBe('a2');
    expect(answerAfter([msg('a1', 'assistant')], before, false)).toBeNull();
    expect(answerAfter([...now, msg('e1', 'error')], before, false)?.id).toBe('e1');
  });
});

/** A browser's speech recognition the test drives: what it hears, and whether it listens. */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = false;
  interimResults = false;
  listening = false;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    if (this.listening) throw new Error('already started');
    this.listening = true;
  }
  stop() {
    this.abort();
  }
  abort() {
    if (!this.listening) return;
    this.listening = false;
    this.onend?.();
  }
  hear(text: string) {
    const result = Object.assign([{ transcript: text }], { isFinal: true });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

function setup(transcribe: boolean) {
  vi.mocked(api.transcribeStatus).mockResolvedValue({ available: transcribe } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const send = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(
    (p: { messages: Message[]; busy: boolean }) =>
      useVoiceCall({ locale: 'tr', serverVoice: false, send, onError, ...p }),
    { wrapper, initialProps: { messages: [msg('a0', 'assistant')], busy: false } },
  );
  return { hook, send, onError };
}

describe('sesli görüşme kancası', () => {
  beforeEach(() => {
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    FakeRecognition.last = null;
    vi.mocked(speakAndWait).mockReset();
    vi.mocked(stopSpeech).mockReset();
  });

  it('söyleneni gönderir, cevabı okurken dinlemeyi keser, sonra yeniden dinler', async () => {
    const { hook, send } = setup(false);
    let read!: () => void;
    vi.mocked(speakAndWait).mockReturnValue(new Promise<void>((r) => (read = r)));
    await waitFor(() => expect(hook.result.current.supported).toBe(true));
    act(() => hook.result.current.start());
    const rec = FakeRecognition.last!;
    expect(hook.result.current.state).toBe('listening');
    expect(rec.listening).toBe(true);

    act(() => rec.hear('Yarın hava nasıl?'));
    expect(send).toHaveBeenCalledWith('Yarın hava nasıl?');
    expect(hook.result.current.state).toBe('waiting');

    // The bot is still working: nothing is read yet.
    hook.rerender({ messages: [msg('a0', 'assistant'), msg('u1', 'user')], busy: true });
    expect(hook.result.current.state).toBe('waiting');

    hook.rerender({
      messages: [msg('a0', 'assistant'), msg('u1', 'user'), msg('a1', 'assistant', 'Güneşli.')],
      busy: false,
    });
    expect(hook.result.current.state).toBe('speaking');
    expect(vi.mocked(speakAndWait).mock.calls[0]?.slice(0, 2)).toEqual(['a1', 'Güneşli.']);
    // While the answer is read the bot's own voice is not heard as the person's.
    expect(rec.listening).toBe(false);
    act(() => rec.hear('Güneşli.'));
    expect(send).toHaveBeenCalledTimes(1);

    await act(async () => read());
    expect(hook.result.current.state).toBe('listening');
    expect(rec.listening).toBe(true);
  });

  it('dinlerken botun kendiliğinden başlattığı cevabı okur; öncekileri ve hataları okumaz', async () => {
    const { hook, send } = setup(false);
    let read!: () => void;
    vi.mocked(speakAndWait).mockReturnValue(new Promise<void>((r) => (read = r)));
    await waitFor(() => expect(hook.result.current.supported).toBe(true));
    act(() => hook.result.current.start());
    expect(speakAndWait).not.toHaveBeenCalled();

    // An error and a reply still being worked on are not read.
    hook.rerender({ messages: [msg('a0', 'assistant'), msg('e1', 'error')], busy: false });
    hook.rerender({ messages: [msg('a0', 'assistant'), msg('e1', 'error')], busy: true });
    expect(speakAndWait).not.toHaveBeenCalled();

    // A routine's reply arrives with nobody having spoken.
    hook.rerender({
      messages: [msg('a0', 'assistant'), msg('e1', 'error'), msg('a2', 'assistant', 'Sabah özeti hazır.')],
      busy: false,
    });
    expect(hook.result.current.state).toBe('speaking');
    expect(vi.mocked(speakAndWait).mock.calls[0]?.slice(0, 2)).toEqual(['a2', 'Sabah özeti hazır.']);
    expect(FakeRecognition.last!.listening).toBe(false);
    expect(send).not.toHaveBeenCalled();

    await act(async () => read());
    expect(hook.result.current.state).toBe('listening');
    // Once read, it is not read again.
    expect(speakAndWait).toHaveBeenCalledTimes(1);
  });

  it('kapatınca dinlemeyi bırakır; sonradan gelen söz gönderilmez', async () => {
    const { hook, send } = setup(false);
    await waitFor(() => expect(hook.result.current.supported).toBe(true));
    act(() => hook.result.current.start());
    const rec = FakeRecognition.last!;
    act(() => hook.result.current.hangUp());
    expect(hook.result.current.state).toBe('off');
    expect(rec.listening).toBe(false);
    act(() => rec.hear('geç kalan söz'));
    expect(send).not.toHaveBeenCalled();
  });

  it('mikrofon izni kapattıktan sonra gelirse mikrofonu hemen bırakır', async () => {
    const stopTrack = vi.fn();
    let grant!: (s: MediaStream) => void;
    vi.stubGlobal('MediaRecorder', Object.assign(vi.fn(), { isTypeSupported: () => true }));
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => new Promise<MediaStream>((r) => (grant = r)) },
    });
    const audioContext = vi.fn();
    vi.stubGlobal('AudioContext', audioContext);
    // Only the server's speech-to-text: the browser's own recognition is not there.
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    const { hook } = setup(true);
    await waitFor(() => expect(hook.result.current.supported).toBe(true));
    act(() => hook.result.current.start());
    act(() => hook.result.current.hangUp());
    await act(async () => grant({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream));
    expect(stopTrack).toHaveBeenCalled();
    expect(audioContext).not.toHaveBeenCalled();
    expect(hook.result.current.state).toBe('off');
    Reflect.deleteProperty(navigator, 'mediaDevices');
  });
});
