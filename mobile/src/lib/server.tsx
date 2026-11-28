import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';
import { AccountError, accountClient, pickServer, type AccountUser, type ServerEntry } from './account';
import { apiFor, type Api } from './api';
import { getLink, setLink } from './connection';
import { KEPT_KEY, keepQueries, restoreKept, type Who } from './keptQueries';
import { launchMark } from './launchMarks';
import { clearServerFiles } from './serverFiles';
import { Link, type LinkState } from './tunnelLink';
import { forgetDeviceKey, openServer } from './tunnelOpen';

const SESSION_KEY = 'leafbot.account';
const SERVER_KEY = 'leafbot.server';
/** The account's servers as last listed, so the tunnel opens without waiting for the list. */
const SERVERS_KEY = 'leafbot.servers';
const APP_VERSION = Constants.expoConfig?.version ?? '';
const KEYCHAIN: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Where the phone stands between the person and their server: reading what it kept, signed out, the
 * account service out of reach, no server in the account yet, several to choose from, then the
 * tunnel to the chosen one connecting, open, waiting to try again (`reason` says why), or refused.
 */
export type Phase =
  | 'loading'
  | 'signedOut'
  | 'accountDown'
  | 'noServers'
  | 'choose'
  | 'connecting'
  | 'online'
  | 'retrying'
  | 'refused';

interface Saved {
  token: string;
  user: AccountUser;
}

interface ServerState {
  /** False until what the phone kept (the sign-in and the chosen server) has been read. */
  ready: boolean;
  phase: Phase;
  /**
   * A name for the chosen server that is the same on every launch, for the keys of the queries and
   * of what is kept per server; null until one is chosen. It is not an address: the server is reached
   * only through the tunnel.
   */
  origin: string | null;
  user: AccountUser | null;
  servers: ServerEntry[];
  server: ServerEntry | null;
  /** Why the tunnel is waiting or refused: a tunnel or connection code, or `account`. */
  reason: string | null;
  /** What the WebRTC stack said when the last attempt failed, when it said something. */
  detail: string | null;
  /**
   * Signs the phone in with a connect code; `verifier` for one the phone asked for through the
   * website. Rejects with an `AccountError`.
   */
  redeem: (code: string, verifier?: string) => Promise<void>;
  choose: (serverId: string) => Promise<void>;
  /** Asks the account for the servers again, and the tunnel for another try. */
  refresh: () => void;
  signOut: () => Promise<void>;
}

const ServerContext = createContext<ServerState | null>(null);

const IDLE: LinkState = { at: 'idle' };
const never = () => () => undefined;

async function readServers(): Promise<ServerEntry[] | null> {
  try {
    const raw = await AsyncStorage.getItem(SERVERS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(list) ? (list as ServerEntry[]) : null;
  } catch {
    return null;
  }
}

/** Who the kept screens belong to: the person signed in, on the server the phone would open. */
function keptFor(saved: Saved | null, servers: ServerEntry[] | null, chosen: string | null): Who | null {
  const server = saved && servers ? pickServer(servers, chosen) : null;
  return saved && server ? { user: saved.user.id, origin: originOf(server), version: APP_VERSION } : null;
}

const originOf = (server: ServerEntry) => `leafbot:${server.id}`;

async function readSaved(): Promise<Saved | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY, KEYCHAIN);
    const saved = raw ? (JSON.parse(raw) as Partial<Saved>) : null;
    return saved?.token && saved.user ? (saved as Saved) : null;
  } catch {
    // An unreadable keychain only means signing in again.
    return null;
  }
}

/**
 * The phone's sign-in with the Leaf Bot account and its link to one of the person's servers. The
 * bearer token lives in the keychain; the chosen server is remembered, and picked on its own when
 * the account has only one. The link opens when a server is chosen and opens again, with growing
 * waits, whenever it ends.
 */
