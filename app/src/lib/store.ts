import type { TurnState } from '@leafbot/shared';
import { create } from 'zustand';

export type SettingsTab =
  | 'profile'
  | 'people'
  | 'general'
  | 'connection'
  | 'channels'
  | 'permissions'
  | 'vault'
  | 'memory'
  | 'services'
  | 'routines'
  | 'skills'
  | 'groups'
  | 'import'
  | 'usage'
  | 'about';

/**
 * Sidebar widths in px. Below the snap point the sidebar folds into an avatar-only rail, wide
 * enough that the window buttons at its top left keep as much room on their right as on their left.
 */
export const SIDEBAR = { rail: 96, min: 240, max: 480, default: 340 } as const;
const SIDEBAR_SNAP = (SIDEBAR.rail + SIDEBAR.min) / 2;

/** Width of the bot panel beside the chat. */
export const PANEL_WIDTH = 360;
/** The chat keeps at least this width beside the sidebar and the panel. */
export const CHAT_MIN = 480;

/**
 * Width the sidebar takes when `room` px is left for it: its chosen width, narrower when that
 * does not fit, or the rail when not even the narrowest width does. The chosen width is kept,
 * so the sidebar grows back as the window does.
 */
export function sidebarFit(width: number, room: number): number {
  if (width <= SIDEBAR.rail || room < SIDEBAR.min) return SIDEBAR.rail;
  return Math.min(width, Math.floor(room));
}

/**
 * How a window of `viewport` px is shared when the sidebar was set to `chosen` px. As the window
 * narrows the panel gives way first, moving over the chat, and only then does the sidebar narrow;
 * so each part only ever shrinks while the window does, and grows back in the same order.
 */
export function fitLayout(viewport: number, chosen: number): { sidebar: number; panelBeside: boolean } {
  const sidebar = sidebarFit(chosen, viewport - CHAT_MIN);
  return { sidebar, panelBeside: viewport - sidebar - CHAT_MIN >= PANEL_WIDTH };
}

/** Width the sidebar takes for a dragged width: the rail, or a width between min and max. */
export function sidebarWidthFor(dragged: number): number {
  if (dragged < SIDEBAR_SNAP) return SIDEBAR.rail;
  return Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, dragged)));
}

export interface Stream {
  turnId: string;
  text: string;
}

