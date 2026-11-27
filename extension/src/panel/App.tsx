import type { Tunnel, TunnelEndCode } from '@leafbot/client/tunnel';
import { TunnelError } from '@leafbot/client/tunnel';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { account, AccountError, appUrl, loadToken, type ServerEntry } from '../account';
import { t } from '../i18n';
import { openServer } from '../tunnel';
import { Home } from './Home';
import { loadStored, saveServer, type Stored } from './stored';

type State =
  | { at: 'loading' }
  | { at: 'signIn' }
  | { at: 'servers'; servers: ServerEntry[] | null; error: string | null }
  | { at: 'opening'; server: ServerEntry }
  | { at: 'open'; server: ServerEntry; tunnel: Tunnel }
  | { at: 'failed'; server: ServerEntry; message: string };

/** What a tunnel that did not open, or ended, means to the person. */
function tunnelText(err: unknown): string {
  const code: TunnelEndCode | null = err instanceof TunnelError ? err.code : null;
  if (code === 'closed') return t('connect.lost');
  if (code === 'outdated') return t('connect.outdated');
  if (err instanceof AccountError && err.status === 0) return t('connect.accountUnreachable');
  return t('connect.failed', { code: code ?? (err instanceof Error ? err.message : String(err)) });
}

export function App() {
  const [state, setState] = useState<State>({ at: 'loading' });
  const [stored, setStored] = useState<Stored | null>(null);

  // Each opening is numbered, so one that finishes after the person moved on is dropped.
  const attempt = useRef(0);

  const open = useCallback((server: ServerEntry) => {
    const mine = ++attempt.current;
    let ended: TunnelEndCode | null = null;
    const failed = (message: string): State => ({ at: 'failed', server, message });
    setState({ at: 'opening', server });
    void saveServer(server.id);
    openServer(server, (code) => {
      // An end before the tunnel was handed over is read when it is.
      ended = code;
      if (attempt.current !== mine) return;
      setState((s) =>
        s.at === 'open' && s.server.id === server.id ? failed(tunnelText(new TunnelError(code))) : s,
      );
    }).then(
      (tunnel) => {
        if (attempt.current !== mine) return tunnel.close();
        if (ended) {
          tunnel.close();
          return setState(failed(tunnelText(new TunnelError(ended))));
        }
        setState({ at: 'open', server, tunnel });
      },
      (err: unknown) => {
        if (attempt.current !== mine) return;
        if (err instanceof AccountError && err.status === 401) return setState({ at: 'signIn' });
        setState(failed(tunnelText(err)));
      },
    );
  }, []);

  // The servers of the account; the one opened last, or the only one, opens at once.
  const list = useCallback(
    (auto: boolean) => {
      attempt.current++;
      setState({ at: 'servers', servers: null, error: null });
      void Promise.all([account.servers(), loadStored()]).then(
        ([servers, kept]) => {
          setStored(kept);
          const pick =
            servers.find((s) => s.id === kept.server) ?? (servers.length === 1 ? servers[0] : null);
          if (auto && pick) return open(pick);
          setState({ at: 'servers', servers, error: null });
        },
        (err: unknown) => {
          if (err instanceof AccountError && err.status === 401) return setState({ at: 'signIn' });
          setState({ at: 'servers', servers: [], error: t('connect.accountUnreachable') });
        },
      );
    },
    [open],
  );

  useEffect(() => {
    void loadToken().then((token) => (token ? list(true) : setState({ at: 'signIn' })));
  }, [list]);

  // The tunnel ends with the panel.
  const tunnel = state.at === 'open' ? state.tunnel : null;
  useEffect(() => () => tunnel?.close(), [tunnel]);

  const signOut = () => {
    attempt.current++;
    void saveServer(null)
      .then(() => account.signOut())
      .then(() => setState({ at: 'signIn' }));
  };

  switch (state.at) {
    case 'loading':
      return null;
    case 'signIn':
      return <SignIn onSignedIn={() => list(true)} />;
    case 'servers':
      return (
        <div className="connect">
          <h1>{t('servers.title')}</h1>
          {state.servers === null && <p>{t('connect.going')}</p>}
          {state.servers?.length === 0 && !state.error && <p>{t('servers.empty')}</p>}
          {state.servers?.map((s) => (
            <button key={s.id} type="button" className="primary" onClick={() => open(s)}>
              {s.name}
            </button>
          ))}
          {state.error && <p className="error">{state.error}</p>}
          <button type="button" className="link quiet" onClick={signOut}>
            {t('connect.signOut')}
          </button>
        </div>
      );
    case 'opening':
      return (
        <div className="connect">
          <h1>{state.server.name}</h1>
          <p>{t('connect.going')}</p>
        </div>
      );
    case 'failed':
      return (
        <div className="connect">
          <h1>{state.server.name}</h1>
          <p className="error">{state.message}</p>
          <button type="button" className="primary" onClick={() => open(state.server)}>
            {t('connect.retry')}
          </button>
          <button type="button" className="link quiet" onClick={() => list(false)}>
            {t('connect.otherServer')}
          </button>
        </div>
      );
    case 'open':
      return (
        <Home
          key={state.server.id}
          tunnel={state.tunnel}
          appUrl={appUrl(state.server.id)}
          sharing={stored?.sharing ?? false}
          onDisconnect={() => {
            state.tunnel.close();
            list(false);
          }}
        />
      );
  }
}

/** Signs this Chrome in to the person's Leaf Bot account with a code from a device signed in. */
function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    account
      .redeem(code)
      .then(onSignedIn, (err: unknown) => {
        const status = err instanceof AccountError ? err.status : 0;
        setError(
          status === 0
            ? t('connect.accountUnreachable')
            : status === 429
              ? t('connect.tooMany')
              : t('connect.badCode'),
        );
      })
      .finally(() => setBusy(false));
  };

  return (
    <form className="connect" onSubmit={submit}>
      <h1>{t('connect.title')}</h1>
      <label>
        <span>{t('connect.code')}</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        <small>{t('connect.codeHint')}</small>
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>
        {busy ? t('connect.going') : t('connect.go')}
      </button>
    </form>
  );
}
