import {
  INTL_LOCALE,
  leavesForEngine,
  newBotEngine,
  type ModelInfo,
  type ProviderInfo,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  ImageIcon,
  Loader2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { splitPiModel } from '@/lib/new-bot';
import {
  useBots,
  useClaudeAuth,
  useImageModels,
  useInfo,
  useProviderModelInfo,
  useProviders,
  useSettings,
} from '@/lib/queries';
import { settingsMatch } from '@/lib/settingsMatch';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ClaudeConnect } from './ClaudeConnect';
import { ModelDefaults } from './ModelDefaults';
import {
  connectionName,
  EndpointEdit,
  EndpointForm,
  isPiModel,
  ModelSearch,
  PiModelPicker,
  PLAN_ONLY,
  PLANS,
  PlanSignIn,
  POPULAR,
  providerName,
  useHasProvider,
  useSavePiModel,
} from './ProviderConnect';
import { Heading, ListRow, Mark, PageHead, rowClass, Status, Tag, type Health } from './SettingsList';
import { Card, Row, useSaveSettings } from './SettingsPage';

/** Claude's place among the providers; never a provider id, which the server names in lowercase words. */
export const CLAUDE = 'claude';

/** Opens one provider's page, or the list with null. */
const show = (id: string | null) => useUi.setState({ settingsView: id });

/**
 * The AI providers on one page: what new bots start with, the providers already connected, and
 * the ones that can be. Each connected provider opens to its own page with its sign-in, its key
 * and its models, so the list stays one line per provider however much each one holds.
 */
export function ProvidersTab() {
  const view = useUi((s) => s.settingsView);
  const { data: providers, isLoading } = useProviders();
  const known = view === CLAUDE || !!providers?.some((p) => p.id === view && p.configured);
  // A provider whose last key or sign-in was just removed has no page left; back to the list.
  useEffect(() => {
    if (view && !isLoading && !known) show(null);
  }, [view, isLoading, known]);
  if (view && known) return <ProviderPage id={view} />;
  return <ProviderList />;
}

/** The name the settings title shows for the provider page that is open. */
export function useProviderTitle(id: string | null): string | null {
  const t = useT();
  const { data: providers = [] } = useProviders();
  if (!id) return null;
  if (id === CLAUDE) return t('ai.claude');
  const p = providers.find((x) => x.id === id);
  return p ? connectionName(p) : null;
}

/** How many bots run on Claude, or on a model of the given provider. */
function useBotCount(id: string) {
  const { data: bots = [] } = useBots();
  return bots.filter((b) =>
    id === CLAUDE ? b.engine === 'claude' : b.engine === 'pi' && b.model.startsWith(`${id}/`),
  ).length;
}

/** What a provider is used for: the start of new bots, the backup model, or both. */
function useRoles(id: string) {
  const { data: settings } = useSettings();
  const target = newBotEngine(settings);
  const backup = settings?.backupModel ? splitPiModel(settings.backupModel).provider : '';
  return {
    newBots:
      id === CLAUDE
        ? target.engine === 'claude'
        : target.engine === 'pi' && target.model.startsWith(`${id}/`),
    backup: id !== CLAUDE && backup === id,
  };
}

/** Claude's state as the list and its page show it. */
function useClaudeStatus() {
  const t = useT();
  const { data: info } = useInfo();
  const { data: auth } = useClaudeAuth();
  const status = info?.claude.status ?? 'unknown';
  const detail =
    auth?.kind === 'token'
      ? t('claude.usingToken', { hint: auth.hint ?? '' })
      : auth?.kind === 'apiKey'
        ? auth.baseUrl
          ? t('claude.usingGateway', { hint: auth.hint ?? '', url: auth.baseUrl })
          : t('claude.usingApiKey', { hint: auth.hint ?? '' })
        : t('claude.usingLogin');
  return { status, detail };
}

/** Claude's state in the words the lists use. */
const claudeHealth = (status: string): Health =>
  status === 'ok' ? 'ok' : status === 'unknown' ? 'unknown' : status === 'logged-out' ? 'off' : 'error';

function RoleTags({ id }: { id: string }) {
  const t = useT();
  const roles = useRoles(id);
  return (
    <>
      {roles.newBots && <Tag>{t('providers.role.newBots')}</Tag>}
      {roles.backup && <Tag>{t('providers.role.backup')}</Tag>}
    </>
  );
}

