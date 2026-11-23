import {
  CATALOG_CATEGORIES,
  CATALOG_GROUPS,
  CONNECTION_CATALOG,
  addressKey,
  catalogEntry,
  catalogLogo,
  formHeaders,
  headerNameAllowed,
  parseMcpSetup,
  searchCatalog,
  sharesApp,
  type Bot,
  type CatalogCategory,
  type CatalogGroup,
  type CatalogEntry,
  type Connection,
  type ConnectionAuth,
  type ConnectionCreate,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  LogIn,
  LogOut,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useBots, useConnections, useManagesServer } from '@/lib/queries';
import { TeamChoice } from './VaultTab';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'connected' | CatalogGroup;
type View =
  | { kind: 'browse' }
  | { kind: 'setup'; entry: CatalogEntry | null; sibling?: Connection }
  | { kind: 'connection'; id: string; signInUrl?: string };

const STATUS_KEY: Record<Connection['status'], MessageKey> = {
  connected: 'apps.status.connected',
  'signed-out': 'apps.status.signedOut',
  error: 'apps.status.error',
};

/** The service's logo, or its first letter when there is none. */
export function AppLogo({ id, name, size = 40 }: { id: string | null; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const box = { width: size, height: size };
  if (!id || failed) {
    return (
      <span
        style={box}
        className="flex shrink-0 items-center justify-center rounded-xl border bg-background text-sm font-semibold text-muted-foreground uppercase"
      >
        {name.trim()[0] ?? '?'}
      </span>
    );
  }
  return (
    <img
      src={catalogLogo(id)}
      alt=""
      style={box}
      onError={() => setFailed(true)}
      className="shrink-0 rounded-xl border bg-white object-contain"
    />
  );
}

/** One service as the list shows it: a catalog service with all its accounts, or one other server. */
interface Service {
  key: string;
  logo: string | null;
  name: string;
  accounts: Connection[];
}

/** The accounts of a catalog service at the same address are one service; other servers stand alone. */
export function servicesOf(connections: Connection[]): Service[] {
  const out = new Map<string, Service>();
  for (const c of connections) {
    const entry = catalogEntry(c.catalogId);
    const key = entry ? `${entry.id} ${addressKey(c.url)}` : c.id;
    const s = out.get(key);
    if (s) s.accounts.push(c);
    else out.set(key, { key, logo: c.catalogId, name: entry?.name ?? c.name, accounts: [c] });
  }
  return [...out.values()];
}

/** How a service's row reads: its accounts when more than one, else the one account's status. */
function serviceStatus(t: ReturnType<typeof useT>, accounts: Connection[]) {
  return {
    sub:
      accounts.length > 1
        ? t('apps.accountCount', { count: accounts.length })
        : t(STATUS_KEY[accounts[0]!.status]),
    tone: accounts.every((a) => a.status === 'connected') ? ('ok' as const) : ('warn' as const),
  };
}

/** Opens a service's sign-in page in the person's browser (the desktop app hands it to the system browser). */
function openSignIn(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Whether a bot may use a connection's tools. */
export function openTo(c: Connection, botId: string) {
  return c.allBots || c.botIds.includes(botId);
}

/** Changes which bots may use a connection. */
export function useConnectionBots() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ c, allBots, botIds = [] }: { c: Connection; allBots: boolean; botIds?: string[] }) =>
      api.setConnectionBots(c.id, { allBots, botIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
    onError: (e) => toast.error((e as Error).message),
  });
}

/**
 * Turns a connection on for one bot, or off. Turning one bot off while every bot has it keeps it
 * for all the others.
 */
export function useToggleBot() {
  const { data: bots = [] } = useBots();
  const set = useConnectionBots();
  return {
    isPending: set.isPending,
    mutate: ({ c, botId, on }: { c: Connection; botId: string; on: boolean }) => {
      const current = c.allBots ? bots.filter((b) => !b.archivedAt).map((b) => b.id) : c.botIds;
      const botIds = on ? [...new Set([...current, botId])] : current.filter((b) => b !== botId);
      set.mutate({ c, allBots: false, botIds });
    },
  };
}

/**
 * The apps page: services to connect, the connections made, and each one's tools and bots. It
 * covers the main area while open; what was there stays as it was under it.
 */
export function AppsPage() {
  const apps = useUi((s) => s.apps);
  const openApps = useUi((s) => s.openApps);
  const [chosen, setView] = useState<View>({ kind: 'browse' });
  // Opened on one connection (a card in the chat asked to sign in to it) until the person moves on.
  const view: View =
    chosen.kind === 'browse' && apps?.connectionId ? { kind: 'connection', id: apps.connectionId } : chosen;
  const back = () => {
    if (apps?.connectionId) openApps({ botId: apps.botId });
    setView({ kind: 'browse' });
  };
  return (
    // The whole main area: the lists of apps take as many columns as its width holds.
    <section className="@container flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 w-full flex-col">
        {view.kind === 'browse' && (
          <Browse
            onView={setView}
            onClose={() => openApps(null)}
            initialQuery={catalogEntry(apps?.catalogId)?.name ?? ''}
          />
        )}
        {view.kind === 'setup' && (
          <Setup
            entry={view.entry}
            sibling={view.sibling}
            onBack={() =>
              setView(view.sibling ? { kind: 'connection', id: view.sibling.id } : { kind: 'browse' })
            }
            onDone={(id, signInUrl) => setView({ kind: 'connection', id, signInUrl })}
          />
        )}
        {view.kind === 'connection' && (
          <Detail
            id={view.id}
            signInUrl={view.signInUrl}
            onBack={back}
            onSignIn={(url) => setView({ kind: 'connection', id: view.id, signInUrl: url })}
            onOpen={(id) => setView({ kind: 'connection', id })}
            onAddAccount={(entry, sibling) => setView({ kind: 'setup', entry, sibling })}
          />
        )}
      </div>
    </section>
  );
}

