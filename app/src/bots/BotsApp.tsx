import { deviceKeysSupported, TunnelError, type Tunnel, type TunnelEndCode } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Loader2, Server } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { App } from '@/App';
import { AppMascot } from '@/components/AppMascot';
import { Button } from '@/components/ui/button';
import { useT, type MessageKey } from '@/i18n';
import { useUi } from '@/lib/store';
import { catchServerLinks, dropServerFiles } from '@/lib/server-files';
import { useServerHost } from '@/lib/serverSwitch';
import { setMissingFeatureHandler, setTunnel } from '@/lib/transport';
import { account, AccountError, signInUrl, type ServerEntry } from './account';
import { openServer } from './connect';
import { passing, reconnect } from './reconnect';

const LAST = 'leafbot.web.server';

type Problem = 'offline' | 'outdated' | 'access' | 'revoked' | 'busy' | 'failed' | 'hostProof' | 'closed';

type View =
  | { at: 'checking' }
  | { at: 'accountDown' }
  | { at: 'unsupported' }
  | { at: 'servers'; servers: ServerEntry[] }
  | { at: 'connecting'; servers: ServerEntry[]; server: ServerEntry }
  | { at: 'open'; servers: ServerEntry[]; server: ServerEntry; tunnel: Tunnel }
  | { at: 'problem'; servers: ServerEntry[]; server: ServerEntry; problem: Problem };

const ROLE: Record<ServerEntry['role'], MessageKey> = {
  owner: 'bots.role.owner',
  admin: 'bots.role.admin',
  member: 'bots.role.member',
};

/** Why a server could not be opened, or why an open one ended, in the words the page shows. */
function problemOf(err: unknown, opened: boolean): Problem | 'signIn' | 'accountDown' {
  if (err instanceof AccountError) {
    if (err.status === 401) return 'signIn';
    if (err.status === 403 || err.status === 404) return 'access';
    return 'accountDown';
  }
  const code: TunnelEndCode | ConnectError['code'] | null =
    err instanceof TunnelError || err instanceof ConnectError ? err.code : null;
  switch (code) {
    case 'offline':
      return 'offline';
    case 'outdated':
      return 'outdated';
    case 'access':
      return 'access';
    case 'ticket':
    case 'proof':
    case 'expired':
    case 'revoked':
      return 'revoked';
    case 'busy':
      return 'busy';
    case 'host-proof':
      return 'hostProof';
    default:
      return opened ? 'closed' : 'failed';
  }
}

/** Counts attempts to open a server; an answer for an earlier one is dropped. */
const attempt = { current: 0 };

type Start =
  | { at: 'unsupported' | 'accountDown' | 'signIn' }
  | { at: 'servers'; servers: ServerEntry[]; pick?: ServerEntry };

/** What the page starts with: the person's servers, or why there are none to show. */
async function discover(): Promise<Start> {
  if (!(await deviceKeysSupported())) return { at: 'unsupported' };
  try {
    await account.session();
    const servers = await account.servers();
    const last = servers.find((s) => s.id === remembered());
    const pick = last ?? (servers.length === 1 ? servers[0] : undefined);
    return { at: 'servers', servers, ...(pick ? { pick } : {}) };
  } catch (err) {
    return { at: err instanceof AccountError && err.status === 401 ? 'signIn' : 'accountDown' };
  }
}

function remembered(): string | null {
  try {
    return localStorage.getItem(LAST);
  } catch {
    return null;
  }
}

function remember(id: string) {
  try {
    localStorage.setItem(LAST, id);
  } catch {
    // Not kept: the list shows next time.
  }
}

/**
 * The web app on the website: the person's servers from their Leaf Bot account, and once one is
 * picked, the same app a server serves itself, reaching that server only through the tunnel.
 */