export interface UiState {
  authed: boolean | null;
  connected: boolean;
  botId: string | null;
  threadId: string | null;
  /** The room open in place of a bot's chat, if any. */
  roomId: string | null;
  /** The window that starts a room or changes one. */
  roomDialog: { mode: 'create' } | { mode: 'edit'; roomId: string } | null;
  panelOpen: boolean;
  /** The bot panel over the chat, on screens too narrow to show it beside. */
  panelSheet: boolean;
  /** On a phone, whether the list of bots or the chosen bot's chat fills the screen. */
  phonePane: 'list' | 'chat';
  sidebarWidth: number;
  settingsTab: SettingsTab | null;
  /** On a phone, whether the settings show their list of sections rather than one section. */
  settingsList: boolean;
  searchOpen: boolean;
  /** What the search starts with when opened from the sidebar. */
  searchQuery: string;
  /** A message to bring into view once its conversation shows it (from the search). */
  focusedMessage: { id: string; threadId: string } | null;
  /** The find bar over the open conversation. */
  findOpen: boolean;
  /** What the find bar starts with when the search opened it: the words, and the message picked. */
  findSeed: { query: string; messageId: string } | null;
  /** The list of keyboard shortcuts. */
  shortcutsOpen: boolean;
  /** The day's summary. */
  todayOpen: boolean;
  boardOpen: boolean;
  /**
   * The routine open in place of the bot's chat: a saved one, or a new one when `routineId` is
   * null. `showRuns` opens it at its latest runs, for a routine opened to see why a run failed.
   */
  routine: { botId: string; routineId: string | null; showRuns?: boolean } | null;
  /**
   * A bot as a page in place of the chat: a new one being made, which may start with a name and a
   * folder, or one's settings.
   */
  botPage:
    | { mode: 'create'; preset?: { name: string; projectDir: string } }
    | { mode: 'edit'; botId: string }
    | null;
  /** Text picked in a message, waiting to be quoted at the top of the draft. */
  pendingQuote: string | null;
  /**
   * The apps (connections) page, over whatever the main area shows, which stays as it was under it.
   * `botId` is the bot it was opened for, whose switch a new connection turns on; `catalogId` opens
   * it on one service of the catalog, `connectionId` on one connection.
   */
  apps: { botId: string | null; catalogId?: string; connectionId?: string } | null;
  /** The bot whose computer (browser) is open. */
  computerBotId: string | null;
  /** Whether that browser shows in a small window over the chat rather than the large view. */
  computerFloat: boolean;
  /** In-progress assistant text per thread, until the saved message arrives. */
  streams: Record<string, Stream>;
  /** How much of its turn's streaming text had arrived when each card (by message id) did. */
  cardCuts: Record<string, number>;
  /** Live turn state per thread from the realtime channel. */
  states: Record<string, TurnState>;
  /** Threads whose answer text arrived within the last moment. */
  writing: Record<string, true>;
  /** The tool each thread's running turn is using now, as the engine names it. */
  tools: Record<string, string>;
  setAuthed(v: boolean): void;
  setConnected(v: boolean): void;
  selectBot(botId: string | null): void;
  /** Selects a bot and, on a phone, shows its chat. */
  openChat(botId: string): void;
  showList(): void;
  selectThread(threadId: string | null): void;
  /** Opens a room and, on a phone, shows it. */
  openRoom(roomId: string | null): void;
  openRoomDialog(d: UiState['roomDialog']): void;
  togglePanel(open?: boolean): void;
  togglePanelSheet(open?: boolean): void;
  resizeSidebar(dragged: number): void;
  /** `list`: on a phone, start from the list of sections (the settings button) instead of `tab`. */
  openSettings(tab: SettingsTab | null, list?: boolean): void;
  openSearch(open: boolean, query?: string): void;
  focusMessage(target: { id: string; threadId: string } | null): void;
  setFindOpen(open: boolean, seed?: { query: string; messageId: string }): void;
  setShortcutsOpen(open: boolean): void;
  setTodayOpen(open: boolean): void;
  setBoardOpen(open: boolean): void;
  /** Opens a routine in place of its bot's chat; `null` leaves it as `leavePage` does. */
  openRoutine(routine: UiState['routine']): void;
  /**
   * Closes the page open in place of the chat (a routine, a bot), asking first when it holds
   * changes not saved; false when the person keeps it open. Whatever would show something else in
   * its place goes through here.
   */
  leavePage(): boolean;
  /** Closes that page without asking, once its changes are saved or it is gone. */
  closePage(): void;
  quote(text: string | null): void;
  openApps(apps: UiState['apps']): void;
  /** Opens a new bot, or a bot's settings, in place of the chat; `null` leaves it as `leavePage` does. */
  openBotPage(page: UiState['botPage']): void;
  openComputer(botId: string | null): void;
  floatComputer(float: boolean): void;
  /** Adds a turn's next words; `restart` starts its text over, as the run did. */
  appendStream(threadId: string, turnId: string, text: string, restart?: boolean): void;
  dropStream(threadId: string, turnId?: string): void;
  /** Notes where cards were asked in their turn's text; a card's first note stays. */
  markCards(cuts: Record<string, number>): void;
  setState(threadId: string, state: TurnState): void;
  setTool(threadId: string, tool: string | null): void;
  /** Notes that answer text just arrived; it counts as writing until the text pauses. */
  markWriting(threadId: string): void;
  resetLive(): void;
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('leafbot.ui') ?? '{}') as {
      botId?: string;
      threadId?: string | null;
      roomId?: string | null;
      panelOpen?: boolean;
      sidebarWidth?: number;
      computerFloat?: boolean;
    };
  } catch {
    return {};
  }
})();