function Browse({
  onView,
  onClose,
  initialQuery = '',
}: {
  onView(v: View): void;
  /** Leaves the apps page for what was under it. */
  onClose(): void;
  initialQuery?: string;
}) {
  const t = useT();
  const { data: connections = [] } = useConnections();
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<Filter>('all');
  const qc = useQueryClient();
  const label = (c: CatalogCategory) => t(`apps.category.${c}`);

  // A catalog service already added opens its connection instead of adding it again.
  const byAddress = useMemo(() => {
    const m = new Map<string, Connection[]>();
    for (const c of connections) m.set(addressKey(c.url), [...(m.get(addressKey(c.url)) ?? []), c]);
    return m;
  }, [connections]);
  const accountsOf = (e: CatalogEntry) => byAddress.get(addressKey(e.url)) ?? [];
  const existing = (e: CatalogEntry) => accountsOf(e)[0];

  // A connection of the same provider whose registered app this service can sign in with.
  const lenderOf = (e: CatalogEntry) =>
    e.auth === 'oauth' && e.client?.family
      ? connections.find(
          (c) => c.auth === 'oauth' && !!c.clientId && sharesApp(c, { url: e.url, catalogId: e.id }),
        )
      : undefined;

  const connect = useMutation({
    mutationFn: async ({ entry, lender }: { entry: CatalogEntry; lender?: Connection }) => {
      const c = await api.addConnection({
        name: entry.name,
        url: entry.url,
        auth: entry.auth,
        catalogId: entry.id,
        ...(lender ? { sameAppAs: lender.id } : {}),
      });
      if (entry.auth !== 'oauth') return { id: c.id, url: undefined };
      const started = await api.signInConnection(c.id);
      return { id: c.id, url: started.url ?? undefined };
    },
    onSuccess: ({ id, url }) => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      if (url) openSignIn(url);
      onView({ kind: 'connection', id, signInUrl: url });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const start = (entry: CatalogEntry) => {
    const c = existing(entry);
    if (c) return onView({ kind: 'connection', id: c.id });
    // A token, or an app registered with the service, is asked for first, unless another service
    // of the same provider already has the app: then only the sign-in opens.
    const lender = lenderOf(entry);
    if (entry.auth === 'token' || (entry.client && !lender)) return onView({ kind: 'setup', entry });
    connect.mutate({ entry, lender });
  };

  const q = query.trim();
  const services = useMemo(() => servicesOf(connections), [connections]);
  const connectedCount = services.length;
  const sections: { title: string; entries: CatalogEntry[] }[] = q
    ? [{ title: t('apps.results'), entries: searchCatalog(q, label) }]
    : filter === 'all'
      ? [
          { title: t('apps.featured'), entries: CONNECTION_CATALOG.filter((e) => e.featured) },
          ...CATALOG_CATEGORIES.map((c) => ({
            title: label(c),
            entries: CONNECTION_CATALOG.filter((e) => e.category === c),
          })),
        ]
      : filter === 'connected'
        ? []
        : CATALOG_GROUPS[filter].map((c) => ({
            title: label(c),
            entries: CONNECTION_CATALOG.filter((e) => e.category === c),
          }));
  const shownServices =
    filter === 'connected' || (!q && filter === 'all')
      ? services
      : q
        ? services.filter((s) =>
            [s.name, ...s.accounts.map((a) => a.name)].some((n) =>
              n.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
            ),
          )
        : [];

  return (
    <>
      <div className="window-drag flex items-center gap-2 px-3 pt-3 pb-4 sm:px-6">
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full"
          onClick={onClose}
          aria-label={t('common.back')}
        >
          <ChevronLeft className="size-5 rtl:-scale-x-100" />
        </Button>
        <h1 className="text-xl font-semibold">{t('apps.title')}</h1>
        {connectedCount > 0 && (
          <button
            onClick={() => setFilter('connected')}
            className="ms-auto flex items-center gap-2 rounded-full px-2 py-1 text-sm text-muted-foreground hover:bg-accent"
          >
            <span className="flex -space-x-2">
              {services.slice(0, 4).map((s) => (
                <AppLogo key={s.key} id={s.logo} name={s.name} size={22} />
              ))}
            </span>
            {t('apps.connectedCount', { count: connectedCount })}
            <ChevronRight className="size-4 rtl:-scale-x-100" />
          </button>
        )}
      </div>
      <p className="sr-only">{t('apps.subtitle')}</p>
      <div className="flex gap-2 px-5 sm:px-8">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('apps.search')}
            className="h-10 rounded-full ps-9"
          />
        </div>
        <Button
          variant="outline"
          className="h-10 rounded-full"
          onClick={() => onView({ kind: 'setup', entry: null })}
        >
          <Plus /> {t('apps.custom')}
        </Button>
      </div>
      {!q && (
        <div className="scroll-thin flex shrink-0 gap-2 overflow-x-auto px-5 sm:px-8 pt-4 pb-2">
          {(['all', 'connected', ...Object.keys(CATALOG_GROUPS)] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'shrink-0 rounded-full px-3.5 py-1.5 text-sm transition-colors hover:bg-accent',
                filter === f ? 'bg-foreground text-background hover:bg-foreground/90' : 'bg-secondary/70',
              )}
            >
              {f === 'all'
                ? t('apps.filter.all')
                : f === 'connected'
                  ? t('apps.filter.connected')
                  : t(`apps.group.${f}`)}
            </button>
          ))}
        </div>
      )}
      <div className="scroll-thin relative flex-1 overflow-y-auto px-5 sm:px-8 pt-2 pb-8">
        {shownServices.length > 0 && (
          <Section title={t('apps.yours')}>
            {shownServices.map((s) => {
              const { sub, tone } = serviceStatus(t, s.accounts);
              return (
                <AppRow
                  key={s.key}
                  logo={s.logo}
                  name={s.name}
                  sub={sub}
                  subTone={tone}
                  action={t('apps.manage')}
                  onClick={() => onView({ kind: 'connection', id: s.accounts[0]!.id })}
                />
              );
            })}
          </Section>
        )}
        {filter === 'connected' && !q && connections.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">{t('apps.noneConnected')}</p>
        )}
        {sections.map((s) =>
          s.entries.length ? (
            <Section key={s.title} title={s.title}>
              {s.entries.map((e) => {
                const all = accountsOf(e);
                const status = all.length ? serviceStatus(t, all) : null;
                return (
                  <AppRow
                    key={e.id}
                    logo={e.id}
                    name={e.name}
                    sub={status?.sub ?? label(e.category)}
                    subTone={status?.tone}
                    action={status ? t('apps.manage') : t('apps.connect')}
                    busy={connect.isPending && connect.variables?.entry.id === e.id}
                    onClick={() => start(e)}
                  />
                );
              })}
            </Section>
          ) : (
            q && (
              <p key={s.title} className="py-10 text-center text-sm text-muted-foreground">
                {t('apps.noMatch')}
              </p>
            )
          ),
        )}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pt-5">
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 @xl:grid-cols-2 @5xl:grid-cols-3">{children}</div>
    </section>
  );
}

