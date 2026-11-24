import type { VaultLogin } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp, KeyRound, Pencil, Plus, QrCode, Search, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots, useManagesServer, useSession, useVault } from '@/lib/queries';
import { canReadQr, readQr } from '@/lib/qr';
import { ApiKeys } from './ApiKeys';
import { ApiSources } from './ApiSources';
import { ContentSeal } from './ContentSeal';
import { PasswordManagers } from './PasswordManagers';
import { ContactDetails } from './ContactDetails';
import { PaymentCards } from './PaymentCards';
import { SharedPages } from './SharedPages';
import { VaultCsvImport } from './VaultImport';

/** The password vault: saved sign-ins, listed without their passwords. */
export function VaultTab() {
  const t = useT();
  const { data: logins = [], isLoading } = useVault();
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<VaultLogin | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const manages = useManagesServer();
  const isOwner = useSession().data?.user?.role === 'owner';
  const q = query.trim().toLowerCase();
  const shown = q ? logins.filter((l) => l.site.includes(q) || l.username.toLowerCase().includes(q)) : logins;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('vault.search')}
            className="h-10 rounded-full ps-9"
          />
        </div>
        <Button
          variant="secondary"
          className="rounded-full"
          onClick={() => setImporting(true)}
          aria-label={t('vaultImport.open')}
          title={t('vaultImport.open')}
        >
          <FileUp />
        </Button>
        <Button className="rounded-full" onClick={() => setEditing('new')}>
          <Plus /> {t('common.add')}
        </Button>
      </div>

      {importing && <VaultCsvImport onDone={() => setImporting(false)} />}
      {editing === 'new' && <LoginForm onDone={() => setEditing(null)} />}

      <div className="divide-y rounded-2xl border bg-card/50">
        {!isLoading && shown.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
            <KeyRound className="size-6" />
            {q ? t('vault.noMatch') : t('vault.empty')}
          </div>
        )}
        {shown.map((l) =>
          editing !== 'new' && editing?.id === l.id ? (
            <div key={l.id} className="p-3">
              <LoginForm login={l} onDone={() => setEditing(null)} />
            </div>
          ) : (
            <LoginRow key={l.id} login={l} onEdit={() => setEditing(l)} />
          ),
        )}
      </div>
      <p className="px-1 text-xs text-muted-foreground">{t('vault.note')}</p>
      <PasswordManagers />
      <PaymentCards />
      <ContactDetails />
      <ApiKeys />
      {manages && <ApiSources />}
      <SharedPages />
      {isOwner && <ContentSeal />}
    </div>
  );
}

