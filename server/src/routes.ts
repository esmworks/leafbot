import { createReadStream, readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { BackupService } from './services/backup';
import type { MemoryReach } from './services/memory';
import type { SkillReach } from './services/skills';
import { MAX_AUDIO_BYTES, type TranscribeService } from './services/transcribe';
import { MAX_EMAIL_BYTES } from './services/email';
import { Readable } from 'node:stream';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import {
  AccessRequest,
  AccountSet,
  PersonCreate,
  PersonUpdate,
  connectionToolParts,
  describeAction,
  ApprovalDecision,
  type Approver,
  type SecondYes,
  BotAccess,
  BotCreate,
  type Bot,
  type BotLevel,
  type Ticket,
  BotMove,
  BotUpdate,
  newBotEngine,
  ApnsSet,
  ClaudeAuthSet,
  PushDeviceSet,
  type ClaudeAuthStatus,
  type ClaudeModel,
  ConnectionBots,
  ConnectionCreate,
  ConnectionToolPatch,
  ConnectionUpdate,
  CustomEndpointCreate,
  CustomEndpointUpdate,
  FileName,
  LoginRequest,
  GroupCreate,
  GroupMove,
  MAX_BOT_IMPORT_BYTES,
  MemoryCreate,
  MemoryUpdate,
  MessageReaction,
  patchOf,
  PermissionRuleCreate,
  SuggestionDismiss,
  ProviderKeyInput,
  ProviderSignInStart,
  LOCALES,
  pickLocale,
  RoutineCreate,
  RoutineSuggestionAccept,
  SkillSuggestionAccept,
  RoutineUpdate,
  RehearsalStart,
  RoomCreate,
  RoomSend,
  MeetingAnswer,
  MeetingSave,
  RoomUpdate,
  SendMessage,
  SkillBot,
  SkillCreate,
  SkillUpdate,
  DiscordConnect,
  DiscordUpdate,
  SlackConnect,
  TeamsConnect,
  TeamsUpdate,
  SlackUpdate,
  TelegramConnect,
  TelegramUpdate,
  WhatsAppSet,
  type ServerInfo,
  ThreadCreate,
  USAGE_RANGES,
  type UsageRange,
  PasswordManagerCreate,
  PaymentCardCreate,
  PaymentCardUpdate,
  type PersonComputerState,
  PasswordManagerUpdate,
  VaultImport,
  VaultLoginCreate,
  VaultLoginUpdate,
  frameCsp,
  frameDocument,
  frameHeader,
  PAGE_LIBRARIES,
  PageShareCreate,
  ApiCredentialCreate,
  ApiKeyImport,
  ApiCredentialUpdate,
  TrapKeyCreate,
  DoctorRepair,
  EmailClaim,
  EmailCodes,
  AI_KINDS,
  AiEndpointSet,
  PluginInstall,
  ApiSourceCreate,
  TicketCommentCreate,
  RowValues,
  type TableRow,
  TicketCreate,
  TicketUpdate,
  skillSlug,
} from '@leafbot/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import { MIN_PASSWORD } from './account';
import {
  canAdminister,
  clientAddress,
  requireAdmin,
  OLD_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  type Auth,
  type Principal,
} from './auth';
import { BrowserError } from './browser/manager';
import type { Config } from './config';
import { PLAIN_PAGE_POLICY } from './csp';
import { translator } from './i18n';
import { schema } from './db';
import type { AccountStatus, ModelTest } from './engine/types';
import type { Services } from './services';
import { clientMetadata, clientMetadataUrlFor, OAUTH_CLIENT_PATH } from './connections/client';
import { OAUTH_CALLBACK_PATH, oauthRedirectUrl } from './services/connections';
import { fetchSkillFile, privateHost } from './services/skill-link';
import { readGrokLink } from './services/grok-link';
import { isPersonal, serverLocale, Settings } from './services/settings';
import { EMOJI } from './tools';
import { attachedFiles, cancelStagedUpload, saveStagedUpload, stagingDir } from './uploads';
import { storageReport } from './storage';
import { OWNER_ID } from './users';
import { HttpError, notFound, truncate } from './util';
import { atLeast, managesServer } from './services/access';
import { findProjects, findSetup } from './services/setup-import';
import { APP_DIR } from './runtime/turns';
import { bundlePage } from './tools/page-bundle';
import { replaySteps } from './browser/replay';
import { stepsText } from './browser/teach';
import { findLinkedFile, workspacePaths } from './workspace';
import { uniqueName, zip } from './zip';
import { TEAMS_PATH } from './channels/teams';

/** Where services start routines by their secret address; needs no access key. */
export const WEBHOOK_PATH = '/api/hooks/routines';
/** Where a mail relay hands over messages; it signs in with the mail secret, not the access key. */
export const EMAIL_INBOUND_PATH = '/api/email/inbound';
/** Where a shared page opens, outside /api so it needs no sign-in. */
export const SHARE_PATH = '/p';
/** The largest request Teams may deliver; a message with a card is a few kilobytes. */
const TEAMS_BODY_MAX = 256 * 1024;
/** Longest text a script may hand a routine run. */
const MAX_PAYLOAD = 50_000;
/** The largest webhook body read; GitHub sends up to 25 MB, but what a bot reads is cut far shorter. */
const WEBHOOK_BODY_MAX = 5 * 1024 * 1024;
/** Most bytes put in one ZIP download; it is built in memory. */
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
/** The app's id for one attached file, the same on each of its tries (see `saveStagedUpload`). */
const UploadId = z.string().regex(/^[\w-]{8,64}$/);
import { eq } from 'drizzle-orm';

interface Deps {
  services: Services;
  backup: BackupService;
  transcribe: TranscribeService;
  auth: Auth;
  config: Config;
  info(): ServerInfo;
  checkClaude(): Promise<AccountStatus>;
  claude: {
    status(): Promise<ClaudeAuthStatus>;
    /** Saves the token or key, then checks it with one real request. */
    set(input: ClaudeAuthSet): Promise<ServerInfo['claude']>;
    clear(): Promise<ServerInfo['claude']>;
    models(): Promise<ClaudeModel[]>;
  };
  /** One short request to a provider's model with its stored key. */
  testModel(provider: string, model: string): Promise<ModelTest>;
  /** Closes a person's live connections, so they come back with what they may do now, or not at all. */
  dropSockets(userId: string): void;
}

const IdParams = z.object({ id: z.string().min(1) });
const RunParams = z.object({ id: z.string().min(1), runId: z.string().min(1) });
/** Pauses (true) or resumes (false) a bot, a group or every bot. */
const PauseBody = z.object({ paused: z.boolean() });

/** Library files the page may show as pictures. */
/** What the page may show in place: raster images, and PDFs in the browser's own viewer. */
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  // Shown only as a picture, and sandboxed below: a script inside it never runs.
  '.svg': 'image/svg+xml',
  // Sound and video play in the page's own player; they cannot run anything.
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

/** `bytes=a-b` of a file of `size` bytes, or null when absent or not one satisfiable range. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // The last n bytes.
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : null;
}

/** Who a signed-in request comes from; every route past the sign-in check has one. */
function me(req: FastifyRequest): Principal {
  if (!req.principal) throw new HttpError(401, 'error.accessKeyRequired');
  return req.principal;
}

/** How the audit log names the person a request comes from. */
const actorOf = (req: FastifyRequest) => `user:${me(req).userId}`;
/** Who decides on skills: their makers, and those who look after the server. */
const skillReach = (req: FastifyRequest): SkillReach => ({
  userId: me(req).userId,
  admin: canAdminister(me(req).role),
});

/** A browser problem as an answer to the person who asked. */
function browserHttpError(err: unknown): unknown {
  if (!(err instanceof BrowserError)) return err;
  switch (err.code) {
    case 'busy':
      return new HttpError(409, 'browser.busy');
    case 'badUrl':
      return new HttpError(400, 'browser.badUrl', { url: err.message });
    case 'launch':
      return new HttpError(502, 'browser.launchFailed', { message: err.message });
    default:
      return new HttpError(409, 'browser.windowUnavailable');
  }
}

export function registerRoutes(app: FastifyInstance, d: Deps) {
  const s = d.services;

  app.get('/api/health', async () => ({ ok: true }));

  const sessionCookie = {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: d.config.secureCookies,
    path: '/',
    maxAge: Math.floor(SESSION_IDLE_MS / 1000),
  };
  app.get('/api/session', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    const who = await d.auth.authenticate(req.headers, token, clientAddress(req.headers, req.ip, d.config));
    // Each visit moves the cookie's end along with the session's.
    if (who?.via === 'session' && token) reply.setCookie(SESSION_COOKIE, token, sessionCookie);
    const user = who ? await d.auth.users.get(who.userId) : null;
    return {
      authenticated: !!who,
      // Whether the sign-in page asks for a username and password or for the access key.
      account: await d.auth.users.anyPassword(),
      ...(user && { user: { id: user.id, username: user.username, role: user.role } }),
    };
  });
  // People: everyone sees who is here, to share bots with them; those who look after the server
  // add, change and remove them. The owner stays as they are, and only the owner handles admins.
  app.get('/api/people', async (req) => {
    const all = await d.auth.users.list();
    return managesServer(me(req).role) ? all : all.filter((p) => !p.disabled);
  });
  /** A person the one asking may change: not themselves, not the owner, an admin only by the owner. */
  const changeable = async (req: FastifyRequest, id: string) => {
    const who = me(req);
    if (id === who.userId) throw new HttpError(403, 'error.notYourself');
    const person = await d.auth.users.person(id);
    if (!person || person.role === 'owner') throw notFound('person');
    if (person.role === 'admin' && who.role !== 'owner') throw new HttpError(403, 'error.ownerManagesAdmins');
    return person;
  };
  const checkPassword = (password: string | undefined) => {
    if (password !== undefined && password.length < MIN_PASSWORD) {
      throw new HttpError(400, 'error.passwordShort', { min: String(MIN_PASSWORD) });
    }
  };
  /** After a change to a person: what was remembered about them is forgotten. */
  const peopleChanged = async (userId: string, signOut: boolean) => {
    await d.auth.forgetPerson(userId, signOut);
    s.access.forget();
    // A step may have waited for this person's second yes.
    await s.approvals.refuseUnanswerable();
    d.dropSockets(userId);
    s.ctx.bus.refresh({ scope: 'people' });
  };
  app.post('/api/people', async (req) => {
    const body = PersonCreate.parse(req.body);
    checkPassword(body.password);
    if (body.role === 'admin' && me(req).role !== 'owner')
      throw new HttpError(403, 'error.ownerManagesAdmins');
    const made = await d.auth.users.create(body);
    s.access.forget();
    s.ctx.bus.refresh({ scope: 'people' });
    return made;
  });
  app.patch('/api/people/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await changeable(req, id);
    const patch = PersonUpdate.parse(req.body);
    checkPassword(patch.password);
    if (patch.role === 'admin' && me(req).role !== 'owner')
      throw new HttpError(403, 'error.ownerManagesAdmins');
    const changed = await d.auth.users.change(id, patch);
    // A new password or a disabled person signs out everywhere; a new role counts at once.
    await peopleChanged(id, patch.password !== undefined || patch.disabled === true);
    return changed;
  });
  /**
   * Removes a person. Their conversations go with them, files included; the bots they made pass to
   * the owner; their notes, apps, sign-ins and chat apps go. What they wrote elsewhere stays,
   * without their name.
   */
  app.delete('/api/people/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await changeable(req, id);
    // Signed out first, so nothing new of theirs starts while they are removed.
    await d.auth.users.change(id, { disabled: true });
    await peopleChanged(id, true);
    const threads = await s.ctx.db
      .select({ id: schema.threads.id, botId: schema.threads.botId })
      .from(schema.threads)
      .where(eq(schema.threads.userId, id));
    for (const th of threads) await deleteThread(th.id, th.botId);
    const channels = await s.ctx.db
      .select({ kind: schema.channels.kind, botId: schema.channels.botId })
      .from(schema.channels)
      .where(eq(schema.channels.userId, id));
    for (const c of channels) {
      if (c.kind === 'telegram' && c.botId) await s.telegram.disconnect(c.botId);
      if (c.kind === 'whatsapp') await s.whatsapp.disconnect();
    }
    await s.bots.leftBy(id, OWNER_ID);
    await d.auth.users.remove(id);
    await peopleChanged(id, true);
    return { ok: true };
  });

  app.get('/api/sessions', async (req) => d.auth.listSessions(req.cookies[SESSION_COOKIE], me(req).userId));
  app.delete('/api/sessions/:id', async (req) => {
    const id = z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;
    const ended = await d.auth.revokeSessions(
      req.cookies[SESSION_COOKIE],
      me(req).userId,
      id === 'others' ? 'others' : { id },
    );
    return { ended };
  });

  app.post('/api/access', async (req, reply) => {
    const { key } = AccessRequest.parse(req.body);
    // The key cannot be guessed, but an address that keeps trying is still turned away. Only per
    // address: a flood of wrong keys from elsewhere must not shut the owner out of this way in.
    const attempt = d.auth.keyThrottle.attempt(clientAddress(req.headers, req.ip, d.config), {
      shared: false,
    });
    if (!attempt) throw new HttpError(429, 'error.loginBlocked');
    if (!d.auth.checkKey(key)) {
      await new Promise((r) => setTimeout(r, 300));
      throw new HttpError(401, 'error.accessKeyWrong');
    }
    attempt.succeeded();
    // The access key is the owner's.
    const token = await d.auth.createSession(OWNER_ID, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, sessionCookie);
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const { username, password } = LoginRequest.parse(req.body);
    // The try is counted before the slow check, so many sent at once cannot all get past the limit.
    const attempt = d.auth.throttle.attempt(clientAddress(req.headers, req.ip, d.config));
    if (!attempt) throw new HttpError(429, 'error.loginBlocked');
    const user = await d.auth.users.check(username, password);
    if (!user) throw new HttpError(401, 'error.loginWrong');
    attempt.succeeded();
    reply.setCookie(
      SESSION_COOKIE,
      await d.auth.createSession(user.id, req.headers['user-agent']),
      sessionCookie,
    );
    return { ok: true };
  });

  // Pairing: a signed-in device makes a short code; another device signs in with it once.
  app.post('/api/pairing', async (req) => ({
    ...d.auth.createPairingCode(me(req).userId),
    // Where the other device finds this server, when it is known to the server.
    url: d.config.publicUrl ?? null,
  }));
  app.post('/api/pair', async (req, reply) => {
    const { code, token: wantToken } = z
      .object({ code: z.string().min(1).max(40), token: z.boolean().optional() })
      .parse(req.body);
    // Wrong codes count with wrong passwords: guessing either is slowed the same way.
    const attempt = d.auth.throttle.attempt(clientAddress(req.headers, req.ip, d.config));
    if (!attempt) throw new HttpError(429, 'error.loginBlocked');
    // The new device signs in as whoever made the code.
    const userId = d.auth.usePairingCode(code);
    if (!userId) {
      await new Promise((r) => setTimeout(r, 300));
      throw new HttpError(401, 'error.pairingWrong');
    }
    attempt.succeeded();
    const token = await d.auth.createSession(userId, req.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, sessionCookie);
    // The desktop app pairs from its own process and puts the session in its window's cookies.
    return wantToken
      ? { ok: true, token, cookie: SESSION_COOKIE, maxAge: sessionCookie.maxAge }
      : { ok: true };
  });

  // The signed-in person's own username and password.
  app.get('/api/account', async (req) => ({
    username: (await d.auth.users.get(me(req).userId))?.username ?? null,
  }));
  app.put('/api/account', async (req) => {
    const { username, password, current } = AccountSet.parse(req.body);
    if (password.length < MIN_PASSWORD) {
      throw new HttpError(400, 'error.passwordShort', { min: String(MIN_PASSWORD) });
    }
    const who = me(req);
    const user = await d.auth.users.get(who.userId);
    if (!user) throw new HttpError(401, 'error.accessKeyRequired');
    // Changing it takes the current password, or, for the owner, the access key when that is forgotten.
    const changing = user.username !== null;
    if (changing) {
      // Only a signed-in device gets here, so the count across all addresses is left alone: a
      // flood of guesses at the sign-in page must not stop the owner changing the password.
      const attempt = d.auth.throttle.attempt(clientAddress(req.headers, req.ip, d.config), {
        shared: false,
      });
      if (!attempt) throw new HttpError(429, 'error.loginBlocked');
      const ok =
        !!current &&
        ((user.role === 'owner' && d.auth.checkKey(current)) ||
          (await d.auth.users.checkFor(user.id, current)));
      if (!ok) throw new HttpError(403, 'error.currentPasswordWrong');
      attempt.succeeded();
    }
    const saved = await d.auth.users.setCredentials(user.id, username, password);
    // A new password is often set because the old one got out: whoever signed in with it is
    // signed out, everywhere but on the device that made the change.
    if (changing) await d.auth.revokeSessions(req.cookies[SESSION_COOKIE], user.id, 'others');
    return { username: saved.username };
  });

  app.post('/api/logout', async (req, reply) => {
    await d.auth.endSession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.clearCookie(OLD_SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/info', async () => d.info());
  app.post('/api/info/claude-check', async () => d.checkClaude());

  // Each person reads the server's settings with their own profile in them, and changes their own
  // profile; the server's settings are changed by those who look after it.
  app.get('/api/settings', async (req) => s.settings.all(me(req).userId));
  app.patch('/api/settings', async (req) => {
    const patch = patchOf(Settings).parse(req.body);
    if (Object.keys(patch).some((k) => !isPersonal(k))) requireAdmin(me(req));
    return s.settings.update(patch, me(req).userId);
  });

  // API keys for the Pi engine; responses carry only a hint of each key.
  const ProviderParams = z.object({ id: z.string().regex(/^[a-z0-9-]{2,60}$/) });
  // How Claude bots sign in. The token or key is write-only: reads return a hint.
  app.get('/api/claude/auth', async () => d.claude.status());
  app.put('/api/claude/auth', async (req) => d.claude.set(ClaudeAuthSet.parse(req.body)));
  app.delete('/api/claude/auth', async () => d.claude.clear());
  app.get('/api/claude/models', async () => d.claude.models());

  // Notifications on phones while the app is closed. The Apple key is write-only.
  const PushToken = z.object({ token: z.string().regex(/^[0-9a-fA-F]{32,200}$/) });
  app.put('/api/push/device', async (req) => {
    await s.push.register(PushDeviceSet.parse(req.body), req.cookies[SESSION_COOKIE]);
    return { ok: true };
  });
  app.delete('/api/push/device/:token', async (req) => {
    await s.push.unregister(PushToken.parse(req.params).token);
    return { ok: true };
  });
  app.post('/api/push/test', async (req) => {
    await s.push.test(PushToken.parse(req.body).token);
    return { ok: true };
  });
  app.get('/api/push/apns', async () => s.push.apnsStatus());
  app.put('/api/push/apns', async (req) => {
    await s.push.setApns(ApnsSet.parse(req.body));
    return s.push.apnsStatus();
  });
  app.delete('/api/push/apns', async () => {
    await s.push.clearApns();
    return s.push.apnsStatus();
  });

  app.get('/api/providers', async () => s.keys.list());
  app.get('/api/providers/:id/models', async (req) => s.keys.models(ProviderParams.parse(req.params).id));
  app.get('/api/providers/:id/model-info', async (req) =>
    s.keys.modelInfo(ProviderParams.parse(req.params).id),
  );
  app.put('/api/providers/:id/key', async (req) => {
    await s.keys.set(ProviderParams.parse(req.params).id, ProviderKeyInput.parse(req.body).key);
    return { ok: true };
  });
  app.post('/api/providers/:id/test', async (req) =>
    d.testModel(
      ProviderParams.parse(req.params).id,
      z.object({ model: z.string().trim().min(1).max(200) }).parse(req.body).model,
    ),
  );
  // Signing in with the person's own plan (ChatGPT, Copilot); the app follows the sign-in it starts.
  app.post('/api/providers/:id/sign-in', async (req) =>
    s.subscriptions.start(ProviderParams.parse(req.params).id, ProviderSignInStart.parse(req.body ?? {})),
  );
  app.get('/api/sign-ins/:id', async (req) => s.subscriptions.status(IdParams.parse(req.params).id));
  app.post('/api/sign-ins/:id/paste', async (req) =>
    s.subscriptions.paste(
      IdParams.parse(req.params).id,
      z.object({ input: z.string().min(1).max(4000) }).parse(req.body).input,
    ),
  );
  app.delete('/api/sign-ins/:id', async (req) => {
    s.subscriptions.cancel(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.delete('/api/providers/:id/sign-in', async (req) => {
    await s.subscriptions.signOut(ProviderParams.parse(req.params).id);
    return { ok: true };
  });
  app.delete('/api/providers/:id/key', async (req) => {
    await s.keys.remove(ProviderParams.parse(req.params).id);
    return { ok: true };
  });
  // The person's own OpenAI-compatible endpoints, listed among the providers.
  app.post('/api/providers/custom', async (req) => s.keys.addEndpoint(CustomEndpointCreate.parse(req.body)));
  app.get('/api/providers/discover', async () => s.keys.discover());
  app.patch('/api/providers/:id', async (req) =>
    s.keys.updateEndpoint(ProviderParams.parse(req.params).id, CustomEndpointUpdate.parse(req.body)),
  );
  app.post('/api/providers/:id/refresh', async (req) =>
    s.keys.refreshEndpoint(ProviderParams.parse(req.params).id),
  );
  app.delete('/api/providers/:id', async (req) => {
    await s.keys.removeEndpoint(ProviderParams.parse(req.params).id);
    return { ok: true };
  });

  // Bots and groups
  /** Only the bot's own owner, or those who look after the server, share or remove a bot. */
  const requireBotOwner = async (req: FastifyRequest, botId: string) => {
    const p = me(req);
    if (canAdminister(p.role)) return;
    if ((await s.access.botOwner(botId)) !== p.userId) throw new HttpError(403, 'error.botOwnerOnly');
  };
  /**
   * A group's bots share its files folder, so a bot joins one only for someone who may change
   * every bot already in it.
   */
  const checkGroup = async (req: FastifyRequest, groupId: string | null | undefined) => {
    if (!groupId || canAdminister(me(req).role)) return;
    const editable = new Set(await s.access.botIds(me(req), 'edit'));
    const members = (await s.bots.list({ includeArchived: true })).filter((b) => b.groupId === groupId);
    if (!members.every((b) => editable.has(b.id))) throw new HttpError(403, 'error.groupNotYours');
  };
  /** A bot with what the asking person may do with it. */
  const leveled = async (req: FastifyRequest, bot: Bot): Promise<Bot> => ({
    ...bot,
    yourLevel: await s.access.level(me(req), bot.id),
  });
  /** A project folder opens the server's files to the bot: only those who look after the server pick one. */
  const checkProjectDir = (req: FastifyRequest, projectDir: string | null | undefined) => {
    if (projectDir && !canAdminister(me(req).role)) throw new HttpError(403, 'error.adminOnly');
  };
  app.get('/api/bots', async (req) => {
    const q = z.object({ archived: z.enum(['0', '1']).optional() }).parse(req.query);
    const levels = await s.access.levels(me(req));
    return (await s.bots.list({ includeArchived: q.archived === '1' }))
      .map((b) => ({ ...b, yourLevel: levels.get(b.id) ?? 'none' }))
      .filter((b) => b.yourLevel !== 'none');
  });
  // A bot linked to a document reads it right away, so its text waits for the person at once.
  app.post('/api/bots', async (req) => {
    const body = BotCreate.parse(req.body);
    // The Mac is the owner's: only they let a bot use it.
    if (body.personComputer && me(req).role !== 'owner') throw new HttpError(403, 'error.ownerOnly');
    checkProjectDir(req, body.projectDir);
    await checkGroup(req, body.groupId);
    const bot = await s.bots.create(body, me(req).userId);
    return leveled(req, bot.instructionsUrl ? await s.instructionDocs.check(bot.id) : bot);
  });
  // Moves the existing bots to what new bots start with, while its provider can still be reached
  // the way the engine reaches it: a key, a sign-in with a plan, or an endpoint that takes none.
  app.post('/api/bots/engine', async () => {
    const target = newBotEngine(await s.settings.all());
    if (target.engine === 'pi') {
      const provider = target.model.slice(0, target.model.indexOf('/'));
      if (!(await s.keys.auth(provider))?.apiKey) throw new HttpError(400, 'error.noProviderKey');
    }
    return { changed: await s.bots.moveAllTo(target) };
  });
  app.get('/api/bots/:id', async (req) => leveled(req, await s.bots.get(IdParams.parse(req.params).id)));
  app.patch('/api/bots/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const before = await s.bots.get(id);
    const patch = BotUpdate.parse(req.body);
    if (patch.projectDir !== undefined && patch.projectDir !== before.projectDir) {
      checkProjectDir(req, patch.projectDir);
    }
    if (patch.groupId !== undefined && patch.groupId !== before.groupId) await checkGroup(req, patch.groupId);
    // The Mac is the owner's: only they let a bot use it.
    if (patch.personComputer && !before.personComputer && me(req).role !== 'owner') {
      throw new HttpError(403, 'error.ownerOnly');
    }
    const bot = await s.bots.update(id, patch);
    const relinked = !!bot.instructionsUrl && bot.instructionsUrl !== before.instructionsUrl;
    return leveled(req, relinked ? await s.instructionDocs.check(id) : bot);
  });
  // Who else may talk with the bot or change it: its owner and those who look after the server say.
  app.put('/api/bots/:id/access', async (req) => {
    const id = IdParams.parse(req.params).id;
    await requireBotOwner(req, id);
    const bot = await s.bots.setAccess(id, BotAccess.parse(req.body));
    s.access.forget();
    // Someone who lost the bot can no longer give a second yes on its steps.
    await s.approvals.refuseUnanswerable();
    return leveled(req, bot);
  });
  // The document a bot's instructions are kept in: read it now, take its text, or turn it down.
  app.post('/api/bots/:id/instructions/check', async (req) =>
    s.instructionDocs.check(IdParams.parse(req.params).id),
  );
  app.post('/api/bots/:id/instructions/accept', async (req) => {
    const { expected } = z.object({ expected: z.string().max(100_000).optional() }).parse(req.body ?? {});
    return s.instructionDocs.accept(IdParams.parse(req.params).id, expected, actorOf(req));
  });
  app.post('/api/bots/:id/instructions/decline', async (req) =>
    s.instructionDocs.decline(IdParams.parse(req.params).id),
  );
  app.post('/api/bots/:id/move', async (req) => {
    const id = IdParams.parse(req.params).id;
    const body = BotMove.parse(req.body);
    if (body.groupId !== (await s.bots.get(id)).groupId) await checkGroup(req, body.groupId);
    return s.bots.move(id, body);
  });
  app.post('/api/bots/:id/archive', async (req) => s.bots.archive(IdParams.parse(req.params).id));
  // A paused bot's running work stops at once; a person's waiting message starts on the resume.
  app.post('/api/bots/:id/pause', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { paused } = PauseBody.parse(req.body);
    const bot = await s.bots.setPaused(id, paused);
    if (paused) await s.turns.stopBots([id]);
    else s.turns.schedule();
    return bot;
  });
  app.get('/api/bots/:id/spend', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    return s.usage.botSpent(id);
  });
  app.post('/api/bots/pause-all', async (req) => {
    const { paused } = PauseBody.parse(req.body);
    const ids = await s.bots.setAllPaused(paused);
    if (paused) await s.turns.stopBots(ids);
    else s.turns.schedule();
    return { count: ids.length };
  });
  app.post('/api/bots/:id/restore', async (req) => s.bots.restore(IdParams.parse(req.params).id));
  app.delete('/api/bots/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await requireBotOwner(req, id);
    // An archived bot leaves its rooms first, so a room it started is not removed with it.
    if ((await s.bots.get(id)).archivedAt) await s.rooms.removeBot(id);
    await s.bots.purge(id);
    await s.ctx.browser.close(id).catch(() => {});
    // Its folders go with it: files, conversations, the browser profile.
    const data = d.config.dataDir;
    for (const dir of [join(data, 'workspaces', 'bots', id), join(data, 'browsers', id)]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true };
  });
  // The bot's browser as an ordinary window on this computer, for signing in by hand.
  app.post('/api/bots/:id/browser/window', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { url } = z.object({ url: z.string().trim().max(2000).optional() }).parse(req.body ?? {});
    await s.bots.get(id);
    const browser = s.ctx.browser;
    if (!browser.windowAvailable) throw new HttpError(409, 'browser.windowUnavailable');
    try {
      await browser.openWindow(id, url || undefined);
    } catch (err) {
      throw browserHttpError(err);
    }
    return { ok: true };
  });
  app.delete('/api/bots/:id/browser/window', async (req) => {
    await s.ctx.browser.closeWindow(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.get('/api/bots/:id/audit', async (req) => s.tools.auditFor(IdParams.parse(req.params).id));
  app.get('/api/summaries', async (req) => s.threads.summaries(await s.access.summaryScope(me(req))));
  app.get('/api/search', async (req) => {
    const q = z
      .object({
        q: z.string().max(200),
        threadId: z.string().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .parse(req.query);
    const { seen } = await s.access.summaryScope(me(req));
    return s.threads.search(q.q, { threadId: q.threadId, limit: q.limit, seen });
  });
  app.get('/api/usage', async (req) => {
    const q = z
      .object({ days: z.coerce.number().int().default(30), bot: z.string().min(1).max(64).optional() })
      .refine((v) => (USAGE_RANGES as readonly number[]).includes(v.days), 'validation.usageRange')
      .parse(req.query);
    return s.usage.report(q.days as UsageRange, q.bot);
  });
  // How much room the bots' folders take; read fresh, so it is asked for only when shown.
  app.get('/api/storage', async () => storageReport(s.ctx));
  // The plan's windows alone, for the meter beside the chat: everyone who talks with a Claude bot
  // spends the same plan, and its limit warnings already reach their conversations.
  app.get('/api/usage/plan', async () => ({ plan: (await s.usage.plan()) ?? null }));
  app.get('/api/today', async (req) => {
    // Every bot's level is read once, for what the person may talk with and what they may change.
    const levels = [...(await s.access.levels(me(req)))];
    const reach = (wanted: BotLevel) => levels.filter(([, l]) => atLeast(l, wanted)).map(([id]) => id);
    const notes: MemoryReach = {
      userId: me(req).userId,
      botIds: reach('edit'),
      places: await s.memory.placesFor(me(req).userId, managesServer(me(req).role)),
    };
    return {
      ...(await s.usage.today(canAdminister(me(req).role) ? undefined : reach('chat'))),
      staleMemory: (await s.memory.stale(new Date(), notes)).length,
      expiredMemory: (await s.memory.expired(new Date(), notes)).length,
      pendingMemory: (await s.memory.pending(notes)).length,
      pendingSkills: (await s.skills.changes(skillReach(req))).length,
      canaryAlarms: await s.canary.open(me(req).userId),
    };
  });

  // A bot as an API: send it a message from a script and get its reply when the turn ends (or the
  // turn's id to ask again later when the wait runs out).
  app.post('/api/bots/:id/ask', async (req, reply) => {
    const id = IdParams.parse(req.params).id;
    const body = z
      .object({
        text: z.string().trim().min(1).max(100_000),
        threadId: z.string().min(1).max(64).optional(),
        wait: z.number().int().min(0).max(600).default(300),
      })
      .parse(req.body);
    const result = await s.botApi.ask(id, body.text, {
      threadId: body.threadId,
      waitMs: body.wait * 1000,
      userId: me(req).userId,
    });
    return reply.code(result.status === 'running' ? 202 : 200).send(result);
  });
  // How many turns run now, so the desktop app can ask before quitting stops them.
  app.get('/api/turns/running', async () => ({ count: s.turns.runningCount() }));
  // What a turn changed in its bot's own world, and putting it back: only the person whose turn it
  // was, admins included; the handler keeps each person to their own.
  app.get('/api/threads/:id/turn-changes', async (req) =>
    s.changes.pending(IdParams.parse(req.params).id, me(req).userId),
  );
  app.get('/api/turns/:id/changes', async (req) =>
    s.changes.preview(IdParams.parse(req.params).id, me(req).userId),
  );
  app.post('/api/turns/:id/undo', async (req) =>
    s.changes.undo(IdParams.parse(req.params).id, me(req).userId, await s.settings.translator()),
  );
  app.get('/api/turns/:id/result', async (req, reply) => {
    const q = z.object({ wait: z.coerce.number().int().min(0).max(600).default(0) }).parse(req.query);
    const result = await s.botApi.result(IdParams.parse(req.params).id, q.wait * 1000);
    return reply.code(result.status === 'running' ? 202 : 200).send(result);
  });
  app.get('/api/usage/turns.csv', async (req, reply) => {
    const q = z
      .object({ days: z.coerce.number().int().default(30) })
      .refine((v) => (USAGE_RANGES as readonly number[]).includes(v.days), 'validation.usageRange')
      .parse(req.query);
    const csv = await s.usage.csv(q.days as UsageRange);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="leafbot-usage-${q.days}d.csv"`)
      .send(csv);
  });

  // What the person's other AI tools on this computer have that LeafBot does not: skills and remote
  // MCP servers. Only when the server runs on the person's own computer, whose home folder it is.
  const foundSetup = async () =>
    findSetup({
      skills: (await s.skills.list()).map((k) => k.name),
      urls: (await s.connections.list()).map((c) => c.url),
    });
  app.get('/api/setup-import', async () => {
    if (!d.config.onUserComputer) return { available: false, skills: [], servers: [] };
    const found = await foundSetup();
    return {
      available: true,
      skills: found.skills.map(({ body: _b, ...k }) => k),
      servers: found.servers,
    };
  });
  // Folders the person's coding tools work in, each one a bot could be made to work in.
  app.get('/api/setup-import/projects', async () => {
    if (!d.config.onUserComputer) return { available: false, projects: [] };
    const bots = await s.bots.list({ includeArchived: true });
    const dirs = bots.map((b) => b.projectDir).filter((p): p is string => !!p);
    return { available: true, projects: await findProjects({ dirs }, { dataDir: d.config.dataDir }) };
  });
  app.post('/api/setup-import', async (req) => {
    if (!d.config.onUserComputer) throw new HttpError(404, 'error.notFound');
    const body = z
      .object({
        skills: z.array(z.string().max(64)).max(200).default([]),
        servers: z.array(z.string().max(2000)).max(100).default([]),
      })
      .parse(req.body);
    const found = await foundSetup();
    let skills = 0;
    let servers = 0;
    // Brought in switched off: no bot gets them until the person turns them on.
    for (const k of found.skills.filter((x) => body.skills.includes(x.name))) {
      await s.skills.create({ name: k.name, description: k.description, body: k.body, botIds: [] });
      skills++;
    }
    for (const c of found.servers.filter((x) => body.servers.includes(x.url))) {
      await s.connections.create(
        { name: c.name, url: c.url, auth: 'none', catalogId: null, allBots: false, botIds: [] },
        me(req).userId,
      );
      servers++;
    }
    return { skills, servers };
  });
  // Content sealed at rest: the switch, and how far the stored rows are converted.
  app.get('/api/content-encryption', async () => s.contentSeal.status());
  app.put('/api/content-encryption', async (req) => {
    await s.contentSeal.set(z.object({ on: z.boolean() }).parse(req.body).on);
    return s.contentSeal.status();
  });

  // Teaching a task by showing it in the bot's browser; the steps come back as a skill draft.
  app.post('/api/bots/:id/teach', async (req) => {
    const bot = await s.bots.get(IdParams.parse(req.params).id);
    if (!d.services.ctx.browser.available) throw new HttpError(409, 'error.teachNoBrowser');
    await d.services.ctx.browser.startTeaching(bot.id);
    return { steps: 0 };
  });
  app.get('/api/bots/:id/teach', async (req) => ({
    steps: d.services.ctx.browser.teaching(IdParams.parse(req.params).id),
  }));
  app.post('/api/bots/:id/teach/stop', async (req) => {
    const bot = await s.bots.get(IdParams.parse(req.params).id);
    const { goal } = z.object({ goal: z.string().trim().max(500).default('') }).parse(req.body ?? {});
    const steps = d.services.ctx.browser.stopTeaching(bot.id);
    if (!steps?.length) throw new HttpError(409, 'error.teachNothing');
    const t = await s.settings.translator();
    const tr = t as unknown as (key: string, params?: Record<string, string | number>) => string;
    const description = goal || t('teach.defaultGoal');
    return {
      name: skillSlug(goal) || 'taught-task',
      description,
      body: [t('teach.intro', { goal: description }), '', stepsText(steps, tr), '', t('teach.outro')].join(
        '\n',
      ),
      steps: steps.length,
      // Kept with the skill, so the task can be replayed without the model.
      taught: steps,
    };
  });
  // Does a taught skill again in the bot's browser without the model; the answer says where it
  // stopped, if it did, so the person can hand the rest to the bot.
  app.post('/api/bots/:id/skills/:skillId/replay', async (req) => {
    const p = z.object({ id: z.string().min(1), skillId: z.string().min(1) }).parse(req.params);
    const bot = await s.bots.get(p.id);
    const skill = await s.skills.get(p.skillId);
    if (!skill.botIds.includes(bot.id)) throw notFound('skill');
    if (!skill.steps?.length) throw new HttpError(409, 'error.notTaught');
    if (!d.services.ctx.browser.available) throw new HttpError(409, 'error.teachNoBrowser');
    if (await s.bots.isPaused(bot)) throw new HttpError(409, 'error.botPaused', { bot: bot.name });
    // The steps would cross the bot's own browser calls in a turn under way.
    if (s.turns.botWorking(bot.id) || d.services.ctx.browser.state(bot.id).status === 'bot') {
      throw new HttpError(409, 'browser.busy');
    }
    const t = await s.settings.translator();
    const tr = t as unknown as (key: string, params?: Record<string, string | number>) => string;
    await s.skills.markUsed(skill.id);
    return replaySteps(d.services.ctx.browser, bot.id, skill.steps, tr);
  });

  // Bots' tables: the person reads, corrects and clears what a bot keeps there.
  app.get('/api/bots/:id/tables', async (req) => s.tables.list(IdParams.parse(req.params).id));
  app.get('/api/tables/:id/rows', async (req) => s.tables.rows(IdParams.parse(req.params).id));
  app.get('/api/tables/:id/rows.csv', async (req, reply) => {
    const t = await s.settings.translator();
    const { name, text } = await s.tables.csv(
      IdParams.parse(req.params).id,
      t('tool.tableYes'),
      t('tool.tableNo'),
    );
    // The table's own name, in any letters, with a plain fallback for older clients.
    const file = `${name.replace(/[\\/:*?"<>|]|\p{Cc}/gu, '_')}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="table.csv"; filename*=UTF-8''${encodeURIComponent(file)}`,
      )
      .send(text);
  });
  /** A row the person adds or fills in can be work a routine picks up; the row is saved whether or not one starts. */
  const rowsForRoutines = async (tableId: string, rows: TableRow[], req: FastifyRequest) => {
    await s.routines
      .runFromTableRows(await s.tables.get(tableId), rows, me(req).userId)
      .catch((err) => console.error(`Routines for table ${tableId} failed to start`, err));
  };
  app.post('/api/tables/:id/rows', async (req) => {
    const id = IdParams.parse(req.params).id;
    const rows = await s.tables.addRows(id, [RowValues.parse(req.body)], me(req).userId);
    await rowsForRoutines(id, rows, req);
    return rows[0];
  });
  app.patch('/api/tables/:id/rows/:rowId', async (req) => {
    const p = z.object({ id: z.string(), rowId: z.string() }).parse(req.params);
    const row = await s.tables.updateRow(p.id, p.rowId, RowValues.parse(req.body), me(req).userId);
    await rowsForRoutines(p.id, [row], req);
    return row;
  });
  app.delete('/api/tables/:id/rows/:rowId', async (req) => {
    const p = z.object({ id: z.string(), rowId: z.string() }).parse(req.params);
    return { deleted: await s.tables.deleteRows(p.id, [p.rowId]) };
  });
  app.delete('/api/tables/:id', async (req) => {
    await s.tables.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // The board: tickets the person and the bots work from.
  // The board: a person sees the tickets they opened and those of bots they may talk with; they
  // change those they opened or whose bot they may change.
  const seesTicket = (p: Principal, ticket: Ticket, levels: Map<string, BotLevel>) =>
    canAdminister(p.role) ||
    ticket.createdByUserId === p.userId ||
    (!!ticket.assigneeBotId && atLeast(levels.get(ticket.assigneeBotId) ?? 'none', 'chat'));
  const ticketFor = async (req: FastifyRequest, id: string, change: boolean) => {
    const p = me(req);
    const ticket = await s.tickets.get(id);
    const levels = await s.access.levels(p);
    if (!seesTicket(p, ticket, levels)) throw notFound('ticket');
    const mayChange =
      canAdminister(p.role) ||
      ticket.createdByUserId === p.userId ||
      (!!ticket.assigneeBotId && atLeast(levels.get(ticket.assigneeBotId) ?? 'none', 'edit'));
    if (change && !mayChange) throw new HttpError(403, 'error.botEditOnly');
    return ticket;
  };
  /** A ticket goes only to a bot the person may talk with. */
  const checkAssignee = async (req: FastifyRequest, botId: string | null | undefined) => {
    if (botId) await s.access.requireBot(me(req), botId, 'chat');
  };
  app.get('/api/tickets', async (req) => {
    const levels = await s.access.levels(me(req));
    return (await s.tickets.list()).filter((tk) => seesTicket(me(req), tk, levels));
  });
  app.post('/api/tickets', async (req) => {
    const body = TicketCreate.parse(req.body);
    await checkAssignee(req, body.assigneeBotId);
    return s.tickets.create(body, 'user', true, me(req).userId);
  });
  app.patch('/api/tickets/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const body = TicketUpdate.parse(req.body);
    await ticketFor(req, id, true);
    await checkAssignee(req, body.assigneeBotId);
    return s.tickets.update(id, body);
  });
  app.delete('/api/tickets/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ticketFor(req, id, true);
    await s.tickets.remove(id);
    return { ok: true };
  });
  app.post('/api/tickets/:id/comments', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ticketFor(req, id, false);
    return s.tickets.comment(id, TicketCommentCreate.parse(req.body).text);
  });

  // Plugins: read first, so the person sees what each would add, then installed as connections
  // and skills.
  app.post('/api/plugins/preview', async (req) =>
    s.plugins.preview(z.object({ url: z.string().min(1).max(2000) }).parse(req.body).url),
  );
  app.post('/api/plugins/install', async (req) =>
    s.plugins.install(PluginInstall.parse(req.body), me(req).userId),
  );
  app.get('/api/skills', async () => s.skills.list());
  app.post('/api/skills', async (req) => {
    const body = SkillCreate.parse(req.body);
    // Turning a skill on for a bot changes the bot.
    for (const botId of body.botIds ?? []) await s.access.requireBot(me(req), botId, 'edit');
    return s.skills.create(body, me(req).userId);
  });
  // A skill file from a link (a GitHub page of a SKILL.md, or any https address); read here, so
  // the page is not stopped by the other site's rules on who may read it.
  app.post('/api/skills/fetch', async (req) =>
    fetchSkillFile(z.object({ url: z.string().min(1).max(2000) }).parse(req.body).url),
  );
  /** A skill is changed by whoever made it and by those who look after the server. */
  const ownSkill = async (req: FastifyRequest, id: string) => {
    const p = me(req);
    const [row] = await s.ctx.db
      .select({ by: schema.skills.createdByUserId })
      .from(schema.skills)
      .where(eq(schema.skills.id, id))
      .limit(1);
    if (!row) throw notFound('skill');
    if (!canAdminister(p.role) && row.by !== p.userId) throw new HttpError(403, 'error.adminOnly');
  };
  app.patch('/api/skills/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ownSkill(req, id);
    return s.skills.update(id, SkillUpdate.parse(req.body));
  });
  app.delete('/api/skills/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ownSkill(req, id);
    await s.skills.remove(id);
    return { ok: true };
  });
  // Changes bots found for skills the person may not change, for those who decide on each skill.
  app.get('/api/skill-changes', async (req) => s.skills.changes(skillReach(req)));
  app.post('/api/skill-changes/:id/accept', async (req) =>
    s.skills.acceptChange(IdParams.parse(req.params).id, skillReach(req)),
  );
  app.post('/api/skill-changes/:id/reject', async (req) => {
    await s.skills.rejectChange(IdParams.parse(req.params).id, skillReach(req));
    return { ok: true };
  });
  app.put('/api/skills/:id/bots/:botId', async (req) => {
    const p = z.object({ id: z.string().min(1), botId: z.string().min(1) }).parse(req.params);
    await s.skills.get(p.id);
    await s.skills.setBot(p.id, p.botId, SkillBot.parse(req.body).on);
    return s.skills.get(p.id);
  });

  app.get('/api/groups', async () => s.bots.listGroups());
  app.post('/api/groups', async (req) => s.bots.createGroup(GroupCreate.parse(req.body).name));
  app.patch('/api/groups/:id', async (req) =>
    s.bots.renameGroup(IdParams.parse(req.params).id, GroupCreate.parse(req.body).name),
  );
  app.post('/api/groups/:id/move', async (req) =>
    s.bots.moveGroup(IdParams.parse(req.params).id, GroupMove.parse(req.body)),
  );
  app.post('/api/groups/:id/pause', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { paused } = PauseBody.parse(req.body);
    const group = await s.bots.setGroupPaused(id, paused);
    if (paused) await s.turns.stopBots(await s.bots.groupBotIds(id));
    else s.turns.schedule();
    return group;
  });
  app.delete('/api/groups/:id', async (req) => {
    await s.bots.deleteGroup(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // Threads and messages
  app.get('/api/bots/:id/threads', async (req) => {
    const id = IdParams.parse(req.params).id;
    return s.threads.list(id, await s.access.listScope(me(req), id));
  });
  app.get('/api/bots/:id/main-thread', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    return s.threads.main(id, me(req).userId);
  });
  app.post('/api/bots/:id/threads', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    return s.threads.create(id, { title: ThreadCreate.parse(req.body ?? {}).title, userId: me(req).userId });
  });
  app.get('/api/threads/:id', async (req) => s.threads.get(IdParams.parse(req.params).id));
  app.patch('/api/threads/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const body = z
      .object({
        title: z.string().max(120).optional(),
        goal: z.string().trim().max(2000).optional(),
        archived: z.boolean().optional(),
        /** Until when it stays out of the list; null brings it back. */
        snoozedUntil: z.iso
          .datetime({ offset: true })
          .refine((v) => new Date(v).getTime() > Date.now(), 'validation.snoozeFuture')
          .nullable()
          .optional(),
        pinned: z.boolean().optional(),
        /** One emoji (with its joiners and modifiers), or '' for none. */
        icon: z
          .string()
          .max(16)
          .refine((v) => v === '' || /^\p{Extended_Pictographic}/u.test(v), 'validation.emoji')
          .optional(),
      })
      .parse(req.body);
    if (body.icon !== undefined) await s.threads.setIcon(id, body.icon);
    if (body.title !== undefined) await s.threads.rename(id, body.title);
    if (body.archived !== undefined) await s.threads.archive(id, body.archived);
    if (body.snoozedUntil !== undefined)
      await s.threads.snooze(id, body.snoozedUntil ? new Date(body.snoozedUntil) : null);
    if (body.pinned !== undefined) await s.threads.pinInList(id, body.pinned);
    if (body.goal !== undefined) await s.threads.setGoal(id, body.goal);
    return s.threads.get(id);
  });
  /** Deletes a conversation with its turns, its folder and its staged uploads. */
  const deleteThread = async (id: string, botId: string) => {
    await s.turns.interrupt(id);
    // Work it gave other bots would answer into a conversation that is gone.
    await s.jobs.stopFrom(id);
    await s.threads.remove(id);
    // The conversation's own folder (its attachments and what the bot made there) goes with it.
    const root = join(d.config.dataDir, 'workspaces', 'bots', botId, 'threads');
    await rm(join(root, id), { recursive: true, force: true }).catch(() => {});
    await rm(join(d.config.dataDir, 'uploads', id), { recursive: true, force: true }).catch(() => {});
    await rm(join(d.config.dataDir, 'upload-ids', id), { recursive: true, force: true }).catch(() => {});
  };
  app.delete('/api/threads/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { botId } = await s.threads.row(id);
    await deleteThread(id, botId);
    return { ok: true };
  });
  // Every conversation of a bot but its main one: a clean slate without losing the bot.
  app.delete('/api/bots/:id/threads', async (req) => {
    const id = IdParams.parse(req.params).id;
    await s.bots.get(id);
    // Only the person's own conversations: the bot's own work and others' stay.
    const { userId } = me(req);
    const main = await s.threads.main(id, userId);
    const others = (await s.threads.list(id, { userId, botWork: false })).filter((th) => th.id !== main.id);
    for (const th of others) await deleteThread(th.id, id);
    return { deleted: others.length };
  });
  app.get('/api/threads/:id/messages', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { before } = z.object({ before: z.string().max(100).optional() }).parse(req.query);
    await s.threads.row(id);
    return s.threads.messages(id, { before });
  });
  app.post('/api/threads/:id/messages', async (req, reply) => {
    const id = IdParams.parse(req.params).id;
    const thread = await s.threads.row(id);
    // A room has its members answer in turn, not the one bot its thread points at.
    if (thread.kind === 'room') {
      const { message, created } = await s.rooms.post(id, RoomSend.parse(req.body), me(req).userId);
      return reply.code(created ? 201 : 200).send(message);
    }
    const { offline, ...body } = SendMessage.parse(req.body);
    const { message, created } = await s.inbox.send(id, {
      ...body,
      userId: me(req).userId,
      // Kept on the message, so the conversation shows it was held while the app was offline.
      ...(offline && { props: { sentOffline: true } }),
    });
    return reply.code(created ? 201 : 200).send(message);
  });

  /** A message still waiting for its turn, or a 409 once the bot has started on it. */
  const queuedMessage = async (id: string) => {
    const m = await s.threads.message(id);
    if (m.role !== 'user' || m.author !== 'user' || !m.turnId || !m.props.queued) {
      throw new HttpError(409, 'error.messageStarted');
    }
    return m;
  };

  // Change a message the bot has not started on yet; its turn takes the new text.
  app.patch('/api/messages/:id', async (req) => {
    const m = await queuedMessage(IdParams.parse(req.params).id);
    const { text } = z.object({ text: z.string().max(100_000) }).parse(req.body);
    const files = (m.props.files as { name: string }[] | undefined) ?? [];
    if (!text.trim() && !files.length) throw new HttpError(400, 'validation.emptyMessage');
    const thread = await s.threads.row(m.threadId);
    const bot = await s.bots.get(thread.botId);
    const quotedId = (m.props.replyTo as { id?: string } | undefined)?.id;
    const answered = quotedId ? await s.threads.message(quotedId).catch(() => undefined) : undefined;
    const prompt = await s.inbox.prompt(text.trim(), s.inbox.threadDir(bot, m.threadId), files, answered);
    if (!(await s.turns.editQueued(m.turnId!, prompt))) throw new HttpError(409, 'error.messageStarted');
    await s.threads.editText(m.id, text.trim());
    return s.threads.message(m.id);
  });

  // The person's answer on a work offer: taken sends its task as their message; or turned down.
  // Whether bots can use the person's own Mac, and opening macOS's prompts for its two permissions.
  app.get('/api/person-computer', async (): Promise<PersonComputerState> => {
    const pc = s.ctx.personComputer;
    if (!pc) return { available: false, accessibility: false, screen: false };
    const st = await pc.status().catch(() => null);
    return { available: true, accessibility: st?.accessibility ?? false, screen: st?.screen ?? false };
  });
  app.post('/api/person-computer/request', async (): Promise<PersonComputerState> => {
    const pc = s.ctx.personComputer;
    if (!pc) return { available: false, accessibility: false, screen: false };
    const st = await pc.request();
    return { available: true, accessibility: st.accessibility, screen: st.screen };
  });
  // Sharing this server on the person's Tailscale network.
  app.get('/api/tailscale', async () => s.tailscale.state());
  app.post('/api/tailscale', async (req) => {
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    return s.tailscale.share(on);
  });

  // What a web link in a conversation shows on a hover; none when the page gives nothing.
  app.get('/api/link-preview', async (req) => {
    const { url } = z.object({ url: z.string().min(1).max(2048) }).parse(req.query);
    return { preview: await s.linkPreviews.get(url) };
  });

  app.post('/api/messages/:id/offer', async (req) => {
    const { take } = z.object({ take: z.boolean() }).parse(req.body);
    return s.offers.answer(IdParams.parse(req.params).id, take, me(req).userId);
  });

  // Hand a waiting message to the turn running now, so the bot reads it at its next step.
  app.post('/api/messages/:id/steer', async (req) => {
    const m = await queuedMessage(IdParams.parse(req.params).id);
    if (!(await s.turns.steer(m.threadId, m.turnId!, m.id))) throw new HttpError(409, 'error.nothingRunning');
    return s.threads.message(m.id);
  });

  // Take back a message the bot has not started on yet, or remove one from the conversation.
  // A removed message leaves the chat; what the bot already read of it stays in its memory of
  // the conversation. Cards and bot-to-bot markers stay: they belong to work under way.
  // Runs again the request a failed or stopped turn left unanswered.
  app.post('/api/messages/:id/retry', async (req) => {
    const turn = await s.turns.retry(IdParams.parse(req.params).id);
    if (!turn) throw new HttpError(409, 'error.cannotRetry');
    return { ok: true, turnId: turn.id };
  });
  app.delete('/api/messages/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const m = await s.threads.message(id);
    if (m.props.queued) {
      const queued = await queuedMessage(id);
      if (!(await s.turns.cancelQueued(queued.turnId!))) throw new HttpError(409, 'error.messageStarted');
    } else if (m.role === 'approval' || m.role === 'marker') {
      throw new HttpError(409, 'error.messageKept');
    }
    await s.threads.removeMessage(m.id);
    return { ok: true };
  });

  // The person's emoji on a bot message. Once it settles the bot hears of it and may answer or stay quiet.
  app.put('/api/threads/:id/pin', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { messageId } = z.object({ messageId: z.string().min(1).max(64).nullable() }).parse(req.body);
    await s.threads.pin(id, messageId);
    return s.threads.get(id);
  });
  // A new conversation from the start of this one up to a message, to try another way from there.
  app.post('/api/messages/:id/fork', async (req) => {
    const id = IdParams.parse(req.params).id;
    const m = await s.threads.message(id);
    const source = await s.threads.get(m.threadId);
    const t = await s.settings.translator();
    const title = t('thread.forkTitle', { title: source.title || t('thread.untitled') });
    return s.threads.fork(id, truncate(title, 120), me(req).userId);
  });
  app.put('/api/messages/:id/reaction', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { emoji } = MessageReaction.parse(req.body);
    if (emoji !== null && !EMOJI.test(emoji)) throw new HttpError(400, 'error.notOneEmoji');
    const m = await s.threads.message(id);
    if (m.role !== 'assistant') throw new HttpError(400, 'error.reactBotOnly');
    const updated = await s.threads.setReaction(id, emoji);
    s.reactions.changed(id);
    return updated;
  });

  // Files the person attaches wait in a staging folder; sending the message moves them into the
  // conversation's folder.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  // A recording from the message box's microphone button, as the browser made it.
  app.addContentTypeParser(/^audio\//, (_req, payload, done) => done(null, payload));
  app.get('/api/transcribe', async () => ({ available: await d.transcribe.available() }));
  // A reply read aloud by the speech service the settings name; the app plays it.
  app.get('/api/speech', async () => ({ available: await s.speech.available() }));
  app.post('/api/speech', async (req, reply) => {
    const { text } = z.object({ text: z.string().min(1).max(100_000) }).parse(req.body);
    const { audio, type } = await s.speech.speak(text);
    return reply.header('cache-control', 'no-store').type(type).send(audio);
  });
  app.post('/api/transcribe', async (req) => {
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.body) {
      size += (chunk as Buffer).length;
      if (size > MAX_AUDIO_BYTES) {
        throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(MAX_AUDIO_BYTES / 1024 / 1024) });
      }
      chunks.push(chunk as Buffer);
    }
    const { lang } = z.object({ lang: z.enum(LOCALES).optional() }).parse(req.query);
    const text = await d.transcribe.transcribe(
      Buffer.concat(chunks),
      String(req.headers['content-type'] ?? 'audio/webm'),
      lang,
    );
    return { text };
  });
  app.post('/api/threads/:id/files', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { name, uploadId } = z
      .object({
        name: z.string().min(1).max(500),
        uploadId: UploadId.optional(),
      })
      .parse(req.query);
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const thread = await s.threads.row(id);
    const bot = await s.bots.get(thread.botId);
    if (bot.archivedAt) throw new HttpError(409, 'error.botArchived');
    return saveStagedUpload(d.config.dataDir, id, name, req.body, uploadId);
  });
  // A file taken off while it was still going up: removed whether its upload got through already
  // or gets through later, so nothing is left in the staging folder.
  app.delete('/api/threads/:id/uploads/:uploadId', async (req) => {
    const { id, uploadId } = z.object({ id: z.string().min(1), uploadId: UploadId }).parse(req.params);
    await s.threads.row(id);
    await cancelStagedUpload(d.config.dataDir, id, uploadId);
    return { ok: true };
  });
  // Removes a file attached in the composer but taken off (or left) before sending. Only staged
  // uploads: files already in the conversation folder are not reached from here.
  app.delete('/api/threads/:id/files/:name', async (req) => {
    const { id, name } = z.object({ id: z.string().min(1), name: FileName }).parse(req.params);
    await s.threads.row(id);
    const dir = stagingDir(d.config.dataDir, id);
    attachedFiles(dir, [name]);
    await rm(join(dir, name));
    return { ok: true };
  });
  // The bot starts this conversation afresh; refused while it is working on it.
  app.post('/api/threads/:id/reset', async (req) => {
    const id = IdParams.parse(req.params).id;
    if ((await s.threads.state(id)) !== 'idle') throw new HttpError(409, 'error.threadBusy');
    await s.threads.resetContext(id, await s.settings.translator());
    return { ok: true };
  });

  app.post('/api/threads/:id/stop', async (req) => {
    const id = IdParams.parse(req.params).id;
    const stopped = await s.turns.interrupt(id);
    // The work this bot handed to others stops with it.
    const teammates = await s.jobs.stopFrom(id);
    return { stopped: stopped || teammates > 0, teammates };
  });

  // Rooms: the person and several bots in one conversation. Its messages, cards and files are the
  // thread's own routes; a room's id is its thread's id.
  app.get('/api/rooms', async (req) => s.rooms.list(me(req).userId));
  app.post('/api/rooms', async (req) => {
    const body = RoomCreate.parse(req.body);
    // Every bot in the room must be one the person may talk with.
    for (const botId of body.botIds) await s.access.requireBot(me(req), botId, 'chat');
    return s.rooms.create(body, me(req).userId);
  });
  app.get('/api/rooms/:id', async (req) => s.rooms.get(IdParams.parse(req.params).id));
  app.patch('/api/rooms/:id', async (req) => {
    const body = RoomUpdate.parse(req.body);
    for (const botId of body.botIds ?? []) await s.access.requireBot(me(req), botId, 'chat');
    return s.rooms.update(IdParams.parse(req.params).id, body);
  });
  app.delete('/api/rooms/:id', async (req) => {
    await s.rooms.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/rooms/:id/messages', async (req, reply) => {
    const { message, created } = await s.rooms.post(
      IdParams.parse(req.params).id,
      RoomSend.parse(req.body),
      me(req).userId,
    );
    return reply.code(created ? 201 : 200).send(message);
  });
  app.post('/api/rooms/:id/stop', async (req) => ({
    stopped: await s.rooms.stop(IdParams.parse(req.params).id),
  }));

  // A room's meetings: asked about when a talk starts, their minutes written once they end, and
  // approved by the person, who chooses which bots are to know them.
  const MeetingParams = z.object({ id: z.string().min(1).max(64), meetingId: z.string().min(1).max(64) });
  const meetingRoom = async (req: FastifyRequest) => {
    const { id } = IdParams.parse(req.params);
    if (!(await s.rooms.isRoom(id))) throw notFound('room');
    return id;
  };
  app.get('/api/rooms/:id/meetings', async (req) => s.meetings.list(await meetingRoom(req)));
  app.post('/api/rooms/:id/meetings', async (req) => s.meetings.begin(await meetingRoom(req)));
  app.post('/api/rooms/:id/meetings/:meetingId/answer', async (req) => {
    const { id, meetingId } = MeetingParams.parse(req.params);
    return s.meetings.answer(id, meetingId, MeetingAnswer.parse(req.body));
  });
  app.post('/api/rooms/:id/meetings/:meetingId/end', async (req) => {
    const { id, meetingId } = MeetingParams.parse(req.params);
    return s.meetings.end(id, meetingId);
  });
  app.post('/api/rooms/:id/meetings/:meetingId/resume', async (req) => {
    const { id, meetingId } = MeetingParams.parse(req.params);
    return s.meetings.resume(id, meetingId);
  });
  app.post('/api/rooms/:id/meetings/:meetingId/retry', async (req) => {
    const { id, meetingId } = MeetingParams.parse(req.params);
    return s.meetings.retry(id, meetingId);
  });
  app.post('/api/rooms/:id/meetings/:meetingId/save', async (req) => {
    const { id, meetingId } = MeetingParams.parse(req.params);
    return s.meetings.save(id, meetingId, MeetingSave.parse(req.body), me(req));
  });
  app.delete('/api/rooms/:id/meetings/:meetingId', async (req) => {
    const { id, meetingId } = MeetingParams.parse(req.params);
    await s.meetings.remove(id, meetingId);
    return { ok: true };
  });

  // Bot-to-bot exchange behind a marker line: that one request, not the pair's whole history.
  app.get('/api/jobs/:id', async (req) => {
    const job = await s.jobs.get(IdParams.parse(req.params).id);
    return { job, messages: await s.jobs.exchange(job) };
  });
  app.get('/api/bots/:id/conversations', async (req) => {
    const id = IdParams.parse(req.params).id;
    const rows = await s.ctx.db.select().from(schema.threads).where(eq(schema.threads.peerBotId, id));
    return rows.map((r) => ({ threadId: r.id, botId: r.botId }));
  });

  // Approvals and rules
  app.get('/api/approvals', async (req) => {
    const q = z
      .object({ status: z.enum(['pending', 'allowed', 'denied', 'expired']).optional() })
      .parse(req.query);
    const { seen, answerable } = await s.access.summaryScope(me(req));
    return s.approvals.list({ ...q, seen, answerable });
  });
  app.get('/api/approvals/:id', async (req) => s.approvals.get(IdParams.parse(req.params).id));
  app.post('/api/approvals/:id', async (req) =>
    s.approvals.answer(IdParams.parse(req.params).id, ApprovalDecision.parse(req.body), me(req).userId),
  );
  // Steps that wait for this person's second yes, without the conversations they come from.
  app.get('/api/approvals-second', async (req): Promise<SecondYes[]> => {
    const locale = await serverLocale(s.ctx);
    const names = await s.connections.names();
    const botNames = new Map((await s.bots.list()).map((b) => [b.id, b.name]));
    return (await s.approvals.waitingForSecond(me(req).userId)).map(({ card, askedBy }) => {
      const server = connectionToolParts(card.toolName)?.server;
      const said = describeAction(card.toolName, card.input, {
        bot: botNames.get(card.botId) ?? '',
        locale,
        service: server ? names.get(server) : undefined,
      });
      return {
        id: card.id,
        botId: card.botId,
        askedBy,
        summary: card.summary,
        step: said.step,
        detail: said.detail,
        firstApprover: card.firstApprover ?? null,
        firstAt: card.firstAt ?? card.createdAt,
        createdAt: card.createdAt,
      };
    });
  });
  // The second yes, given from that list: it only reaches a card waiting for one.
  app.post('/api/approvals-second/:id', async (req) =>
    s.approvals.answer(IdParams.parse(req.params).id, ApprovalDecision.parse(req.body), me(req).userId, {
      fromList: true,
    }),
  );
  // Who could give a second yes on a bot's steps (every bot's, without `botId`).
  app.get('/api/approvers', async (req): Promise<Approver[]> => {
    const { botId } = z.object({ botId: z.string().min(1).optional() }).parse(req.query);
    await checkRuleBot(req, botId);
    return s.approvals.approvers(botId ?? null);
  });
  // What a bot changed, and what let each step through.
  app.get('/api/bots/:id/actions', async (req) => {
    const { id } = IdParams.parse(req.params);
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(500).default(100) })
      .parse(req.query);
    await s.bots.get(id);
    return s.actions.list(id, limit);
  });
  // Ways to ask less, from the person's own answers on the bot's cards.
  app.get('/api/bots/:id/suggestions', async (req) => {
    const bot = await s.bots.get(IdParams.parse(req.params).id);
    const locale = await serverLocale(s.ctx);
    const names = await s.connections.names();
    // The step the rule would let through, in the words a card uses for it.
    return s.approvals.suggestions(bot.id, bot.permissionMode, (c, pattern) => {
      const server = connectionToolParts(c.toolName)?.server;
      // A rule for the whole tool is said without the latest card's details ("a routine", not "Morning").
      const input = pattern === c.toolName ? {} : c.input;
      return describeAction(c.toolName, input, {
        bot: bot.name,
        locale,
        service: server ? names.get(server) : undefined,
      }).step;
    });
  });
  app.post('/api/bots/:id/suggestions/dismiss', async (req) => {
    const bot = await s.bots.get(IdParams.parse(req.params).id);
    await s.approvals.dismissSuggestion(bot.id, SuggestionDismiss.parse(req.body).key);
    return { ok: true };
  });
  app.get('/api/bots/:id/actions.csv', async (req, reply) => {
    const { id } = IdParams.parse(req.params);
    await s.bots.get(id);
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="leafbot-steps-${id}.csv"`)
      .send(await s.actions.csv(id));
  });
  // Rules for every bot are the server's: those who look after it set them. A bot's own rules are
  // set by those who may change the bot.
  const checkRuleBot = async (req: FastifyRequest, botId: string | null | undefined) => {
    if (botId) await s.access.requireBot(me(req), botId, 'edit');
    else requireAdmin(me(req));
  };
  app.get('/api/rules', async (req) => {
    const editable = new Set(await s.access.botIds(me(req), 'edit'));
    return (await s.approvals.rules()).filter((r) => !r.botId || editable.has(r.botId));
  });
  app.post('/api/rules', async (req) => {
    const body = PermissionRuleCreate.parse(req.body);
    await checkRuleBot(req, body.botId);
    return s.approvals.addRule(body, me(req).userId);
  });
  app.delete('/api/rules/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    const rule = (await s.approvals.rules()).find((r) => r.id === id);
    if (!rule) throw new HttpError(404, 'error.notFound');
    await checkRuleBot(req, rule.botId);
    await s.approvals.removeRule(id);
    return { ok: true };
  });

  // Connections: remote MCP servers. Tokens and secrets are write-only.
  const redirectUrl = (req: FastifyRequest) =>
    d.config.publicUrl
      ? `${d.config.publicUrl}${OAUTH_CALLBACK_PATH}`
      : oauthRedirectUrl({
          protocol: req.protocol,
          host: req.headers.host ?? req.host,
          forwardedProto: req.headers['x-forwarded-proto'],
          secure: d.config.secureCookies,
        });
  const ToolParams = z.object({ id: z.string().min(1), name: z.string().min(1).max(500) });
  /**
   * A connection a person may see: the team's or their own; another person's is not found. To
   * change the team's, they must look after the server.
   */
  const connectionFor = async (req: FastifyRequest, id: string, change: boolean) => {
    const c = await s.connections.get(id);
    const who = me(req);
    if (c.userId && c.userId !== who.userId) throw new HttpError(404, 'error.notFound.connection');
    if (change && !c.userId && !managesServer(who.role)) throw new HttpError(403, 'error.adminOnly');
    return c;
  };
  /** Who a connection or sign-in goes to: the team's only for those who look after the server. */
  const ownerFor = (req: FastifyRequest, team: boolean | undefined): string | null | undefined => {
    if (team === undefined) return undefined;
    if (!team) return me(req).userId;
    if (!managesServer(me(req).role)) throw new HttpError(403, 'error.adminOnly');
    return null;
  };
  /**
   * The server calls a connection's address itself: only those who look after it may point one
   * at this machine or the private network it sits in.
   */
  const checkConnectionUrl = async (req: FastifyRequest, url: string | undefined) => {
    if (!url || managesServer(me(req).role)) return;
    if (await privateHost(new URL(url).hostname)) throw new HttpError(400, 'error.connectionPrivate');
  };
  /** Whose a new connection or sign-in is: the team's when asked for, otherwise the person's. */
  const ownerOrSelf = (req: FastifyRequest, team: boolean | undefined): string | null => {
    const given = ownerFor(req, team);
    return given === undefined ? me(req).userId : given;
  };
  /** The bots a person opens their own connection or sign-in to must be ones they may talk with. */
  const checkOwnBots = async (req: FastifyRequest, botIds: readonly string[] | null | undefined) => {
    for (const botId of botIds ?? []) await s.access.requireBot(me(req), botId, 'chat');
  };
  app.get('/api/connections', async (req) => s.connections.list(me(req).userId));
  app.get('/api/connections/redirect-url', async (req) => ({ url: redirectUrl(req) }));
  app.post('/api/connections', async (req) => {
    const body = ConnectionCreate.parse(req.body);
    await checkConnectionUrl(req, body.url);
    const owner = ownerOrSelf(req, body.team);
    if (owner) await checkOwnBots(req, body.botIds);
    return s.connections.create(body, owner);
  });
  app.get('/api/connections/:id', async (req) => connectionFor(req, IdParams.parse(req.params).id, false));
  app.patch('/api/connections/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await connectionFor(req, id, true);
    const { team, ...patch } = ConnectionUpdate.parse(req.body);
    await checkConnectionUrl(req, patch.url);
    const owner = ownerFor(req, team);
    const changed = await s.connections.update(id, patch);
    return owner === undefined ? changed : s.connections.setOwner(id, owner);
  });
  app.delete('/api/connections/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await connectionFor(req, id, true);
    await s.connections.remove(id);
    return { ok: true };
  });
  app.get('/api/connections/:id/sender', async (req) => {
    const { id } = IdParams.parse(req.params);
    await connectionFor(req, id, false);
    return s.connections.mailSender(id);
  });
  app.post('/api/connections/:id/refresh', async (req) => {
    const { id } = IdParams.parse(req.params);
    await connectionFor(req, id, true);
    return s.connections.refresh(id);
  });
  app.post('/api/connections/:id/signin', async (req) => {
    const { id } = IdParams.parse(req.params);
    await connectionFor(req, id, true);
    return s.connections.startSignIn(id, redirectUrl(req));
  });
  app.post('/api/connections/:id/signout', async (req) => {
    const { id } = IdParams.parse(req.params);
    await connectionFor(req, id, true);
    return s.connections.signOut(id);
  });
  app.patch('/api/connections/:id/tools/:name', async (req) => {
    const { id, name } = ToolParams.parse(req.params);
    await connectionFor(req, id, true);
    return s.connections.setTool(id, name, ConnectionToolPatch.parse(req.body));
  });
  app.put('/api/connections/:id/bots', async (req) => {
    const { id } = IdParams.parse(req.params);
    const c = await connectionFor(req, id, true);
    const body = ConnectionBots.parse(req.body);
    if (c.userId) await checkOwnBots(req, body.allBots ? [] : body.botIds);
    return s.connections.setBots(id, body);
  });
  // This server as an OAuth client, for a service that takes an address as the client's id: the
  // service reads it here, so the address names the callback it may send the person back to.
  app.get(OAUTH_CLIENT_PATH, async (req, reply) => {
    const redirect = redirectUrl(req);
    const id = clientMetadataUrlFor(redirect, OAUTH_CLIENT_PATH);
    if (!id) throw new HttpError(404, 'error.notFound');
    return reply
      .header('cache-control', 'public, max-age=3600')
      .send({ client_id: id, ...clientMetadata(redirect) });
  });
  // The service sends the person's browser back here, without the app's cookie: the one-time
  // state stands for the session that began the sign-in.
  app.get(OAUTH_CALLBACK_PATH, async (req, reply) => {
    const q = z
      .object({
        state: z.string().max(200).default(''),
        code: z.string().max(4000).optional(),
        error: z.string().max(500).optional(),
        error_description: z.string().max(1000).optional(),
      })
      .parse(req.query);
    const t = await s.settings.translator();
    let ok = true;
    let text: string;
    try {
      const name = await s.connections.finishSignIn({
        state: q.state,
        code: q.code,
        error: q.error ? `(${[q.error, q.error_description].filter(Boolean).join(': ')})` : undefined,
      });
      text = t('connection.page.done', { name });
    } catch (err) {
      ok = false;
      text = err instanceof HttpError ? err.localized(t) : (err as Error).message;
    }
    return reply
      .code(ok ? 200 : 400)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', PLAIN_PAGE_POLICY)
      .header('cache-control', 'no-store')
      .send(
        callbackPage(
          t('connection.page.title'),
          ok ? text : t('connection.page.failed'),
          ok ? t('connection.page.doneHint') : text,
        ),
      );
  });

  // Password vault: sign-ins are listed without their passwords.
  // Model services besides the bots' own: embeddings for memory search, speech in and out.
  const AiKindParams = z.object({ kind: z.enum(AI_KINDS) });
  app.get('/api/ai-endpoints', async () => ({
    ...(await s.ai.all()),
    memoryIndex: await s.embeddings.status(),
  }));
  app.put('/api/ai-endpoints/:kind', async (req) =>
    s.ai.set(AiKindParams.parse(req.params).kind, AiEndpointSet.parse(req.body)),
  );
  app.delete('/api/ai-endpoints/:kind', async (req) => s.ai.clear(AiKindParams.parse(req.params).kind));
  app.post('/api/ai-endpoints/:kind/test', async (req) => {
    const { kind } = AiKindParams.parse(req.params);
    try {
      if (kind === 'embeddings') return { ok: true, detail: String((await s.embeddings.test()).dimensions) };
      if (kind === 'stt') return { ok: true, detail: await d.transcribe.test() };
      return { ok: true, detail: String((await s.speech.test()).bytes) };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  });

  // OpenAPI documents whose operations bots may call, with a saved API key.
  app.get('/api/api-sources', async () => s.apiSources.list());
  app.post('/api/api-sources', async (req) => s.apiSources.create(ApiSourceCreate.parse(req.body)));
  app.post('/api/api-sources/:id/refresh', async (req) =>
    s.apiSources.refresh(IdParams.parse(req.params).id),
  );
  app.delete('/api/api-sources/:id', async (req) => {
    await s.apiSources.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // API keys bots call services with; listed without their values. Each is a person's own or the
  // team's, as sign-ins are.
  /** A key a person may change: their own, or the team's when they look after the server. */
  const keyFor = async (req: FastifyRequest, id: string) => {
    const k = await s.apiCredentials.get(id);
    const who = me(req);
    if (k.userId && k.userId !== who.userId) throw notFound('apiKey');
    if (!k.userId && !managesServer(who.role)) throw new HttpError(403, 'error.adminOnly');
    return k;
  };
  app.get('/api/api-keys', async (req) => s.apiCredentials.list(me(req).userId));
  app.post('/api/api-keys', async (req) => {
    const { team, ...body } = ApiCredentialCreate.parse(req.body);
    // Left out, a key is the team's for those who look after the server, as every key was before
    // keys had owners, and the person's own for everyone else.
    const owner = ownerFor(req, team ?? managesServer(me(req).role));
    if (owner) await checkOwnBots(req, body.botIds);
    return s.apiCredentials.create(body, owner ?? null);
  });
  // A trap key: always the person's own, with an address the server makes up.
  app.post('/api/api-keys/trap', async (req) => {
    const body = TrapKeyCreate.parse(req.body);
    await checkOwnBots(req, body.botIds);
    return s.apiCredentials.createTrap(body, me(req).userId);
  });
  // Alarms of a bot caught steered by text it read: the person's own, marked seen once read.
  app.post('/api/canary-alarms/:id/seen', async (req) => {
    await s.canary.seen(IdParams.parse(req.params).id, me(req).userId);
    return { ok: true };
  });
  // Promises made to the person by a bot, or by the person to others: their own, never anyone else's.
  app.get('/api/promises', async (req) => s.promises.list(me(req).userId));
  app.post('/api/promises/:id/done', async (req) =>
    s.promises.close(IdParams.parse(req.params).id, me(req).userId, 'done'),
  );
  app.post('/api/promises/:id/drop', async (req) =>
    s.promises.close(IdParams.parse(req.params).id, me(req).userId, 'dropped'),
  );
  // Routines suggested from what the person keeps asking by hand: their own, never anyone else's.
  app.get('/api/routine-suggestions', async (req) => s.routineSuggestions.list(me(req)));
  app.post('/api/routine-suggestions/:id/accept', async (req) =>
    s.routineSuggestions.accept(
      IdParams.parse(req.params).id,
      me(req),
      RoutineSuggestionAccept.parse(req.body ?? {}),
    ),
  );
  app.post('/api/routine-suggestions/:id/dismiss', async (req) =>
    s.routineSuggestions.dismiss(IdParams.parse(req.params).id, me(req).userId),
  );
  // Skills suggested from many-step tasks the person keeps asking for: their own, never anyone else's.
  app.get('/api/skill-suggestions', async (req) => s.skillSuggestions.list(me(req)));
  app.post('/api/skill-suggestions/:id/accept', async (req) =>
    s.skillSuggestions.accept(
      IdParams.parse(req.params).id,
      me(req),
      SkillSuggestionAccept.parse(req.body ?? {}),
    ),
  );
  app.post('/api/skill-suggestions/:id/dismiss', async (req) =>
    s.skillSuggestions.dismiss(IdParams.parse(req.params).id, me(req).userId),
  );
  app.post('/api/api-keys/import', async (req) => {
    const { team, ...body } = ApiKeyImport.parse(req.body);
    const owner = ownerFor(req, team ?? managesServer(me(req).role));
    if (owner) await checkOwnBots(req, body.botIds);
    return s.apiCredentials.importEnv(body, owner ?? null);
  });
  app.patch('/api/api-keys/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const k = await keyFor(req, id);
    const { team, ...body } = ApiCredentialUpdate.parse(req.body);
    const owner = ownerFor(req, team);
    if ((owner === undefined ? k.userId : owner) && body.botIds) await checkOwnBots(req, body.botIds);
    return s.apiCredentials.update(id, body, owner);
  });
  app.delete('/api/api-keys/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await keyFor(req, id);
    await s.apiCredentials.remove(id);
    return { ok: true };
  });
  /** A sign-in a person may change: their own, or the team's when they look after the server. */
  const loginFor = async (req: FastifyRequest, id: string) => {
    const v = await s.vault.get(id);
    const who = me(req);
    if (v.userId && v.userId !== who.userId) throw notFound('vault');
    if (!v.userId && !managesServer(who.role)) throw new HttpError(403, 'error.adminOnly');
    return v;
  };
  app.get('/api/vault', async (req) => s.vault.list(me(req).userId));
  app.post('/api/vault', async (req) => {
    const { team, ...body } = VaultLoginCreate.parse(req.body);
    const owner = ownerOrSelf(req, team);
    if (owner) await checkOwnBots(req, body.botIds);
    return s.vault.save(body, owner);
  });
  app.patch('/api/vault/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const v = await loginFor(req, id);
    const { team, ...body } = VaultLoginUpdate.parse(req.body);
    const owner = ownerFor(req, team);
    if ((owner === undefined ? v.userId : owner) && body.botIds) await checkOwnBots(req, body.botIds);
    return s.vault.update(id, body, owner);
  });
  app.post('/api/vault/import', async (req) => {
    const { team, ...body } = VaultImport.parse(req.body);
    const owner = ownerOrSelf(req, team);
    if (owner) await checkOwnBots(req, body.botIds);
    return s.vault.importCsv(body, owner);
  });
  app.delete('/api/vault/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await loginFor(req, id);
    await s.vault.remove(id);
    return { ok: true };
  });

  /** A password manager a person may change: their own, or the team's when they look after the server. */
  const managerFor = async (req: FastifyRequest, id: string) => {
    const m = await s.passwordManagers.get(id);
    const who = me(req);
    if (m.userId && m.userId !== who.userId) throw notFound('vault');
    if (!m.userId && !managesServer(who.role)) throw new HttpError(403, 'error.adminOnly');
    return m;
  };
  app.get('/api/password-managers', async (req) => s.passwordManagers.list(me(req).userId));
  app.post('/api/password-managers', async (req) => {
    const { team, ...body } = PasswordManagerCreate.parse(req.body);
    const owner = ownerOrSelf(req, team);
    if (owner) await checkOwnBots(req, body.botIds);
    return s.passwordManagers.create(body, owner);
  });
  app.patch('/api/password-managers/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const m = await managerFor(req, id);
    const { team, ...body } = PasswordManagerUpdate.parse(req.body);
    const owner = ownerFor(req, team);
    if ((owner === undefined ? m.userId : owner) && body.botIds) await checkOwnBots(req, body.botIds);
    return s.passwordManagers.update(id, body, owner);
  });
  app.post('/api/password-managers/:id/refresh', async (req) => {
    const { id } = IdParams.parse(req.params);
    await managerFor(req, id);
    return s.passwordManagers.refresh(id);
  });
  app.delete('/api/password-managers/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await managerFor(req, id);
    await s.passwordManagers.remove(id);
    return { ok: true };
  });

  /** A card a person may change: their own, or the team's when they look after the server. */
  const cardFor = async (req: FastifyRequest, id: string) => {
    const c = await s.cards.get(id);
    const who = me(req);
    if (c.userId && c.userId !== who.userId) throw notFound('vault');
    if (!c.userId && !managesServer(who.role)) throw new HttpError(403, 'error.adminOnly');
    return c;
  };
  app.get('/api/cards', async (req) => s.cards.list(me(req).userId));
  app.post('/api/cards', async (req) => {
    const { team, ...body } = PaymentCardCreate.parse(req.body);
    const owner = ownerOrSelf(req, team);
    if (owner) await checkOwnBots(req, body.botIds);
    return s.cards.create(body, owner);
  });
  app.patch('/api/cards/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    const c = await cardFor(req, id);
    const { team, ...body } = PaymentCardUpdate.parse(req.body);
    const owner = ownerFor(req, team);
    if ((owner === undefined ? c.userId : owner) && body.botIds) await checkOwnBots(req, body.botIds);
    return s.cards.update(id, body, owner);
  });
  app.delete('/api/cards/:id', async (req) => {
    const { id } = IdParams.parse(req.params);
    await cardFor(req, id);
    await s.cards.remove(id);
    return { ok: true };
  });

  // Chat apps: a bot's own Telegram bot.
  app.get('/api/bots/:id/telegram', async (req) => s.telegram.status(IdParams.parse(req.params).id));
  app.put('/api/bots/:id/telegram', async (req) =>
    s.telegram.connect(IdParams.parse(req.params).id, TelegramConnect.parse(req.body).token, me(req).userId),
  );
  app.patch('/api/bots/:id/telegram', async (req) =>
    s.telegram.update(IdParams.parse(req.params).id, TelegramUpdate.parse(req.body)),
  );
  app.post('/api/bots/:id/telegram/pair', async (req) => s.telegram.pair(IdParams.parse(req.params).id));
  app.delete('/api/bots/:id/telegram', async (req) => {
    await s.telegram.disconnect(IdParams.parse(req.params).id);
    return { ok: true };
  });

  // Chat apps: WhatsApp through a linked device, for whichever bot is chosen.
  app.get('/api/whatsapp', async () => s.whatsapp.status());
  app.put('/api/whatsapp', async (req) => {
    const body = WhatsAppSet.parse(req.body);
    if (body.botId) await s.access.requireBot(me(req), body.botId, 'chat');
    return s.whatsapp.configure(body, me(req).userId);
  });
  app.post('/api/whatsapp/link', async () => s.whatsapp.link());
  // Its groups are listed only to the person whose WhatsApp it is.
  app.get('/api/whatsapp/groups', async (req) => {
    if ((await s.whatsapp.ownerId()) !== me(req).userId)
      throw new HttpError(403, 'error.whatsappGroupNotYours');
    return s.whatsapp.groups();
  });
  app.delete('/api/whatsapp', async () => s.whatsapp.disconnect());
  // The server's Slack app, set up by those who look after the server; each person links their own
  // Slack account to it with a code.
  app.get('/api/slack', async () => s.slack.status());
  app.put('/api/slack', async (req) => s.slack.connect(SlackConnect.parse(req.body)));
  app.patch('/api/slack', async (req) => s.slack.update(SlackUpdate.parse(req.body)));
  app.delete('/api/slack', async () => {
    await s.slack.disconnect();
    return { ok: true };
  });
  app.get('/api/slack/me', async (req) => s.slack.link(me(req).userId));
  app.post('/api/slack/me/code', async (req) => s.slack.newCode(me(req).userId));
  app.delete('/api/slack/me', async (req) => s.slack.unlink(me(req).userId));
  // The server's Teams bot, set up by those who look after the server; each person links their own
  // Teams account to it with a code.
  app.get('/api/teams', async () => s.teams.status());
  app.put('/api/teams', async (req) => s.teams.connect(TeamsConnect.parse(req.body)));
  app.patch('/api/teams', async (req) => s.teams.update(TeamsUpdate.parse(req.body)));
  app.delete('/api/teams', async () => {
    await s.teams.disconnect();
    return { ok: true };
  });
  app.get('/api/teams/me', async (req) => s.teams.link(me(req).userId));
  app.post('/api/teams/me/code', async (req) => s.teams.newCode(me(req).userId));
  app.delete('/api/teams/me', async (req) => s.teams.unlink(me(req).userId));
  // What Teams delivers: no access key, each request carries the Bot Framework's signed token,
  // which the channel checks before it reads anything.
  app.post(TEAMS_PATH, { bodyLimit: TEAMS_BODY_MAX }, async (req, reply) => {
    const status = await s.teams.receive(req.headers.authorization, req.body);
    return reply.code(status).send(status === 200 ? {} : { ok: false });
  });
  // The server's Discord bot, set up by those who look after the server. People in the Discord
  // servers it is in have no account here and link nothing.
  app.get('/api/discord', async () => s.discord.status());
  app.put('/api/discord', async (req) => s.discord.connect(DiscordConnect.parse(req.body)));
  app.patch('/api/discord', async (req) => s.discord.update(DiscordUpdate.parse(req.body)));
  app.delete('/api/discord', async () => {
    await s.discord.disconnect();
    return { ok: true };
  });

  // Memory: each person's notes about themselves, and the notes of the bots they may change.
  const memoryReach = async (req: FastifyRequest): Promise<MemoryReach> => ({
    userId: me(req).userId,
    botIds: await s.access.botIds(me(req), 'edit'),
    places: await s.memory.placesFor(me(req).userId, managesServer(me(req).role)),
    managesServer: managesServer(me(req).role),
  });
  /** A note the person reaches; another's reads as missing. */
  const ownNote = async (req: FastifyRequest, id: string) => {
    const reach = await memoryReach(req);
    const note = await s.memory.get(id);
    if (!s.memory.canEdit(note, reach.botIds, reach.userId, reach.places)) throw notFound('memory');
    return note;
  };
  /** A waiting change the person decides on; another's reads as missing. */
  const ownChange = async (req: FastifyRequest, id: string) => {
    const change = (await s.memory.pending(await memoryReach(req))).find((c) => c.id === id);
    if (!change) throw notFound('memory');
    return change;
  };
  app.get('/api/memory', async (req) => {
    const q = z
      .object({
        scope: z.enum(['bot', 'user', 'room']).optional(),
        botId: z.string().optional(),
      })
      .parse(req.query);
    return s.memory.list({ ...q, reach: await memoryReach(req) });
  });
  app.post('/api/memory', async (req) => {
    const b = MemoryCreate.parse(req.body);
    // A bot's note needs its bot, and leave to change it.
    if (b.scope === 'bot') await s.access.requireBot(me(req), b.botId ?? '', 'edit');
    // `source` says a person wrote it; the history says which person.
    return s.memory.create({ ...b, userId: me(req).userId, source: 'user', actor: actorOf(req) });
  });
  app.patch('/api/memory/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ownNote(req, id);
    // A change of the words may carry the version it was made on; pinning alone has none.
    const { updatedAt, ...patch } = MemoryUpdate.parse(req.body);
    return s.memory.update(id, { ...patch, expectedUpdatedAt: updatedAt }, actorOf(req));
  });
  // Every note one bot keeps for itself.
  app.delete('/api/bots/:id/memory', async (req) =>
    s.memory.removeForBot(IdParams.parse(req.params).id, actorOf(req)),
  );
  app.delete('/api/memory/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ownNote(req, id);
    await s.memory.remove(id, actorOf(req));
    return { ok: true };
  });
  // What happened to the notes the person reaches now.
  app.get('/api/memory-history', async (req) => {
    return s.memory.history(100, await memoryReach(req));
  });
  // Memory changes still waiting from before every change was made at once; none waits now.
  app.get('/api/memory-changes', async (req) => s.memory.pending(await memoryReach(req)));
  app.post('/api/memory-changes/:id/accept', async (req) => {
    const id = IdParams.parse(req.params).id;
    const { content } = z.object({ content: z.string().trim().max(2000).optional() }).parse(req.body ?? {});
    await ownChange(req, id);
    await s.memory.accept(id, content);
    return { ok: true };
  });
  app.delete('/api/memory-changes/:id', async (req) => {
    const id = IdParams.parse(req.params).id;
    await ownChange(req, id);
    await s.memory.reject(id);
    return { ok: true };
  });
  // Notes no bot uses any more, offered to the user to keep or delete.
  app.get('/api/memory-stale', async (req) => s.memory.stale(new Date(), await memoryReach(req)));
  // Deletes the ones of `ids` that are still unused; a note a bot used since the list was shown stays.
  app.post('/api/memory-stale/delete', async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().min(1).max(64)).max(5000) }).parse(req.body);
    const still = new Set((await s.memory.stale(new Date(), await memoryReach(req))).map((m) => m.id));
    return s.memory.removeMany(
      ids.filter((id) => still.has(id)),
      actorOf(req),
    );
  });

  // Routines
  // Bots exported from another assistant app, sent as the file itself. `preview` saves nothing.
  // The bots as an import file; `ids` picks some (comma separated), otherwise every active one.
  app.get('/api/export/bots', async (req, reply) => {
    const { ids } = z.object({ ids: z.string().max(20_000).optional() }).parse(req.query);
    const file = await s.botImport.export(ids ? ids.split(',').filter(Boolean) : undefined);
    const day = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="leafbot-bots-${day}.json"`);
    return file;
  });
  app.post('/api/import/bots', async (req) => {
    const { preview } = z.object({ preview: z.enum(['1']).optional() }).parse(req.query);
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const raw = await readJson(req.body, MAX_BOT_IMPORT_BYTES);
    return preview ? s.botImport.preview(raw) : s.botImport.commit(raw);
  });

  // What a Grok Bot share link shows: the bot's name, who shared it and its description. Read
  // here, since the page cannot read another site; the rest of the bot comes in the import file.
  app.post('/api/import/grok-link', async (req) =>
    readGrokLink(z.object({ url: z.string().min(1).max(2000) }).parse(req.body).url),
  );

  // A whole backup, sealed with a password: written on the server, then downloaded once.
  app.post('/api/backup', async (req) => {
    const { password } = z.object({ password: z.string().max(1000) }).parse(req.body);
    return d.backup.create(password);
  });
  app.get('/api/backup/:id', async (req, reply) => {
    const file = d.backup.path(IdParams.parse(req.params).id);
    if (!file) throw new HttpError(404, 'error.notFound');
    const day = new Date().toISOString().slice(0, 10);
    reply.header('content-disposition', `attachment; filename="leafbot-backup-${day}.ybk"`);
    reply.header('content-length', statSync(file).size);
    reply.type('application/octet-stream');
    // One download: the file holds everything, so it does not wait on the server once fetched.
    reply.raw.once('finish', () => void rm(file, { force: true }));
    return reply.send(createReadStream(file));
  });
  // The password comes in a header, URI-encoded, since the body is the file itself.
  app.post('/api/backup/restore', async (req) => {
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const raw = req.headers['x-backup-password'];
    let password = '';
    try {
      password = decodeURIComponent(typeof raw === 'string' ? raw : '');
    } catch {
      throw new HttpError(400, 'error.backupWrongPassword');
    }
    return d.backup.restore(req.body, password);
  });

  app.get('/api/routines', async (req) => {
    const q = z.object({ botId: z.string().optional() }).parse(req.query);
    // A routine runs as its bot's work: those who may change the bot see and set it.
    const editable = new Set(await s.access.botIds(me(req), 'edit'));
    return (await s.routines.list(q.botId)).filter((r) => editable.has(r.botId));
  });
  app.post('/api/routines', async (req) => {
    const body = RoutineCreate.parse(req.body);
    await s.access.requireBot(me(req), body.botId, 'edit');
    return s.routines.create(body, me(req).userId);
  });
  app.patch('/api/routines/:id', async (req) =>
    s.routines.update(IdParams.parse(req.params).id, RoutineUpdate.parse(req.body), me(req).userId),
  );
  app.delete('/api/routines/:id', async (req) => {
    await s.routines.remove(IdParams.parse(req.params).id);
    return { ok: true };
  });
  // A script may start a routine and hand it some text: `{ "payload": "…" }`, or a text body.
  app.post('/api/routines/:id/failure-seen', async (req) => {
    await s.routines.failureSeen(IdParams.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/routines/:id/run', async (req) => {
    const body = req.body;
    const payload =
      typeof body === 'string'
        ? body
        : z
            .object({ payload: z.string().optional() })
            .catch({})
            .parse(body ?? {}).payload;
    if (payload !== undefined && payload.length > MAX_PAYLOAD) {
      throw new HttpError(413, 'error.payloadTooLarge', { max: MAX_PAYLOAD });
    }
    return s.routines.runNow(IdParams.parse(req.params).id, payload?.trim() || undefined);
  });
  app.post('/api/routines/:id/webhook', async (req) =>
    s.routines.setWebhook(IdParams.parse(req.params).id, true),
  );
  app.delete('/api/routines/:id/webhook', async (req) =>
    s.routines.setWebhook(IdParams.parse(req.params).id, false),
  );
  const WebhookParams = z.object({ id: z.string().min(1).max(64), token: z.string().min(1).max(100) });
  const webhookHooks: RouteShorthandOptions = {
    // The secret is in the address, so it is checked before a byte of the body is read: a caller
    // without it cannot make the server hold megabytes for nothing.
    async onRequest(req) {
      const p = WebhookParams.safeParse(req.params);
      if (!p.success || !(await s.routines.webhookOpen(p.data.id, p.data.token)))
        throw new HttpError(404, 'error.notFound');
    },
    // A signed call is checked against the body exactly as it was sent, before it is parsed.
    async preParsing(req, _reply, payload) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        size += (chunk as Buffer).length;
        if (size > WEBHOOK_BODY_MAX)
          throw new HttpError(413, 'error.payloadTooLarge', { max: WEBHOOK_BODY_MAX });
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks);
      (req as { rawBody?: Buffer }).rawBody = raw;
      return Readable.from([raw]);
    },
  };
  // A service without the access key starts a routine through its secret address. The request's
  // body, whatever it is, goes to the bot as data.
  app.post(`${WEBHOOK_PATH}/:id/:token`, webhookHooks, async (req, reply) => {
    const p = WebhookParams.parse(req.params);
    const body = req.body;
    const raw =
      body === undefined || body === null
        ? ''
        : typeof body === 'string'
          ? body
          : JSON.stringify(body, null, 2);
    const payload = raw.length > MAX_PAYLOAD ? `${raw.slice(0, MAX_PAYLOAD)}…` : raw;
    // Senders that retry name each delivery; the same one sent again runs once.
    const header = (name: string) => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : undefined;
    };
    const delivery =
      header('idempotency-key') ??
      header('x-github-delivery') ??
      header('webhook-id') ??
      header('x-webhook-id');
    // Code hosts name the kind of event in a header; GitHub also signs the body.
    const event = header('x-github-event') ?? header('x-gitlab-event') ?? header('x-event-key');
    const signature = header('x-hub-signature-256');
    const run = await s.routines.runFromWebhook(p.id, p.token, payload.trim() || undefined, delivery, {
      event,
      signature,
      raw: (req as { rawBody?: Buffer }).rawBody,
    });
    if (run === false) throw new HttpError(404, 'error.notFound');
    if (run === 'signature') throw new HttpError(401, 'error.webhookSignature');
    if (run === 'ping') return reply.code(200).send({ ok: true, runId: null, status: 'ping' });
    if (run === 'filtered' || run === 'duplicate')
      return reply.code(202).send({ ok: true, runId: null, status: run });
    // An earlier run is still going: the sender is asked to deliver this one again in a minute.
    if (run === 'busy')
      return reply.code(429).header('retry-after', '60').send({ ok: false, status: 'busy' });
    return reply.code(202).send({ ok: true, runId: run?.id ?? null, status: run?.status ?? 'skipped' });
  });
  app.get('/api/routines/:id/runs', async (req) => s.routines.runs(IdParams.parse(req.params).id));
  // A run with steps that failed or was stopped goes on from that step.
  app.post('/api/routines/:id/runs/:runId/retry', async (req) => {
    const p = RunParams.parse(req.params);
    return s.routines.retryRun(p.id, p.runId);
  });
  app.post('/api/routines/:id/runs/:runId/end-wait', async (req) => {
    const p = RunParams.parse(req.params);
    return s.routines.endWait(p.id, p.runId);
  });
  app.get('/api/routines/:id/revisions', async (req) => s.routines.revisions(IdParams.parse(req.params).id));
  // Trying a routine without doing anything; each person sees only the rehearsals they asked for.
  app.post('/api/routines/:id/rehearse', async (req) =>
    s.rehearsals.start(IdParams.parse(req.params).id, me(req).userId, RehearsalStart.parse(req.body ?? {})),
  );
  app.get('/api/routines/:id/rehearsals', async (req) =>
    s.rehearsals.list(IdParams.parse(req.params).id, me(req).userId),
  );
  app.get('/api/routines/:id/rehearsals/:rehearsalId', async (req) => {
    const p = z
      .object({ id: z.string().min(1).max(64), rehearsalId: z.string().min(1).max(64) })
      .parse(req.params);
    return s.rehearsals.get(p.id, p.rehearsalId, me(req).userId);
  });
  app.get('/api/routines/:id/replayable', async (req) =>
    s.rehearsals.replayable(IdParams.parse(req.params).id, me(req).userId),
  );

  // Library: files in the bot's folders (read-only listing and download).
  const libraryRoots = async (botId: string) => {
    const bot = await s.bots.get(botId);
    const root = resolve(d.config.dataDir, 'workspaces');
    const roots = [join(root, 'bots', bot.id)];
    if (bot.groupId) roots.push(join(root, 'groups', bot.groupId, 'files'));
    return { root, roots, bot };
  };
  app.get('/api/bots/:id/library', async (req) => {
    const { root, roots } = await libraryRoots(IdParams.parse(req.params).id);
    const out: { path: string; name: string; size: number; modifiedAt: string }[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || out.length > 500) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.isFile()) {
          const st = statSync(full);
          out.push({
            path: relative(root, full),
            name: e.name,
            size: st.size,
            modifiedAt: st.mtime.toISOString(),
          });
        }
      }
    };
    for (const r of roots) walk(r, 0);
    return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  });
  /** A file in the bot's folders, resolved past symlinks so a link cannot point outside them. */
  /**
   * A file of a bot's folders. `who`, when given, may open it only if they may change the bot, or
   * the file is in one of their own conversations' folders: those who only talk with a bot get the
   * files it hands them, not everyone's.
   */
  const libraryFile = async (botId: string, path: string, who?: Principal) => {
    const { root, roots, bot } = await libraryRoots(botId);
    let full: string;
    try {
      const found = findLinkedFile(root, path, bot);
      if (!found) throw new Error('missing');
      full = realpathSync(found);
    } catch {
      throw new HttpError(404, 'error.fileMissing');
    }
    const realRoots = roots.flatMap((r) => {
      try {
        return [realpathSync(r)];
      } catch {
        return [];
      }
    });
    if (!realRoots.some((r) => full.startsWith(r + sep))) throw new HttpError(403, 'error.fileForbidden');
    if (who && !atLeast(await s.access.level(who, botId), 'edit')) {
      let threads = '';
      try {
        threads = realpathSync(join(root, 'bots', botId, 'threads'));
      } catch {
        // No conversation of the bot has a folder yet.
      }
      const threadId =
        threads && full.startsWith(threads + sep) ? full.slice(threads.length + 1).split(sep)[0] : null;
      const own = threadId ? await s.access.visibleThreads(who, [threadId]) : new Set<string>();
      if (!threadId || !own.has(threadId)) throw new HttpError(403, 'error.fileForbidden');
    }
    const st = statSync(full);
    if (!st.isFile()) throw new HttpError(404, 'error.fileMissing');
    return { full, st };
  };

  // Several files of a message as one ZIP archive.
  app.get('/api/bots/:id/library/zip', async (req, reply) => {
    const botId = IdParams.parse(req.params).id;
    const q = z
      .object({
        path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(100)]),
        name: z.string().max(100).optional(),
      })
      .parse(req.query);
    const paths = [...new Set(Array.isArray(q.path) ? q.path : [q.path])];
    const taken = new Set<string>();
    const entries = [];
    let total = 0;
    for (const p of paths) {
      const { full, st } = await libraryFile(botId, p, me(req));
      total += st.size;
      if (total > MAX_ZIP_BYTES) {
        throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(MAX_ZIP_BYTES / 1024 / 1024) });
      }
      const name = uniqueName(basename(full), taken);
      taken.add(name);
      entries.push({ name, data: await readFile(full), modifiedAt: st.mtime });
    }
    const file = encodeURIComponent(`${(q.name ?? 'files').replace(/[\\/:*?"<>|]+/g, '-')}.zip`);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${file}`);
    reply.header('x-content-type-options', 'nosniff');
    reply.type('application/zip');
    return reply.send(zip(entries));
  });

  /** The MCP app view a card in the conversation shows, with the bot whose turn showed it. */
  const appView = async (messageId: string) => {
    const m = await s.threads.message(messageId);
    const app = m.props.app as
      { id: string; connectionId: string; connect?: string[]; resources?: string[] } | undefined;
    if (!app || !/^[\w-]{1,64}$/.test(app.id) || !m.author.startsWith('bot:')) {
      throw new HttpError(404, 'error.notFound');
    }
    const bot = await s.bots.get(m.author.slice(4));
    const dir = workspacePaths(d.config.dataDir, bot.id, m.threadId, bot.groupId).threadDir;
    return { app, bot, file: join(dir, APP_DIR, `${app.id}.html`) };
  };
  // The view's page, to run in the app's sandboxed frame under the policy its server asked for.
  app.get('/api/apps/:id/frame', async (req, reply) => {
    const { app: view, file } = await appView(IdParams.parse(req.params).id);
    const html = await readFile(file, 'utf8').catch(() => {
      throw new HttpError(404, 'error.notFound');
    });
    const csp = frameCsp({ resources: view.resources, connect: view.connect, images: [] });
    return reply
      .header('content-security-policy', frameHeader(csp))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(frameDocument(html, csp));
  });
  // A tool call the view makes: to its own connection only, as the bot that showed it may.
  app.post('/api/apps/:id/call', async (req) => {
    const { app: view, bot } = await appView(IdParams.parse(req.params).id);
    const body = z
      .object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}) })
      .parse(req.body);
    return s.connections.callFromApp({
      connectionId: view.connectionId,
      bot,
      userId: me(req).userId,
      name: body.name,
      args: body.arguments,
    });
  });
  // A page a bot made, served to run in the app's sandboxed frame: scripts run, with an opaque
  // origin and a policy that lets it load only the usual libraries and fetch nothing.
  /**
   * A bot's page as a document of its own: scripts run sandboxed, with an opaque origin and a
   * policy that lets it load only the usual libraries and fetch nothing. `print` opens the print
   * dialog once it has drawn, so the person can save it as a PDF.
   */
  const sendPage = async (
    reply: FastifyReply,
    botId: string,
    path: string,
    o: {
      framed?: boolean;
      height?: number;
      print?: boolean;
      title?: string;
      shared?: boolean;
      who?: Principal;
    },
  ) => {
    const { full, st } = await libraryFile(botId, path, o.who);
    if (!/\.html?$/i.test(full) || st.size > 2 * 1024 * 1024) throw new HttpError(404, 'error.notFound');
    const csp = frameCsp({ resources: PAGE_LIBRARIES, images: ['https:'] });
    // Its own scripts, styles, pictures and data go inside it: the frame loads nothing from here.
    // A page opened by its share link carries only the data files it names: anyone with the link
    // gets the page, not every file that happens to sit in its folder.
    const page = await bundlePage(full, { data: o.shared ? 'named' : 'all' });
    return reply
      .header('content-security-policy', frameHeader(csp, { print: o.print }))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(
        frameDocument(page.html, csp, {
          reportSize: o.framed,
          fallbackHeight: o.height,
          print: o.print,
          title: o.title,
        }),
      );
  };
  // A page a bot made, served to run in the app's sandboxed frame, or opened on its own to print.
  app.get('/api/bots/:id/library/page', async (req, reply) => {
    const { path, h, print } = z
      .object({
        path: z.string().min(1),
        h: z.coerce.number().int().min(200).max(1200).optional(),
        print: z.enum(['1']).optional(),
      })
      .parse(req.query);
    return sendPage(reply, IdParams.parse(req.params).id, path, {
      framed: !print,
      height: h,
      print: !!print,
      title: print ? basename(path) : undefined,
      who: me(req),
    });
  });

  // Mail for the bots. A relay posts each message here with the secret; the person sets the domain
  // in the settings and gives bots their addresses.
  app.addContentTypeParser('message/rfc822', (_req, payload, done) => done(null, payload));
  const relayToken = (req: FastifyRequest) => {
    const auth = req.headers.authorization;
    return typeof auth === 'string' ? /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() : undefined;
  };
  const relayHooks: RouteShorthandOptions = {
    // The secret comes in a header, so it is checked before the message (up to 25 MB) is read: a
    // caller without it cannot make the server hold the message for nothing.
    async onRequest(req) {
      if (!(await s.email.accepts(relayToken(req)))) throw new HttpError(401, 'error.emailSecret');
    },
  };
  app.post(EMAIL_INBOUND_PATH, relayHooks, async (req, reply) => {
    const { to } = z.object({ to: z.string().min(3).max(400) }).parse(req.query);
    if (!(req.body instanceof Readable)) throw new HttpError(415, 'error.uploadType');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.body) {
      size += (chunk as Buffer).length;
      if (size > MAX_EMAIL_BYTES) {
        throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(MAX_EMAIL_BYTES / 1024 / 1024) });
      }
      chunks.push(chunk as Buffer);
    }
    // Every message accepted gets 200, kept or not, so the relay neither retries nor bounces it.
    const status = await s.email.receive(relayToken(req), to, Buffer.concat(chunks));
    return reply.code(200).send({ ok: true, status });
  });
  // The server's own check of its data, and the repairs that lose nothing.
  app.get('/api/doctor', () => s.doctor.check());
  app.post('/api/doctor/repair', async (req) => s.doctor.repair(DoctorRepair.parse(req.body).checks));
  app.get('/api/email', () => s.email.settings());
  app.post('/api/email/secret', () => s.email.renewSecret());
  app.post('/api/bots/:id/email', async (req) => {
    if (!(await s.email.domain())) throw new HttpError(409, 'error.emailNoDomain');
    return s.email.claim(IdParams.parse(req.params).id, EmailClaim.parse(req.body).name);
  });
  // Lets the bot type sign-in codes from its mail into the site that sent them, or stops it.
  app.put('/api/bots/:id/email/codes', async (req) =>
    s.email.setCodes(IdParams.parse(req.params).id, EmailCodes.parse(req.body).on),
  );
  app.delete('/api/bots/:id/email', async (req) => {
    await s.email.release(IdParams.parse(req.params).id);
    return s.email.settings();
  });
  app.get('/api/bots/:id/emails', async (req) => s.email.inbox(IdParams.parse(req.params).id, { limit: 50 }));

  // Links that open a page for anyone who has them.
  app.get('/api/page-shares', async (req) =>
    s.pageShares.list(canAdminister(me(req).role) ? undefined : await s.access.botIds(me(req), 'edit')),
  );
  app.get('/api/bots/:id/library/share', async (req) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(req.query);
    return { share: await s.pageShares.find(IdParams.parse(req.params).id, path) };
  });
  app.post('/api/bots/:id/library/share', async (req) => {
    const botId = IdParams.parse(req.params).id;
    const body = PageShareCreate.parse(req.body);
    // Only a page in the bot's own folders, and only an HTML page, can be shared.
    const { full } = await libraryFile(botId, body.path);
    if (!/\.html?$/i.test(full)) throw new HttpError(400, 'error.shareNotPage');
    return s.pageShares.share(botId, body.path, body.name);
  });
  app.delete('/api/page-shares/:token', async (req) => {
    const { token } = z.object({ token: z.string().min(1).max(100) }).parse(req.params);
    const botId = await s.pageShares.botOf(token);
    if (botId) await s.access.requireBot(me(req), botId, 'edit');
    await s.pageShares.unshare(token);
    return { ok: true };
  });
  // The shared page itself: outside /api, so it opens without signing in. It runs sandboxed like
  // in the app, so it cannot reach this server with the visitor's sign-in either.
  app.get(`${SHARE_PATH}/:token`, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(100) }).parse(req.params);
    const { print } = z.object({ print: z.enum(['1']).optional() }).parse(req.query);
    reply.header('x-robots-tag', 'noindex, nofollow');
    const share = await s.pageShares.resolve(token);
    try {
      if (share)
        return await sendPage(reply, share.botId, share.path, {
          print: !!print,
          title: share.name,
          shared: true,
        });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      // The page was moved or deleted since it was shared: the link says it is gone, like an old link.
    }
    const t = translator(pickLocale(req.headers['accept-language'], await s.settings.locale()));
    return reply
      .code(404)
      .header('content-security-policy', PLAIN_PAGE_POLICY)
      .type('text/html; charset=utf-8')
      .send(callbackPage(t('share.gone.title'), t('share.gone.title'), t('share.gone.body')));
  });
  app.get('/api/bots/:id/library/file', async (req, reply) => {
    const { path, inline } = z
      .object({ path: z.string().min(1), inline: z.enum(['1']).optional() })
      .parse(req.query);
    const { full, st } = await libraryFile(IdParams.parse(req.params).id, path, me(req));
    // Only images, PDFs, sound and video are shown on the page; anything else (HTML included)
    // downloads, since the page could otherwise run it as its own.
    const type = inline ? INLINE_TYPES[extname(full).toLowerCase()] : undefined;
    // An SVG opened on its own would be a page of this site: it gets no scripts and no requests.
    if (type === 'image/svg+xml') {
      reply.header(
        'content-security-policy',
        "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
      );
    }
    const name = encodeURIComponent(basename(full));
    reply.header('content-disposition', `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
    reply.header('x-content-type-options', 'nosniff');
    // A bot may rewrite the file at any time; the preview asks again rather than trusting a copy.
    reply.header('cache-control', 'no-cache');
    reply.header('accept-ranges', 'bytes');
    reply.type(type ?? 'application/octet-stream');
    // A player asks for parts of the file to seek in it.
    const range = byteRange(req.headers.range, st.size);
    if (range) {
      reply.code(206);
      reply.header('content-range', `bytes ${range.start}-${range.end}/${st.size}`);
      reply.header('content-length', range.end - range.start + 1);
      return reply.send(createReadStream(full, range));
    }
    return reply.send(createReadStream(full));
  });
}

/** A request body read as JSON, refused past `max` bytes. */
async function readJson(body: Readable, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(max / 1024 / 1024) });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(
      Buffer.concat(chunks)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as unknown;
  } catch {
    throw new HttpError(400, 'error.importFormat');
  }
}

const escapeHtml = (v: string) =>
  v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The small page the person's browser lands on after signing in to a service. */
function callbackPage(title: string, heading: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fff;color:#111}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;font-weight:600}p{opacity:.75;line-height:1.5}</style></head><body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
}