// ─── The list ────────────────────────────────────────────────────────────────

function ProviderList() {
  const t = useT();
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  const [find, setFind] = useState('');
  const matches = (name: string, id: string) => settingsMatch(find, `${name} ${id}`);
  const connected = providers.filter((p) => p.configured);
  const claudeShown = matches(t('ai.claude'), CLAUDE);
  const connectedShown = connected.filter((p) => matches(connectionName(p), p.id));
  return (
    <>
      {(settings?.defaultEngine !== undefined ||
        settings?.backupModel !== undefined ||
        settings?.imageModel !== undefined) && (
        <Card title={t('providers.defaults')}>
          {settings.defaultEngine !== undefined && <NewBotsRow />}
          {settings.backupModel !== undefined && <BackupModel />}
          {settings.imageModel !== undefined && <ImageModelRow />}
        </Card>
      )}
      <section className="mb-6">
        <Heading title={t('providers.connected')}>
          <div className="relative w-56 max-w-full">
            <Search className="pointer-events-none absolute top-1/2 start-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={t('providers.search')}
              aria-label={t('providers.search')}
              className="h-8 rounded-full ps-8 text-sm"
            />
          </div>
        </Heading>
        {claudeShown || connectedShown.length ? (
          <div className="divide-y rounded-2xl border bg-card/50">
            {claudeShown && <ClaudeRow />}
            {connectedShown.map((p) => (
              <ConnectedRow key={p.id} provider={p} />
            ))}
          </div>
        ) : (
          <p className="px-1 text-sm text-muted-foreground">
            {t('providers.noMatch', { query: find.trim() })}
          </p>
        )}
      </section>
      <Available find={find} />
    </>
  );
}

function ClaudeRow() {
  const t = useT();
  const { status, detail } = useClaudeStatus();
  const bots = useBotCount(CLAUDE);
  const { data: auth } = useClaudeAuth();
  return (
    <ListRow
      name={t('ai.claude')}
      mark={<Mark name={t('ai.claude')} />}
      status={<Status health={claudeHealth(status)} />}
      tags={<RoleTags id={CLAUDE} />}
      detail={[
        auth === null ? t('connection.defaultHint') : detail,
        bots > 0 && t('providers.bots', { count: bots }),
      ]}
      onOpen={() => show(CLAUDE)}
    />
  );
}