function AppRow({
  logo,
  name,
  sub,
  subTone,
  action,
  busy,
  onClick,
}: {
  logo: string | null;
  name: string;
  sub: string;
  subTone?: 'ok' | 'warn';
  action: string;
  busy?: boolean;
  onClick(): void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl px-2 py-2 hover:bg-accent/50">
      <AppLogo id={logo} name={name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div
          className={cn(
            'flex items-center gap-1.5 truncate text-xs text-muted-foreground',
            subTone === 'ok' && 'text-emerald-600 dark:text-emerald-400',
            subTone === 'warn' && 'text-amber-600 dark:text-amber-400',
          )}
        >
          {subTone && <span className="size-1.5 shrink-0 rounded-full bg-current" />}
          {sub}
        </div>
      </div>
      <Button size="sm" variant="secondary" className="rounded-full" disabled={busy} onClick={onClick}>
        {busy && <Loader2 className="animate-spin" />}
        {action}
      </Button>
    </div>
  );
}

function Header({
  onBack,
  logo,
  title,
  sub,
}: {
  onBack(): void;
  logo: string | null;
  title: string;
  sub?: string;
}) {
  const t = useT();
  return (
    <div className="window-drag flex items-center gap-3 border-b px-6 py-4">
      <Button
        variant="ghost"
        size="icon"
        className="rounded-full"
        onClick={onBack}
        aria-label={t('apps.back')}
      >
        <ArrowLeft className="rtl:-scale-x-100" />
      </Button>
      <AppLogo id={logo} name={title} size={36} />
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-base font-semibold">{title}</h1>
        {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function HelpLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/** The callback address a service's registered app must name. */
function RedirectUrl() {
  const t = useT();
  const { data } = useQuery({ queryKey: ['connection-redirect'], queryFn: api.connectionRedirectUrl });
  if (!data) return null;
  return (
    <div className="space-y-1.5">
      <span className="text-sm font-medium">{t('apps.redirectUrl')}</span>
      <div className="flex items-center gap-2">
        <Input readOnly value={data.url} className="font-mono text-xs" />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label={t('apps.copy')}
          onClick={async () => {
            if (await copyText(data.url)) toast.success(t('apps.copied'));
            else toast.error(t('message.copyFailed'));
          }}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

/** In the app choice of a further account: sign in through an app of its own, not another account's. */
const NEW_APP = 'new';

/**
 * Adding a service that needs something first (a token, a registered app), or any other server.
 * With `sibling`, a further account of a catalog service already connected: it asks only for a
 * name that tells the two apart, and signs in through the service's default app: the one its
 * first account signed in with. Another app added earlier, or a new one under a name of its own,
 * can be picked behind a link, for an account the default app does not accept (an app open only
 * to its own organization turns personal accounts away).
 */
function Setup({
  entry,
  sibling,
  onBack,
  onDone,
}: {
  entry: CatalogEntry | null;
  sibling?: Connection;
  onBack(): void;
  onDone(id: string, signInUrl?: string): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: connections = [] } = useConnections();
  const another = !!entry && !!sibling;
  // The sibling's app serves every account: one registered with the service, or none needed.
  const reuse =
    another && entry.auth === 'oauth' && sibling.auth === 'oauth' && (!!sibling.clientId || !entry.client);
  // Another app can be picked only where accounts sign in through registered apps; elsewhere each
  // account registers itself with the service.
  const canChoose = reuse && !!entry.client;
  // The apps this service's accounts sign in with, one account standing for each: the default
  // (the first account's) first, then the others in the order they were added.
  const apps = useMemo(() => {
    if (!canChoose || !sibling) return [];
    const same = connections
      .filter(
        (c) =>
          c.auth === 'oauth' &&
          !!c.clientId &&
          c.catalogId === sibling.catalogId &&
          addressKey(c.url) === addressKey(sibling.url),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const byApp = new Map<string, { id: string; name: string | null; clientId: string }>();
    for (const c of same.some((c) => c.id === sibling.id) ? same : [sibling, ...same]) {
      const app = byApp.get(c.clientId!);
      if (!app) byApp.set(c.clientId!, { id: c.id, name: c.clientName, clientId: c.clientId! });
      else app.name ??= c.clientName;
    }
    return [...byApp.values()];
  }, [canChoose, connections, sibling]);
  const [picked, setPicked] = useState<string | null>(null);
  const appFrom = picked ?? apps[0]?.id ?? (reuse ? sibling.id : NEW_APP);
  const [choosingApp, setChoosingApp] = useState(false);
  const reusing = reuse && appFrom !== NEW_APP;
  const [appName, setAppName] = useState('');
  const [name, setName] = useState(another ? '' : (entry?.name ?? ''));
  const [url, setUrl] = useState(entry?.url ?? '');
  const [auth, setAuth] = useState<ConnectionAuth>(entry?.auth ?? 'oauth');
  const [token, setToken] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [ownSwitch, setOwnSwitch] = useState(false);
  const [headers, setHeaders] = useState<{ name: string; value: string }[]>([]);
  const [typed, setTyped] = useState({ name: '', value: '' });
  // A catalog service rarely needs headers of its own: they stay behind a link until asked for.
  const [showHeaders, setShowHeaders] = useState(!entry);
  const sentHeaders = formHeaders(headers, typed);
  const manages = useManagesServer();
  const [team, setTeam] = useState(false);
  // A service that needs a registered app always asks for one; any other only when switched on.
  const ownApp = !reusing && (!!entry?.client || ownSwitch);
  // A new app next to the default is named, so later accounts find it in the list.
  const namingApp = canChoose && !reusing;
  const add = useMutation({
    mutationFn: async () => {
      const input: ConnectionCreate = {
        name: name.trim(),
        url: url.trim(),
        auth,
        catalogId: entry?.id ?? null,
        ...(auth === 'token' ? { token: token.trim() } : {}),
        ...(auth === 'oauth' && ownApp && clientId.trim()
          ? {
              clientId: clientId.trim(),
              ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
              ...(namingApp ? { clientName: appName.trim() } : {}),
            }
          : {}),
        ...(reusing ? { sameAppAs: appFrom } : {}),
        ...(team ? { team } : {}),
        ...(sentHeaders.length ? { headers: sentHeaders } : {}),
      };
      const c = await api.addConnection(input);
      if (auth !== 'oauth') return { id: c.id, url: undefined };
      const started = await api.signInConnection(c.id);
      return { id: c.id, url: started.url ?? undefined };
    },
    onSuccess: ({ id, url: signIn }) => {
      void qc.invalidateQueries({ queryKey: ['connections'] });
      if (signIn) openSignIn(signIn);
      onDone(id, signIn);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const needsClient = !!entry?.client && !entry.client.secretOptional && !reusing;
  const ready =
    name.trim() &&
    url.trim() &&
    (auth !== 'token' || token.trim()) &&
    (!needsClient || clientId.trim()) &&
    (!ownApp || clientId.trim()) &&
    (!namingApp || appName.trim()) &&
    sentHeaders.every((h) => headerNameAllowed(h.name, auth));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) add.mutate();
  };
  return (
    <>
      <Header
        onBack={onBack}
        logo={entry?.id ?? null}
        title={entry?.name ?? t('apps.customTitle')}
        sub={entry ? new URL(entry.url).host : t('apps.customHint')}
      />
      <form
        onSubmit={submit}
        className="scroll-thin relative flex-1 space-y-5 overflow-y-auto px-5 sm:px-8 py-6"
      >
        {another && (
          <Field label={t('apps.accountName')} hint={t('apps.accountNameHint', { name: entry.name })}>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
        )}
        {!entry && (
          <>
            <Field label={t('apps.name')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label={t('apps.url')} hint={t('apps.urlHint')}>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onPaste={(e) => {
                  // A setup command or a JSON config fills the form, not just this field.
                  const setup = parseMcpSetup(e.clipboardData.getData('text/plain'));
                  if (!setup) return;
                  e.preventDefault();
                  setUrl(setup.url);
                  if (setup.name && !name.trim()) setName(setup.name);
                  if (setup.token) {
                    setAuth('token');
                    setToken(setup.token);
                  }
                }}
                placeholder={t('apps.urlPlaceholder')}
                inputMode="url"
              />
            </Field>
            <Field label={t('apps.auth')}>
              <Select value={auth} onValueChange={(v) => setAuth(v as ConnectionAuth)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="oauth">{t('apps.auth.oauth')}</SelectItem>
                  <SelectItem value="token">{t('apps.auth.token')}</SelectItem>
                  <SelectItem value="none">{t('apps.auth.none')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </>
        )}
        {!entry && (
          <NewHeaders headers={headers} onChange={setHeaders} typed={typed} onType={setTyped} auth={auth} />
        )}
        {auth === 'token' && (
          <Field
            label={t('apps.token')}
            hint={
              entry?.tokenHelp ? (
                <HelpLink href={entry.tokenHelp}>{t('apps.tokenHelp', { name: entry.name })}</HelpLink>
              ) : (
                t('apps.tokenHint')
              )
            }
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
              autoFocus={!!entry && !another}
            />
          </Field>
        )}
        {canChoose &&
          (choosingApp ? (
            <Field label={t('apps.whichApp')} hint={t('apps.whichAppHint')}>
              <Select value={appFrom} onValueChange={setPicked}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {apps.map((a, i) => (
                    <SelectItem key={a.id} value={a.id}>
                      {i === 0 ? t('apps.defaultApp') : (a.name ?? a.clientId)}
                    </SelectItem>
                  ))}
                  <SelectItem value={NEW_APP}>{t('apps.newApp')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => {
                setChoosingApp(true);
                // With one app to choose from, the only other choice is a new one.
                if (apps.length < 2) setPicked(NEW_APP);
              }}
            >
              {t('apps.otherApp')}
            </button>
          ))}
        {auth === 'oauth' && !reusing && (
          <div className="space-y-4 rounded-2xl border p-4">
            {entry?.client ? (
              <p className="text-sm text-muted-foreground">
                {t('apps.clientNeeded', { name: entry.name })}{' '}
                <HelpLink href={entry.client.help}>{t('apps.clientWhere')}</HelpLink>
              </p>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{t('apps.ownApp')}</div>
                  <div className="text-xs text-muted-foreground">{t('apps.ownAppHint')}</div>
                </div>
                <Switch checked={ownApp} onCheckedChange={setOwnSwitch} aria-label={t('apps.ownApp')} />
              </div>
            )}
            {ownApp && (
              <>
                {namingApp && (
                  <Field label={t('apps.appName')} hint={t('apps.appNameHint')}>
                    <Input
                      value={appName}
                      onChange={(e) => setAppName(e.target.value)}
                      maxLength={80}
                      placeholder={t('apps.appNamePlaceholder')}
                    />
                  </Field>
                )}
                <RedirectUrl />
                <Field label={t('apps.clientId')}>
                  <Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
                </Field>
                <Field label={t('apps.clientSecret')} hint={t('apps.clientSecretHint')}>
                  <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="off"
                  />
                </Field>
              </>
            )}
          </div>
        )}
        {entry &&
          (showHeaders ? (
            <NewHeaders headers={headers} onChange={setHeaders} typed={typed} onType={setTyped} auth={auth} />
          ) : (
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              onClick={() => setShowHeaders(true)}
            >
              {t('apps.headerAdd')}
            </button>
          ))}
        {another && auth === 'oauth' && (
          <p className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm">
            {t('apps.accountSignInNote', { name: entry.name })}
          </p>
        )}
        {manages && <TeamChoice team={team} onChange={setTeam} />}
        <p className="text-xs text-muted-foreground">{t('apps.trustNote')}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" className="rounded-full" onClick={onBack}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" className="rounded-full" disabled={!ready || add.isPending}>
            {add.isPending ? <Loader2 className="animate-spin" /> : auth === 'oauth' ? <LogIn /> : <Plug />}
            {auth === 'oauth' ? t('apps.connectSignIn') : t('apps.connect')}
          </Button>
        </div>
      </form>
    </>
  );
}

function Detail({
  id,
  signInUrl,
  onBack,
  onSignIn,
  onOpen,
  onAddAccount,
}: {
  id: string;
  signInUrl?: string;
  onBack(): void;
  onSignIn(url: string): void;
  onOpen(id: string): void;
  onAddAccount(entry: CatalogEntry, sibling: Connection): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: connections, isLoading } = useConnections();
  const { data: bots = [] } = useBots();
  const c = connections?.find((x) => x.id === id);
  const done = () => qc.invalidateQueries({ queryKey: ['connections'] });
  const fail = (e: unknown) => toast.error((e as Error).message);
  const signIn = useMutation({
    mutationFn: () => api.signInConnection(id),
    onSuccess: (r) => {
      void done();
      if (r.url) {
        openSignIn(r.url);
        onSignIn(r.url);
      }
    },
    onError: fail,
  });
  const signOut = useMutation({
    mutationFn: () => api.signOutConnection(id),
    onSuccess: done,
    onError: fail,
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshConnection(id),
    onSuccess: (r) => {
      void done();
      if (r.status === 'connected') toast.success(t('apps.refreshed', { count: r.tools.length }));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.removeConnection(id),
    onSuccess: () => {
      void done();
      onBack();
    },
    onError: fail,
  });
  const [token, setToken] = useState('');
  const saveToken = useMutation({
    mutationFn: () => api.updateConnection(id, { token: token.trim() }),
    onSuccess: () => {
      setToken('');
      void done();
    },
    onError: fail,
  });

  if (!c) {
    return (
      <>
        <Header onBack={onBack} logo={null} title={t('apps.title')} />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {isLoading ? <Loader2 className="animate-spin" /> : t('apps.gone')}
        </div>
      </>
    );
  }
  const entry = catalogEntry(c.catalogId);
  const live = bots.filter((b) => !b.archivedAt);
  // Every account of a catalog service that signs in, this one among them.
  const accounts =
    entry && entry.auth !== 'none'
      ? (connections ?? []).filter(
          (x) => x.catalogId === c.catalogId && addressKey(x.url) === addressKey(c.url),
        )
      : [];
  return (
    <>
      <Header
        onBack={onBack}
        logo={c.catalogId}
        title={entry && accounts.length ? entry.name : c.name}
        sub={c.url}
      />
      <div className="scroll-thin relative flex-1 space-y-6 overflow-y-auto px-5 sm:px-8 py-6">
        {entry && accounts.length > 0 && (
          <Accounts accounts={accounts} current={c.id} onOpen={onOpen} onAdd={() => onAddAccount(entry, c)} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          {/* With several accounts, what follows is the one picked above. */}
          {accounts.length > 1 && <span className="text-sm font-semibold">{c.name}</span>}
          <span
            className={cn(
              'me-auto inline-flex items-center gap-2 text-sm font-medium',
              c.status === 'connected'
                ? 'text-emerald-600 dark:text-emerald-400'
                : 'text-amber-600 dark:text-amber-400',
            )}
          >
            <span className="size-2 rounded-full bg-current" />
            {t(STATUS_KEY[c.status])}
          </span>
          {c.auth === 'oauth' && (c.status !== 'connected' || c.needsScope) && (
            <Button
              size="sm"
              className="rounded-full"
              disabled={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              {signIn.isPending ? <Loader2 className="animate-spin" /> : <LogIn />} {t('apps.signIn')}
            </Button>
          )}
          {c.auth === 'oauth' && c.status === 'connected' && (
            <Button
              size="sm"
              variant="ghost"
              className="rounded-full"
              disabled={signOut.isPending}
              onClick={() => signOut.mutate()}
            >
              <LogOut /> {t('apps.signOut')}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className={cn(refresh.isPending && 'animate-spin')} /> {t('apps.refresh')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-destructive hover:text-destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(t('apps.confirmRemove', { name: c.name }))) remove.mutate();
            }}
          >
            <Trash2 /> {t('common.remove')}
          </Button>
        </div>

        {c.status !== 'connected' && signInUrl && c.auth === 'oauth' && (
          <p className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm">
            {t('apps.waitingSignIn')}{' '}
            <a href={signInUrl} target="_blank" rel="noreferrer" className="underline">
              {t('apps.openSignIn')}
            </a>
          </p>
        )}
        {c.error && (
          <p className="rounded-2xl bg-destructive/10 px-4 py-3 text-sm break-words text-destructive">
            {c.error}
          </p>
        )}
        {c.auth === 'oauth' && c.status !== 'connected' && entry?.client && !c.clientId && (
          <p className="text-sm text-muted-foreground">
            {t('apps.clientNeeded', { name: c.name })}{' '}
            <HelpLink href={entry.client.help}>{t('apps.clientWhere')}</HelpLink>
          </p>
        )}

        {c.auth === 'token' && (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) saveToken.mutate();
            }}
          >
            <Field label={c.hasToken ? t('apps.newToken') : t('apps.token')}>
              <Input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
                placeholder={c.hasToken ? '••••••••' : ''}
              />
            </Field>
            <Button type="submit" className="rounded-full" disabled={!token.trim() || saveToken.isPending}>
              {t('common.save')}
            </Button>
          </form>
        )}

        <RequestHeaders connection={c} onSaved={done} />
        <Owned connection={c} />
        <BotAccess connection={c} bots={live} />
        <AppViews connection={c} />
        <Tools connection={c} />
      </div>
    </>
  );
}

/**
 * Extra request headers for the server, such as an API key under the name the service wants. Only
 * the names come back from the server: each shows as saved, and one is changed by adding it again.
 */
/**
 * Request headers for a server being added, sent with it. A name the server would refuse for the
 * chosen sign-in is flagged here, and holds the form back, rather than failing the whole connect.
 */
function NewHeaders({
  headers,
  onChange,
  typed,
  onType,
  auth,
}: {
  headers: { name: string; value: string }[];
  onChange(headers: { name: string; value: string }[]): void;
  typed: { name: string; value: string };
  onType(typed: { name: string; value: string }): void;
  auth: ConnectionAuth;
}) {
  const t = useT();
  const name = typed.name.trim();
  const blocked = !!name && !headerNameAllowed(name, auth);
  const addTyped = () => {
    if (!name || !typed.value || blocked) return;
    onChange(formHeaders(headers, typed));
    onType({ name: '', value: '' });
  };
  // Enter in these fields adds the header instead of connecting.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addTyped();
  };
  return (
    <section className="space-y-2">
      <div className="text-sm font-medium">{t('apps.headers')}</div>
      <p className="text-xs text-muted-foreground">{t('apps.headersHint')}</p>
      {headers.map((h) => {
        const refused = !headerNameAllowed(h.name, auth);
        return (
          <div key={h.name.toLowerCase()} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
            {refused && <span className="text-xs text-destructive">{t('apps.headerNameBlocked')}</span>}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('common.remove')}
              onClick={() => onChange(headers.filter((x) => x !== h))}
            >
              <Trash2 />
            </Button>
          </div>
        );
      })}
      <div className="flex items-center gap-2">
        <Input
          value={typed.name}
          onChange={(e) => onType({ ...typed, name: e.target.value })}
          onKeyDown={onKey}
          placeholder={t('apps.headerName')}
          aria-invalid={blocked || undefined}
          autoComplete="off"
        />
        <Input
          type="password"
          value={typed.value}
          onChange={(e) => onType({ ...typed, value: e.target.value })}
          onKeyDown={onKey}
          placeholder={t('apps.headerValue')}
          autoComplete="off"
        />
        <Button
          type="button"
          variant="outline"
          className="rounded-full"
          disabled={!name || !typed.value || blocked}
          onClick={addTyped}
        >
          {t('apps.headerAdd')}
        </Button>
      </div>
      {blocked && <p className="text-xs text-destructive">{t('apps.headerNameBlocked')}</p>}
    </section>
  );
}

function RequestHeaders({ connection, onSaved }: { connection: Connection; onSaved: () => unknown }) {
  const t = useT();
  const names = connection.headerNames ?? [];
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  // The whole list goes each time; a name sent with no value keeps what is saved under it.
  const save = useMutation({
    mutationFn: (headers: { name: string; value: string }[]) =>
      api.updateConnection(connection.id, { headers }),
    onSuccess: () => {
      setName('');
      setValue('');
      void onSaved();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const kept = (except?: string) =>
    names.filter((n) => n.toLowerCase() !== except?.toLowerCase()).map((n) => ({ name: n, value: '' }));
  return (
    <section className="space-y-2">
      <div className="text-sm font-medium">{t('apps.headers')}</div>
      <p className="text-xs text-muted-foreground">{t('apps.headersHint')}</p>
      {names.map((n) => (
        <div key={n} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate font-medium">{n}</span>
          <span className="text-xs text-muted-foreground">{t('apps.headerSaved')}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('common.remove')}
            disabled={save.isPending}
            onClick={() => save.mutate(kept(n))}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && value) save.mutate([...kept(name.trim()), { name: name.trim(), value }]);
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('apps.headerName')}
          autoComplete="off"
        />
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('apps.headerValue')}
          autoComplete="off"
        />
        <Button type="submit" className="rounded-full" disabled={!name.trim() || !value || save.isPending}>
          {t('apps.headerAdd')}
        </Button>
      </form>
    </section>
  );
}

/** Every bot by default; turned off, a switch per bot. */
/**
 * The accounts signed in to one service, each its own connection: the one open is marked, the
 * others open on a click, and each can be renamed. The name is what people and approval cards
 * see; the tools keep the name they were made with.
 */
function Accounts({
  accounts,
  current,
  onOpen,
  onAdd,
}: {
  accounts: Connection[];
  current: string;
  onOpen(id: string): void;
  onAdd(): void;
}) {
  const t = useT();
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('apps.accounts')}</h3>
      <div className="divide-y rounded-2xl border">
        {accounts.map((a) => (
          <AccountRow key={a.id} account={a} current={a.id === current} onOpen={() => onOpen(a.id)} />
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex w-full items-center gap-2 rounded-b-2xl px-4 py-3 text-start text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        >
          <Plus className="size-4" /> {t('apps.addAccount')}
        </button>
      </div>
    </section>
  );
}

function AccountRow({
  account: a,
  current,
  onOpen,
}: {
  account: Connection;
  current: boolean;
  onOpen(): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(a.name);
  const rename = useMutation({
    mutationFn: (next: string) => api.updateConnection(a.id, { name: next }),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ['connections'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const save = () => {
    const next = name.trim();
    if (!next || next === a.name) {
      setName(a.name);
      setEditing(false);
    } else rename.mutate(next);
  };
  if (editing) {
    return (
      <form
        className="flex items-center gap-2 px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setName(a.name);
              setEditing(false);
            }
          }}
          maxLength={80}
          aria-label={t('apps.accountName')}
          data-escape-local
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          className="h-9"
        />
        <Button type="submit" size="sm" className="rounded-full" disabled={rename.isPending}>
          {rename.isPending && <Loader2 className="animate-spin" />}
          {t('common.save')}
        </Button>
      </form>
    );
  }
  return (
    <div className={cn('flex items-center gap-2 px-4 py-3', current && 'bg-accent/40')}>
      <button
        type="button"
        onClick={onOpen}
        disabled={current}
        aria-current={current ? 'true' : undefined}
        className="min-w-0 truncate text-start text-sm font-medium enabled:hover:underline"
      >
        {a.name}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-full text-muted-foreground"
        aria-label={t('apps.rename')}
        onClick={() => {
          setName(a.name);
          setEditing(true);
        }}
      >
        <Pencil className="size-3.5" />
      </Button>
      <span
        className={cn(
          'ms-auto inline-flex shrink-0 items-center gap-1.5 text-xs',
          a.status === 'connected'
            ? 'text-emerald-600 dark:text-emerald-400'
            : 'text-amber-600 dark:text-amber-400',
        )}
      >
        <span className="size-1.5 rounded-full bg-current" />
        {t(STATUS_KEY[a.status])}
      </span>
    </div>
  );
}

/**
 * Whose a connection is: the team's, which every bot uses for everyone, or the person's own,
 * which a bot uses only while it works for them. Only those who look after the server move one.
 */
function Owned({ connection: c }: { connection: Connection }) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const team = c.userId === null;
  const move = useMutation({
    mutationFn: (to: boolean) => api.updateConnection(c.id, { team: to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  // Servers older than people do not say.
  if (c.userId === undefined) return null;
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('owned.title')}</h3>
      <div className="flex items-center gap-3 rounded-2xl border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{team ? t('owned.team') : t('owned.yours')}</div>
          <div className="text-xs text-muted-foreground">
            {team ? (manages ? t('owned.teamHint') : t('owned.teamLocked')) : t('owned.yoursHint')}
          </div>
        </div>
        {manages && (
          <Switch
            checked={team}
            disabled={move.isPending}
            onCheckedChange={(to) => move.mutate(to)}
            aria-label={t('owned.forTeam')}
          />
        )}
      </div>
    </section>
  );
}

function BotAccess({ connection: c, bots }: { connection: Connection; bots: Bot[] }) {
  const t = useT();
  const set = useConnectionBots();
  return (
    <section>
      <h3 className="mb-2 text-sm font-semibold">{t('apps.bots')}</h3>
      <div className="divide-y rounded-2xl border">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t('apps.allBots')}</div>
            <div className="text-xs text-muted-foreground">
              {c.allBots ? t('apps.allBotsHint') : t('apps.someBotsHint')}
            </div>
          </div>
          <Switch
            checked={c.allBots}
            disabled={set.isPending}
            // Narrowing starts from every bot, so nothing changes until one is turned off.
            onCheckedChange={(all) =>
              set.mutate({ c, allBots: all, botIds: all ? [] : bots.map((b) => b.id) })
            }
            aria-label={t('apps.allBots')}
          />
        </div>
        {!c.allBots &&
          (bots.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">{t('apps.noBots')}</p>
          ) : (
            bots.map((b) => <BotSwitch key={b.id} bot={b} connection={c} />)
          ))}
      </div>
    </section>
  );
}

/** Whether the app's tools show their own views (MCP apps) in the conversation; only when some have one. */
function AppViews({ connection: c }: { connection: Connection }) {
  const t = useT();
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (on: boolean) => api.updateConnection(c.id, { showApps: on }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['connections'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!c.tools.some((x) => x.app)) return null;
  return (
    <section>
      <div className="flex items-center gap-3 rounded-2xl border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t('apps.views')}</div>
          <div className="text-xs text-muted-foreground">{t('apps.viewsHint')}</div>
        </div>
        <Switch
          checked={c.showApps !== false}
          disabled={set.isPending}
          onCheckedChange={(on) => set.mutate(on)}
          aria-label={t('apps.views')}
        />
      </div>
    </section>
  );
}

/** The server's tools, folded away behind a count until the person wants to change one. */
function Tools({ connection: c }: { connection: Connection }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const reads = c.tools.filter((x) => x.kind === 'read').length;
  const off = c.tools.filter((x) => !x.enabled).length;
  if (c.tools.length === 0) {
    return (
      <section>
        <h3 className="mb-2 text-sm font-semibold">{t('apps.tools', { count: 0 })}</h3>
        <p className="text-sm text-muted-foreground">
          {c.status === 'connected' ? t('apps.noTools') : t('apps.toolsAfterSignIn')}
        </p>
      </section>
    );
  }
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-start"
      >
        <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="text-sm font-semibold">{t('apps.tools', { count: c.tools.length })}</span>
        <span className="ms-auto text-xs text-muted-foreground">
          {t('apps.toolsSummary', { read: reads, write: c.tools.length - reads })}
          {off > 0 && ` · ${t('apps.toolsOff', { count: off })}`}
        </span>
      </button>
      {open && (
        <>
          <p className="mt-2 mb-2 text-xs text-muted-foreground">{t('apps.toolsHint')}</p>
          <div className="divide-y rounded-2xl border">
            {c.tools.map((tool) => (
              <ToolRow key={tool.name} connection={c} tool={tool} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function BotSwitch({ bot, connection }: { bot: Bot; connection: Connection }) {
  const toggle = useToggleBot();
  const on = openTo(connection, bot.id);
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <BotAvatar avatar={bot.avatar} color={bot.color} size={28} />
      <span className="min-w-0 flex-1 truncate text-sm">{bot.name}</span>
      <Switch
        checked={on}
        disabled={toggle.isPending}
        onCheckedChange={(v) => toggle.mutate({ c: connection, botId: bot.id, on: v })}
        aria-label={bot.name}
      />
    </div>
  );
}

function ToolRow({ connection, tool }: { connection: Connection; tool: Connection['tools'][number] }) {
  const t = useT();
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (patch: { enabled?: boolean; kind?: 'read' | 'write' }) =>
      api.setConnectionTool(connection.id, tool.name, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className={cn('flex items-start gap-3 px-4 py-3', !tool.enabled && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs font-medium">{tool.title ?? tool.name}</div>
        {tool.description && (
          <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{tool.description}</div>
        )}
      </div>
      <Select value={tool.kind} onValueChange={(v) => set.mutate({ kind: v as 'read' | 'write' })}>
        <SelectTrigger size="sm" className="w-36 shrink-0" aria-label={t('apps.toolKind')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="read">{t('apps.kind.read')}</SelectItem>
          <SelectItem value="write">{t('apps.kind.write')}</SelectItem>
        </SelectContent>
      </Select>
      <Switch
        checked={tool.enabled}
        onCheckedChange={(v) => set.mutate({ enabled: v })}
        aria-label={t('apps.toolEnabled')}
        className="mt-1"
      />
    </div>
  );
}
