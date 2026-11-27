import type {
  AccountInvite,
  PersonInvite,
  CardAnswer,
  CardTick,
  BotAction,
  LinkPreview,
  TailscaleState,
  ComputerPermission,
  PersonComputerState,
  AcpAgentState,
  TurnChanges,
  TurnLogEntry,
  RoutineSuggestion,
  RoutineSuggestionAccept,
  SkillSuggestion,
  SkillSuggestionAccept,
  DoctorCheckId,
  DoctorReport,
  ReplayResult,
  TaughtStep,
  PermissionSuggestions,
  BotTable,
  DashboardSummary,
  DashboardView,
  RowValues,
  TableRow,
  TableShare,
  TableView,
  TelegramStatus,
  DiscordConnect,
  DiscordStatus,
  DiscordUpdate,
  SlackConnect,
  SlackLink,
  TeamsConnect,
  TeamsLink,
  TeamsStatus,
  SlackStatus,
  WhatsAppSet,
  WhatsAppGroup,
  WhatsAppStatus,
  ApnsSet,
  RoutineGateMode,
  ApnsStatus,
  PushDeviceSet,
  SkillWarning,
  Room,
  Meeting,
  MeetingAnswer,
  MeetingSave,
  RoomCreate,
  RoomUpdate,
  BotImportPlan,
  GrokChatResult,
  GrokLook,
  GrokMoveLink,
  BotImportResult,
  GrokTemplateCard,
  Approval,
  Bot,
  BotSummary,
  SessionInfo,
  AccountSet,
  TodayReport,
  Group,
  MailSender,
  LiveText,
  Memory,
  MemoryGraph,
  MemoryChange,
  MemoryFlag,
  MemoryHistoryLine,
  Message,
  PermissionRule,
  Approver,
  SecondYes,
  SpaceJoin,
  SpaceRequest,
  ProviderInfo,
  ModelInfo,
  CustomEndpointCreate,
  CustomEndpointUpdate,
  Routine,
  Skill,
  SkillChange,
  SkillCreate,
  SkillUpdate,
  RoutineFix,
  RoutineRevision,
  RoutineVersionReport,
  UnusedReport,
  RoutineHealth,
  RoutineHealthFindingId,
  Rehearsal,
  RehearsalStart,
  ReplayableRun,
  RoutineRun,
  SearchHit,
  ServerInfo,
  Thread,
  Locale,
  PasswordManager,
  PasswordManagerCreate,
  PasswordManagerUpdate,
  PaymentCard,
  PaymentCardCreate,
  PaymentCardUpdate,
  ContactDetails,
  ContactDetailsCreate,
  ContactDetailsUpdate,
  VaultImport,
  VaultImportResult,
  VaultLogin,
  VaultLoginCreate,
  VaultLoginUpdate,
  BotMove,
  GroupMove,
  GroupCreate,
  GroupUpdate,
  SpaceMembersChange,
  PrivateBots,
  ProfileFocus,
  ProfileHelp,
  ClaudeAuthSet,
  ClaudeAuthStatus,
  ClaudeModel,
  ClaudeAdvisor,
  Effort,
  Connection,
  ConnectionAuthStart,
  ConnectionBots,
  ConnectionCreate,
  ConnectionToolPatch,
  ConnectionUpdate,
  UsageRange,
  UsageReport,
  ProviderSignIn,
  PageApp,
  PageShare,
  ApiCredential,
  ApiCredentialCreate,
  ApiCredentialUpdate,
  ApiKeyImport,
  TrapKeyCreate,
  ApiKeyImportResult,
  EmailSettings,
  AiEndpoint,
  AiEndpoints,
  AiEndpointSet,
  AiKind,
  PluginInstall,
  PluginInstallResult,
  PluginPlan,
  ApiSource,
  ApiSourceCreate,
  Ticket,
  TicketCreate,
  TicketUpdate,
  SessionUser,
  PersonInfo,
  PersonCreate,
  PersonUpdate,
  BotAccess,
  StorageReport,
  LiveActivitySet,
} from '@leafbot/shared';
import { httpOf, type Transport } from './http';

/** Whether this server is linked to a Leaf Bot account and reachable from the web app. */
export interface AccountHostState {
  linked: boolean;
  hostId: string | null;
  name: string | null;
  running: boolean;
  noWebRtc: boolean;
}

/** The owner signed in to their account from the app, and the server linked to it. */
export interface AccountSignedIn {
  email: string;
  /** The account's name; '' when it has none yet. */
  name: string;
  /** The account has no name yet: the app asks for it next. */
  needsName: boolean;
  host: AccountHostState;
}

/** How a file goes up: the same `uploadId` on a second try, its progress, calling it off. */
export interface UploadOptions {
  uploadId?: string;
  onProgress?: (part: number) => void;
  signal?: AbortSignal;
}

export interface LibraryFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}
export interface JobView {
  job: {
    id: string;
    status: string;
    fromBotId: string;
    toBotId: string;
    /** The other bot's conversation the exchange happens in. */
    toThreadId: string;
    request: string;
    reply: string | null;
  };
  messages: Message[];
}
/** A model that makes pictures, as `provider/model`, with the name to show. */
export interface ImageModel {
  ref: string;
  provider: string;
  name: string;
  /** The name of the person's own endpoint the model is on; built-in providers are named by the app. */
  providerName?: string;
}
export interface Settings {
  userName: string;
  /** Profile fields and `onboarded` are missing on servers older than the first-run questions. */
  addressAs?: string;
  occupation?: string;
  focus?: ProfileFocus;
  helpWith?: ProfileHelp[];
  aboutMe?: string;
  onboarded?: boolean;
  /** Claude defaults; missing on older servers. Empty leaves it to the server or the model. */
  defaultModel?: string;
  effort?: Effort | '';
  defaultEngine?: 'claude' | 'pi';
  /** `provider/model` new bots on another provider start with. */
  piModel?: string;
  /** `provider/model` that carries a turn once the usage limit is spent; empty waits instead. */
  backupModel?: string;
  /** `provider/model` that makes pictures; empty picks one from the saved keys. Missing on older servers. */
  imageModel?: string;
  /** Tokens at which a Claude bot folds the conversation into a summary; 0 leaves it to Claude. Missing on older servers. */
  claudeCompactWindow?: number;
  /** The Claude model Claude bots may ask for advice mid-turn; empty is off. Missing on older servers. */
  claudeAdvisorModel?: ClaudeAdvisor | '';
  /** `provider/model` bots on other providers may ask for advice mid-turn; empty is off. Missing on older servers. */
  piAdvisorModel?: string;
  /** Long conversations are summarised while idle, before the size above is reached. Missing on older servers. */
  idleCompact?: boolean;
  /** The most the bots may spend in a day, in US dollars; 0 for none. Missing on older servers. */
  dailyLimitUsd?: number;
  timezone: string;
  /** The most the bots may spend in a calendar month, in US dollars; 0 for none. Missing on older servers. */
  monthlyLimitUsd?: number;
  /** The routine pre-check; missing on older servers. */
  routineGate?: RoutineGateMode;
  maxTurns?: number;
  /** Finished turns between two looks back at a conversation for lasting facts; 0 is off. Missing on older servers. */
  memoryReviewEvery?: number;
  /** Whether the person's own requests are looked at for something asked again and again; missing on older servers. */
  routineSuggestions?: boolean;
  /** Whether a bot tells the person, once a day, of what went wrong and waits on them; missing on older servers. */
  checkIns?: boolean;
  /** The person has seen the offer to move their bots from Grok Bot; missing on older servers. */
  grokMoveOffered?: boolean;
  /** The promise safety net after a bot's reply; missing on older servers. */
  promiseKeeper?: boolean;
  /** The time of day a reminder of the person's own promise arrives (HH:MM); missing on older servers. */
  promiseRemindAt?: string;
  /** The bots' browsers go out through the person's own computer; missing on older servers. */
  browserViaComputer?: boolean;
  modelTitles?: boolean;
  workOffers?: boolean;
  /** The domain bots receive mail at; empty when mail is off. Missing on older servers. */
  emailDomain?: string;
  /** Unset until a language is chosen; the app then stores the one it opened in. */
  language?: Locale;
}