export function BotsApp() {
  const t = useT();
  const [view, setView] = useState<View>({ at: 'checking' });
  const qc = useQueryClient();

  /** Leaves the server: nothing it answered stays for the next one. */
  const leave = useCallback(() => {
    setTunnel(null);
    dropServerFiles();
    qc.clear();
    useUi.setState({ authed: null });
  }, [qc]);

  const open = useCallback(
    (servers: ServerEntry[], server: ServerEntry) => {
      const n = ++attempt.current;
      const current = () => attempt.current === n;
      remember(server.id);
      setView({ at: 'connecting', servers, server });
      const fail = (err: unknown, opened: boolean) => {
        if (!current()) return;
        if (opened) leave();
        const p = problemOf(err, opened);
        if (p === 'signIn') location.assign(signInUrl());
        else if (p === 'accountDown') setView({ at: 'accountDown' });
        else setView({ at: 'problem', servers, server, problem: p });
      };
      // An open server's tunnel that drops for a passing reason (a restart, the network) is opened again
      // underneath the app, which stays as it was: its requests and Socket.IO wait out the gap as they do
      // for a server reached directly, and the next connection names the new tunnel.
      // A tunnel that ends while it is still opening is answered by its own rejection; one loop at a time
      // opens the next.
      let opened = false;
      let reconnecting = false;
      const ended = (code: TunnelEndCode) => {
        if (!current() || !opened || reconnecting) return;
        const err = new TunnelError(code);
        if (!passing(err)) return fail(err, true);
        reconnecting = true;
        void reconnect({
          open: () =>
            openServer(server, ended).then((tunnel) => {
              if (!current()) return tunnel.close();
              setTunnel(tunnel);
              setView({ at: 'open', servers, server, tunnel });
            }),
          current,
          fail: (e) => fail(e, true),
        }).finally(() => {
          reconnecting = false;
        });
      };
      openServer(server, ended).then(
        (tunnel) => {
          if (!current()) return tunnel.close();
          leave();
          opened = true;
          setTunnel(tunnel);
          setView({ at: 'open', servers, server, tunnel });
        },
        (err: unknown) => fail(err, false),
      );
    },
    [leave],
  );

  const start = useCallback(
    (s: Start) => {
      if (s.at === 'signIn') location.assign(signInUrl());
      else if (s.at !== 'servers') setView({ at: s.at });
      else if (s.pick) open(s.servers, s.pick);
      else setView({ at: 'servers', servers: s.servers });
    },
    [open],
  );

  const load = useCallback(() => discover().then(start), [start]);

  useEffect(() => {
    void discover().then(start);
    return () => {
      attempt.current++;
    };
  }, [start]);

  const isOpen = view.at === 'open';
  useEffect(() => {
    if (!isOpen) return;
    setMissingFeatureHandler(() => toast(t('bots.notOffered')));
    const stop = catchServerLinks(() => toast.error(t('bots.saveFailed')));
    return () => {
      stop();
      setMissingFeatureHandler(null);
    };
  }, [isOpen, t]);

  // The sidebar lists the account's servers while one is open and moves to another in place: the open
  // one's tunnel closes once the next attempt has started, so its end is not taken for a drop.
  const openNow = view.at === 'open' ? view : null;
  useEffect(() => {
    if (!openNow) return;
    const { servers, server, tunnel } = openNow;
    useServerHost.setState({
      host: {
        servers: servers.map((s) => ({ id: s.id, name: s.name, role: s.role, current: s.id === server.id })),
        choose: (id) => {
          const next = servers.find((s) => s.id === id);
          if (!next || next.id === server.id) return;
          leave();
          open(servers, next);
          tunnel.close();
        },
        add: () => location.assign('/setup'),
      },
    });
    return () => useServerHost.setState({ host: null });
  }, [openNow, open, leave]);

  const choose = (servers: ServerEntry[]) => {
    attempt.current++;
    leave();
    try {
      localStorage.removeItem(LAST);
    } catch {
      // Nothing kept.
    }
    setView({ at: 'servers', servers });
  };

  if (view.at === 'open')
    return <App key={view.server.id} signedOut={<NoAccess onChoose={() => choose(view.servers)} />} />;

  return (
    <div className="flex min-h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <AppMascot className="size-14" />
          {view.at === 'servers' && <h1 className="text-xl font-semibold">{t('bots.title')}</h1>}
        </div>
        {view.at === 'checking' && <Waiting text={t('bots.checking')} />}
        {view.at === 'connecting' && <Waiting text={t('bots.connecting', { name: view.server.name })} />}
        {view.at === 'accountDown' && (
          <Notice text={t('bots.accountDown')}>
            <Button
              onClick={() => {
                setView({ at: 'checking' });
                void load();
              }}
            >
              {t('bots.retry')}
            </Button>
          </Notice>
        )}
        {view.at === 'unsupported' && <Notice text={t('bots.unsupported')} />}
        {view.at === 'problem' && (
          <Notice text={t(`bots.error.${view.problem}`, { name: view.server.name })}>
            <Button onClick={() => open(view.servers, view.server)}>{t('bots.retry')}</Button>
            {view.servers.length > 1 && (
              <Button variant="secondary" onClick={() => choose(view.servers)}>
                {t('bots.otherServer')}
              </Button>
            )}
          </Notice>
        )}
        {view.at === 'servers' && <ServerList servers={view.servers} onOpen={(s) => open(view.servers, s)} />}
      </div>
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center text-sm text-muted-foreground" role="status">
      <Loader2 className="size-5 animate-spin" />
      {text}
    </div>
  );
}

function Notice({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-4 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {children && <div className="flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function ServerList({ servers, onOpen }: { servers: ServerEntry[]; onOpen: (s: ServerEntry) => void }) {
  const t = useT();
  if (servers.length === 0) {
    return (
      <Notice text={t('bots.none')}>
        <Button asChild>
          <a href="/setup">{t('bots.addServer')}</a>
        </Button>
      </Notice>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-center text-sm text-muted-foreground">{t('bots.pick')}</p>
      <ul className="divide-y overflow-hidden rounded-lg border">
        {servers.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className="flex w-full items-center gap-3 px-4 py-3 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              onClick={() => onOpen(s)}
            >
              <Server className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{s.name}</span>
                <span className="block text-xs text-muted-foreground">{t(ROLE[s.role])}</span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The server answered, but has no person for this account: they were removed there. */
function NoAccess({ onChoose }: { onChoose: () => void }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex justify-center">
          <AppMascot className="size-14" />
        </div>
        <Notice text={t('bots.noAccess')}>
          <Button variant="secondary" onClick={onChoose}>
            {t('bots.otherServer')}
          </Button>
        </Notice>
      </div>
    </div>
  );
}
