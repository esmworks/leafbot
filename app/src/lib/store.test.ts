import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  askBeforeLeavingPage,
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

describe('rutin sayfası', () => {
  beforeEach(() => {
    askBeforeLeavingPage(null);
    useUi.setState({ routine: null, botId: 'b1', threadId: 't1', roomId: null });
  });
  afterEach(() => askBeforeLeavingPage(null));

  it('rutini botunun sohbeti yerine açar, aynı botta açık konuşmayı korur', () => {
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    expect(useUi.getState()).toMatchObject({ routine: { routineId: 'r1' }, botId: 'b1', threadId: 't1' });
    useUi.getState().openRoutine({ botId: 'b2', routineId: null });
    expect(useUi.getState()).toMatchObject({ routine: { routineId: null }, botId: 'b2', threadId: null });
  });

  it('kaydedilmemiş değişiklik varken başka bir şey açmadan önce sorar, hayır denirse sayfa kalır', () => {
    const ask = vi.fn(() => false);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    askBeforeLeavingPage(ask);
    useUi.getState().selectThread('t2');
    useUi.getState().openChat('b2');
    useUi.getState().openRoom('room1');
    expect(ask).toHaveBeenCalledTimes(3);
    expect(useUi.getState()).toMatchObject({ routine: { routineId: 'r1' }, threadId: 't1', roomId: null });
  });

  it('evet denince bir kez sorar ve gerisi sormadan açılır', () => {
    const ask = vi.fn(() => true);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    askBeforeLeavingPage(ask);
    useUi.getState().openChat('b2');
    useUi.getState().selectThread('t9');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(useUi.getState()).toMatchObject({ routine: null, botId: 'b2', threadId: 't9' });
  });

  it('aynı rutini yeniden açmak sormaz, kaydedilince sormadan kapanır', () => {
    const ask = vi.fn(() => false);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    askBeforeLeavingPage(ask);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1', showRuns: true });
    expect(ask).not.toHaveBeenCalled();
    expect(useUi.getState().routine?.showRuns).toBe(true);
    useUi.getState().closePage();
    expect(useUi.getState().routine).toBeNull();
  });
});

describe('bot ve uygulama sayfaları', () => {
  beforeEach(() => {
    askBeforeLeavingPage(null);
    useUi.setState({ routine: null, botPage: null, apps: null, botId: 'b1', threadId: 't1', roomId: null });
  });
  afterEach(() => askBeforeLeavingPage(null));

  it('yeni bot da botun ayarları da sohbetin yerinde sayfa olarak açılır', () => {
    useUi.getState().openBotPage({ mode: 'create', preset: { name: 'Proje', projectDir: '/p' } });
    expect(useUi.getState().botPage).toEqual({ mode: 'create', preset: { name: 'Proje', projectDir: '/p' } });
    useUi.getState().openBotPage({ mode: 'edit', botId: 'b2' });
    expect(useUi.getState()).toMatchObject({
      botPage: { mode: 'edit', botId: 'b2' },
      botId: 'b2',
      threadId: null,
    });
  });

  it('açık rutinden bota geçerken sorar; yarım kalan bot rutin ya da sohbet açmadan önce sorar', () => {
    const ask = vi.fn(() => false);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    askBeforeLeavingPage(ask);
    useUi.getState().openBotPage({ mode: 'create' });
    expect(useUi.getState()).toMatchObject({ botPage: null, routine: { routineId: 'r1' } });
    ask.mockReturnValue(true);
    useUi.getState().openBotPage({ mode: 'create' });
    expect(useUi.getState()).toMatchObject({ botPage: { mode: 'create' }, routine: null });
    askBeforeLeavingPage(() => false);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    useUi.getState().openChat('b2');
    expect(useUi.getState()).toMatchObject({ botPage: { mode: 'create' }, routine: null, botId: 'b1' });
  });

  it('uygulamalar açık sayfanın üstüne gelir, kapanınca sayfa olduğu gibi kalır', () => {
    const ask = vi.fn(() => false);
    useUi.getState().openRoutine({ botId: 'b1', routineId: 'r1' });
    askBeforeLeavingPage(ask);
    useUi.getState().openApps({ botId: 'b1', catalogId: 'gmail' });
    expect(ask).not.toHaveBeenCalled();
    expect(useUi.getState()).toMatchObject({ apps: { catalogId: 'gmail' }, routine: { routineId: 'r1' } });
    useUi.getState().openApps(null);
    expect(useUi.getState()).toMatchObject({ apps: null, routine: { routineId: 'r1' } });
  });

  it('uygulamalar açıkken başka bir şey açmak uygulamaları kapatır', () => {
    useUi.getState().openApps({ botId: null });
    useUi.getState().selectThread('t2');
    expect(useUi.getState()).toMatchObject({ apps: null, threadId: 't2' });
    useUi.getState().openApps({ botId: null });
    useUi.getState().openBotPage({ mode: 'edit', botId: 'b1' });
    expect(useUi.getState()).toMatchObject({ apps: null, botPage: { mode: 'edit', botId: 'b1' } });
  });
});

describe('görev panosu', () => {
  beforeEach(() => {
    askBeforeLeavingPage(null);
    useUi.setState({
      routine: null,
      botPage: null,
      apps: null,
      boardOpen: false,
      botId: 'b1',
      threadId: null,
      roomId: null,
      phonePane: 'list',
    });
  });

  it('botlar yanında kalsın diye sohbetin yerinde açılır; bir sohbet açmak panoyu kapatır', () => {
    useUi.getState().openApps({ botId: null });
    useUi.getState().setBoardOpen(true);
    expect(useUi.getState()).toMatchObject({ boardOpen: true, apps: null });
    useUi.getState().openChat('b2');
    expect(useUi.getState()).toMatchObject({ boardOpen: false, botId: 'b2' });
    useUi.getState().setBoardOpen(true);
    useUi.getState().openApps({ botId: null });
    expect(useUi.getState().boardOpen).toBe(false);
  });

  it('kimse istemeden ana konuşmaya ya da ilk bota dönmek panoyu kapatmaz, bir konuşma açmak kapatır', () => {
    useUi.getState().setBoardOpen(true);
    useUi.getState().selectThread(null);
    useUi.getState().selectBot('b2');
    expect(useUi.getState()).toMatchObject({ boardOpen: true, botId: 'b2' });
    useUi.getState().selectThread('t2');
    expect(useUi.getState()).toMatchObject({ boardOpen: false, threadId: 't2' });
  });

  it('telefonda kapanınca açıldığı ekrana döner', () => {
    useUi.getState().setBoardOpen(true);
    expect(useUi.getState().phonePane).toBe('chat');
    useUi.getState().setBoardOpen(false);
    expect(useUi.getState().phonePane).toBe('list');
    useUi.setState({ phonePane: 'chat' });
    useUi.getState().setBoardOpen(true);
    useUi.getState().setBoardOpen(false);
    expect(useUi.getState().phonePane).toBe('chat');
  });
});