/**
 * Typed endpoints of a LeafBot server; paths mirror the server routes. `send` makes one request
 * the way the platform does (cookies, timeout, errors); `base` goes before addresses handed to the
 * page or a viewer as they are (files, pages, downloads): empty on a page the server serves itself.
 */
export function endpoints(send: Transport, base = '') {
  const http = httpOf(send);
  return {
    /** `account` is missing on servers older than username and password sign-in. */
    session: () =>
      http.get<{ authenticated: boolean; account?: boolean; user?: SessionUser }>('/api/session'),
    /** Signs this browser in with a one-time pairing code from a signed-in device. */
    pair: (code: string) => http.post<{ ok: true }>('/api/pair', { code }),
    /** A one-time code that signs one more device in within five minutes. */
    pairingCode: () => http.post<{ code: string; expiresAt: string; url: string | null }>('/api/pairing'),
    access: (key: string) => http.post<{ ok: true }>('/api/access', { key }),
    login: (username: string, password: string) =>
      http.post<{ ok: true }>('/api/login', { username, password }),
    account: () => http.get<{ username: string | null }>('/api/account'),
    setAccount: (input: AccountSet) => http.put<{ username: string }>('/api/account', input),
    logout: () => http.post<{ ok: true }>('/api/logout'),
    sessions: () => http.get<SessionInfo[]>('/api/sessions'),
    /** Signs out one device, or with `others` every device but this one. */
    endSession: (id: string | 'others') =>
      http.del<{ ended: number }>(`/api/sessions/${encodeURIComponent(id)}`),
    info: () => http.get<ServerInfo>('/api/info'),
    checkClaude: () => http.post<ServerInfo['claude']>('/api/info/claude-check'),
    claudeAuth: () => http.get<ClaudeAuthStatus>('/api/claude/auth'),
    /** Saves a token or key, then tries it with one real request. */
    setClaudeAuth: (b: ClaudeAuthSet) => http.put<ServerInfo['claude']>('/api/claude/auth', b),
    clearClaudeAuth: () => http.del<ServerInfo['claude']>('/api/claude/auth'),
    claudeModels: () => http.get<ClaudeModel[]>('/api/claude/models'),
    /** Starts signing in to Claude with the person's own account; follow it with `claudeSignIn`. */
    startClaudeSignIn: () => http.post<ProviderSignIn>('/api/claude/sign-in', {}),
    claudeSignIn: (id: string) => http.get<ProviderSignIn>(`/api/claude/sign-in/${id}`),
    pasteClaudeSignIn: (id: string, input: string) =>
      http.post<ProviderSignIn>(`/api/claude/sign-in/${id}/paste`, { input }),
    cancelClaudeSignIn: (id: string) => http.del<{ ok: true }>(`/api/claude/sign-in/${id}`),
    /** This phone's push token and choices; the server sends notices that pass them. */
    pushDevice: (b: PushDeviceSet) => http.put<{ ok: true }>('/api/push/device', b),
    pushTest: (token: string) => http.post<{ ok: true }>('/api/push/test', { token }),
    /** A Live Activity this phone started for a conversation's work, for the server to keep current. */
    watchActivity: (threadId: string, b: LiveActivitySet) =>
      http.put<{ pushing: boolean }>(`/api/threads/${threadId}/activity`, b),
    /** The Apple key for iPhone notifications; write-only, reads say only which key it is. */
    apns: () => http.get<ApnsStatus>('/api/push/apns'),
    setApns: (b: ApnsSet) => http.put<ApnsStatus>('/api/push/apns', b),
    clearApns: () => http.del<ApnsStatus>('/api/push/apns'),
    /** A bot's own Telegram bot: never the token, which is write-only. */
    telegram: (botId: string) => http.get<TelegramStatus>(`/api/bots/${botId}/telegram`),
    connectTelegram: (botId: string, token: string) =>
      http.put<TelegramStatus>(`/api/bots/${botId}/telegram`, { token }),
    pairTelegram: (botId: string) => http.post<TelegramStatus>(`/api/bots/${botId}/telegram/pair`, {}),
    updateTelegram: (botId: string, patch: { notices: boolean }) =>
      http.patch<TelegramStatus>(`/api/bots/${botId}/telegram`, patch),
    disconnectTelegram: (botId: string) => http.del<{ ok: true }>(`/api/bots/${botId}/telegram`),
    whatsapp: () => http.get<WhatsAppStatus>('/api/whatsapp'),
    setWhatsapp: (b: WhatsAppSet) => http.put<WhatsAppStatus>('/api/whatsapp', b),
    linkWhatsapp: () => http.post<WhatsAppStatus>('/api/whatsapp/link', {}),
    whatsappGroups: () => http.get<WhatsAppGroup[]>('/api/whatsapp/groups'),
    disconnectWhatsapp: () => http.del<WhatsAppStatus>('/api/whatsapp'),
    slack: () => http.get<SlackStatus>('/api/slack'),
    connectSlack: (b: SlackConnect) => http.put<SlackStatus>('/api/slack', b),
    updateSlack: (b: { botId: string | null }) => http.patch<SlackStatus>('/api/slack', b),
    disconnectSlack: () => http.del<{ ok: true }>('/api/slack'),
    slackLink: () => http.get<SlackLink>('/api/slack/me'),
    slackCode: () => http.post<SlackLink>('/api/slack/me/code', {}),
    slackUnlink: () => http.del<SlackLink>('/api/slack/me'),
    teams: () => http.get<TeamsStatus>('/api/teams'),
    connectTeams: (b: TeamsConnect) => http.put<TeamsStatus>('/api/teams', b),
    updateTeams: (b: { botId: string | null }) => http.patch<TeamsStatus>('/api/teams', b),
    disconnectTeams: () => http.del<{ ok: true }>('/api/teams'),
    teamsLink: () => http.get<TeamsLink>('/api/teams/me'),
    teamsCode: () => http.post<TeamsLink>('/api/teams/me/code', {}),
    teamsUnlink: () => http.del<TeamsLink>('/api/teams/me'),
    discord: () => http.get<DiscordStatus>('/api/discord'),
    connectDiscord: (b: DiscordConnect) => http.put<DiscordStatus>('/api/discord', b),
    updateDiscord: (b: DiscordUpdate) => http.patch<DiscordStatus>('/api/discord', b),
    disconnectDiscord: () => http.del<{ ok: true }>('/api/discord'),
    settings: () => http.get<Settings>('/api/settings'),
    updateSettings: (p: Partial<Settings>) => http.patch<Settings>('/api/settings', p),
    people: () => http.get<PersonInfo[]>('/api/people'),
    addPerson: (p: PersonCreate) => http.post<PersonInfo>('/api/people', p),
    updatePerson: (id: string, p: PersonUpdate) => http.patch<PersonInfo>(`/api/people/${id}`, p),
    removePerson: (id: string) => http.del<{ ok: true }>(`/api/people/${id}`),
    /** Invites through the Leaf Bot account: someone new, or someone here (`personId`) to their account. */
    invitePerson: (p: PersonInvite) => http.post<{ id: string; expiresAt: number }>('/api/people/invites', p),
    personInvites: () => http.get<{ invites: AccountInvite[] }>('/api/people/invites'),
    revokeInvite: (id: string) => http.del<{ ok: true }>(`/api/people/invites/${id}`),
    setBotAccess: (id: string, access: BotAccess) => http.put<Bot>(`/api/bots/${id}/access`, access),
    /** Models that make pictures through a saved key; the chosen one is the `imageModel` setting. */
    imageModels: () => http.get<{ models: ImageModel[] }>('/api/images/models'),
    /** A square picture made from a description of the avatar, as a data URL. */
    makeAvatar: (description: string, model?: string) =>
      http.post<{ image: string; model: string }>('/api/images/avatar', { description, model }),
    providers: () => http.get<ProviderInfo[]>('/api/providers'),
    providerModels: (id: string) => http.get<string[]>(`/api/providers/${encodeURIComponent(id)}/models`),
    providerModelInfo: (id: string) =>
      http.get<ModelInfo[]>(`/api/providers/${encodeURIComponent(id)}/model-info`),
    setProviderKey: (id: string, key: string) =>
      http.put<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/key`, { key }),
    testProviderModel: (id: string, model: string) =>
      http.post<{ ok: true } | { ok: false; detail: string }>(
        `/api/providers/${encodeURIComponent(id)}/test`,
        {
          model,
        },
      ),
    removeProviderKey: (id: string) => http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}/key`),
    /** Starts signing in to a provider with the person's plan; follow it with `signIn`. */
    startSignIn: (provider: string, enterprise?: string) =>
      http.post<ProviderSignIn>(`/api/providers/${encodeURIComponent(provider)}/sign-in`, { enterprise }),
    signIn: (id: string) => http.get<ProviderSignIn>(`/api/sign-ins/${id}`),
    pasteSignIn: (id: string, input: string) =>
      http.post<ProviderSignIn>(`/api/sign-ins/${id}/paste`, { input }),
    cancelSignIn: (id: string) => http.del<{ ok: true }>(`/api/sign-ins/${id}`),
    signOut: (provider: string) =>
      http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(provider)}/sign-in`),
    addEndpoint: (input: CustomEndpointCreate) => http.post<ProviderInfo>('/api/providers/custom', input),
    discoverEndpoints: () =>
      http.get<{ name: string; baseUrl: string; models: string[] }[]>('/api/providers/discover'),
    updateEndpoint: (id: string, patch: CustomEndpointUpdate) =>
      http.patch<ProviderInfo>(`/api/providers/${encodeURIComponent(id)}`, patch),
    refreshEndpoint: (id: string) =>
      http.post<string[]>(`/api/providers/${encodeURIComponent(id)}/refresh`, {}),
    removeEndpoint: (id: string) => http.del<{ ok: true }>(`/api/providers/${encodeURIComponent(id)}`),

    bots: () => http.get<Bot[]>('/api/bots'),
    bot: (id: string) => http.get<Bot>(`/api/bots/${id}`),
    createBot: (b: unknown) => http.post<Bot>('/api/bots', b),
    updateBot: (id: string, b: unknown) => http.patch<Bot>(`/api/bots/${id}`, b),
    checkInstructionsDoc: (id: string) => http.post<Bot>(`/api/bots/${id}/instructions/check`, {}),
    acceptInstructionsDoc: (id: string, expected: string) =>
      http.post<Bot>(`/api/bots/${id}/instructions/accept`, { expected }),
    declineInstructionsDoc: (id: string) => http.post<Bot>(`/api/bots/${id}/instructions/decline`, {}),
    /** Moves every active bot to what new bots start with; says how many changed. */
    moveBotsToNewEngine: () => http.post<{ changed: number }>('/api/bots/engine'),
    archiveBot: (id: string) => http.post<Bot>(`/api/bots/${id}/archive`),
    botSpend: (id: string) => http.get<{ dayUsd: number; monthUsd: number }>(`/api/bots/${id}/spend`),
    pauseBot: (id: string, paused: boolean) => http.post<Bot>(`/api/bots/${id}/pause`, { paused }),
    pauseAllBots: (paused: boolean) => http.post<{ count: number }>('/api/bots/pause-all', { paused }),
    today: () => http.get<TodayReport>('/api/today'),
    /** Pins a message above its conversation; null takes the pin away. */
    pinMessage: (threadId: string, messageId: string | null) =>
      http.put<Thread>(`/api/threads/${threadId}/pin`, { messageId }),
    /** A new conversation copied from this message's up to it. */
    forkFrom: (messageId: string) => http.post<Thread>(`/api/messages/${messageId}/fork`),
    updateThread: (
      id: string,
      patch: {
        title?: string;
        archived?: boolean;
        snoozedUntil?: string | null;
        pinned?: boolean;
        icon?: string;
      },
    ) => http.patch<Thread>(`/api/threads/${id}`, patch),
    /** Sets what a conversation is for; empty clears it. */
    setGoal: (threadId: string, goal: string) => http.patch<Thread>(`/api/threads/${threadId}`, { goal }),
    /** Deletes every conversation of the bot but its main one. */
    clearThreads: (botId: string) => http.del<{ deleted: number }>(`/api/bots/${botId}/threads`),
    fetchSkill: (url: string) => http.post<{ text: string; name: string }>('/api/skills/fetch', { url }),
    setupProjects: () =>
      http.get<{
        available: boolean;
        projects: { path: string; name: string; sources: string[]; lastUsed: string | null }[];
      }>('/api/setup-import/projects'),
    setupImport: () =>
      http.get<{
        available: boolean;
        skills: { name: string; description: string; source: string; warnings: SkillWarning[] }[];
        servers: { name: string; url: string; source: string }[];
      }>('/api/setup-import'),
    runSetupImport: (body: { skills: string[]; servers: string[] }) =>
      http.post<{ skills: number; servers: number }>('/api/setup-import', body),
    restoreBot: (id: string) => http.post<Bot>(`/api/bots/${id}/restore`),
    archivedBots: () =>
      http.get<Bot[]>('/api/bots?archived=1').then((list) => list.filter((b) => b.archivedAt)),
    /** Deletes an archived bot for good, with its conversations and files. */
    deleteBot: (id: string) => http.del<{ ok: true }>(`/api/bots/${id}`),
    moveBot: (id: string, to: BotMove) => http.post<Bot>(`/api/bots/${id}/move`, to),
    summaries: () => http.get<BotSummary[]>('/api/summaries'),
    skills: () => http.get<Skill[]>('/api/skills'),
    createSkill: (input: SkillCreate) => http.post<Skill>('/api/skills', input),
    updateSkill: (id: string, patch: SkillUpdate) => http.patch<Skill>(`/api/skills/${id}`, patch),
    removeSkill: (id: string) => http.del<{ ok: true }>(`/api/skills/${id}`),
    /** Does a taught skill again in the bot's browser without the model. */
    replaySkill: (botId: string, skillId: string) =>
      http.post<ReplayResult>(`/api/bots/${botId}/skills/${skillId}/replay`),
    setSkillBot: (id: string, botId: string, on: boolean) =>
      http.put<Skill>(`/api/skills/${id}/bots/${botId}`, { on }),
    skillChanges: () => http.get<SkillChange[]>('/api/skill-changes'),
    acceptSkillChange: (id: string) => http.post<Skill>(`/api/skill-changes/${id}/accept`),
    rejectSkillChange: (id: string) => http.post<{ ok: true }>(`/api/skill-changes/${id}/reject`),
    enableWebhook: (id: string) => http.post<Routine>(`/api/routines/${id}/webhook`, {}),
    disableWebhook: (id: string) => http.del<Routine>(`/api/routines/${id}/webhook`),
    setWebhookSecret: (id: string, secret: string | null) =>
      http.put<Routine>(`/api/routines/${id}/webhook-secret`, { secret }),
    usage: (days: UsageRange, botId?: string) =>
      http.get<UsageReport>(`/api/usage?days=${days}${botId ? `&bot=${encodeURIComponent(botId)}` : ''}`),
    planUsage: () => http.get<{ plan: UsageReport['plan'] | null }>('/api/usage/plan'),
    storage: () => http.get<StorageReport>('/api/storage'),
    openBrowserWindow: (botId: string, url?: string) =>
      http.post<{ ok: true }>(`/api/bots/${botId}/browser/window`, { url }),
    closeBrowserWindow: (botId: string) => http.del<{ ok: true }>(`/api/bots/${botId}/browser/window`),

    groups: () => http.get<Group[]>('/api/groups'),
    createGroup: (name: string, opts: Omit<GroupCreate, 'name'> = {}) =>
      http.post<Group>('/api/groups', { name, ...opts }),
    renameGroup: (id: string, name: string) => http.patch<Group>(`/api/groups/${id}`, { name }),
    updateGroup: (id: string, patch: GroupUpdate) => http.patch<Group>(`/api/groups/${id}`, patch),
    /** Those who wait for their team spaces to be chosen; for those who look after the server. */
    newcomers: () => http.get<PersonInfo[]>('/api/newcomers'),
    placeNewcomer: (personId: string, spaceIds: string[]) =>
      http.post<{ ok: true }>(`/api/newcomers/${personId}`, { spaceIds }),
    privateBots: (personId: string) => http.get<PrivateBots>(`/api/people/${personId}/private-bots`),
    pausePrivateBots: (personId: string, paused: boolean) =>
      http.post<PrivateBots>(`/api/people/${personId}/private-bots/pause`, { paused }),
    archivePrivateBots: (personId: string) =>
      http.post<PrivateBots>(`/api/people/${personId}/private-bots/archive`, {}),
    joinSpace: (id: string) => http.post<SpaceJoin>(`/api/groups/${id}/join`, {}),
    /** Leaves the space, or takes back the request to join it. */
    leaveSpace: (id: string) => http.post<{ ok: true }>(`/api/groups/${id}/leave`, {}),
    spaceRequests: () => http.get<SpaceRequest[]>('/api/space-requests'),
    answerSpaceRequest: (id: string, decision: 'allow' | 'deny') =>
      http.post<{ ok: true }>(`/api/space-requests/${id}`, { decision }),
    setSpaceMembers: (id: string, change: SpaceMembersChange) =>
      http.put<Group>(`/api/groups/${id}/members`, change),
    moveGroup: (id: string, to: GroupMove) => http.post<Group>(`/api/groups/${id}/move`, to),
    deleteGroup: (id: string) => http.del<{ ok: true }>(`/api/groups/${id}`),
    pauseGroup: (id: string, paused: boolean) => http.post<Group>(`/api/groups/${id}/pause`, { paused }),

    threads: (botId: string) => http.get<Thread[]>(`/api/bots/${botId}/threads`),
    mainThread: (botId: string) => http.get<Thread>(`/api/bots/${botId}/main-thread`),
    newThread: (botId: string) => http.post<Thread>(`/api/bots/${botId}/threads`, {}),
    rooms: () => http.get<Room[]>('/api/rooms'),
    createRoom: (input: RoomCreate) => http.post<Room>('/api/rooms', input),
    updateRoom: (id: string, patch: RoomUpdate) => http.patch<Room>(`/api/rooms/${id}`, patch),
    deleteRoom: (id: string) => http.del<{ ok: true }>(`/api/rooms/${id}`),
    setRoomPeople: (id: string, change: { add?: string[]; remove?: string[] }) =>
      http.put<Room>(`/api/rooms/${id}/people`, change),
    leaveRoom: (id: string) => http.post<{ ok: true }>(`/api/rooms/${id}/leave`),
    roomUnshared: (id: string) => http.get<Record<string, string[]>>(`/api/rooms/${id}/unshared`),
    sendToRoom: (id: string, clientId: string, text: string, replyTo?: string) =>
      http.post<Message>(`/api/rooms/${id}/messages`, { clientId, text, replyTo }),
    stopRoom: (id: string) => http.post<{ stopped: boolean }>(`/api/rooms/${id}/stop`),
    resetRoom: (id: string) => http.post<{ ok: true }>(`/api/rooms/${id}/reset`),
    meetings: (roomId: string) => http.get<Meeting[]>(`/api/rooms/${roomId}/meetings`),
    startMeeting: (roomId: string) => http.post<Meeting>(`/api/rooms/${roomId}/meetings`),
    answerMeeting: (roomId: string, id: string, answer: MeetingAnswer['answer']) =>
      http.post<Meeting>(`/api/rooms/${roomId}/meetings/${id}/answer`, { answer }),
    endMeeting: (roomId: string, id: string) => http.post<Meeting>(`/api/rooms/${roomId}/meetings/${id}/end`),
    resumeMeeting: (roomId: string, id: string) =>
      http.post<Meeting>(`/api/rooms/${roomId}/meetings/${id}/resume`),
    retryMeeting: (roomId: string, id: string) =>
      http.post<Meeting>(`/api/rooms/${roomId}/meetings/${id}/retry`),
    saveMeeting: (roomId: string, id: string, body: MeetingSave) =>
      http.post<Meeting>(`/api/rooms/${roomId}/meetings/${id}/save`, body),
    deleteMeeting: (roomId: string, id: string) =>
      http.del<{ ok: true }>(`/api/rooms/${roomId}/meetings/${id}`),
    thread: (id: string) => http.get<Thread>(`/api/threads/${id}`),
    deleteThread: (id: string) => http.del<{ ok: true }>(`/api/threads/${id}`),
    resetThread: (id: string) => http.post<{ ok: true }>(`/api/threads/${id}/reset`),
    /** What the bot has written so far of the reply it is writing; null when nothing runs. */
    live: (threadId: string) => http.get<{ live: LiveText | null }>(`/api/threads/${threadId}/live`),
    /**
     * The latest messages, or with `before` the ones just older than that message. With no
     * `limit` the server sends its full page; a server from before `limit` sends that page anyway.
     */
    messages: (threadId: string, before?: string, limit?: number) => {
      const query = new URLSearchParams();
      if (before) query.set('before', before);
      if (limit) query.set('limit', String(limit));
      const qs = query.toString();
      return http.get<Message[]>(`/api/threads/${threadId}/messages${qs ? `?${qs}` : ''}`);
    },
    send: (
      threadId: string,
      clientId: string,
      text: string,
      files: string[] = [],
      replyTo?: string,
      offline?: boolean,
      spoken?: boolean,
      /** The socket id of the Chrome extension's panel it is sent from, while it shares Chrome. */
      chrome?: string,
    ) =>
      http.post<Message>(`/api/threads/${threadId}/messages`, {
        clientId,
        text,
        files,
        replyTo,
        ...(offline && { offline: true }),
        ...(spoken && { spoken: true }),
        ...(chrome && { chrome }),
      }),
    search: (q: string, opts: { threadId?: string; limit?: number } = {}) =>
      http.get<SearchHit[]>(
        `/api/search?q=${encodeURIComponent(q)}` +
          (opts.threadId ? `&threadId=${encodeURIComponent(opts.threadId)}` : '') +
          (opts.limit ? `&limit=${opts.limit}` : ''),
      ),
    editMessage: (id: string, text: string) => http.patch<Message>(`/api/messages/${id}`, { text }),
    removeMessage: (id: string) => http.del<{ ok: true }>(`/api/messages/${id}`),
    retryMessage: (id: string) => http.post<{ ok: true; turnId: string }>(`/api/messages/${id}/retry`),
    acpAgents: () => http.get<AcpAgentState[]>('/api/acp-agents'),
    personComputer: () => http.get<PersonComputerState>('/api/person-computer'),
    requestPersonComputer: (pane?: ComputerPermission) =>
      http.post<PersonComputerState>('/api/person-computer/request', pane ? { pane } : {}),
    /** This server's link to a Leaf Bot account, through which the web app reaches it. */
    accountHost: () => http.get<AccountHostState>('/api/account-host'),
    linkAccountHost: (code: string, name?: string) =>
      http.post<AccountHostState>('/api/account-host', { code, ...(name ? { name } : {}) }),
    unlinkAccountHost: () => http.del<AccountHostState>('/api/account-host'),
    /** Signs the owner in to their account by an emailed code; the server links itself on the way. */
    accountSignInStart: (email: string) => http.post<{ ok: true }>('/api/account-host/email', { email }),
    accountSignInVerify: (email: string, code: string) =>
      http.post<AccountSignedIn>('/api/account-host/verify', { email, code }),
    accountSetName: (name: string) =>
      http.post<{ name: string; savedToAccount: boolean }>('/api/account-host/name', { name }),
    tailscale: () => http.get<TailscaleState>('/api/tailscale'),
    setTailscale: (on: boolean) => http.post<TailscaleState>('/api/tailscale', { on }),
    linkPreview: (url: string) =>
      http.get<{ preview: LinkPreview | null }>(`/api/link-preview?url=${encodeURIComponent(url)}`),
    answerOffer: (id: string, take: boolean) => http.post<Message>(`/api/messages/${id}/offer`, { take }),
    /** A press on a bot's card; the card comes back settled, and the answer is the person's next message. */
    answerCard: (id: string, answer: CardAnswer) => http.post<Message>(`/api/messages/${id}/card`, answer),
    /** A tick on a card's checklist item; the card comes back with it kept, and stays open. */
    tickCard: (id: string, tick: CardTick) => http.post<Message>(`/api/messages/${id}/card/tick`, tick),
    /** A tool call an MCP app's view makes, through the server to its own connection. */
    appCall: (messageId: string, name: string, args: Record<string, unknown>) =>
      http.post<unknown>(`/api/apps/${messageId}/call`, { name, arguments: args }),
    react: (messageId: string, emoji: string | null) =>
      http.put<Message>(`/api/messages/${messageId}/reaction`, { emoji }),
    /**
     * Puts a file in the conversation's folder; the server may pick another name if it is taken.
     * `uploadId` is the same on a second try, so the server keeps one copy (see the shared retry).
     */
    uploadFile: (threadId: string, name: string, file: Blob, opts: UploadOptions = {}) =>
      send<{ name: string; size: number }>(
        'POST',
        `/api/threads/${threadId}/files?name=${encodeURIComponent(name)}${
          opts.uploadId ? `&uploadId=${encodeURIComponent(opts.uploadId)}` : ''
        }`,
        file,
        { onProgress: opts.onProgress, signal: opts.signal },
      ),
    /** Calls off a file still going up; `keepalive` as for {@link removeFile}. */
    cancelUpload: (threadId: string, uploadId: string, opts: { keepalive?: boolean } = {}) =>
      send<{ ok: true }>(
        'DELETE',
        `/api/threads/${threadId}/uploads/${encodeURIComponent(uploadId)}`,
        undefined,
        opts,
      ),
    /** `keepalive`: sent while the page closes, so the request outlives it. */
    removeFile: (threadId: string, name: string, opts: { keepalive?: boolean } = {}) =>
      send<{ ok: true }>(
        'DELETE',
        `/api/threads/${threadId}/files/${encodeURIComponent(name)}`,
        undefined,
        opts,
      ),
    stop: (threadId: string) => http.post<{ stopped: boolean }>(`/api/threads/${threadId}/stop`),
    job: (id: string) => http.get<JobView>(`/api/jobs/${id}`),
    /** Stops a command a bot runs on the person's own computer. */
    stopPersonJob: (id: string) => http.post<{ stopped: boolean }>(`/api/person-jobs/${id}/stop`),

    approvals: () => http.get<Approval[]>('/api/approvals'),
    /** Only the cards that still wait for an answer. */
    pendingApprovals: () => http.get<Approval[]>('/api/approvals?status=pending'),
    /** Steps waiting for this person's second yes, without the conversations they come from. */
    secondYes: () => http.get<SecondYes[]>('/api/approvals-second'),
    answerSecond: (id: string, decision: 'allow' | 'deny') =>
      http.post<Approval>(`/api/approvals-second/${id}`, { decision }),
    /** Who could give a second yes on a bot's steps; on every bot's without a bot. */
    approvers: (botId?: string | null) =>
      http.get<Approver[]>(`/api/approvers${botId ? `?botId=${encodeURIComponent(botId)}` : ''}`),
    answer: (
      id: string,
      d: {
        decision: 'allow' | 'deny';
        answer?: string;
        answers?: string[];
        remember?: boolean;
        login?: { username: string; password: string; save: boolean; exact?: boolean };
      },
    ) => http.post<Approval>(`/api/approvals/${id}`, d),
    connections: () => http.get<Connection[]>('/api/connections'),
    connectionRedirectUrl: () => http.get<{ url: string }>('/api/connections/redirect-url'),
    addConnection: (c: ConnectionCreate) => http.post<Connection>('/api/connections', c),
    updateConnection: (id: string, c: ConnectionUpdate) =>
      http.patch<Connection>(`/api/connections/${id}`, c),
    removeConnection: (id: string) => http.del<{ ok: true }>(`/api/connections/${id}`),
    connectionSender: (id: string) => http.get<MailSender>(`/api/connections/${id}/sender`),
    refreshConnection: (id: string) => http.post<Connection>(`/api/connections/${id}/refresh`, {}),
    signInConnection: (id: string) => http.post<ConnectionAuthStart>(`/api/connections/${id}/signin`, {}),
    signOutConnection: (id: string) => http.post<Connection>(`/api/connections/${id}/signout`, {}),
    setConnectionTool: (id: string, name: string, patch: ConnectionToolPatch) =>
      http.patch<Connection>(`/api/connections/${id}/tools/${encodeURIComponent(name)}`, patch),
    setConnectionBots: (id: string, access: ConnectionBots) =>
      http.put<Connection>(`/api/connections/${id}/bots`, access),
    vault: () => http.get<VaultLogin[]>('/api/vault'),
    addVaultLogin: (v: VaultLoginCreate) => http.post<VaultLogin>('/api/vault', v),
    updateVaultLogin: (id: string, v: VaultLoginUpdate) => http.patch<VaultLogin>(`/api/vault/${id}`, v),
    removeVaultLogin: (id: string) => http.del<{ ok: true }>(`/api/vault/${id}`),
    importVault: (v: VaultImport) => http.post<VaultImportResult>('/api/vault/import', v),
    passwordManagers: () => http.get<PasswordManager[]>('/api/password-managers'),
    addPasswordManager: (v: PasswordManagerCreate) => http.post<PasswordManager>('/api/password-managers', v),
    updatePasswordManager: (id: string, v: PasswordManagerUpdate) =>
      http.patch<PasswordManager>(`/api/password-managers/${id}`, v),
    refreshPasswordManager: (id: string) =>
      http.post<PasswordManager>(`/api/password-managers/${id}/refresh`, {}),
    removePasswordManager: (id: string) => http.del<{ ok: true }>(`/api/password-managers/${id}`),
    cards: () => http.get<PaymentCard[]>('/api/cards'),
    addCard: (v: PaymentCardCreate) => http.post<PaymentCard>('/api/cards', v),
    updateCard: (id: string, v: PaymentCardUpdate) => http.patch<PaymentCard>(`/api/cards/${id}`, v),
    removeCard: (id: string) => http.del<{ ok: true }>(`/api/cards/${id}`),
    contacts: () => http.get<ContactDetails[]>('/api/contacts'),
    addContact: (v: ContactDetailsCreate) => http.post<ContactDetails>('/api/contacts', v),
    updateContact: (id: string, v: ContactDetailsUpdate) =>
      http.patch<ContactDetails>(`/api/contacts/${id}`, v),
    removeContact: (id: string) => http.del<{ ok: true }>(`/api/contacts/${id}`),
    rules: () => http.get<PermissionRule[]>('/api/rules'),
    botActions: (botId: string, limit = 100) =>
      http.get<BotAction[]>(`/api/bots/${botId}/actions?limit=${limit}`),
    suggestions: (botId: string) => http.get<PermissionSuggestions>(`/api/bots/${botId}/suggestions`),
    dismissSuggestion: (botId: string, key: string) =>
      http.post<{ ok: true }>(`/api/bots/${botId}/suggestions/dismiss`, { key }),
    addRule: (r: {
      list: 'ask' | 'allow' | 'block';
      pattern: string;
      botId?: string | null;
      field?: string;
      limit?: number;
      secondPerson?: boolean;
      secondUserId?: string | null;
    }) => http.post<PermissionRule>('/api/rules', r),
    removeRule: (id: string) => http.del<{ ok: true }>(`/api/rules/${id}`),

    memory: () => http.get<Memory[]>('/api/memory'),
    memoryGraph: () => http.get<MemoryGraph>('/api/memory/graph'),
    addMemory: (m: {
      scope: 'bot' | 'user' | 'common';
      botId?: string | null;
      content: string;
      site?: string | null;
      validUntil?: string | null;
    }) => http.post<Memory>('/api/memory', m),
    updateMemory: (
      id: string,
      p: {
        content?: string;
        pinned?: boolean;
        validUntil?: string | null;
        updatedAt?: string;
        /** The person says the note is right: it is no longer marked as written from outside text. */
        verified?: true;
      },
    ) => http.patch<Memory>(`/api/memory/${id}`, p),
    memoryHistory: () => http.get<MemoryHistoryLine[]>('/api/memory-history'),
    removeMemory: (id: string) => http.del<{ ok: true }>(`/api/memory/${id}`),
    /** Deletes every note the bot keeps for itself. */
    removeBotMemory: (botId: string) => http.del<{ count: number }>(`/api/bots/${botId}/memory`),
    staleMemory: () => http.get<Memory[]>('/api/memory-stale'),
    removeStaleMemory: (ids: string[]) => http.post<{ count: number }>('/api/memory-stale/delete', { ids }),
    /** Memory changes bots asked for while nobody watched; they wait for the person. */
    memoryChanges: () => http.get<MemoryChange[]>('/api/memory-changes'),
    acceptMemoryChange: (id: string) => http.post<{ ok: true }>(`/api/memory-changes/${id}/accept`, {}),
    rejectMemoryChange: (id: string) => http.del<{ ok: true }>(`/api/memory-changes/${id}`),
    /** Gaps bots found in what they know and could not fill themselves. */
    memoryFlags: () => http.get<MemoryFlag[]>('/api/memory/flags'),
    answerMemoryFlag: (id: string, text: string) =>
      http.post<{ ok: true }>(`/api/memory/flags/${id}/answer`, { text }),
    dismissMemoryFlag: (id: string) => http.post<{ ok: true }>(`/api/memory/flags/${id}/dismiss`, {}),

    routines: () => http.get<Routine[]>('/api/routines'),
    createRoutine: (r: unknown) => http.post<Routine>('/api/routines', r),
    updateRoutine: (id: string, p: unknown) => http.patch<Routine>(`/api/routines/${id}`, p),
    removeRoutine: (id: string) => http.del<{ ok: true }>(`/api/routines/${id}`),
    /** Runs it now; `inputs` are values typed for this run's inputs. */
    runRoutine: (id: string, inputs?: Record<string, string>) =>
      http.post<RoutineRun | null>(`/api/routines/${id}/run`, inputs ? { inputs } : undefined),
    routineFailureSeen: (id: string) => http.post<{ ok: true }>(`/api/routines/${id}/failure-seen`),
    routineRuns: (id: string) => http.get<RoutineRun[]>(`/api/routines/${id}/runs`),
    retryRoutineRun: (id: string, runId: string) =>
      http.post<RoutineRun>(`/api/routines/${id}/runs/${runId}/retry`),
    endRoutineWait: (id: string, runId: string) =>
      http.post<RoutineRun>(`/api/routines/${id}/runs/${runId}/end-wait`),
    routineRevisions: (id: string) => http.get<RoutineRevision[]>(`/api/routines/${id}/revisions`),
    /** A change to the routine proposed from its last runs; nothing changes until it is applied. */
    proposeRoutineFix: (id: string) => http.post<RoutineFix>(`/api/routines/${id}/fix`),
    routineVersions: (id: string) => http.get<RoutineVersionReport>(`/api/routines/${id}/versions`),
    unused: () => http.get<UnusedReport>('/api/unused'),
    routineHealth: () => http.get<RoutineHealth[]>('/api/routines/health'),
    dismissRoutineHealth: (id: string, finding: RoutineHealthFindingId) =>
      http.post<RoutineHealth>(`/api/routines/${id}/health/dismiss`, { finding }),
    rehearseRoutine: (id: string, body: RehearsalStart) =>
      http.post<Rehearsal>(`/api/routines/${id}/rehearse`, body),
    routineRehearsals: (id: string) => http.get<Rehearsal[]>(`/api/routines/${id}/rehearsals`),
    routineReplayable: (id: string) => http.get<ReplayableRun[]>(`/api/routines/${id}/replayable`),

    library: (botId: string) => http.get<LibraryFile[]>(`/api/bots/${botId}/library`),
    /** `inline`: an image to show on the page rather than a download. */
    /** `thumb` asks for a small copy of a picture, for showing it in a conversation. */
    fileUrl: (botId: string, path: string, opts: { inline?: boolean; thumb?: boolean } = {}) =>
      `${base}/api/bots/${botId}/library/file?path=${encodeURIComponent(path)}${opts.inline ? '&inline=1' : ''}${opts.thumb ? '&thumb=1' : ''}`,
    /** A page the bot made, served to run in the app's sandboxed frame. */
    pageUrl: (botId: string, path: string, height?: number, theme?: 'light' | 'dark') =>
      `${base}/api/bots/${botId}/library/page?path=${encodeURIComponent(path)}${height ? `&h=${height}` : ''}${theme ? `&theme=${theme}` : ''}`,
    teachStatus: (botId: string) => http.get<{ steps: number | null }>(`/api/bots/${botId}/teach`),
    startTeaching: (botId: string) => http.post<{ steps: number }>(`/api/bots/${botId}/teach`),
    stopTeaching: (botId: string, goal: string) =>
      http.post<{ name: string; description: string; body: string; steps: number; taught: TaughtStep[] }>(
        `/api/bots/${botId}/teach/stop`,
        {
          goal,
        },
      ),
    contentEncryption: () =>
      http.get<{ on: boolean; pending: number; unreadable: number; converting: boolean }>(
        '/api/content-encryption',
      ),
    setContentEncryption: (on: boolean) =>
      http.put<{ on: boolean; pending: number; unreadable: number; converting: boolean }>(
        '/api/content-encryption',
        {
          on,
        },
      ),
    botTables: (botId: string) => http.get<BotTable[]>(`/api/bots/${botId}/tables`),
    tableRows: (id: string) => http.get<TableRow[]>(`/api/tables/${id}/rows`),
    addTableRow: (id: string, values: RowValues = {}) =>
      http.post<TableRow>(`/api/tables/${id}/rows`, values),
    updateTableRow: (id: string, rowId: string, values: RowValues) =>
      http.patch<TableRow>(`/api/tables/${id}/rows/${rowId}`, values),
    deleteTableRow: (id: string, rowId: string) =>
      http.del<{ deleted: number }>(`/api/tables/${id}/rows/${rowId}`),
    removeTable: (id: string) => http.del<{ ok: true }>(`/api/tables/${id}`),
    /** Lays the table out another way, for everyone who opens it. */
    setTableView: (id: string, view: TableView) => http.put<BotTable>(`/api/tables/${id}/view`, view),
    /** The other bots let into a table. */
    tableShares: (id: string) => http.get<TableShare[]>(`/api/tables/${id}/shares`),
    shareTable: (id: string, botId: string, write: boolean) =>
      http.put<TableShare>(`/api/tables/${id}/shares/${botId}`, { write }),
    unshareTable: (id: string, botId: string) => http.del<{ ok: true }>(`/api/tables/${id}/shares/${botId}`),
    dashboards: () => http.get<DashboardSummary[]>('/api/dashboards'),
    dashboard: (id: string) => http.get<DashboardView>(`/api/dashboards/${id}`),
    removeDashboard: (id: string) => http.del<{ ok: true }>(`/api/dashboards/${id}`),
    removeDashboardTile: (id: string) => http.del<{ ok: true }>(`/api/dashboard-tiles/${id}`),
    moveDashboardTile: (id: string, direction: 'earlier' | 'later') =>
      http.post<{ ok: true }>(`/api/dashboard-tiles/${id}/move`, { direction }),
    /** Puts a tile just before another, or last when `beforeId` is null. */
    placeDashboardTile: (id: string, beforeId: string | null) =>
      http.post<{ ok: true }>(`/api/dashboard-tiles/${id}/move`, { beforeId }),
    /** Where the table downloads as a CSV file. */
    tableCsvUrl: (id: string) => `${base}/api/tables/${id}/rows.csv`,
    tickets: () => http.get<Ticket[]>('/api/tickets'),
    createTicket: (input: TicketCreate) => http.post<Ticket>('/api/tickets', input),
    updateTicket: (id: string, patch: TicketUpdate) => http.patch<Ticket>(`/api/tickets/${id}`, patch),
    removeTicket: (id: string) => http.del<{ ok: true }>(`/api/tickets/${id}`),
    commentTicket: (id: string, text: string) => http.post<Ticket>(`/api/tickets/${id}/comments`, { text }),
    apiSources: () => http.get<ApiSource[]>('/api/api-sources'),
    addApiSource: (input: ApiSourceCreate) => http.post<ApiSource>('/api/api-sources', input),
    refreshApiSource: (id: string) => http.post<ApiSource>(`/api/api-sources/${id}/refresh`),
    removeApiSource: (id: string) => http.del<{ ok: true }>(`/api/api-sources/${id}`),
    previewPlugin: (url: string) => http.post<PluginPlan>('/api/plugins/preview', { url }),
    installPlugin: (input: PluginInstall) => http.post<PluginInstallResult>('/api/plugins/install', input),
    aiEndpoints: () =>
      http.get<AiEndpoints & { memoryIndex: { indexed: number; total: number } }>('/api/ai-endpoints'),
    setAiEndpoint: (kind: AiKind, input: AiEndpointSet) =>
      http.put<AiEndpoint>(`/api/ai-endpoints/${kind}`, input),
    clearAiEndpoint: (kind: AiKind) => http.del<AiEndpoint>(`/api/ai-endpoints/${kind}`),
    testAiEndpoint: (kind: AiKind) =>
      http.post<{ ok: boolean; detail: string }>(`/api/ai-endpoints/${kind}/test`),
    /** Whether replies can be read aloud by the server's speech service. */
    speechStatus: () => http.get<{ available: boolean }>('/api/speech'),
    emailSettings: () => http.get<EmailSettings>('/api/email'),
    renewEmailSecret: () => http.post<EmailSettings>('/api/email/secret'),
    claimEmail: (botId: string, name: string) =>
      http.post<EmailSettings>(`/api/bots/${botId}/email`, { name }),
    releaseEmail: (botId: string) => http.del<EmailSettings>(`/api/bots/${botId}/email`),
    doctor: () => http.get<DoctorReport>('/api/doctor'),
    repairDoctor: (checks: DoctorCheckId[]) => http.post<DoctorReport>('/api/doctor/repair', { checks }),
    setEmailCodes: (botId: string, on: boolean) =>
      http.put<EmailSettings>(`/api/bots/${botId}/email/codes`, { on }),
    apiKeys: () => http.get<ApiCredential[]>('/api/api-keys'),
    addApiKey: (input: ApiCredentialCreate) => http.post<ApiCredential>('/api/api-keys', input),
    updateApiKey: (id: string, input: ApiCredentialUpdate) =>
      http.patch<ApiCredential>(`/api/api-keys/${id}`, input),
    removeApiKey: (id: string) => http.del<{ ok: true }>(`/api/api-keys/${id}`),
    addTrapKey: (input: TrapKeyCreate) => http.post<ApiCredential>('/api/api-keys/trap', input),
    routineSuggestions: () => http.get<RoutineSuggestion[]>('/api/routine-suggestions'),
    acceptRoutineSuggestion: (id: string, input: RoutineSuggestionAccept) =>
      http.post<Routine>(`/api/routine-suggestions/${id}/accept`, input),
    dismissRoutineSuggestion: (id: string) =>
      http.post<{ ok: true }>(`/api/routine-suggestions/${id}/dismiss`, {}),
    skillSuggestions: () => http.get<SkillSuggestion[]>('/api/skill-suggestions'),
    acceptSkillSuggestion: (id: string, input: SkillSuggestionAccept) =>
      http.post<Skill>(`/api/skill-suggestions/${id}/accept`, input),
    dismissSkillSuggestion: (id: string) =>
      http.post<{ ok: true }>(`/api/skill-suggestions/${id}/dismiss`, {}),
    /** The turns of a conversation with something to put back, with how many changes each made. */
    turnChangesPending: (threadId: string) =>
      http.get<Record<string, number>>(`/api/threads/${threadId}/turn-changes`),
    turnChanges: (turnId: string) => http.get<TurnChanges>(`/api/turns/${turnId}/changes`),
    actionLog: (threadId: string) => http.get<TurnLogEntry[]>(`/api/threads/${threadId}/action-log`),
    undoTurn: (turnId: string) => http.post<TurnChanges>(`/api/turns/${turnId}/undo`, {}),
    canaryAlarmSeen: (id: string) => http.post<{ ok: true }>(`/api/canary-alarms/${id}/seen`, {}),
    importApiKeys: (input: ApiKeyImport) => http.post<ApiKeyImportResult>('/api/api-keys/import', input),
    /** The page opened on its own, with the print dialog, to save it as a PDF. */
    pagePrintUrl: (botId: string, path: string) =>
      `${base}/api/bots/${botId}/library/page?path=${encodeURIComponent(path)}&print=1`,
    pageShare: (botId: string, path: string) =>
      http.get<{ share: PageShare | null }>(
        `/api/bots/${botId}/library/share?path=${encodeURIComponent(path)}`,
      ),
    sharePage: (botId: string, path: string, name: string) =>
      http.post<PageShare>(`/api/bots/${botId}/library/share`, { path, name }),
    pageShares: () => http.get<PageShare[]>('/api/page-shares'),
    /** Pages the person saved as apps, newest first. */
    pageApps: () => http.get<PageApp[]>('/api/page-apps'),
    /** A saved app, and whether its page still opens for the person. */
    pageApp: (id: string) =>
      http.get<PageApp & { available: boolean }>(`/api/page-apps/${encodeURIComponent(id)}`),
    /** The app the person made of a page, if they saved it. */
    pageAppOf: (botId: string, path: string) =>
      http.get<{ app: PageApp | null }>(`/api/bots/${botId}/library/app?path=${encodeURIComponent(path)}`),
    savePageApp: (botId: string, page: { path: string; name: string; threadId?: string }) =>
      http.post<PageApp>(`/api/bots/${botId}/library/app`, page),
    renamePageApp: (id: string, name: string) =>
      http.patch<PageApp>(`/api/page-apps/${encodeURIComponent(id)}`, { name }),
    removePageApp: (id: string) => http.del<{ ok: true }>(`/api/page-apps/${encodeURIComponent(id)}`),
    /** A call a bot's page makes through `window.leafbot`, as the person viewing it. */
    pageCall: (botId: string, path: string, method: string, params: object, confirmed?: boolean) =>
      http.post<{ result: unknown }>(`/api/bots/${botId}/library/page-call`, {
        path,
        method,
        params,
        ...(confirmed && { confirmed }),
      }),
    /** The same, from a saved app's own view. */
    pageAppCall: (id: string, method: string, params: object, confirmed?: boolean) =>
      http.post<{ result: unknown }>(`/api/page-apps/${encodeURIComponent(id)}/call`, {
        method,
        params,
        ...(confirmed && { confirmed }),
      }),
    /** A saved app's page, served to fill its view in the app's sandboxed frame. */
    pageAppUrl: (id: string, theme?: 'light' | 'dark') =>
      `${base}/api/page-apps/${encodeURIComponent(id)}/page${theme ? `?theme=${theme}` : ''}`,
    unsharePage: (token: string) => http.del<{ ok: true }>(`/api/page-shares/${encodeURIComponent(token)}`),
    /** Several files of a bot's folders as one ZIP download. */
    zipUrl: (botId: string, paths: string[], name?: string) =>
      `${base}/api/bots/${botId}/library/zip?${paths.map((p) => `path=${encodeURIComponent(p)}`).join('&')}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
    /** What a bot import file would make; saves nothing. */
    previewBotImport: (file: Blob) => http.post<BotImportPlan>('/api/import/bots?preview=1', file),
    steerMessage: (id: string) => http.post<Message>(`/api/messages/${id}/steer`),
    importBots: (file: Blob) => http.post<BotImportResult>('/api/import/bots', file),
    /** What a Grok Bot share link's page shows about the bot. */
    readGrokLink: (url: string) => http.post<GrokTemplateCard>('/api/import/grok-link', { url }),
    /** Grok Bot's export files in Downloads and its desktop app's bots, on the person's computer. */
    grokLook: () => http.get<GrokLook>('/api/import/grok'),
    /** The text of export files `grokLook` found, to import as a pasted reply would be. */
    grokFiles: (names: string[]) => http.post<{ text: string }>('/api/import/grok/files', { names }),
    /** Each moved bot's chat from the Grok Bot app, by its name there. */
    grokChats: (bots: { id: string; name: string }[]) =>
      http.post<GrokChatResult[]>('/api/import/grok/chats', { bots }),
    /** The link Grok Bot sends bots over, with what arrived after `after`. */
    grokLink: () => http.get<GrokMoveLink>('/api/import/grok/link'),
    /** What arrived on the link up to `upTo` and is not imported yet, as one text. */
    grokLinkTexts: (upTo: number) => http.get<{ text: string }>(`/api/import/grok/link/texts?upTo=${upTo}`),
    /** What arrived up to `upTo` was imported, so it is not offered again. */
    grokLinkImported: (upTo: number) => http.post<GrokMoveLink>('/api/import/grok/link/imported', { upTo }),
    openGrokLink: () => http.post<GrokMoveLink>('/api/import/grok/link'),
    endGrokLink: () => http.del<GrokMoveLink>('/api/import/grok/link'),
    /** Whether the server can turn speech into text (an OpenAI or Groq key is saved). */
    transcribeStatus: () => http.get<{ available: boolean }>('/api/transcribe'),
    /** A recording from the message box, written out by the provider whose key the server has. */
    /** With no language the service works out which one was spoken. */
    transcribe: (audio: Blob, lang?: string) =>
      send<{ text?: string } | null>(
        'POST',
        lang ? `/api/transcribe?lang=${encodeURIComponent(lang)}` : '/api/transcribe',
        audio,
        {
          headers: { 'content-type': audio.type || 'audio/webm' },
        },
      ).then((data) => ({ text: data?.text ?? '' })),
    /** Writes a sealed backup of everything on the server, ready for one download at `/api/backup/<id>`. */
    createBackup: (password: string) => http.post<{ id: string; size: number }>('/api/backup', { password }),
    /** Replaces everything with a backup; the server starts again after. The body is the file itself. */
    restoreBackup: (file: Blob, password: string) =>
      send<{ tables: number; files: number }>('POST', '/api/backup/restore', file, {
        headers: { 'x-backup-password': encodeURIComponent(password) },
      }),
  };
}
