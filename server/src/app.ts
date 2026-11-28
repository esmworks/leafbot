import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import { MAC_EVENT, MAC_JOB_EVENT, MAC_JOBS_EVENT, MAC_NAMESPACE } from '@leafbot/shared/mac';
import fastifyStatic from '@fastify/static';
import {
  BrowserControlEvent,
  BrowserInputEvent,
  pickLocale,
  type Bot,
  type ClaudeAuthKind,
  type ClaudeAuthSet,
  type ClaudeModel,
  type ClientToServerEvents,
  type ServerInfo,
  type ServerToClientEvents,
} from '@leafbot/shared';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { Server as IOServer, type Namespace } from 'socket.io';
import { ZodError } from 'zod';
import {
  Auth,
  checkHostOrigin,
  clientAddress,
  isLocalRequest,
  loadAccessKey,
  needsSignIn,
  parseCookie,
  routedPath,
  OLD_SESSION_COOKIE,
  SESSION_COOKIE,
  type Principal,
  type SocketData,
} from './auth';
import { BrowserManager } from './browser/manager';
import { browserErrorText } from './browser/text';
import { Bus } from './bus';
import { MacBridge } from './computer/bridge';
import { PersonComputer } from './computer/person';
import { ComputerService } from './computer/service';
import { RfbClientFilter } from './computer/rfb-filter';
import { computerErrorText } from './tools/computer';
import { linkComputer } from './egress/computer-link';
import { EgressHub, startLocalSocks } from './egress/hub';
import type { Config } from './config';
import { appPolicy, STRICT_TRANSPORT_SECURITY } from './csp';
import type { Ctx } from './context';
import { openDb, type DbHandle } from './db';
import { adoptLegacyAccount } from './users';
import { atLeast, managesServer } from './services/access';
import { enforceRule, ruleFor } from './access-rules';
import { setContentKey } from './db/sealed';
import { AcpEngine, refusingEngine } from './engine/acp';
import { ClaudeEngine, engineEnv, FALLBACK_MODELS } from './engine/claude';
import { FakeEngine } from './engine/fake';
import { PiEngine } from './engine/pi';
import type { AccountStatus, Engine, ModelTest } from './engine/types';
import { registerMcpServer } from './mcp-server';
import { TEAMS_PATH } from './channels/teams';
import { EMAIL_INBOUND_PATH, registerRoutes, WEBHOOK_PATH } from './routes';
import { MOVE_HOOK_PATH } from './services/grok-move';
import { OAUTH_CALLBACK_PATH } from './services/connections';
import { githubAuthorLookup, type GitAuthorLookup } from './services/github-author';
import { dropAllClients, OAUTH_CLIENT_PATH, setToolCallTimeout } from './connections/client';
import { Services } from './services';
import { BackupService } from './services/backup';
import { bundledClaude, ClaudeSignInService } from './services/claude-sign-in';
import { probeShellSandbox } from './shell-sandbox';
import { isServerKey, translator, type T } from './i18n';
import { serverLocale } from './services/settings';
import { inOrder } from './in-order';
import { PhoneBridge } from './phone/bridge';
import { ChromeBridge } from './chrome/bridge';
import { sweepUploads } from './uploads';
import { HttpError } from './util';
import { AccountHost, accountHostConfig } from './tunnel/host';
import { AccountLinks } from './tunnel/links';
import { AccountSignIn } from './tunnel/signin';
import { tunnelIdentity } from './tunnel/identity';
import type { RtcFactory } from './tunnel/signal';
import { launchMark, launchSpan } from './launch-timings';

export interface ServerOptions {
  /** Replace every engine (tests). */
  engine?: Engine;
  clock?: () => Date;
  logger?: boolean;
  /**
   * Starts the server process again, after a backup was restored: what it holds in memory (the
   * vault key, sign-ins to apps, queued work) belongs to the data it replaced.
   */
  restart?: () => void;
  /** The Claude Code program that signs in to Claude (tests); unset uses the one the Agent SDK brings. */
  claudeExecutable?: string | null;
  /**
   * Makes WebRTC connections for browsers that reach the server through its account; without one
   * the server can be linked but browsers cannot reach it yet.
   */
  rtc?: RtcFactory | null;
  /** Replace the lookup of a GitHub key's account (tests: no call reaches GitHub). */
  gitAuthor?: GitAuthorLookup;
}

export interface LeafBotServer {
  app: FastifyInstance;
  io: IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  services: Services;
  auth: Auth;
  db: DbHandle;
  bootId: string;
  accessKey: string;
  /** Every route as registered (`METHOD /path`). */
  routes: string[];
  info(): ServerInfo;
  checkClaude(): Promise<AccountStatus>;
  listen(): Promise<string>;
  close(): Promise<void>;
}

/** How often, and how long after its last try, a failed app connection is tried again. */
const CONNECTION_RETRY_MS = 5 * 60_000;
/** How old a connected app's list of tools may get before it is read again. */
const TOOL_LIST_MAX_AGE_MS = 6 * 60 * 60_000;

/** The socket room of one person's devices. */
const personRoom = (userId: string) => `user:${userId}`;

const PUBLIC_API = new Set([
  '/api/health',
  '/api/access',
  '/api/session',
  OAUTH_CALLBACK_PATH,
  OAUTH_CLIENT_PATH,
  // A mail relay signs in with the mail secret, checked by the route itself.
  EMAIL_INBOUND_PATH,
  // Teams signs each delivery with the Bot Framework's keys, checked by the channel itself.
  TEAMS_PATH,
]);
/**
 * Routes that start a session of the server's own (a cookie) and so mean nothing over the tunnel,
 * where the account is the sign-in.
 */
