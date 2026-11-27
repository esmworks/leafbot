import { useEffect, useState, type FormEvent } from 'react';
import { apiFor, ApiError, errorText } from '../api';
import { t } from '../i18n';
import { sitePattern } from '../share';
import { Home } from './Home';
import { loadStored, saveServer, type Stored } from './stored';

export function App() {
  const [stored, setStored] = useState<Stored | null>(null);
  useEffect(() => {
    void loadStored().then(setStored);
  }, []);
  if (!stored) return null;
  if (!stored.server) return <Connect onConnected={(server) => setStored({ ...stored, server })} />;
  return (
    <Home
      origin={stored.server}
      sharing={stored.sharing}
      onDisconnect={() => {
        void saveServer(null);
        setStored({ ...stored, server: null });
      }}
    />
  );
}

/** The server's origin from what the person typed; null when it is not a web address. */
function originFrom(address: string): string | null {
  const text = address.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Connects the panel to the person's server: Chrome's permission to reach that address, then the
 * pairing code if this Chrome is not signed in there already.
 */
function Connect({ onConnected }: { onConnected: (origin: string) => void }) {
  const [address, setAddress] = useState('http://localhost:4319');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const origin = originFrom(address);
    if (!origin) return setError(t('connect.badAddress'));
    setBusy(true);
    setError(null);
    // Asked first, while the click still counts: Chrome refuses the prompt after an await.
    void chrome.permissions
      .request({ origins: [sitePattern(origin)] })
      .then(async (granted) => {
        if (!granted) return setError(t('connect.noPermission'));
        const api = apiFor(origin);
        if (code.trim()) await api.pair(code.trim());
        const session = await api.session();
        if (!session.authenticated) return setError(t('connect.needCode'));
        await saveServer(origin);
        onConnected(origin);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError ? err.message : t('connect.unreachable', { message: errorText(err) }),
        ),
      )
      .finally(() => setBusy(false));
  };

  return (
    <form className="connect" onSubmit={submit}>
      <h1>{t('connect.title')}</h1>
      <label>
        <span>{t('connect.address')}</span>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          inputMode="url"
          autoComplete="url"
        />
        <small>{t('connect.addressHint')}</small>
      </label>
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