function LoginRow({ login, onEdit }: { login: VaultLogin; onEdit(): void }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const manages = useManagesServer();
  // The team's are changed only by those who look after the server.
  const mayChange = manages || !!login.userId;
  const remove = useMutation({
    mutationFn: () => api.removeVaultLogin(login.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vault'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-sm font-semibold text-muted-foreground uppercase">
        {login.site[0]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{login.site}</div>
        <div className="truncate text-xs text-muted-foreground">
          {login.username || t('vault.noUsername')}
          {` · ${login.userId === null ? t('owned.team') : t('owned.yours')}`}
          {login.hasTotp ? ` · ${t('vault.hasTotp')}` : ''}
          {login.botIds ? ` · ${t('vault.someBots', { count: login.botIds.length })}` : ''}
          {login.lastUsedAt ? ` · ${t('vault.lastUsed', { when: dayLabel(login.lastUsedAt) })}` : ''}
        </div>
      </div>
      {mayChange && (
        <>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onClick={onEdit}
            aria-label={t('vault.edit')}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(t('vault.confirmDelete', { site: login.site }))) remove.mutate();
            }}
            aria-label={t('common.delete')}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </div>
  );
}

/** Adds a sign-in, or edits one; the password is only sent when typed. */
function LoginForm({ login, onDone }: { login?: VaultLogin; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [site, setSite] = useState(login?.site ?? '');
  const [username, setUsername] = useState(login?.username ?? '');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [clearTotp, setClearTotp] = useState(false);
  // Null: every bot may use it.
  const [botIds, setBotIds] = useState<string[] | null>(login?.botIds ?? null);
  const manages = useManagesServer();
  const [team, setTeam] = useState(login ? login.userId === null : false);
  /** Takes the authenticator setup from a picture of the site's QR code. */
  const fromPicture = async (picture: Blob) => {
    const text = await readQr(picture);
    if (text && /^otpauth:\/\//i.test(text)) {
      setTotp(text);
      setClearTotp(false);
      toast.success(t('vault.totpQrRead'));
    } else toast.error(t('vault.totpQrNone'));
  };
  const save = useMutation({
    mutationFn: () =>
      login
        ? api.updateVaultLogin(login.id, {
            site,
            username,
            botIds,
            ...(manages && team !== (login.userId === null) && { team }),
            ...(password && { password }),
            ...(totp.trim() ? { totp: totp.trim() } : clearTotp ? { totp: '' } : {}),
          })
        : api.addVaultLogin({
            site,
            username,
            password,
            botIds,
            ...(totp.trim() && { totp: totp.trim() }),
            ...(team && { team }),
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vault'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <Input
        value={site}
        onChange={(e) => setSite(e.target.value)}
        placeholder={t('vault.site')}
        aria-label={t('vault.site')}
        required
      />
      <Input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={t('vault.username')}
        aria-label={t('vault.username')}
        autoComplete="off"
      />
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={login ? t('vault.newPassword') : t('vault.password')}
        aria-label={t('vault.password')}
        autoComplete="new-password"
        required={!login}
      />
      <div className="flex gap-2">
        <Input
          type="password"
          value={totp}
          onChange={(e) => setTotp(e.target.value)}
          onPaste={(e) => {
            // A screenshot of the site's QR code, pasted, is read here like a chosen picture.
            const picture = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
            if (!picture) return;
            e.preventDefault();
            void fromPicture(picture);
          }}
          placeholder={login?.hasTotp && !clearTotp ? t('vault.totpKept') : t('vault.totp')}
          aria-label={t('vault.totp')}
          autoComplete="off"
        />
        {canReadQr() && (
          <label
            className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border text-muted-foreground hover:bg-accent"
            title={t('vault.totpQr')}
          >
            <QrCode className="size-4" />
            <span className="sr-only">{t('vault.totpQr')}</span>
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const picture = e.target.files?.[0];
                e.target.value = '';
                if (picture) void fromPicture(picture);
              }}
            />
          </label>
        )}
      </div>
      {login?.hasTotp && (
        <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={clearTotp} onChange={(e) => setClearTotp(e.target.checked)} />
          {t('vault.totpRemove')}
        </label>
      )}
      <BotAccess botIds={botIds} onChange={setBotIds} />
      {manages && <TeamChoice team={team} onChange={setTeam} />}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending || !site.trim()}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Which bots may use a saved secret: every bot, or the ones ticked. */
export function BotAccess({
  botIds,
  onChange,
}: {
  botIds: string[] | null;
  onChange(ids: string[] | null): void;
}) {
  const t = useT();
  const { data: bots = [] } = useBots();
  return (
    <div className="space-y-1 rounded-xl border px-3 py-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={botIds === null}
          onChange={(e) => onChange(e.target.checked ? null : [])}
        />
        {t('vault.allBots')}
      </label>
      {botIds !== null && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
          {bots.map((b) => (
            <label key={b.id} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={botIds.includes(b.id)}
                onChange={(e) =>
                  onChange(e.target.checked ? [...botIds, b.id] : botIds.filter((id) => id !== b.id))
                }
              />
              {b.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Whether a saved sign-in or a connection is the whole team's, for those who look after the
 * server; anyone else's are their own, used only when a bot works for them.
 */
export function TeamChoice({ team, onChange }: { team: boolean; onChange(team: boolean): void }) {
  const t = useT();
  return (
    <label className="flex items-start gap-2 rounded-xl border px-3 py-2 text-sm">
      <input type="checkbox" className="mt-1" checked={team} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {t('owned.forTeam')}
        <span className="block text-xs text-muted-foreground">{t('owned.forTeamHint')}</span>
      </span>
    </label>
  );
}