export function ServerProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [listDown, setListDown] = useState(false);
  const [link, setLinkState] = useState<Link | null>(null);
  const token = useRef<string | null>(null);
  token.current = saved?.token ?? null;
  const account = useMemo(
    () => accountClient({ fetch: (...a) => fetch(...a), token: () => token.current }),
    [],
  );

  useEffect(() => {
    let live = true;
    void Promise.all([readSaved(), AsyncStorage.getItem(SERVER_KEY).catch(() => null), readServers()]).then(
      async ([s, id, list]) => {
        // The servers as last listed open the tunnel at once; the account's list follows and wins.
        const known = s ? list : null;
        const who = keptFor(s, known, id);
        // What the screens showed last is in the cache before the first of them asks for it.
        if (who && (await restoreKept(qc, AsyncStorage, who).catch(() => false))) launchMark('kept screens');
        if (!live) return;
        setSaved(s);
        setChosen(id);
        if (known) setServers((cur) => cur ?? known);
        setReady(true);
      },
    );
    return () => {
      live = false;
    };
  }, [qc]);

  const forget = useCallback(async () => {
    setLink(null);
    setSaved(null);
    setServers(null);
    setListDown(false);
    setChosen(null);
    // Emptied first, so nothing of this sign-in is kept again while the copy is being removed.
    qc.clear();
    await Promise.all([
      SecureStore.deleteItemAsync(SESSION_KEY, KEYCHAIN).catch(() => undefined),
      AsyncStorage.multiRemove([SERVER_KEY, SERVERS_KEY, KEPT_KEY]).catch(() => undefined),
      forgetDeviceKey(),
    ]);
    clearServerFiles();
  }, [qc]);

  const loadServers = useCallback(async () => {
    setListDown(false);
    try {
      const list = await account.servers();
      setServers(list);
      void AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(list)).catch(() => undefined);
    } catch (err) {
      // The service no longer knows this sign-in (ended elsewhere): the phone is signed out.
      if (err instanceof AccountError && err.status === 401) void forget();
      else setListDown(true);
    }
  }, [account, forget]);

  const signedInAs = saved?.token ?? null;
  useEffect(() => {
    // Fetching the list from the service is the external work; the state is set when it answers.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (signedInAs) void loadServers();
  }, [signedInAs, loadServers]);

  // The same server object while its id and key stand, so a refreshed list does not open the link again.
  const found = servers ? pickServer(servers, chosen) : null;
  const stable = useRef<ServerEntry | null>(null);
  if (!found) stable.current = null;
  else if (stable.current?.id !== found.id || stable.current.publicKey !== found.publicKey)
    stable.current = found;
  const server = stable.current;

  useEffect(() => {
    if (!server) return;
    const l = new Link({ open: (onEnd) => openServer(server, account, onEnd) });
    setLink(l);
    setLinkState(l);
    l.start();
    return () => {
      l.stop();
      if (getLink() === l) setLink(null);
      setLinkState((cur) => (cur === l ? null : cur));
    };
  }, [server, account]);

  const linkState = useSyncExternalStore(link?.subscribe ?? never, () => link?.state ?? IDLE);

  // A ticket the service refused for want of a sign-in: the phone is signed out.
  const refusedSignedOut = linkState.at === 'refused' && linkState.reason === 'signed-out';
  useEffect(() => {
    // Forgetting the sign-in is the reaction to the service's refusal, which lives outside React.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (refusedSignedOut) void forget();
  }, [refusedSignedOut, forget]);

  // What failed to load while the link was down loads again once it is back, so a screen that
  // showed the failure mends itself instead of waiting for a tap.
  const online = linkState.at === 'online';
  if (online) launchMark('tunnel open');
  useEffect(() => {
    if (online) void qc.refetchQueries({ type: 'active', predicate: (q) => q.state.status === 'error' });
  }, [online, qc]);

  // Back in the front the connection is likely gone: try now instead of after the wait.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      getLink()?.poke();
      setListDown((down) => {
        if (down) void loadServers();
        return down;
      });
    });
    return () => sub.remove();
  }, [loadServers]);

  const phase: Phase = !ready
    ? 'loading'
    : !saved
      ? 'signedOut'
      : servers === null
        ? listDown
          ? 'accountDown'
          : 'loading'
        : servers.length === 0
          ? 'noServers'
          : !server
            ? 'choose'
            : linkState.at === 'online'
              ? 'online'
              : linkState.at === 'retrying'
                ? 'retrying'
                : linkState.at === 'refused'
                  ? 'refused'
                  : 'connecting';

  // Everything on screen read through an earlier tunnel is read again when the socket says hello
  // on the new one (realtime.tsx), which it does as soon as the tunnel is open.

  // What the screens show is kept for the next launch, for this person on this server.
  const userId = saved?.user.id ?? null;
  const keptOrigin = server ? originOf(server) : null;
  useEffect(() => {
    if (!userId || !keptOrigin) return;
    return keepQueries(qc, AsyncStorage, { user: userId, origin: keptOrigin, version: APP_VERSION });
  }, [userId, keptOrigin, qc]);

  const redeem = useCallback(
    async (code: string, verifier?: string) => {
      const res = await account.redeem(code, verifier);
      // A code for someone else (or the same person again) replaces the earlier sign-in.
      if (token.current) {
        try {
          await account.signOut();
        } catch {
          // The earlier session ends at the service on its own.
        }
      }
      const next: Saved = { token: res.token, user: res.user };
      await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next), KEYCHAIN).catch(() => undefined);
      setLink(null);
      setServers(null);
      setChosen(null);
      void AsyncStorage.multiRemove([SERVER_KEY, SERVERS_KEY, KEPT_KEY]).catch(() => undefined);
      clearServerFiles();
      qc.clear();
      token.current = next.token;
      setSaved(next);
    },
    [account, qc],
  );

  const choose = useCallback(async (serverId: string) => {
    setChosen(serverId);
    await AsyncStorage.setItem(SERVER_KEY, serverId).catch(() => undefined);
  }, []);

  const signOut = useCallback(async () => {
    link?.stop();
    try {
      await account.signOut();
    } catch {
      // Signed out here even if the service did not hear it; the session ends there on its own.
    }
    await forget();
  }, [account, forget, link]);

  const refresh = useCallback(() => {
    void loadServers();
    getLink()?.poke();
  }, [loadServers]);

  const value = useMemo<ServerState>(
    () => ({
      ready,
      phase,
      origin: server ? originOf(server) : null,
      user: saved?.user ?? null,
      servers: servers ?? [],
      server,
      reason: linkState.at === 'retrying' || linkState.at === 'refused' ? linkState.reason : null,
      detail: linkState.at === 'retrying' || linkState.at === 'refused' ? (linkState.detail ?? null) : null,
      redeem,
      choose,
      refresh,
      signOut,
    }),
    [ready, phase, server, saved, servers, linkState, redeem, choose, refresh, signOut],
  );
  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerState {
  const ctx = useContext(ServerContext);
  if (!ctx) throw new Error('useServer outside ServerProvider');
  return ctx;
}

/** The endpoints of the chosen server. */
export function useApi(): Api {
  const { origin } = useServer();
  // The origin is the key of the chosen server: a new one gets new endpoints. A screen can still be
  // up for a moment after there is none (signing out, or the server left the account while the
  // screens showed what was kept of it): its reads find no link and fail until it gives way.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => apiFor(), [origin]);
}
