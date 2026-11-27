import type { ApiAuth, ApiCredential } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, KeySquare, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useManagesServer } from '@/lib/queries';
import { EnvImport } from './VaultImport';
import { BotAccess, TeamChoice } from './VaultTab';

type AuthType = ApiAuth['type'];

/**
 * API keys bots call services with. Listed without their values: a key only ever goes from the
 * server to its own address, added to a request the bot names it in. Each is the person's own or
 * the team's; the team's are changed only by those who look after the server.
 */
export function ApiKeys() {
  const t = useT();
  const { data: keys = [] } = useQuery({ queryKey: ['api-keys'], queryFn: api.apiKeys });
  const [editing, setEditing] = useState<ApiCredential | 'new' | 'trap' | null>(null);
  const [importing, setImporting] = useState(false);
  return (
    <section className="space-y-2">
      <div className="flex items-start gap-2 px-1">
        <div className="flex-1 space-y-1">
          <h3 className="text-sm font-medium">{t('apiKeys.title')}</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">{t('apiKeys.note')}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          onClick={() => setImporting(true)}
          aria-label={t('envImport.open')}
          title={t('envImport.open')}
        >
          <FileUp />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          onClick={() => setEditing('trap')}
          aria-label={t('apiKeys.trapAdd')}
          title={t('apiKeys.trapAdd')}
        >
          <ShieldAlert />
        </Button>
        <Button size="sm" variant="secondary" className="rounded-full" onClick={() => setEditing('new')}>
          <Plus /> {t('common.add')}
        </Button>
      </div>
      {importing && <EnvImport onDone={() => setImporting(false)} />}
      {editing === 'new' && <KeyForm onDone={() => setEditing(null)} />}
      {editing === 'trap' && <TrapForm onDone={() => setEditing(null)} />}
      <div className="divide-y rounded-2xl border bg-card/50">
        {!keys.length && <div className="px-4 py-3 text-sm text-muted-foreground">{t('apiKeys.empty')}</div>}
        {keys.map((k) =>
          typeof editing === 'object' && editing?.id === k.id ? (
            <div key={k.id} className="p-3">
              <KeyForm current={k} onDone={() => setEditing(null)} />
            </div>
          ) : (
            <KeyRow key={k.id} k={k} onEdit={() => setEditing(k)} />
          ),
        )}
      </div>
    </section>
  );
}

function KeyRow({ k, onEdit }: { k: ApiCredential; onEdit(): void }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const manages = useManagesServer();
  const mayChange = manages || !!k.userId;
  // A trap key is only added or removed: what it is made as is what makes it a trap.
  const mayEdit = mayChange && !k.trap;
  const remove = useMutation({
    mutationFn: () => api.removeApiKey(k.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['api-keys'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <KeySquare className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {k.name}
          {k.trap && <span className="font-normal text-destructive"> · {t('apiKeys.trapBadge')}</span>}
          {k.label && <span className="font-normal text-muted-foreground"> · {k.label}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {k.origin}
          {k.userId !== undefined && ` · ${k.userId === null ? t('owned.team') : t('owned.yours')}`}
          {k.botIds ? ` · ${t('vault.someBots', { count: k.botIds.length })}` : ''}
          {k.lastUsedAt ? ` · ${t('vault.lastUsed', { when: dayLabel(k.lastUsedAt) })}` : ''}
        </div>
      </div>
      {mayChange && (
        <>
          {mayEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              onClick={onEdit}
              aria-label={t('vault.edit')}
            >
              <Pencil />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(t('apiKeys.confirmDelete', { name: k.name }))) remove.mutate();
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

/** Adds a key, or edits one; the value is only sent when typed. */
function KeyForm({ current, onDone }: { current?: ApiCredential; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(current?.name ?? '');
  const [origin, setOrigin] = useState(current?.origin ?? '');
  const [label, setLabel] = useState(current?.label ?? '');
  const [value, setValue] = useState('');
  const [type, setType] = useState<AuthType>(current?.auth.type ?? 'bearer');
  const a = current?.auth;
  const [extra, setExtra] = useState(
    a?.type === 'header' ? a.header : a?.type === 'query' ? a.param : a?.type === 'basic' ? a.username : '',
  );
  const [botIds, setBotIds] = useState<string[] | null>(current?.botIds ?? null);
  const manages = useManagesServer();
  // Those who look after the server add the team's keys unless they say otherwise.
  const wasTeam = current ? current.userId == null : manages;
  const [team, setTeam] = useState(wasTeam);
  const auth = (): ApiAuth =>
    type === 'header'
      ? { type, header: extra.trim() }
      : type === 'query'
        ? { type, param: extra.trim() }
        : type === 'basic'
          ? { type, username: extra }
          : { type };
  const save = useMutation({
    mutationFn: () =>
      current
        ? api.updateApiKey(current.id, {
            origin,
            label,
            auth: auth(),
            botIds,
            ...(value && { value }),
            ...(manages && team !== wasTeam && { team }),
          })
        : api.addApiKey({ name, origin, label, auth: auth(), value, botIds, team: manages && team }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const extraLabel =
    type === 'header' ? t('apiKeys.header') : type === 'query' ? t('apiKeys.param') : t('apiKeys.username');
  return (
    <form onSubmit={submit} className="space-y-2 rounded-2xl border bg-background p-3">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('apiKeys.name')}
          aria-label={t('apiKeys.name')}
          disabled={!!current}
          required
          className="w-40"
        />
        <Input
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder={t('apiKeys.origin')}
          aria-label={t('apiKeys.origin')}
          required
        />
      </div>
      <Input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('apiKeys.label')}
        aria-label={t('apiKeys.label')}
      />
      <div className="flex gap-2">
        <Select value={type} onValueChange={(v) => setType(v as AuthType)}>
          <SelectTrigger className="w-48" aria-label={t('apiKeys.how')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bearer">{t('apiKeys.how.bearer')}</SelectItem>
            <SelectItem value="header">{t('apiKeys.how.header')}</SelectItem>
            <SelectItem value="query">{t('apiKeys.how.query')}</SelectItem>
            <SelectItem value="basic">{t('apiKeys.how.basic')}</SelectItem>
          </SelectContent>
        </Select>
        {type !== 'bearer' && (
          <Input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder={extraLabel}
            aria-label={extraLabel}
            required={type !== 'basic'}
          />
        )}
      </div>
      <Input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={current ? t('apiKeys.newValue') : t('apiKeys.value')}
        aria-label={t('apiKeys.value')}
        autoComplete="new-password"
        required={!current}
      />
      <BotAccess botIds={botIds} onChange={setBotIds} />
      {manages && <TeamChoice team={team} onChange={setTeam} />}
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

/** Adds a trap key: a name and the bots that see it; the server makes up the rest. */
function TrapForm({ onDone }: { onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [botIds, setBotIds] = useState<string[] | null>(null);
  const save = useMutation({
    mutationFn: () => api.addTrapKey({ name, botIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
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
      <p className="text-xs text-muted-foreground">{t('apiKeys.trapHint')}</p>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('apiKeys.trapName')}
        aria-label={t('apiKeys.trapName')}
        required
      />
      <BotAccess botIds={botIds} onChange={setBotIds} />
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