const TUNNEL_REFUSED = new Set([
  '/api/access',
  '/api/account-host',
  '/api/account-host/email',
  '/api/account-host/verify',
  '/api/account-host/name',
  // The owner's account would be handed to whoever holds a tunnel; over one, the account makes it.
  '/api/account-host/phone-code',
]);
/** Routes (as registered, not as a URL spells them) that need no access key or session. */
const openRoute = (route: string) =>
  PUBLIC_API.has(route) ||
  route.startsWith(`${WEBHOOK_PATH}/`) ||
  // Grok Bot sending bots over the move link, which checks the link's key itself.
  route.startsWith(`${MOVE_HOOK_PATH}/`);

export async function createServer(config: Config, opts: ServerOptions = {}): Promise<LeafBotServer> {
  const db = await launchSpan('db', () =>
    openDb({ url: config.databaseUrl, dataDir: config.dataDir, memory: config.memoryDb }),
  );
  // The single account from before people came in becomes the owner's sign-in.
  await launchSpan('legacy account', () => adoptLegacyAccount(db.db));
  const bus = new Bus();
  // Each bot's desktop, when a computer service runs next to this server. Its folders are the
  // bot's workspace, which both containers see at the same path.
  // The computer service mounts this folder; it must exist before that container starts.
  if (config.computer) mkdirSync(join(config.dataDir, 'workspaces'), { recursive: true, mode: 0o700 });
  const computer = config.computer
    ? new ComputerService({
        ...config.computer,
        idleMs: config.computerIdleMs,
        prepare: async (botId) => {
          const bot = await services.bots.get(botId);
          const root = join(config.dataDir, 'workspaces');
          const own = join(root, 'bots', bot.id);
          const home = join(own, 'home');
          const files = join(own, 'files');
          const group = bot.groupId ? join(root, 'groups', bot.groupId, 'files') : null;
          for (const d of [home, files, group]) if (d) mkdirSync(d, { recursive: true, mode: 0o700 });
          return {
            // The desktop's browser needs the internet; each command still asks per the bot's rules.
            internet: true,
            // The desktop image holds Turkish and English; other languages see it in English.
            locale: (await serverLocale(ctx)) === 'tr' ? 'tr' : 'en',
            home,
            workdir: files,
            // A read-only bot's folders are read-only on its desktop too (its home stays writable
            // for the programs' own settings). Takes effect the next time the desktop starts.
            folders: [own, ...(group ? [group] : [])].map((path) => ({
              path,
              writable: bot.permissionMode !== 'readonly',
            })),
          };
        },
        // A bot with the internet off keeps git off GitHub too, though its desktop's browser is online.
        // A GitHub key comes before the GitHub app's sign-in of the same owner: it may be narrower.
        gitToken: async (botId, owner = null) =>
          (await services.bots.get(botId)).internet
            ? ((await services.apiCredentials.gitToken(botId, owner)) ??
              (await services.connections.gitToken(botId, owner)))
            : null,
        // The commits a command pushes are written by the account of the key it pushes with.
        gitAuthor: opts.gitAuthor ?? githubAuthorLookup(),
      })
    : null;
  // The person's own computer as the bots' way out to the web, when this server runs elsewhere.
  const egress = config.onUserComputer ? null : new EgressHub();
  // Without a computer service this server starts the browsers itself, behind a proxy of its own;
  // with one, the desktops' browsers reach that way through the service. On the person's own
  // computer the proxy has no other way out, but it still checks each address it connects to: the
  // browser would otherwise look a name up again after the server checked it.
  const localSocks =
    !computer && config.browserPath
      ? await startLocalSocks(egress, config.browserLocalHosts, config.browserEgressProxy)
      : null;
  const stopComputerLink = egress && config.computer ? linkComputer(egress, config.computer) : null;
  const browser = new BrowserManager({
    executable: config.browserPath,
    profileDir: (botId) => join(config.dataDir, 'browsers', botId),
    sandbox: config.browserSandbox,
    max: config.maxBrowsers,
    idleMs: config.browserIdleMs,
    callMs: config.browserCallMs,
    localHosts: config.browserLocalHosts,
    windows: config.onUserComputer,
    language: () => serverLocale(ctx),
    ...(localSocks && { proxy: `socks5://127.0.0.1:${localSocks.port}` }),
    ...(computer && {
      connect: async (botId: string) => {
        await computer.ensure(botId);
        return {
          url: computer.client.socketUrl(botId, 'cdp'),
          proxied: computer.browserProxied(botId),
        };
      },
      blocked: (botId: string) => computer.userHasControl(botId),
      awaitDesktop: (botId: string, signal: AbortSignal | undefined, maxMs: number) =>
        computer.awaitControl(botId, signal, maxMs),
      hold: (botId: string) => computer.hold(botId),
    }),
  });
  // The person's own Mac, through the desktop app's helper, for the bots they allow to use it.
  const personComputer = config.personComputer ? PersonComputer.start(config.personComputer) : null;
  const macs = new MacBridge();
  const phones = new PhoneBridge();
  const chromes = new ChromeBridge();
  const ctx: Ctx = {
    db: db.db,
    bus,
    config,
    browser,
    computer,
    egress,
    personComputer,
    macs,
    phones,
    chromes,
    // Read once a turn runs, after the startup check below has answered.
    shellUnavailable: () => shellSandbox.status === 'unavailable',
  };
  const accessKey = loadAccessKey(config);
  setToolCallTimeout(config.mcpCallTimeoutMs);
  const auth = new Auth(db.db, accessKey);
  const bootId = randomUUID();
  const buildId = readBuildId(config.appDir);

  const fake = config.engine === 'fake' ? new FakeEngine() : null;
  // In a container the data folder is outside home; the Claude login may be too.
  const claude = new ClaudeEngine({
    // The engine passes only a short list of variables to the CLI; without this it would look
    // for the login in the home folder instead of where the container keeps it.
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    hidden: [config.dataDir, process.env.CLAUDE_CONFIG_DIR].filter((d): d is string => !!d),
    // Created before the services it reads from; only called once a turn runs.
    credential: () => services.claudeAuth.credential(),
  });
  // Created before the services it reads keys from; only called once a turn runs.
  // API-key bots' commands keep their turn's settings, home and temporary files here, inside the data
  // folder no command reads; what a stopped server left behind goes at start.
  const shellDir = join(config.dataDir, 'shell');
  rmSync(shellDir, { recursive: true, force: true });
  const pi = new PiEngine({
    sessionsDir: join(config.dataDir, 'pi-sessions'),
    apiKey: (provider) => services.keys.credential(provider),
    auth: (provider) => services.keys.auth(provider),
    hasAuth: (provider) => services.keys.hasAuth(provider),
    customModel: (provider, id) => services.keys.customModel(provider, id),
    takesTools: (provider, id) => services.keys.takesTools(provider, id),
    webSearchUrl: config.webSearchUrl,
    hidden: [config.dataDir, process.env.CLAUDE_CONFIG_DIR].filter((d): d is string => !!d),
    // Read once a turn runs, after the startup check below has answered.
    shellReady: () => shellSandbox.status === 'ok',
    shellDir,
  });
  // Coding agents on the computer, only where the server runs on the owner's own computer.
  const acp = config.onUserComputer ? new AcpEngine({ version: '0.10.0' }) : null;
  const engineFor = (bot: Bot): Engine =>
    opts.engine ??
    fake ??
    (bot.engine === 'pi' ? pi : bot.engine === 'acp' ? (acp ?? refusingEngine('engine.acpOff')) : claude);
  const services: Services = new Services(ctx, engineFor, opts.clock);
  // Content sealed at rest opens with a key from the vault key; the switch is the saved setting.
  setContentKey(services.vault.contentKey());
  launchMark('services');
  await launchSpan('content seal', () => services.contentSeal.start());
  if (egress) {
    const syncEgress = async () =>
      egress.setEnabled((await services.settings.get('browserViaComputer')) === true);
    await syncEgress();
    // A settings change refreshes the info; the switch is read again then.
    bus.on('refresh', (e) => {
      if (e.scope === 'info') void syncEgress().catch(() => {});
    });
    egress.on(() => bus.refresh({ scope: 'info' }));
  }

  let claudeStatus: ServerInfo['claude'] = { status: 'unknown', detail: null };
  const claudeEngine = (): Engine => opts.engine ?? fake ?? claude;
  const checkClaude = async (probe = false): Promise<AccountStatus & { auth: ClaudeAuthKind }> => {
    const engine = claudeEngine();
    const r: AccountStatus =
      probe && engine.probe
        ? await engine.probe()
        : engine.account
          ? await engine.account()
          : { status: 'ok', detail: null };
    const status = { ...r, auth: (await services.claudeAuth.status()).kind };
    claudeStatus = status;
    bus.refresh({ scope: 'info' });
    return status;
  };
  // Listing models starts a CLI; a list from a working login is kept until the login changes.
  let models: { list: ClaudeModel[]; at: number } | null = null;
  const claudeModels = async (): Promise<ClaudeModel[]> => {
    if (models && Date.now() - models.at < 30 * 60_000) return models.list;
    const list = await (claudeEngine().models?.() ?? Promise.resolve([])).catch(() => []);
    if (!list.length) return FALLBACK_MODELS;
    models = { list, at: Date.now() };
    return list;
  };
  // Fake and test engines answer for every engine, so they stand in for Pi here too. A model off
  // the provider's list is tried too: a new release or one an endpoint does not list. The request
  // itself tells whether the provider serves it. Asking for the list turns away unknown providers.
  const testModel = async (provider: string, model: string): Promise<ModelTest> => {
    await services.keys.models(provider);
    if (!(await services.keys.credential(provider))) throw new HttpError(400, 'error.noProviderKey');
    const engine = opts.engine ?? fake ?? pi;
    if (!engine.testModel) return { ok: true };
    return engine.testModel(`${provider}/${model}`, await services.settings.locale());
  };
  const claudeSignIn = new ClaudeSignInService({
    executable: () => (opts.claudeExecutable === undefined ? bundledClaude() : opts.claudeExecutable),
    // What the engine passes the CLI, so the login lands where the bots' Claude looks for it, and
    // the desktop's display, so on a Linux desktop it can open the sign-in page in the browser.
    env: () =>
      engineEnv({
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        ...Object.fromEntries(
          ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'BROWSER'].map(
            (k) => [k, process.env[k]],
          ),
        ),
      }),
    // A saved token or key would come before the new login: the person chose to sign in instead.
    // When Claude does not answer with the login, the token or key goes back as it was.
    async onSignedIn() {
      const saved = await services.claudeAuth.credential();
      await services.claudeAuth.clear();
      models = null;
      const status = await checkClaude(true);
      if (status.status === 'ok') return null;
      if (saved) {
        await services.claudeAuth.set(saved);
        await checkClaude();
      }
      return status.detail ?? status.reason ?? status.status;
    },
  });
  const claudeAuth = {
    signIn: claudeSignIn,
    status: () => services.claudeAuth.status(),
    async set(input: ClaudeAuthSet) {
      await services.claudeAuth.set(input);
      models = null;
      return checkClaude(true);
    },
    async clear() {
      await services.claudeAuth.clear();
      models = null;
      return checkClaude();
    },
    models: claudeModels,
  };
  // A failed turn for lack of login updates the status without polling the CLI.
  const markSignedOut = () => {
    claudeStatus = { status: 'logged-out', detail: null };
    bus.refresh({ scope: 'info' });
  };
  services.turns.onFinished(async (_t, o) => {
    if (!o.ok && o.kind === 'auth') markSignedOut();
  });
  // A backup model may carry the turn, so its outcome alone would hide the expired sign-in.
  services.turns.onSignedOut(markSignedOut);

  let shellSandbox: ServerInfo['shellSandbox'] = { status: 'unknown', detail: null };
  if (!opts.engine && !fake) {
    void probeShellSandbox().then((r) => {
      shellSandbox = r;
      if (r.status !== 'ok')
        console.warn(`Bash sandbox unavailable: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
      bus.refresh({ scope: 'info' });
    });
  }

  let computerStatus: ServerInfo['computer'] = computer
    ? { status: 'unreachable', detail: config.computer!.url }
    : { status: 'off', detail: null };
  const checkComputer = async () => {
    if (!computer) return;
    const ok = await computer.client.health();
    const next = ok ? 'ok' : 'unreachable';
    if (next !== computerStatus.status) {
      // Reachable again (or for the first time): desktops left running are taken over.
      if (ok) await computer.adopt();
      computerStatus = { status: next, detail: config.computer!.url };
      bus.refresh({ scope: 'info' });
    }
  };
  void checkComputer();
  const computerCheck = computer ? setInterval(() => void checkComputer(), 15_000) : null;
  computerCheck?.unref();

  // Attachments whose message was never sent (the page was closed with them on it).
  // Old lines of the bots' lists of what they changed, and of what turns changed, go with it.
  const sweep = () => {
    void sweepUploads(config.dataDir).catch((err) => console.warn(`Upload sweep failed: ${String(err)}`));
    void services.actions.prune().catch((err) => console.warn(`Action list sweep failed: ${String(err)}`));
    void services.changes.prune().catch((err) => console.warn(`Turn change sweep failed: ${String(err)}`));
    void services.rehearsals.prune().catch((err) => console.warn(`Rehearsal sweep failed: ${String(err)}`));
    // Documents bots' instructions are kept in are looked at once a day.
    void services.instructionDocs
      .checkDue()
      .catch((err) => console.warn(`Instructions document check failed: ${String(err)}`));
    // Each person's requests are looked at for something asked again and again, once a day. Not
    // with a test's own engine, which would spend the day's look at the start, before any request.
    if (!opts.engine && !fake)
      void services.routineSuggestions
        .runDue()
        .catch((err) => console.warn(`Routine suggestions failed: ${String(err)}`));
    // Each person's many-step tasks are looked at for one to keep as a skill, once a week.
    if (!opts.engine && !fake)
      void services.skillSuggestions
        .runDue()
        .catch((err) => console.warn(`Skill suggestions failed: ${String(err)}`));
    // Each person's bots are looked over once a day for what went wrong and waits on them; not with
    // a test's engine either, whose seeded routines would start a turn nobody in the test expects.
    if (!opts.engine && !fake)
      void services.checkIns.runDue().catch((err) => console.warn(`Check-ins failed: ${String(err)}`));
    // Each set of notes that changed is tidied once a week; likewise not with a test's engine.
    if (!opts.engine && !fake)
      void services.memoryTidy.runDue().catch((err) => console.warn(`Memory tidy-up failed: ${String(err)}`));
    // A command on someone's computer that never said how it ended, past that computer's own limit.
    void services.personJobs.sweep().catch((err) => console.warn(`Job sweep failed: ${String(err)}`));
  };
  sweep();
  const sweepTimer = setInterval(sweep, 60 * 60_000);
  sweepTimer.unref();

  // A connected app that failed is tried again every few minutes until it answers, and the tools of
  // one that works are listed again now and then, since most services don't say when they change.
  const retryApps = setInterval(() => {
    void services.connections
      .retryFailed(CONNECTION_RETRY_MS)
      .then(() => services.connections.refreshStale(TOOL_LIST_MAX_AGE_MS))
      .catch(() => {});
  }, CONNECTION_RETRY_MS);
  retryApps.unref();

  // Notes are indexed for search by meaning a little after start, and now and then after that,
  // so notes written while the embedding service was down catch up.
  if (!opts.engine && !fake) services.embeddings.soon(15_000);
  const indexMemory = setInterval(() => services.embeddings.soon(0), 10 * 60_000);
  indexMemory.unref();

  const info = (): ServerInfo => ({
    name: 'leafbot',
    version: '0.10.0',
    bootId,
    buildId,
    claude: claudeStatus,
    shellSandbox,
    browser: browser.available
      ? { status: 'ok', detail: browser.executable, window: browser.windowAvailable }
      : { status: 'unavailable', detail: null },
    computer: computerStatus,
    publicUrl: config.publicUrl,
    ...(egress && { egress: egress.state() }),
  });

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 5 * 1024 * 1024 });
  await app.register(fastifyCookie);
  // Who a request comes from; set by the sign-in check below, null on the routes open to anyone.
  app.decorateRequest('principal', null);

  /** Errors go out in the language the page asks in, else in the server's language. */
  const requestT = async (headers: { 'accept-language'?: string }): Promise<T> =>
    translator(pickLocale(headers['accept-language'], await serverLocale(ctx)));
  const sendError = async (req: FastifyRequest, reply: FastifyReply, err: HttpError) =>
    reply.code(err.status).send({ error: err.localized(await requestT(req.headers)) });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // A request that came over the tunnel is who the tunnel proved; it carries no cookie, and its
    // Host and Origin are written by the gateway, so the checks for the open web do not apply.
    const tunnel = tunnelIdentity(req.raw.socket);
    if (tunnel) {
      req.cookies = {};
      if (TUNNEL_REFUSED.has(req.routeOptions.url ?? '')) {
        return sendError(req, reply, new HttpError(403, 'error.notOverTunnel'));
      }
      const principal = await auth.tunnelPrincipal(tunnel.userId);
      if (principal) req.principal = principal;
      else if (needsSignIn(req.routeOptions.url, req.url, openRoute)) {
        return sendError(req, reply, new HttpError(401, 'error.accessKeyRequired'));
      }
      return;
    }
    // A session started before the rename reads as one under the new name for every handler.
    const earlier = req.cookies[OLD_SESSION_COOKIE];
    if (earlier && !req.cookies[SESSION_COOKIE]) req.cookies[SESSION_COOKIE] = earlier;
    if (config.secureCookies) void reply.header('strict-transport-security', STRICT_TRANSPORT_SECURITY);
    const problem = checkHostOrigin(
      { host: req.headers.host, origin: req.headers.origin, method: req.method },
      config,
      services.tailscale.hosts(),
    );
    if (problem) return sendError(req, reply, problem);
    // Judged by the route matched, not the URL as written: the router undoes percent escapes, so
    // `/%61pi/bots` runs the /api/bots handler while its URL does not start with /api/.
    if (!needsSignIn(req.routeOptions.url, req.url, openRoute)) return;
    const from = clientAddress(req.headers, req.ip, config);
    const principal = await auth.authenticate(
      req.headers,
      req.cookies[SESSION_COOKIE],
      from,
      isLocalRequest(req.headers, req.ip, config),
    );
    if (!principal) return sendError(req, reply, new HttpError(401, 'error.accessKeyRequired'));
    req.principal = principal;
    // Cookie-authenticated writes must come from our own page.
    if (principal.via === 'session' && req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.origin) {
      return sendError(req, reply, new HttpError(403, 'error.originRequired'));
    }
  });

  const routes: string[] = [];
  // Who may call what: each signed-in route's rule, checked once its params are read.
  app.addHook('preHandler', async (req: FastifyRequest) => {
    const route = req.routeOptions.url;
    if (!route || !needsSignIn(route, req.url, openRoute)) return;
    await enforceRule(services, req, ruleFor(req.method, route));
  });
  // Every route as registered, so a test can check each signed-in one has a rule.
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push(`${method} ${r.url}`);
  });

  app.setErrorHandler(async (err, req, reply) => {
    if (err instanceof HttpError) return sendError(req, reply, err);
    if (err instanceof ZodError) {
      const t = await requestT(req.headers);
      // Shared schemas use message keys for their own checks; zod's built-in messages pass through.
      const text = (m: string) => (isServerKey(m) ? t(m) : m);
      return reply
        .code(400)
        .send({ error: err.issues.map((i) => `${i.path.join('.')}: ${text(i.message)}`).join('; ') });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    console.error(err);
    return reply.code(500).send({ error: (await requestT(req.headers))('error.server') });
  });

  const accountHost = new AccountHost({
    db: db.db,
    vault: services.vault,
    server: app.server,
    config: accountHostConfig(config),
    rtc: opts.rtc ?? null,
    onNameChanged: () => bus.refresh({ scope: 'info' }),
    // Someone new waits for their team spaces: the apps of those who look after the server show
    // the card, and their phones are told.
    onJoined: (userId) => {
      bus.refresh({ scope: 'people' });
      void services.push.newcomer(userId);
    },
  });
  const accountSignIn = new AccountSignIn({
    issuer: accountHostConfig(config).issuer,
    host: accountHost,
    links: new AccountLinks(db.db, () => bus.refresh({ scope: 'info' })),
  });

  registerMcpServer(app, services);
  registerRoutes(app, {
    accountHost,
    accountSignIn,
    services,
    transcribe: services.transcribe,
    backup: new BackupService(
      ctx,
      opts.restart ?? (() => console.warn('backup restored; start the server again')),
    ),
    auth,
    config,
    info,
    checkClaude: () => checkClaude(),
    claude: claudeAuth,
    // Their tunnels too: one already open would otherwise serve them until its next ticket.
    dropSockets: (userId, cutOff) => {
      io.in(personRoom(userId)).disconnectSockets(true);
      accountHost.dropUser(userId, cutOff);
    },
    testModel,
  });

  if (config.appDir && existsSync(join(config.appDir, 'index.html'))) {
    const csp = appPolicy(readFileSync(join(config.appDir, 'index.html'), 'utf8'));
    await app.register(fastifyStatic, {
      root: config.appDir,
      // Vite names each built file after its content, so a file under assets/ never changes and
      // a browser may keep it; the page itself is checked every time, so a new version shows.
      cacheControl: false,
      setHeaders: (reply, path) => {
        if (path.endsWith('.html')) {
          void reply.header('content-security-policy', csp);
          void reply.header('cache-control', 'no-cache');
        } else if (/[\\/]assets[\\/]/.test(path)) {
          void reply.header('cache-control', 'public, max-age=31536000, immutable');
        } else {
          void reply.header('cache-control', 'public, max-age=3600');
        }
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const path = routedPath(req.url);
      // Client-side routes get the page; missing files (paths with an extension) stay 404, and so
      // does anything that reads as the API, however it is spelled.
      const isRoute = !/\.[a-z0-9]+$/i.test(path);
      const reserved = /^\/(?:api|socket\.io)(?:\/|$)/.test(path);
      if (req.method === 'GET' && isRoute && !reserved) {
        return reply.sendFile('index.html');
      }
      return sendError(req, reply, new HttpError(404, 'error.notFound'));
    });
  }

  /** Who each socket's handshake request signed in as, read when the socket connects. */
  const socketPrincipals = new WeakMap<IncomingMessage, Principal>();
  const io = new IOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(
    app.server,
    {
      path: '/socket.io',
      serveClient: false,
      allowRequest: (req, cb) => {
        const refuse = (err: HttpError) =>
          void requestT(req.headers).then(
            (t) => cb(err.localized(t), false),
            () => cb(err.message, false),
          );
        const tunnel = tunnelIdentity(req.socket);
        if (tunnel) {
          return void auth
            .tunnelPrincipal(tunnel.userId)
            .then((principal) => {
              if (!principal) return refuse(new HttpError(401, 'error.accessKeyRequired'));
              socketPrincipals.set(req, principal);
              cb(null, true);
            })
            .catch(() => refuse(new HttpError(500, 'error.authCheckFailed')));
        }
        const problem = checkHostOrigin(
          { host: req.headers.host, origin: req.headers.origin, method: 'GET' },
          config,
          services.tailscale.hosts(),
        );
        if (problem) return refuse(problem);
        const cookie =
          parseCookie(req.headers.cookie, SESSION_COOKIE) ??
          parseCookie(req.headers.cookie, OLD_SESSION_COOKIE);
        const from = clientAddress(req.headers, req.socket.remoteAddress ?? '', config);
        auth
          .authenticate(
            { authorization: req.headers.authorization },
            cookie,
            from,
            isLocalRequest(req.headers, req.socket.remoteAddress ?? '', config),
          )
          .then((principal) => {
            if (!principal) return refuse(new HttpError(401, 'error.accessKeyRequired'));
            socketPrincipals.set(req, principal);
            cb(null, true);
          })
          .catch((err: unknown) =>
            refuse(err instanceof HttpError ? err : new HttpError(500, 'error.authCheckFailed')),
          );
      },
    },
  );
  phones.attach(async (socketId, ask, timeoutMs) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) throw new Error('gone');
    return socket.timeout(timeoutMs).emitWithAck('phone:ask', ask);
  });
  chromes.attach(async (socketId, ask, timeoutMs) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) throw new Error('gone');
    return socket.timeout(timeoutMs).emitWithAck('chrome:ask', ask);
  });
  // The desktop app offers its computer as the bots' way out to the web. Frames are binary
  // messages of the egress protocol; the sign-in is the same as for every socket. Every bot's
  // pages then pass through that computer, so only those who look after the server offer one.
  const egressSockets = io.of('/egress') as unknown as Namespace;
  egressSockets.on('connection', (socket) => {
    const by = socketPrincipals.get(socket.request);
    if (!egress || !by || !managesServer(by.role)) return void socket.disconnect(true);
    const device: unknown = socket.handshake.auth?.device;
    const link = egress.attach(
      typeof device === 'string' ? device : '',
      (f) => socket.emit('f', f),
      // A takeover tells the app it was let go, so it stays away; a stop only drops the
      // connection, which the app reads as the server gone for a while and connects again.
      (why) => (why === 'replaced' ? socket.disconnect(true) : socket.conn.close()),
    );
    socket.on('f', (f: unknown) => {
      if (Buffer.isBuffer(f)) link.receive(f);
    });
    socket.on('disconnect', () => link.detach());
  });

  // A desktop app offers its Mac to the bots of the person signed in there, with the switch in its
  // own menu on. Any signed-in person may: it only reaches their own turns. The app checks every
  // request and asks on the Mac itself before a bot first sees or touches the screen.
  const macSockets = io.of(MAC_NAMESPACE) as unknown as Namespace;
  macs.attach(async (socketId, req, timeoutMs) => {
    const socket = macSockets.sockets.get(socketId);
    if (!socket) throw new Error('gone');
    return socket.timeout(timeoutMs).emitWithAck(MAC_EVENT, req);
  });
  macSockets.on('connection', (socket) => {
    const by = socketPrincipals.get(socket.request);
    if (!by) return void socket.disconnect(true);
    const device: unknown = socket.handshake.auth?.device;
    const name = typeof device === 'string' ? device : '';
    // Commands only when that computer's own switch lets bots run them.
    macs.offer(socket.id, by.userId, name, socket.handshake.auth?.commands === true);
    // How the commands go: told only for this person's own jobs (see `PersonJobService`).
    socket.on(MAC_JOB_EVENT, (e: unknown) => {
      void services.personJobs
        .onEvent(by.userId, e)
        .catch((err) => console.warn(`job event: ${String(err)}`));
    });
    socket.on(MAC_JOBS_EVENT, (e: unknown) => {
      void services.personJobs
        .onSnapshot(by.userId, name, e)
        .catch((err) => console.warn(`job list: ${String(err)}`));
    });
    bus.refresh({ scope: 'info' });
    socket.on('disconnect', () => {
      macs.drop(socket.id);
      bus.refresh({ scope: 'info' });
    });
  });

  io.on('connection', (socket) => {
    // Who signed this socket in; the handshake request is the one the sign-in check saw.
    socket.data.principal = socketPrincipals.get(socket.request) ?? null;
    const viewer = socket.data.principal;
    // Live events of a conversation go to its people's rooms.
    if (viewer) void socket.join(personRoom(viewer.userId));
    socket.emit('hello', { bootId, buildId });
    // The phone app says what its person lets bots read from it; only a signed-in person's socket.
    socket.on('phone:offer', (kinds) => {
      if (viewer) phones.offer(socket.id, viewer.userId, kinds);
    });
    // The Chrome extension's side panel says whether its person shares that Chrome with their bots.
    socket.on('chrome:offer', (sharing) => {
      if (viewer) chromes.offer(socket.id, viewer.userId, sharing);
    });
    socket.on('disconnect', () => {
      phones.drop(socket.id);
      chromes.drop(socket.id);
    });

    // Watching and driving a bot's browser. Only existing bots: the id names a profile folder.
    const watching = new Set<string>();
    const botExists = (id: unknown): id is string =>
      typeof id === 'string' && id.length <= 64 && /^[\w-]+$/.test(id);
    // The browser and the desktop are the bot's, shared by everyone who uses it: only those who
    // may change the bot watch or drive them.
    const known = async (id: unknown) =>
      botExists(id) && !!viewer && atLeast(await services.access.level(viewer, id), 'edit');
    socket.on('browser:watch', async (botId, ack) => {
      if (typeof ack !== 'function') return;
      if (!(await known(botId))) return ack(null);
      watching.add(botId);
      await socket.join(`browser:${botId}`);
      const { state, frame } = browser.watch(botId, socket.id);
      ack(state);
      if (frame) socket.emit('browser:frame', { botId, ...frame });
    });
    socket.on('browser:unwatch', (botId) => {
      if (typeof botId !== 'string' || !watching.delete(botId)) return;
      void socket.leave(`browser:${botId}`);
      browser.unwatch(botId, socket.id);
    });
    socket.on('browser:control', async (raw, ack) => {
      if (typeof ack !== 'function') return;
      const t = await requestT(socket.handshake.headers);
      const parsed = BrowserControlEvent.safeParse(raw);
      if (!parsed.success || !(await known(parsed.data.botId))) {
        return ack({ ok: false, error: t('error.notFound') });
      }
      try {
        await browser.setControl(parsed.data.botId, parsed.data.on);
        ack({ ok: true });
      } catch (err) {
        ack({ ok: false, error: browserErrorText(err, t) });
      }
    });
    socket.on('browser:input', (raw) => {
      const parsed = BrowserInputEvent.safeParse(raw);
      if (parsed.success && watching.has(parsed.data.botId)) {
        void browser.input(parsed.data.botId, parsed.data.input);
      }
    });
    // A bot's desktop: its state, waking it, taking control, and the live screen (RFB bytes).
    const desks = new Set<string>();
    const screens = new Map<string, { ws: WebSocket; filter: RfbClientFilter }>();
    const closeScreen = (botId: string) => {
      const s = screens.get(botId);
      if (!s) return;
      screens.delete(botId);
      s.ws.close();
    };
    socket.on('computer:watch', async (botId, ack) => {
      if (typeof ack !== 'function') return;
      if (!computer || !(await known(botId))) return ack(null);
      desks.add(botId);
      computer.watch(botId, socket.id);
      ack(computer.state(botId));
    });
    socket.on('computer:unwatch', (botId) => {
      if (!computer || typeof botId !== 'string' || !desks.delete(botId)) return;
      computer.unwatch(botId, socket.id);
    });
    socket.on('computer:wake', async (botId, ack) => {
      if (typeof ack !== 'function') return;
      const t = await requestT(socket.handshake.headers);
      if (!computer || !(await known(botId))) return ack({ ok: false, error: t('error.notFound') });
      try {
        await computer.ensure(botId);
        ack({ ok: true });
      } catch (err) {
        ack({ ok: false, error: computerErrorText(err, t) });
      }
    });
    socket.on('computer:control', async (raw, ack) => {
      if (typeof ack !== 'function') return;
      const t = await requestT(socket.handshake.headers);
      const parsed = BrowserControlEvent.safeParse(raw);
      if (!computer || !parsed.success || !(await known(parsed.data.botId))) {
        return ack({ ok: false, error: t('error.notFound') });
      }
      const { botId, on } = parsed.data;
      try {
        if (on) await computer.ensure(botId);
        computer.setControl(botId, socket.id, on);
        ack({ ok: true });
      } catch (err) {
        ack({ ok: false, error: computerErrorText(err, t) });
      }
    });
    socket.on('vnc:open', async (botId, ack) => {
      if (typeof ack !== 'function') return;
      const t = await requestT(socket.handshake.headers);
      if (!computer || !(await known(botId))) return ack({ ok: false, error: t('error.notFound') });
      if (computer.state(botId).status !== 'running') {
        return ack({ ok: false, error: t('computer.notRunning') });
      }
      closeScreen(botId);
      const ws = new WebSocket(computer.client.socketUrl(botId, 'vnc'));
      ws.binaryType = 'arraybuffer';
      const entry = { ws, filter: new RfbClientFilter(() => computer.controlledBy(botId, socket.id)) };
      screens.set(botId, entry);
      let opened = false;
      ws.addEventListener('open', () => {
        opened = true;
        ack({ ok: true });
      });
      ws.addEventListener('message', (e) => {
        if (screens.get(botId) === entry)
          socket.emit('vnc:data', { botId, data: Buffer.from(e.data as ArrayBuffer) });
      });
      ws.addEventListener('close', () => {
        if (!opened) ack({ ok: false, error: t('computer.unreachable') });
        // Closed from this side (the viewer left): the viewer already knows.
        if (screens.get(botId) !== entry) return;
        screens.delete(botId);
        socket.emit('vnc:closed', { botId });
      });
    });
    socket.on('vnc:data', (raw) => {
      const botId = (raw as { botId?: unknown } | null)?.botId;
      const data = (raw as { data?: unknown } | null)?.data;
      if (typeof botId !== 'string' || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return;
      const entry = screens.get(botId);
      if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;
      const r = entry.filter.push(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
      if ('error' in r) {
        closeScreen(botId);
        socket.emit('vnc:closed', { botId });
        return;
      }
      if (r.out.length) entry.ws.send(r.out);
    });
    socket.on('vnc:close', (botId) => {
      if (typeof botId === 'string') closeScreen(botId);
    });
    socket.on('disconnect', () => {
      for (const botId of watching) browser.unwatch(botId, socket.id);
      for (const botId of [...screens.keys()]) closeScreen(botId);
      computer?.forget(socket.id);
    });
  });
  /**
   * Sends to the people of a conversation, or of a bot (those who may change it). With nobody to
   * send to it sends nothing: an empty list of rooms would reach every socket.
   */
  const nobody = { emit: () => true } as unknown as ReturnType<typeof io.to>;
  const toPeople = (users: string[]) => (users.length ? io.to(users.map(personRoom)) : nobody);
  const toThread = async (threadId: string) => toPeople(await services.access.threadAudience(threadId));
  // Events of one conversation go out in the order they happened, so a streaming reply is not scrambled.
  const inThreadOrder = inOrder((err) => app.log.warn({ err }, 'could not send a conversation event'));
  const sendToThread = (threadId: string, send: (to: ReturnType<typeof io.to>) => void) =>
    void inThreadOrder(threadId, () => toThread(threadId), send);
  const toBotEditors = async (botId: string) => toPeople(await services.access.botPeople(botId, 'edit'));
  computer?.on((s) => void toBotEditors(s.botId).then((to) => to.emit('computer:state', s)));
  // A person at the desktop's controls picks files in the browser's own window; the bot never does.
  computer?.on((s) => browser.desktopControl(s.botId, s.user));
  browser.on({
    state: (s) => void toBotEditors(s.botId).then((to) => to.emit('browser:state', s)),
    // A frame a slow viewer cannot take yet is dropped, not queued: the next one replaces it anyway.
    frame: (botId, f) => io.to(`browser:${botId}`).volatile.emit('browser:frame', { botId, ...f }),
  });
  const toBotPeople = async (botId: string) => toPeople(await services.access.botPeople(botId, 'chat'));
  // A refresh only says what to fetch again, but one about a conversation or a bot also says it
  // exists and is busy: it goes only to those who see it. The rest are lists each fetches as theirs.
  bus.on('refresh', (e) => {
    if (e.scope === 'thread' || e.scope === 'routineMade')
      sendToThread(e.threadId, (to) => to.emit('refresh', e));
    else if (e.scope === 'threads' || e.scope === 'tables' || e.scope === 'actions')
      void toBotPeople(e.botId).then((to) => to.emit('refresh', e));
    else io.emit('refresh', e);
  });
  bus.on('delta', (e) => sendToThread(e.threadId, (to) => to.emit('delta', e)));
  bus.on('turn', (e) => {
    sendToThread(e.threadId, (to) => to.emit('turn', e));
    void services.push.activityTurn(e);
  });
  bus.on('notice', (e) => {
    services.push.activityNotice(e);
    // A notice for named people (a second yes wanted) goes to them alone.
    void (e.to ? Promise.resolve(e.to) : services.access.noticeAudience(e.threadId)).then((users) => {
      toPeople(users).emit('notice', e);
      return services.push.notice(e, users);
    });
  });
  bus.on('tool', (e) => sendToThread(e.threadId, (to) => to.emit('tool', e)));

  // A part that cannot start (a stored row it cannot read, a chat app whose service is down) is
  // written to the log and the rest still opens: one bad row would otherwise keep the whole app
  // from starting, and the desktop app would only say the server keeps stopping.
  launchMark('routes');
  const begin = async (what: string, step: () => unknown) => {
    try {
      await launchSpan(what, step);
    } catch (err) {
      console.warn(`Could not start ${what}: ${String(err)}`);
    }
  };
  await begin('turn recovery', () => services.turns.recover());
  await begin('request recovery', () => services.jobs.recover());
  await begin('routine recovery', () => services.routines.recover());
  await begin('marker recount', () => services.jobs.recountMarkers());
  services.routines.start();
  services.followUps.start();
  services.turns.startUpkeep();
  await begin('meetings', () => services.meetings.start());
  // In the background: model lists work from the engine's own until the catalog is in.
  await begin('the model catalog', () => services.modelCatalog.start());
  await begin('the account tunnel', () => accountHost.start());
  if (config.channelsEnabled) {
    await begin('Telegram', () => services.telegram.start());
    await begin('WhatsApp', () => services.whatsapp.start());
    await begin('Slack', () => services.slack.start());
    await begin('Discord', () => services.discord.start());
    await begin('Teams', () => services.teams.start());
  }

  return {
    app,
    io,
    services,
    auth,
    db,
    bootId,
    accessKey,
    routes,
    info,
    checkClaude,
    async listen() {
      return app.listen({ host: config.host, port: config.port });
    },
    async close() {
      accountHost.stop();
      await services.routines.stop();
      await services.followUps.stop();
      await services.telegram.stop();
      await services.whatsapp.stop();
      await services.slack.stop();
      await services.discord.stop();
      await services.teams.stop();
      await services.reactions.stop();
      services.push.stop();
      services.subscriptions.stop();
      claudeSignIn.stop();
      await services.turns.shutdown();
      await services.memoryReview.shutdown();
      await services.memoryTidy.shutdown();
      await services.promises.shutdown();
      await services.routineSuggestions.shutdown();
      await services.checkIns.shutdown();
      await services.skillSuggestions.shutdown();
      await services.titles.shutdown();
      await services.reviewer.shutdown();
      await services.offers.shutdown();
      await services.meetings.shutdown();
      await services.calls.shutdown();
      await browser.shutdown();
      if (computerCheck) clearInterval(computerCheck);
      clearInterval(sweepTimer);
      clearInterval(retryApps);
      clearInterval(indexMemory);
      await services.contentSeal.settled();
      services.embeddings.stop();
      await computer?.shutdown();
      personComputer?.close();
      stopComputerLink?.();
      localSocks?.close();
      egress?.close();
      io.disconnectSockets(true);
      dropAllClients();
      await app.close();
      await db.close();
    },
  };
}

/**
 * What this server serves: the page (it names the web app's hashed files) and the server's own
 * code. An open page compares it across reconnects to tell a new deploy from a plain restart.
 * Null without a built web app (development serves the page from elsewhere).
 */
function readBuildId(appDir: string | null): string | null {
  if (!appDir) return null;
  try {
    const hash = createHash('sha256').update(readFileSync(join(appDir, 'index.html')));
    try {
      hash.update(readFileSync(fileURLToPath(import.meta.url)));
    } catch {
      // Only the page then; a server-only change goes unnoticed.
    }
    return hash.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}