/** How long after the last piece of text a thread still counts as writing. */
export const WRITING_PAUSE_MS = 1200;
const writingTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The open page's question before its changes are dropped; it says whether to go on. */
let pageLeaveAsk: (() => boolean) | null = null;
/** Set by a page in place of the chat while it is open, so leaving it from anywhere asks the same. */
export function askBeforeLeavingPage(ask: (() => boolean) | null): void {
  pageLeaveAsk = ask;
}

function stopWriting(threadId: string) {
  clearTimeout(writingTimers.get(threadId));
  writingTimers.delete(threadId);
}

export const useUi = create<UiState>((set, get) => ({
  authed: null,
  connected: false,
  botId: saved.botId ?? null,
  // The conversation open when the app was last closed opens again.
  threadId: (saved.botId && saved.threadId) || null,
  roomId: saved.roomId ?? null,
  roomDialog: null,
  panelOpen: saved.panelOpen ?? true,
  panelSheet: false,
  phonePane: 'list',
  sidebarWidth: sidebarWidthFor(saved.sidebarWidth ?? SIDEBAR.default),
  settingsTab: null,
  settingsList: false,
  searchOpen: false,
  searchQuery: '',
  focusedMessage: null,
  findOpen: false,
  findSeed: null,
  shortcutsOpen: false,
  todayOpen: false,
  boardOpen: false,
  routine: null,
  botPage: null,
  pendingQuote: null,
  apps: null,
  computerBotId: null,
  computerFloat: saved.computerFloat ?? false,
  streams: {},
  cardCuts: {},
  states: {},
  writing: {},
  tools: {},
  setAuthed: (authed) => set({ authed }),
  setConnected: (connected) => set({ connected }),
  // Without a bot there is no chat to show, so a phone goes back to the list.
  selectBot: (botId) => {
    if (!get().leavePage()) return;
    set(
      botId
        ? { botId, threadId: null, roomId: null, findOpen: false, apps: null }
        : { botId, threadId: null, roomId: null, phonePane: 'list', findOpen: false, apps: null },
    );
  },
  openChat: (botId) => {
    if (!get().leavePage()) return;
    set({
      botId,
      threadId: null,
      roomId: null,
      phonePane: 'chat',
      panelSheet: false,
      findOpen: false,
      apps: null,
    });
  },
  showList: () => set({ phonePane: 'list', panelSheet: false }),
  selectThread: (threadId) => {
    if (!get().leavePage()) return;
    set({ threadId, roomId: null, apps: null });
  },
  openRoom: (roomId) => {
    if (!roomId) return set({ roomId });
    if (!get().leavePage()) return;
    set({ roomId, phonePane: 'chat', panelSheet: false, findOpen: false, apps: null });
  },
  openRoomDialog: (roomDialog) => set({ roomDialog }),
  togglePanel: (open) => set((s) => ({ panelOpen: open ?? !s.panelOpen })),
  togglePanelSheet: (open) => set((s) => ({ panelSheet: open ?? !s.panelSheet })),
  resizeSidebar: (dragged) => set({ sidebarWidth: sidebarWidthFor(dragged) }),
  openSettings: (settingsTab, list = false) => set({ settingsTab, settingsList: list }),
  openSearch: (searchOpen, searchQuery = '') => set({ searchOpen, searchQuery }),
  focusMessage: (focusedMessage) => set({ focusedMessage }),
  setFindOpen: (findOpen, seed) => set({ findOpen, findSeed: findOpen ? (seed ?? null) : null }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setTodayOpen: (todayOpen) => set({ todayOpen }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  openRoutine: (routine) => {
    if (!routine) return void get().leavePage();
    const s = get();
    // The same routine again only moves to its runs; another one is a page left.
    const same = s.routine?.botId === routine.botId && s.routine.routineId === routine.routineId;
    if (!same && !s.leavePage()) return;
    set({
      routine,
      botId: routine.botId,
      threadId: routine.botId === s.botId ? s.threadId : null,
      roomId: null,
      phonePane: 'chat',
      panelSheet: false,
      findOpen: false,
      apps: null,
    });
  },
  leavePage: () => {
    const s = get();
    if (!s.routine && !s.botPage) return true;
    if (pageLeaveAsk && !pageLeaveAsk()) return false;
    s.closePage();
    return true;
  },
  closePage: () => {
    pageLeaveAsk = null;
    set({ routine: null, botPage: null, apps: null });
  },
  quote: (pendingQuote) => set({ pendingQuote }),
  // The page under it is kept as it is, typed changes too, for when the apps page closes.
  openApps: (apps) => set(apps ? { apps, phonePane: 'chat', panelSheet: false } : { apps }),
  openBotPage: (page) => {
    if (!page) return void get().leavePage();
    const s = get();
    // The same page again stays as it is; another one is a page left.
    const open = s.botPage;
    const same =
      open?.mode === page.mode &&
      (page.mode === 'create' || (open.mode === 'edit' && open.botId === page.botId));
    if (same) return set({ apps: null });
    if (!s.leavePage()) return;
    set({
      botPage: page,
      ...(page.mode === 'edit' && {
        botId: page.botId,
        threadId: page.botId === s.botId ? s.threadId : null,
        roomId: null,
      }),
      phonePane: 'chat',
      panelSheet: false,
      findOpen: false,
      apps: null,
    });
  },
  openComputer: (computerBotId) => set({ computerBotId }),
  floatComputer: (computerFloat) => set({ computerFloat }),
  appendStream: (threadId, turnId, text, restart) =>
    set((s) => {
      const cur = s.streams[threadId];
      const next = cur && cur.turnId === turnId && !restart ? cur.text + text : text;
      return { streams: { ...s.streams, [threadId]: { turnId, text: next } } };
    }),
  dropStream: (threadId, turnId) =>
    set((s) => {
      const cur = s.streams[threadId];
      if (!cur || (turnId && cur.turnId !== turnId)) return s;
      const streams = { ...s.streams };
      delete streams[threadId];
      return { streams };
    }),
  markCards: (cuts) => set((s) => ({ cardCuts: { ...cuts, ...s.cardCuts } })),
  setTool: (threadId, tool) =>
    set((s) => {
      const { [threadId]: _, ...tools } = s.tools;
      return { tools: tool ? { ...tools, [threadId]: tool } : tools };
    }),
  setState: (threadId, state) =>
    set((s) => {
      if (state !== 'running' && s.writing[threadId]) {
        stopWriting(threadId);
        const { [threadId]: _, ...writing } = s.writing;
        return { states: { ...s.states, [threadId]: state }, writing };
      }
      return { states: { ...s.states, [threadId]: state } };
    }),
  markWriting: (threadId) => {
    stopWriting(threadId);
    writingTimers.set(
      threadId,
      setTimeout(() => {
        writingTimers.delete(threadId);
        set((s) => {
          const { [threadId]: _, ...writing } = s.writing;
          return { writing };
        });
      }, WRITING_PAUSE_MS),
    );
    // Only the start of writing changes state, so each token does not re-render.
    if (!get().writing[threadId]) set((s) => ({ writing: { ...s.writing, [threadId]: true } }));
  },
  resetLive: () => {
    for (const id of [...writingTimers.keys()]) stopWriting(id);
    set({ streams: {}, cardCuts: {}, states: {}, writing: {}, tools: {} });
  },
}));

useUi.subscribe((s) => {
  try {
    localStorage.setItem(
      'leafbot.ui',
      JSON.stringify({
        botId: s.botId,
        threadId: s.threadId,
        roomId: s.roomId,
        panelOpen: s.panelOpen,
        sidebarWidth: s.sidebarWidth,
        computerFloat: s.computerFloat,
      }),
    );
  } catch {
    // Storage may be unavailable; the UI still works.
  }
});
