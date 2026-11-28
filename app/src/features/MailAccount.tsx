import {
  MAIL_PORTS,
  guessMailServers,
  mailUrl,
  type Connection,
  type MailSecurity,
  type MailServer,
  type MailSettingsInput,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useManagesServer } from '@/lib/queries';
import { TeamChoice } from './VaultTab';

/**
 * A mail account reached over IMAP and SMTP, such as an address on one's own domain: the address,
 * its password and its two servers. Adds a new account, or with `connection` changes one; the
 * server signs in to both servers before it counts the account as connected.
 */

type Kind = 'imap' | 'smtp';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

function ServerFields({
  kind,
  server,
  onChange,
}: {
  kind: Kind;
  server: MailServer;
  onChange(next: MailServer): void;
}) {
  const t = useT();
  // Switching how it is reached moves a usual port along with it; a port of the person's own stays.
  const secure = (security: MailSecurity) => {
    const usual = Object.values(MAIL_PORTS[kind]) as number[];
    onChange({
      ...server,
      security,
      port: usual.includes(server.port) ? MAIL_PORTS[kind][security] : server.port,
    });
  };
  return (
    <fieldset className="space-y-3 rounded-2xl border p-4">
      <legend className="px-1 text-sm font-medium">
        {kind === 'imap' ? t('apps.mail.imap') : t('apps.mail.smtp')}
      </legend>
      <Field label={t('apps.mail.host')}>
        <Input
          value={server.host}
          onChange={(e) => onChange({ ...server, host: e.target.value })}
          placeholder={kind === 'imap' ? 'imap.example.com' : 'smtp.example.com'}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <Field label={t('apps.mail.security')}>
          <Select value={server.security} onValueChange={(v) => secure(v as MailSecurity)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tls">{t('apps.mail.security.tls')}</SelectItem>
              <SelectItem value="starttls">{t('apps.mail.security.starttls')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('apps.mail.port')}>
          <Input
            type="number"
            min={1}
            max={65535}
            value={server.port || ''}
            onChange={(e) => onChange({ ...server, port: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>
    </fieldset>
  );
}

const EMPTY_SERVER = (kind: Kind): MailServer => ({ host: '', port: MAIL_PORTS[kind].tls, security: 'tls' });

export function MailForm({
  connection,
  onCancel,
  onSaved,
}: {
  connection?: Connection;
  onCancel?(): void;
  onSaved(c: Connection): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const was = connection?.mail;
  const [address, setAddress] = useState(was?.address ?? '');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState(was?.displayName ?? '');
  const [username, setUsername] = useState(was?.username ?? '');
  const [imap, setImap] = useState<MailServer>(was?.imap ?? EMPTY_SERVER('imap'));
  const [smtp, setSmtp] = useState<MailServer>(was?.smtp ?? EMPTY_SERVER('smtp'));
  const [saveSent, setSaveSent] = useState(was?.saveSent ?? true);
  const [signature, setSignature] = useState(was?.signature ?? '');
  const [team, setTeam] = useState(false);
  // The servers follow the address until the person types their own.
  const [ownServers, setOwnServers] = useState(!!was);
  const [advanced, setAdvanced] = useState(!!was?.username);

  const typeAddress = (value: string) => {
    setAddress(value);
    const guess = !ownServers && guessMailServers(value);
    if (guess) {
      setImap(guess.imap);
      setSmtp(guess.smtp);
    }
  };
  const server = (set: (s: MailServer) => void) => (next: MailServer) => {
    setOwnServers(true);
    set(next);
  };

  const settings = (): MailSettingsInput => ({
    address: address.trim(),
    displayName: displayName.trim(),
    username: username.trim(),
    imap: { ...imap, host: imap.host.trim() },
    smtp: { ...smtp, host: smtp.host.trim() },
    saveSent,
    signature,
  });
  const save = useMutation({
    mutationFn: async () => {
      const mail = settings();
      if (connection) {
        // A name that was the old address follows the new one; a name of the person's own stays.
        const rename = !!was && connection.name === was.address && mail.address !== was.address;
        return api.updateConnection(connection.id, {
          mail,
          ...(password ? { password } : {}),
          ...(rename ? { name: mail.address } : {}),
        });
      }
      return api.addConnection({
        name: mail.address,
        url: mailUrl(mail),
        auth: 'token',
        password,
        mail,
        ...(team ? { team } : {}),
      });
    },
    onSuccess: (c) => {
      setPassword('');
      void qc.invalidateQueries({ queryKey: ['connections'] });
      onSaved(c);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const ready =
    address.trim().includes('@') &&
    // Settings that could not be read are entered again whole, the password with them.
    (!!was || password) &&
    imap.host.trim() &&
    smtp.host.trim() &&
    imap.port > 0 &&
    smtp.port > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label={t('apps.mail.address')}>
        <Input
          type="email"
          value={address}
          onChange={(e) => typeAddress(e.target.value)}
          placeholder={t('apps.mail.addressPlaceholder')}
          autoComplete="off"
          autoFocus={!connection}
        />
      </Field>
      <Field
        label={was ? t('apps.mail.newPassword') : t('apps.mail.password')}
        hint={t('apps.mail.passwordHint')}
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder={was ? '••••••••' : ''}
        />
      </Field>
      <Field label={t('apps.mail.displayName')} hint={t('apps.mail.displayNameHint')}>
        <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={100} />
      </Field>
      <p className="text-sm text-muted-foreground">{t('apps.mail.serversHint')}</p>
      <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2">
        <ServerFields kind="imap" server={imap} onChange={server(setImap)} />
        <ServerFields kind="smtp" server={smtp} onChange={server(setSmtp)} />
      </div>
      {advanced ? (
        <Field label={t('apps.mail.username')} hint={t('apps.mail.usernameHint')}>
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={address.trim()}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      ) : (
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => setAdvanced(true)}
        >
          {t('apps.mail.usernameShow')}
        </button>
      )}
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium">{t('apps.mail.saveSent')}</div>
          <div className="text-xs text-muted-foreground">{t('apps.mail.saveSentHint')}</div>
        </div>
        <Switch checked={saveSent} onCheckedChange={setSaveSent} aria-label={t('apps.mail.saveSent')} />
      </div>
      <Field label={t('apps.mail.signature')} hint={t('apps.mail.signatureHint')}>
        <Textarea
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          rows={3}
          maxLength={10_000}
        />
      </Field>
      {!connection && manages && <TeamChoice team={team} onChange={setTeam} />}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" className="rounded-full" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        )}
        <Button type="submit" className="rounded-full" disabled={!ready || save.isPending}>
          {save.isPending ? <Loader2 className="animate-spin" /> : <Plug />}
          {connection ? t('common.save') : t('apps.connect')}
        </Button>
      </div>
      {save.isPending && <p className="text-end text-xs text-muted-foreground">{t('apps.mail.checking')}</p>}
    </form>
  );
}

/**
 * A mail account's settings on its page, folded until opened. Settings that could not be read
 * (sealed with a key this server no longer has) show open, to be entered again.
 */
export function MailSettingsPanel({ connection }: { connection: Connection }) {
  const t = useT();
  const mail = connection.mail;
  const [open, setOpen] = useState(!mail);
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t('apps.mail.settings')}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {mail ? `${mail.imap.host} · ${mail.smtp.host}` : t('apps.mail.missing')}
          </p>
        </div>
        {!open && (
          <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setOpen(true)}>
            {t('apps.mail.edit')}
          </Button>
        )}
      </div>
      {open && (
        <MailForm
          connection={connection}
          onCancel={mail ? () => setOpen(false) : undefined}
          onSaved={() => setOpen(false)}
        />
      )}
    </section>
  );
}
