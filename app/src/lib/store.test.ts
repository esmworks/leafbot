import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_MIN,
  fitLayout,
  PANEL_WIDTH,
  SIDEBAR,
  sidebarFit,
  sidebarWidthFor,
  useUi,
  WRITING_PAUSE_MS,
} from './store';

describe('akış tamponu', () => {
  beforeEach(() => useUi.getState().resetLive());
  it('aynı tura ekler, yeni tur tamponu baştan başlatır', () => {
    const s = useUi.getState();
    s.appendStream('t1', 'turn-a', 'Mer');
    s.appendStream('t1', 'turn-a', 'haba');
    expect(useUi.getState().streams.t1).toEqual({ turnId: 'turn-a', text: 'Merhaba' });
    s.appendStream('t1', 'turn-b', 'Yeni');
    expect(useUi.getState().streams.t1?.text).toBe('Yeni');
  });
  it('baştan başlayan çalışmanın yazısı öncekinin yerine geçer', () => {
    const s = useUi.getState();
    s.appendStream('t1', 'turn-a', 'Yarım kalan');
    s.appendStream('t1', 'turn-a', 'Yeniden', true);
    s.appendStream('t1', 'turn-a', ' deniyorum');
    expect(useUi.getState().streams.t1).toEqual({ turnId: 'turn-a', text: 'Yeniden deniyorum' });
  });
  it('yalnızca kendi turunun tamponunu siler', () => {
    const s = useUi.getState();
    s.appendStream('t1', 'turn-b', 'x');
    s.dropStream('t1', 'turn-a');
    expect(useUi.getState().streams.t1).toBeDefined();
    s.dropStream('t1', 'turn-b');
    expect(useUi.getState().streams.t1).toBeUndefined();
  });
});

describe('kenar çubuğu genişliği', () => {
  it('sınırlar arasında kalır, yarı yoldan aşağısı ikon şeridine katlanır', () => {
    expect(sidebarWidthFor(300.4)).toBe(300);
    expect(sidebarWidthFor(9999)).toBe(SIDEBAR.max);
    expect(sidebarWidthFor(SIDEBAR.min - 10)).toBe(SIDEBAR.min);
    expect(sidebarWidthFor(100)).toBe(SIDEBAR.rail);
    expect(sidebarWidthFor(-50)).toBe(SIDEBAR.rail);
  });
  it('şeritten yeterince sağa çekilince en dar genişlikte açılır', () => {
    expect(sidebarWidthFor(SIDEBAR.rail + 20)).toBe(SIDEBAR.rail);
    expect(sidebarWidthFor(200)).toBe(SIDEBAR.min);
  });
  it('pencere daralınca önce daralır, en dar genişlik de sığmazsa ikon şeridine katlanır', () => {
    expect(sidebarFit(340, 900)).toBe(340);
    expect(sidebarFit(340, 300.7)).toBe(300);
    expect(sidebarFit(340, SIDEBAR.min)).toBe(SIDEBAR.min);
    expect(sidebarFit(340, SIDEBAR.min - 1)).toBe(SIDEBAR.rail);
  });
  it('seçilmiş ikon şeridi yer olsa da şerit kalır', () => {
    expect(sidebarFit(SIDEBAR.rail, 900)).toBe(SIDEBAR.rail);
  });
  it('pencere daralırken önce panel sohbetin üstüne geçer, kenar çubuğu sonra daralır', () => {
    const all = 340 + CHAT_MIN + PANEL_WIDTH;
    expect(fitLayout(all, 340)).toEqual({ sidebar: 340, panelBeside: true });
    expect(fitLayout(all - 1, 340)).toEqual({ sidebar: 340, panelBeside: false });
    expect(fitLayout(340 + CHAT_MIN - 20, 340)).toEqual({ sidebar: 320, panelBeside: false });
  });
  it('pencere daralırken kenar çubuğu hiç yeniden genişlemez', () => {
    for (const chosen of [SIDEBAR.rail, SIDEBAR.min, 340, SIDEBAR.max]) {
      let prev = Infinity;
      for (let w = 1600; w >= 768; w--) {
        const { sidebar } = fitLayout(w, chosen);
        expect(sidebar).toBeLessThanOrEqual(prev);
        prev = sidebar;
      }
    }
  });
});

describe('yazıyor durumu', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUi.getState().resetLive();
  });
  afterEach(() => vi.useRealTimers());

  it('metin durunca biter, yeni metinle yeniden başlar', () => {
    const s = useUi.getState();
    s.setState('t1', 'running');
    s.markWriting('t1');
    vi.advanceTimersByTime(WRITING_PAUSE_MS - 100);
    s.markWriting('t1');
    vi.advanceTimersByTime(WRITING_PAUSE_MS - 100);
    expect(useUi.getState().writing.t1).toBe(true);
    // A tool call: no text for a while, the turn is still running.
    vi.advanceTimersByTime(200);
    expect(useUi.getState().writing.t1).toBeUndefined();
    expect(useUi.getState().states.t1).toBe('running');
    s.markWriting('t1');
    expect(useUi.getState().writing.t1).toBe(true);
  });

  it('tur bitince hemen biter', () => {
    const s = useUi.getState();
    s.setState('t1', 'running');
    s.markWriting('t1');
    s.setState('t1', 'idle');
    expect(useUi.getState().writing.t1).toBeUndefined();
  });
});