/** How a connected provider is reached, in a few words: its plan, its key, or its address. */
function useReach(p: ProviderInfo) {
  const t = useT();
  if (p.custom) return p.custom.baseUrl;
  return [
    p.signIn?.signedIn ? t('provider.signedIn') : '',
    p.hint ? t('providers.keyHint', { hint: p.hint }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function ConnectedRow({ provider: p }: { provider: ProviderInfo }) {
  const t = useT();
  const reach = useReach(p);
  const bots = useBotCount(p.id);
  const { data: models } = useProviderModelInfo(p.id);
  const name = connectionName(p);
  return (
    <ListRow
      name={name}
      mark={<Mark name={name} endpoint={!!p.custom} />}
      status={<Status health="ok" />}
      tags={<RoleTags id={p.id} />}
      detail={[
        reach,
        models && t('provider.foundModels', { count: models.length }),
        bots > 0 && t('providers.bots', { count: bots }),
      ]}
      mono={!!p.custom}
      onOpen={() => show(p.id)}
    />
  );
}

/** One way to connect something not connected yet. */
type Offer =
  | { kind: 'plan'; key: string; name: string; plan: (typeof PLANS)[number] }
  | { kind: 'key'; key: string; name: string; id: string; popular: boolean }
  | { kind: 'found'; key: string; name: string; baseUrl: string; models: number }
  | { kind: 'custom'; key: string; name: string };

/**
 * The providers that can still be connected. Plans and the most used providers show first; the
 * rest fold behind one button until asked for or searched. Connecting happens in the row itself.
 */
function Available({ find }: { find: string }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: providers = [] } = useProviders();
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const { data: found = [] } = useQuery({
    queryKey: ['endpoint-discovery'],
    queryFn: api.discoverEndpoints,
    staleTime: 60_000,
  });
  const addFound = useMutation({
    mutationFn: (f: { name: string; baseUrl: string }) =>
      api.addEndpoint({ name: f.name, baseUrl: f.baseUrl }),
    onSuccess: (_, f) => {
      toast.success(t('providers.added', { provider: f.name }));
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['endpoint-discovery'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const offers = useMemo(() => {
    const free = providers.filter((p) => !p.configured && !p.custom);
    const plans: Offer[] = PLANS.filter((x) => free.some((p) => p.id === x.provider && p.signIn)).map(
      (plan) => ({
        kind: 'plan',
        key: plan.chip,
        name: plan.name,
        plan,
      }),
    );
    const keys: Offer[] = free
      .filter((p) => !PLAN_ONLY.has(p.id))
      .map((p) => ({
        kind: 'key' as const,
        key: p.id,
        name: providerName(p.id),
        id: p.id,
        popular: POPULAR.includes(p.id),
      }))
      .sort((a, b) =>
        a.popular !== b.popular
          ? a.popular
            ? -1
            : 1
          : a.popular
            ? POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id)
            : a.name.localeCompare(b.name),
      );
    const local: Offer[] = found.map((f) => ({
      kind: 'found',
      key: `found:${f.baseUrl}`,
      name: f.name,
      baseUrl: f.baseUrl,
      models: f.models.length,
    }));
    return {
      first: [...plans, ...local, ...keys.filter((k) => k.kind === 'key' && k.popular)],
      rest: keys.filter((k) => k.kind === 'key' && !k.popular),
    };
  }, [providers, found]);
  const custom: Offer = { kind: 'custom', key: '+custom', name: t('provider.custom') };
  const searching = !!find.trim();
  const matches = (o: Offer) => settingsMatch(find, `${o.name} ${o.kind === 'key' ? o.id : ''}`);
  const shown = searching
    ? [...offers.first, ...offers.rest, custom].filter(matches)
    : [...offers.first, ...(all ? offers.rest : []), custom];
  const folded = !searching && offers.rest.length > 0;
  if (!shown.length) return null;
  return (
    <section className="mb-6">
      <Heading title={t('providers.available')} />
      <div className="divide-y rounded-2xl border bg-card/50">
        {shown.map((o) => (
          <OfferRow
            key={o.key}
            offer={o}
            open={open === o.key}
            onOpen={(v) => setOpen(v ? o.key : null)}
            adding={
              addFound.isPending && addFound.variables?.baseUrl === (o.kind === 'found' ? o.baseUrl : null)
            }
            onAddFound={() => o.kind === 'found' && addFound.mutate({ name: o.name, baseUrl: o.baseUrl })}
          />
        ))}
        {folded && (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className={cn(
              rowClass,
              'justify-center py-2.5 text-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {all ? t('providers.fewer') : t('providers.more', { count: offers.rest.length })}
            <ChevronDown className={cn('size-4 transition-transform', all && 'rotate-180')} />
          </button>
        )}
      </div>
      <p className="mt-2 px-1 text-xs text-muted-foreground">{t('keys.hint')}</p>
    </section>
  );
}

function OfferRow({
  offer: o,
  open,
  onOpen,
  adding,
  onAddFound,
}: {
  offer: Offer;
  open: boolean;
  onOpen(open: boolean): void;
  adding: boolean;
  onAddFound(): void;
}) {
  const t = useT();
  const done = () => {
    toast.success(t('providers.added', { provider: o.name }));
    onOpen(false);
  };
  const how =
    o.kind === 'plan'
      ? t('providers.how.plan')
      : o.kind === 'key'
        ? t('providers.how.key')
        : o.kind === 'found'
          ? `${t('provider.found')} · ${t('provider.foundModels', { count: o.models })}`
          : t('providers.how.custom');
  return (
    <div className="first:rounded-t-2xl last:rounded-b-2xl">
      <div className="flex items-center gap-3 px-4 py-3">
        <Mark name={o.name} endpoint={o.kind === 'found' || o.kind === 'custom'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{o.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{how}</span>
        </span>
        {o.kind === 'found' ? (
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={onAddFound}
            disabled={adding}
          >
            {adding && <Loader2 className="animate-spin" />}
            {t('common.add')}
          </Button>
        ) : open ? (
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-muted-foreground"
            onClick={() => onOpen(false)}
          >
            {t('common.cancel')}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" className="rounded-full" onClick={() => onOpen(true)}>
            {o.kind === 'plan' ? t('providers.signIn') : t('providers.connect')}
          </Button>
        )}
      </div>
      {open && (
        <div className="px-4 pb-4 ps-16">
          {o.kind === 'plan' ? (
            <PlanSignIn plan={o.plan} onDone={() => onOpen(false)} />
          ) : o.kind === 'key' ? (
            <KeyField id={o.id} onSaved={done} />
          ) : o.kind === 'custom' ? (
            <EndpointForm hideFound onAdded={() => onOpen(false)} />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Saves a provider's API key; the server keeps it and the app only ever sees its last characters. */
function KeyField({ id, onSaved }: { id: string; onSaved(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.setProviderKey(id, key.trim()),
    onSuccess: () => {
      setKey('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers'] });
      void qc.invalidateQueries({ queryKey: ['provider-models', id] });
      onSaved();
    },
    onError: (e) => setError((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (key.trim()) save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setError(null);
          }}
          aria-label={t('provider.keyFor', { provider: providerName(id) })}
          placeholder={t('provider.keyFor', { provider: providerName(id) })}
          className="h-10 min-w-56 flex-1 rounded-full px-4 font-mono"
        />
        <Button type="submit" className="h-10 rounded-full" disabled={!key.trim() || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}

// ─── Defaults ────────────────────────────────────────────────────────────────

/**
 * What new bots start with: Claude, or a model of a connected provider. Picking Claude saves at
 * once; a provider's model is tried with one short request before it is saved.
 */
function NewBotsRow() {
  const t = useT();
  const { data: settings } = useSettings();
  const { data: providers = [] } = useProviders();
  const save = useSaveSettings();
  const connected = providers.filter((p) => p.configured);
  const stored = settings?.defaultEngine === 'pi' ? (settings.piModel ?? '') : '';
  const [ref, setRef] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const pi = useSavePiModel(() => {
    setRef(null);
    setPicked(null);
  });
  const engine = picked ?? (stored ? splitPiModel(stored).provider : CLAUDE);
  const value =
    ref ?? (engine !== CLAUDE && splitPiModel(stored).provider === engine ? stored : `${engine}/`);
  const { data: models = [] } = useProviderModelInfo(engine === CLAUDE ? null : engine);
  const saved = engine !== CLAUDE && value === stored;
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-40 flex-1">
          <div className="text-sm">{t('model.newBots')}</div>
          <div className="text-xs text-muted-foreground">{t('model.newBotsHint')}</div>
        </div>
        <Select
          value={engine}
          onValueChange={(v) => {
            setPicked(v);
            setRef(null);
            if (v === CLAUDE && settings?.defaultEngine !== 'claude')
              save.mutate({ defaultEngine: 'claude' });
          }}
        >
          <SelectTrigger className="w-56 rounded-full" aria-label={t('model.newBots')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={CLAUDE}>{t('ai.claude')}</SelectItem>
            {connected.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {connectionName(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {engine === CLAUDE ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="-ms-3 rounded-full text-muted-foreground"
            onClick={() => show(CLAUDE)}
          >
            {t('providers.claudeModel')}
            <ChevronRight className="rtl:-scale-x-100" />
          </Button>
          {!connected.length && (
            <span className="text-xs text-muted-foreground">{t('providers.addFirst')}</span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <ModelSearch
              value={splitPiModel(value).model}
              models={models.map((m) => ({ value: m.id, name: m.name }))}
              onChange={(m) => setRef(`${engine}/${m}`)}
            />
            <Button
              className="h-10 rounded-full"
              onClick={() => pi.save.mutate(value)}
              disabled={!isPiModel(value) || saved || pi.save.isPending}
            >
              {pi.save.isPending && <Loader2 className="animate-spin" />}
              {pi.save.isPending ? t('claude.testing') : t('provider.tryAndSave')}
            </Button>
          </div>
          {saved && <p className="text-xs text-muted-foreground">{t('provider.inUse')}</p>}
          {pi.error && (
            <p className="text-sm text-destructive">{t('provider.failed', { detail: pi.error })}</p>
          )}
        </div>
      )}
      {(engine === CLAUDE ? settings?.defaultEngine !== 'pi' : saved) && <MoveExistingBots />}
    </div>
  );
}

/**
 * Offers to move the bots that run on another AI to what new bots start with, since changing
 * that setting leaves every existing bot as it was.
 */
function MoveExistingBots() {
  const t = useT();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: bots = [] } = useBots();
  const target = newBotEngine(settings);
  const count = bots.filter((b) => leavesForEngine(b, target)).length;
  const move = useMutation({
    mutationFn: api.moveBotsToNewEngine,
    onSuccess: ({ changed }) => {
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['routines'] });
      toast.success(t('model.moved', { count: changed }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!count) return null;
  const confirm = () => {
    const pi = target.engine === 'pi';
    const text = [
      pi
        ? t('model.moveConfirm.pi', { count, model: target.model })
        : t('model.moveConfirm.claude', { count }),
      t('model.moveKeeps'),
      ...(pi ? [t('bot.engineHint.pi')] : []),
    ].join('\n\n');
    if (window.confirm(text)) move.mutate();
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2">
      <span className="text-xs text-muted-foreground">{t('model.moveExisting', { count })}</span>
      <Button
        size="sm"
        variant="outline"
        className="rounded-full"
        onClick={confirm}
        disabled={move.isPending}
      >
        {move.isPending && <Loader2 className="animate-spin" />}
        {t('model.moveButton')}
      </Button>
    </div>
  );
}

/** Select items cannot carry an empty value, so "pick one from the saved keys" travels under this one. */
const IMAGE_AUTO = 'auto';

/**
 * The model that makes pictures, for a bot's pictures and an avatar from a description, chosen among
 * the providers with a saved key; automatic leaves it to the saved keys and the bot's own provider.
 */
function ImageModelRow() {
  const t = useT();
  const { data: settings } = useSettings();
  const { data } = useImageModels();
  const save = useSaveSettings();
  if (!data) return null;
  const stored = settings?.imageModel ?? '';
  const models = data.models;
  // A model chosen earlier whose key is gone stays listed, so the box never shows empty.
  const gone = stored && !models.some((m) => m.ref === stored);
  const chosen = models.find((m) => m.ref === stored);
  return (
    <Row
      label={t('model.image')}
      hint={
        !models.length
          ? t('model.imageNoKey')
          : gone
            ? t('model.imageGone')
            : chosen
              ? t('model.imageChosenHint')
              : t('model.imageAutoHint')
      }
    >
      {(models.length > 0 || gone) && (
        <Select
          value={stored || IMAGE_AUTO}
          onValueChange={(v) => save.mutate({ imageModel: v === IMAGE_AUTO ? '' : v })}
        >
          <SelectTrigger className="w-56 rounded-full" aria-label={t('model.image')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={IMAGE_AUTO}>{t('model.imageAuto')}</SelectItem>
            {gone && <SelectItem value={stored}>{stored}</SelectItem>}
            {models.map((m) => (
              <SelectItem key={m.ref} value={m.ref}>
                {t('model.imageOption', {
                  provider: m.providerName ?? providerName(m.provider),
                  model: m.name,
                })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </Row>
  );
}

/** The model that carries the work once the usage limit is spent, instead of waiting for it. */
function BackupModel() {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [on, setOn] = useState<boolean | null>(null);
  const [ref, setRef] = useState<string | null>(null);
  const pi = useSavePiModel(() => setRef(null), true);
  const hasProvider = useHasProvider();
  const stored = settings?.backupModel ?? '';
  const open = on ?? !!stored;
  const value = ref ?? stored;
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm">{t('model.backup')}</div>
          <div className="text-xs text-muted-foreground">{t('model.backupHint')}</div>
        </div>
        <Switch
          checked={open}
          onCheckedChange={(v) => {
            setOn(v);
            if (!v && stored) save.mutate({ backupModel: '' });
          }}
          aria-label={t('model.backup')}
        />
      </div>
      {open && (
        <div className="space-y-2">
          <PiModelPicker
            value={value}
            onChange={setRef}
            empty={<p className="text-sm text-muted-foreground">{t('providers.addFirst')}</p>}
          />
          {hasProvider && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                className="rounded-full"
                onClick={() => pi.save.mutate(value)}
                disabled={!isPiModel(value) || value === stored || pi.save.isPending}
              >
                {pi.save.isPending && <Loader2 className="animate-spin" />}
                {pi.save.isPending ? t('claude.testing') : t('provider.tryAndSave')}
              </Button>
              {stored && value === stored && (
                <span className="text-xs text-muted-foreground">{t('providers.backupInUse')}</span>
              )}
            </div>
          )}
          {pi.error && (
            <p className="text-sm text-destructive">{t('provider.failed', { detail: pi.error })}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── One provider's page ─────────────────────────────────────────────────────

function ProviderPage({ id }: { id: string }) {
  const t = useT();
  const { data: providers = [] } = useProviders();
  const p = providers.find((x) => x.id === id);
  const claude = id === CLAUDE;
  const name = claude ? t('ai.claude') : p ? connectionName(p) : id;
  const bots = useBotCount(id);
  const { status } = useClaudeStatus();
  const qc = useQueryClient();
  const check = useMutation({
    mutationFn: api.checkClaude,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['info'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <>
      <PageHead
        name={name}
        mark={<Mark name={name} endpoint={!!p?.custom} large />}
        status={<Status health={claude ? claudeHealth(status) : 'ok'} />}
        tags={<RoleTags id={id} />}
        line={bots ? t('providers.bots', { count: bots }) : t('providers.noBots')}
      >
        {claude && (
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            <RefreshCw className={cn(check.isPending && 'animate-spin')} /> {t('connection.check')}
          </Button>
        )}
      </PageHead>
      {claude ? <ClaudePage checking={check.isPending} /> : p && <KeyPage provider={p} />}
    </>
  );
}

function ClaudePage({ checking }: { checking: boolean }) {
  const t = useT();
  const { data: auth } = useClaudeAuth();
  const { data: info } = useInfo();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const claude = info?.claude;
  const hint =
    claude?.status === 'logged-out'
      ? t('connection.loggedOutHint')
      : claude?.reason === 'api-key'
        ? t('connection.apiKeyInUse', { source: claude.detail ?? '' })
        : claude?.reason === 'timeout'
          ? t('connection.timeout')
          : (claude?.detail ?? t('connection.defaultHint'));
  return (
    <>
      {auth === null ? (
        <Card title={t('providers.signInSection')}>
          <Row label={t('connection.claude')} hint={hint} />
        </Card>
      ) : (
        // The sign-in draws its own frame, so it sits under the heading without a card around it.
        <section className="mb-6">
          <Heading title={t('providers.signInSection')} />
          <ClaudeConnect checking={checking} />
        </section>
      )}
      {settings?.defaultModel !== undefined && (
        <Card title={t('model.title')}>
          <div className="px-4 py-4">
            <ModelDefaults
              value={{ model: settings.defaultModel, effort: settings.effort ?? '' }}
              onChange={(v) => save.mutate({ defaultModel: v.model, effort: v.effort })}
            />
          </div>
          {settings.claudeCompactWindow !== undefined && <CompactWindow />}
          {settings.idleCompact !== undefined && !!settings.claudeCompactWindow && (
            <Row label={t('model.idleCompact')} hint={t('model.idleCompactHint')}>
              <Switch
                checked={settings.idleCompact}
                onCheckedChange={(v) => save.mutate({ idleCompact: v })}
                aria-label={t('model.idleCompact')}
              />
            </Row>
          )}
        </Card>
      )}
    </>
  );
}

/** Sizes offered, in tokens; 0 leaves it to Claude. The server starts at the recommended one. */
const COMPACT_CHOICES = [100_000, 150_000, 200_000, 300_000, 400_000, 600_000, 800_000, 1_000_000, 0];
const COMPACT_RECOMMENDED = 200_000;

/** How big a Claude bot's conversation grows before its older part is folded into a summary. */
function CompactWindow() {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const value = settings?.claudeCompactWindow ?? COMPACT_RECOMMENDED;
  // A size another client saved stays listed, so the box never shows empty.
  const choices = COMPACT_CHOICES.includes(value) ? COMPACT_CHOICES : [...COMPACT_CHOICES, value];
  const label = (n: number) => {
    const size =
      n === 0
        ? t('model.compactAuto')
        : n >= 1_000_000
          ? t('model.compactMillion', { count: n / 1_000_000 })
          : t('model.compactThousand', { count: n / 1_000 });
    return n === COMPACT_RECOMMENDED ? t('model.compactRecommended', { size }) : size;
  };
  return (
    <Row label={t('model.compact')} hint={t('model.compactHint')}>
      <Select value={String(value)} onValueChange={(v) => save.mutate({ claudeCompactWindow: Number(v) })}>
        <SelectTrigger className="w-56 rounded-full" aria-label={t('model.compact')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((n) => (
            <SelectItem key={n} value={String(n)}>
              {label(n)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Row>
  );
}

/**
 * A provider other than Claude: how it is reached (its plan, its key or its address), each
 * removable on its own, and the models it offers.
 */
function KeyPage({ provider: p }: { provider: ProviderInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const plan = PLANS.find((x) => x.provider === p.id);
  const [planOpen, setPlanOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const refreshProviders = () => void qc.invalidateQueries({ queryKey: ['providers'] });
  const fail = (e: unknown) => toast.error((e as Error).message);
  const removeKey = useMutation({
    mutationFn: () => api.removeProviderKey(p.id),
    onSuccess: refreshProviders,
    onError: fail,
  });
  const signOut = useMutation({
    mutationFn: () => api.signOut(p.id),
    onSuccess: refreshProviders,
    onError: fail,
  });
  const removeEndpoint = useMutation({
    mutationFn: () => api.removeEndpoint(p.id),
    onSuccess: refreshProviders,
    onError: fail,
  });
  // Asks first only when the provider would be left with no way in, since its bots then stop.
  const confirmRemove = (last: boolean, run: () => void) => {
    if (!last || window.confirm(t('providers.removeConfirm', { provider: connectionName(p) }))) run();
  };
  return (
    <>
      <Card title={t('providers.signInSection')}>
        {p.custom &&
          (editing ? (
            <div className="px-4 py-3">
              <EndpointEdit provider={p} onDone={() => setEditing(false)} />
            </div>
          ) : (
            <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-40 flex-1">
                <div className="text-sm">{t('provider.customUrl')}</div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {p.custom.baseUrl}
                  {p.hint ? ` · ${p.hint}` : ''}
                </div>
              </div>
              <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setEditing(true)}>
                <Pencil /> {t('provider.customEdit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-muted-foreground"
                onClick={() => confirmRemove(true, () => removeEndpoint.mutate())}
                disabled={removeEndpoint.isPending}
              >
                <X /> {t('common.remove')}
              </Button>
            </div>
          ))}
        {plan && p.signIn && (
          <div>
            <Row
              label={t('providers.plan', { plan: plan.name })}
              hint={p.signIn.signedIn ? t('provider.signedIn') : t('providers.planNone')}
            >
              {p.signIn.signedIn ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full text-muted-foreground"
                  onClick={() => confirmRemove(!p.hint, () => signOut.mutate())}
                  disabled={signOut.isPending}
                >
                  <X /> {t('provider.signOut')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  className="rounded-full"
                  onClick={() => setPlanOpen(!planOpen)}
                >
                  {planOpen ? t('common.cancel') : t('providers.signIn')}
                </Button>
              )}
            </Row>
            {planOpen && !p.signIn.signedIn && (
              <div className="px-4 pb-4">
                <PlanSignIn plan={plan} onDone={() => setPlanOpen(false)} />
              </div>
            )}
          </div>
        )}
        {!p.custom && !PLAN_ONLY.has(p.id) && (
          <div>
            <Row label={t('providers.key')} hint={p.hint ?? t('providers.keyNone')}>
              <Button
                variant="secondary"
                size="sm"
                className="rounded-full"
                onClick={() => setKeyOpen(!keyOpen)}
              >
                {keyOpen ? t('common.cancel') : p.hint ? t('providers.keyChange') : t('providers.keyAdd')}
              </Button>
              {p.hint && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full text-muted-foreground"
                  onClick={() => confirmRemove(!p.signIn?.signedIn, () => removeKey.mutate())}
                  disabled={removeKey.isPending}
                >
                  <X /> {t('common.remove')}
                </Button>
              )}
            </Row>
            {keyOpen && (
              <div className="px-4 pb-4">
                <KeyField
                  id={p.id}
                  onSaved={() => {
                    setKeyOpen(false);
                    toast.success(t('providers.keySaved'));
                  }}
                />
              </div>
            )}
          </div>
        )}
      </Card>
      <ModelList provider={p} />
    </>
  );
}

/** Context window as a short number: 200K, 1M. */
function useShortNumber() {
  const locale = useLocale((s) => s.locale);
  return useMemo(
    () => new Intl.NumberFormat(INTL_LOCALE[locale], { notation: 'compact', maximumFractionDigits: 1 }),
    [locale],
  );
}

/**
 * The models a provider offers, searchable, each of which can be made what new bots start with
 * or the backup model from here.
 */
function ModelList({ provider: p }: { provider: ProviderInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: models, isLoading, isError } = useProviderModelInfo(p.id);
  const { data: settings } = useSettings();
  const [find, setFind] = useState('');
  const short = useShortNumber();
  const newBots = useSavePiModel();
  const backup = useSavePiModel(undefined, true);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.refreshEndpoint(p.id),
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: ['provider-models', p.id] });
      toast.success(t('provider.customRefreshed', { count: list.length }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const list = models ?? [];
  const shown = list.filter((m) => settingsMatch(find, `${m.name} ${m.id}`));
  const ref = (m: ModelInfo) => `${p.id}/${m.id}`;
  const target = newBotEngine(settings);
  const use = (m: ModelInfo, as: 'new' | 'backup') => {
    const r = ref(m);
    setBusy(r);
    (as === 'new' ? newBots : backup).save.mutate(r, {
      onSuccess: () =>
        toast.success(
          as === 'new'
            ? t('providers.newBotsSaved', { model: m.name })
            : t('providers.backupSaved', { model: m.name }),
        ),
      onError: (e) => toast.error(t('provider.failed', { detail: (e as Error).message })),
      onSettled: () => setBusy(null),
    });
  };
  return (
    <section className="mb-6">
      <Heading title={models ? `${t('providers.models')} · ${list.length}` : t('providers.models')}>
        <div className="flex items-center gap-2">
          {list.length > 8 && (
            <div className="relative w-56 max-w-full">
              <Search className="pointer-events-none absolute top-1/2 start-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={find}
                onChange={(e) => setFind(e.target.value)}
                placeholder={t('providers.modelSearch')}
                aria-label={t('providers.modelSearch')}
                className="h-8 rounded-full ps-8 text-sm"
              />
            </div>
          )}
          {p.custom && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full text-muted-foreground"
              aria-label={t('provider.customRefresh')}
              title={t('provider.customRefresh')}
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending}
            >
              <RefreshCw className={cn(refresh.isPending && 'animate-spin')} />
            </Button>
          )}
        </div>
      </Heading>
      {isLoading ? (
        <Loader2 className="ms-1 size-4 animate-spin text-muted-foreground" />
      ) : isError || !list.length ? (
        <p className="px-1 text-sm text-muted-foreground">{t('providers.modelsNone')}</p>
      ) : !shown.length ? (
        <p className="px-1 text-sm text-muted-foreground">{t('providers.noMatch', { query: find.trim() })}</p>
      ) : (
        <div className="scroll-thin max-h-[32rem] divide-y overflow-y-auto rounded-2xl border bg-card/50">
          {shown.map((m) => {
            const r = ref(m);
            const isNew = target.engine === 'pi' && target.model === r;
            const isBackup = settings?.backupModel === r;
            return (
              <div key={m.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate text-sm">{m.name}</span>
                    {isNew && <Tag>{t('providers.role.newBots')}</Tag>}
                    {isBackup && <Tag>{t('providers.role.backup')}</Tag>}
                  </span>
                  {m.name !== m.id && (
                    <span className="block truncate font-mono text-xs text-muted-foreground">{m.id}</span>
                  )}
                </span>
                {m.images && (
                  <ImageIcon
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={t('providers.images')}
                  />
                )}
                {m.contextWindow ? (
                  <span
                    className="w-12 shrink-0 text-end text-xs text-muted-foreground tabular-nums"
                    title={t('providers.context')}
                  >
                    {short.format(m.contextWindow)}
                  </span>
                ) : null}
                {busy === r ? (
                  <Loader2 className="m-2 size-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0 rounded-full text-muted-foreground"
                        aria-label={t('providers.modelActions')}
                        disabled={!!busy}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {settings?.defaultEngine !== undefined && (
                        <DropdownMenuItem disabled={isNew} onSelect={() => use(m, 'new')}>
                          {t('providers.useForNew')}
                        </DropdownMenuItem>
                      )}
                      {settings?.backupModel !== undefined && (
                        <DropdownMenuItem disabled={isBackup} onSelect={() => use(m, 'backup')}>
                          {t('providers.useAsBackup')}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
