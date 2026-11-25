import type { ProviderInfo, ProviderSignIn } from '@leafbot/shared';
import * as Clipboard from 'expo-clipboard';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { IconButton, PillButton, usePageScroll } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { Chip, ChipRow, ChoiceRow } from '@/components/settings/common/controls';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { useProviderModels, useProviders } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Keys and endpoints for models outside the Claude subscription. The server keeps every key; the
 * app only ever sees its last characters.
 *
 * - `ProviderKeyForm` (no props): `ProviderRows` above `AddProviderForm`, for the first-run screen.
 * - `ProviderRows` (`plain?`): the providers that can be used, each a `ProviderRow` (`provider`,
 *   `plain?`); `plain` drops the frames, for rows inside a settings card.
 * - `AddProviderForm` (`onAdded?`): picks a provider and takes its key, or adds an endpoint.
 * - `EndpointRow` (`provider`, `plain?`): one of the person's own endpoints, with edit, refresh
 *   and remove; editing also changes the models named by hand.
 * - `EndpointForm` (`onAdded?`): adds an OpenAI-compatible endpoint (Ollama, LM Studio, a hosted one).
 * - `PiModelPicker` (`value`, `onChange`, `empty?`): picks `provider/model` among providers with a
 *   key; `empty` is shown while there is none (the key form when left out).
 * - `useSavePiModel(onSaved?, backup?)`: tries a `provider/model` with one request, then stores it
 *   as what new bots start with (or the backup model when `backup`); returns `{ save, error }`.
 * - `useHasProvider()`: true once some provider can be used.
 * - `isPiModel(ref)`, `providerName(id)`: helpers.
 */

/** Offered first; every other provider the server knows is under "Other". */
export const POPULAR = ['openai', 'google', 'openrouter', 'deepseek', 'xai', 'mistral', 'groq'];
/**
 * Product names, not words to translate. A provider missing here shows its id, which is also
 * how regional plans (`minimax-cn`, `xiaomi-token-plan-sgp`) stay told apart.
 */
const NAMES: Record<string, string> = {
  openai: 'OpenAI',
  'github-copilot': 'GitHub Copilot',
  google: 'Google Gemini',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  mistral: 'Mistral',
  groq: 'Groq',
  anthropic: 'Anthropic',
  baseten: 'Baseten',
  cerebras: 'Cerebras',
  fireworks: 'Fireworks',
  huggingface: 'Hugging Face',
  'kimi-coding': 'Kimi Coding',
  meta: 'Meta',
  minimax: 'MiniMax',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  opencode: 'OpenCode',
  'opencode-go': 'OpenCode Go',
  together: 'Together AI',
  'vercel-ai-gateway': 'Vercel AI Gateway',
  xiaomi: 'Xiaomi',
  zai: 'Z.ai',
};
export const providerName = (id: string) => NAMES[id] ?? id;
/** What a connected provider is called: the endpoint's own name, or the plan it is reached by. */
export function connectionName(p: ProviderInfo): string {
  if (p.custom) return p.custom.name;
  const plan = PLANS.find((x) => x.provider === p.id);
  return plan && p.signIn?.signedIn && !p.hint ? plan.name : providerName(p.id);
}
const byName = (a: string, b: string) => providerName(a).localeCompare(providerName(b));
/** Model names typed into one field, split on spaces, commas and new lines. */
const modelList = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((m) => m.trim())
    .filter(Boolean);
/** How many matching models the picker shows under its field before asking for more letters. */
const SHOWN_MODELS = 8;
/** The chip that opens the form for the person's own endpoint; never a provider id. */
const CUSTOM = '+custom';
/** Plans signed in to instead of a key; the chip value is not a provider id (OpenAI also takes keys). */
export const PLANS = [
  { chip: '+chatgpt', provider: 'openai', name: 'ChatGPT' },
  { chip: '+copilot', provider: 'github-copilot', name: 'GitHub Copilot' },
] as const;
/** Providers reached only by signing in to a plan: no key chip for them. */
export const PLAN_ONLY = new Set(['github-copilot']);
/** Ollama's address on the same computer; an address, not a word to translate. */
const EXAMPLE_URL = 'http://localhost:11434/v1';
const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** Splits `provider/model`; a text without a slash is all model. */
export function splitPiModel(ref: string): { provider: string; model: string } {
  const i = ref.indexOf('/');
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: '', model: ref };
}

/** True when `provider/model` names both parts. */
export function isPiModel(ref: string) {
  const { provider, model } = splitPiModel(ref);
  return !!provider && !!model;
}

function useRefreshProviders() {
  const qc = useQueryClient();
  const { origin } = useServer();
  return () => qc.invalidateQueries({ queryKey: ['providers', origin] });
}

/** A bordered line with a round icon, as the saved providers and endpoints are listed. */
function SavedLine({
  icon,
  title,
  sub,
  plain,
  children,
}: {
  icon: 'check' | 'server';
  title: string;
  sub?: string;
  /** No frame, for a line that sits in a settings card. */
  plain?: boolean;
  children?: ReactNode;
}) {
  const c = useColors();
  return (
    <View style={[styles.saved, plain ? styles.plain : { borderColor: c.border }]}>
      <View style={[styles.badge, { backgroundColor: `${c.success}26` }]}>
        <Feather name={icon} size={20} color={c.success} />
      </View>
      <View style={styles.savedText}>
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={2}>
          {title}
        </Text>
        {sub ? (
          <Text style={[styles.sub, { color: c.mutedForeground, fontFamily: MONO }]} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

export function ProviderKeyForm() {
  const c = useColors();
  const { isLoading } = useProviders();
  if (isLoading) return <ActivityIndicator color={c.mutedForeground} />;
  return (
    <View style={styles.root}>
      <ProviderRows />
      <AddProviderForm />
    </View>
  );
}

/** The providers that can be used: those with a key, and the person's own endpoints. */
export function ProviderRows({ plain = false }: { plain?: boolean }) {
  const { data: providers = [] } = useProviders();
  // A provider can have both: a saved key and a sign-in with the person's plan.
  return providers
    .filter((p) => p.configured)
    .flatMap((p) => [
      ...(p.signIn?.signedIn ? [<PlanRow key={`${p.id}-plan`} provider={p} plain={plain} />] : []),
      ...(p.custom || p.hint ? [<ProviderRow key={p.id} provider={p} plain={plain} />] : []),
    ]);
}

/** A sign-in with the person's plan, with sign-out. */
function PlanRow({ provider: p, plain }: { provider: ProviderInfo; plain: boolean }) {
  const api = useApi();
  const refresh = useRefreshProviders();
  const out = useMutation({ mutationFn: api.signOut, onSuccess: () => void refresh(), onError: toastError });
  return (
    <SavedLine
      icon="check"
      plain={plain}
      title={PLANS.find((x) => x.provider === p.id)?.name ?? providerName(p.id)}
      sub={t('provider.signedIn')}
    >
      <IconButton
        icon="log-out"
        size={18}
        label={t('provider.signOut')}
        onPress={() => out.mutate(p.id)}
        disabled={out.isPending}
      />
    </SavedLine>
  );
}

/**
 * Signing in with the person's own plan: the server runs it; the phone opens the page, shows a
 * code to type there (Copilot), or takes the address the browser ended on (ChatGPT, whose page
 * cannot come back to a phone by itself).
 */
export function PlanSignIn({ plan, onDone }: { plan: (typeof PLANS)[number]; onDone?: () => void }) {
  const c = useColors();
  const api = useApi();
  const refresh = useRefreshProviders();
  const [session, setSession] = useState<ProviderSignIn | null>(null);
  const [enterprise, setEnterprise] = useState('');
  const [pasted, setPasted] = useState('');
  const copilot = plan.provider === 'github-copilot';
  const start = useMutation({
    mutationFn: () => api.startSignIn(plan.provider, copilot ? enterprise.trim() : undefined),
    onSuccess: setSession,
    onError: toastError,
  });
  const live = session && (session.status === 'starting' || session.status === 'waiting');
  const { data: polled } = useQuery({
    queryKey: ['sign-in', session?.id],
    queryFn: () => api.signIn(session!.id),
    enabled: !!live,
    refetchInterval: 1500,
  });
  const now = polled && polled.id === session?.id ? polled : session;
  const done = now?.status === 'done';
  useEffect(() => {
    if (!done) return;
    toast(t('provider.signInDone', { provider: plan.name }));
    void refresh();
    onDone?.();
  }, [done, plan.name, refresh, onDone]);
  // Ends a sign-in left half-way when the form closes or another provider is picked.
  useEffect(() => {
    const id = session?.id;
    return () => {
      if (id) void api.cancelSignIn(id).catch(() => {});
    };
  }, [session?.id, api]);
  const paste = useMutation({
    mutationFn: () => api.pasteSignIn(now!.id, pasted.trim()),
    onSuccess: (s) => {
      setSession(s);
      setPasted('');
    },
    onError: toastError,
  });

  if (!now || now.status === 'cancelled' || now.status === 'error' || now.status === 'done') {
    return (
      <View style={styles.root}>
        <Text style={[styles.sub, { color: c.mutedForeground }]}>
          {t(copilot ? 'provider.copilotHint' : 'provider.chatgptHint')}
        </Text>
        {copilot ? (
          <Field
            value={enterprise}
            onChangeText={setEnterprise}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('provider.enterprise')}
            accessibilityLabel={t('provider.enterprise')}
          />
        ) : null}
        {now?.status === 'error' ? (
          <Text style={[styles.sub, { color: c.destructive }]}>{now.error}</Text>
        ) : null}
        <View style={styles.start}>
          <PillButton
            variant="primary"
            icon="log-in"
            label={t('provider.signInWith', { provider: plan.name })}
            onPress={() => start.mutate()}
            busy={start.isPending}
          />
        </View>
      </View>
    );
  }
  return (
    <View style={styles.root}>
      {now.userCode ? (
        <>
          <Text style={[styles.sub, { color: c.foreground }]}>{t('provider.deviceCode')}</Text>
          <Pressable
            onPress={() => void Clipboard.setStringAsync(now.userCode!)}
            accessibilityLabel={t('message.copy')}
          >
            <Text selectable style={[styles.title, styles.code, { color: c.foreground }]}>
              {now.userCode}
            </Text>
          </Pressable>
        </>
      ) : null}
      {now.url ? (
        <View style={styles.start}>
          <PillButton
            icon="external-link"
            label={t('provider.openSignIn')}
            onPress={() => void Linking.openURL(now.url!)}
          />
        </View>
      ) : null}
      {now.needsPaste ? (
        <>
          <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.pasteHint')}</Text>
          <Field
            value={pasted}
            onChangeText={setPasted}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('provider.pastePlaceholder')}
            accessibilityLabel={t('provider.pastePlaceholder')}
          />
          <View style={styles.start}>
            <PillButton
              variant="primary"
              label={t('common.save')}
              onPress={() => pasted.trim() && paste.mutate()}
              busy={paste.isPending}
              disabled={!pasted.trim()}
            />
          </View>
        </>
      ) : null}
      <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.signInWaiting')}</Text>
    </View>
  );
}

/** One provider that can be used: a key's provider with remove, or the person's own endpoint. */
export function ProviderRow({ provider: p, plain = false }: { provider: ProviderInfo; plain?: boolean }) {
  const api = useApi();
  const refresh = useRefreshProviders();
  const remove = useMutation({
    mutationFn: api.removeProviderKey,
    onSuccess: () => void refresh(),
    onError: toastError,
  });
  if (p.custom) return <EndpointRow provider={p} plain={plain} />;
  return (
    <SavedLine
      icon="check"
      plain={plain}
      title={providerName(p.id)}
      sub={t('provider.keySaved', { hint: p.hint ?? '' })}
    >
      <IconButton
        icon="x"
        size={18}
        label={t('common.remove')}
        onPress={() => remove.mutate(p.id)}
        disabled={remove.isPending}
      />
    </SavedLine>
  );
}

/**
 * Picks a provider and takes its key, or adds the person's own endpoint. `onAdded` runs once a
 * key or an endpoint is saved.
 */
export function AddProviderForm({ onAdded }: { onAdded?: () => void }) {
  const c = useColors();
  const api = useApi();
  const { data: providers = [] } = useProviders();
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = useRefreshProviders();
  const ids = providers.filter((p) => !p.custom && !PLAN_ONLY.has(p.id)).map((p) => p.id);
  const plans = PLANS.filter((x) => providers.some((p) => p.id === x.provider && p.signIn));
  const popular = POPULAR.filter((id) => ids.includes(id));
  const others = ids.filter((id) => !popular.includes(id)).sort(byName);
  const current = provider || popular[0] || ids[0] || '';
  const save = useMutation({
    mutationFn: () => api.setProviderKey(current, key.trim()),
    onSuccess: () => {
      setKey('');
      setError(null);
      void refresh();
      onAdded?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  const pick = (id: string) => {
    setProvider(id);
    setError(null);
  };

  return (
    <View style={styles.root}>
      <Text style={[styles.title, { color: c.foreground }]}>{t('provider.pick')}</Text>
      <ChipRow>
        {plans.map((x) => (
          <Chip
            key={x.chip}
            on={current === x.chip}
            onPress={() => pick(x.chip)}
            icon="log-in"
            label={x.name}
          />
        ))}
        {popular.map((id) => (
          <Chip key={id} on={current === id} onPress={() => pick(id)} label={providerName(id)} />
        ))}
        <Chip
          on={current === CUSTOM}
          onPress={() => pick(CUSTOM)}
          icon="server"
          label={t('provider.custom')}
        />
      </ChipRow>
      {others.length > 0 ? (
        <View style={[styles.other, { borderColor: c.border, backgroundColor: c.muted }]}>
          <ChoiceRow
            label={t('provider.other')}
            value={others.includes(current) ? current : ''}
            options={others.map((id) => ({ value: id, label: providerName(id) }))}
            onChange={pick}
          />
        </View>
      ) : null}
      {current === CUSTOM ? (
        <EndpointForm onAdded={onAdded} />
      ) : PLANS.some((x) => x.chip === current) ? (
        <PlanSignIn key={current} plan={PLANS.find((x) => x.chip === current)!} onDone={onAdded} />
      ) : (
        <>
          <Field
            value={key}
            onChangeText={(v) => {
              setKey(v);
              setError(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('provider.keyFor', { provider: providerName(current) })}
            placeholder={t('provider.keyFor', { provider: providerName(current) })}
          />
          <View style={styles.start}>
            <PillButton
              variant="primary"
              label={t('common.save')}
              onPress={() => key.trim() && save.mutate()}
              busy={save.isPending}
              disabled={!key.trim()}
            />
          </View>
          {error ? <Text style={[styles.sub, { color: c.destructive }]}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

/** One of the person's own endpoints: its name, where it is, and its model list on request. */
export function EndpointRow({ provider: p, plain = false }: { provider: ProviderInfo; plain?: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const refresh = useMutation({
    mutationFn: () => api.refreshEndpoint(p.id),
    onSuccess: (models) => {
      qc.setQueryData(['provider-models', origin, p.id], models);
      toast(t('provider.customRefreshed', { count: models.length }));
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.removeEndpoint(p.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['providers', origin] }),
    onError: toastError,
  });
  const [editing, setEditing] = useState(false);
  if (editing) return <EndpointEdit provider={p} plain={plain} onDone={() => setEditing(false)} />;
  return (
    <SavedLine
      icon="server"
      plain={plain}
      title={p.custom!.name}
      sub={`${p.custom!.baseUrl}${p.hint ? ` · ${p.hint}` : ''}`}
    >
      <IconButton icon="edit-2" size={17} label={t('provider.customEdit')} onPress={() => setEditing(true)} />
      <IconButton
        icon="refresh-cw"
        size={17}
        label={t('provider.customRefresh')}
        onPress={() => refresh.mutate()}
        disabled={refresh.isPending}
      />
      <IconButton
        icon="x"
        size={18}
        label={t('common.remove')}
        onPress={() => remove.mutate()}
        disabled={remove.isPending}
      />
    </SavedLine>
  );
}

/**
 * Changes a saved endpoint's name, address, models or key; an empty key field keeps the saved key.
 * The models are the ones named by hand, for an endpoint whose own list leaves some out.
 */
export function EndpointEdit({
  provider: p,
  plain,
  onDone,
}: {
  provider: ProviderInfo;
  plain: boolean;
  onDone: () => void;
}) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [name, setName] = useState(p.custom!.name);
  const [baseUrl, setBaseUrl] = useState(p.custom!.baseUrl);
  const [key, setKey] = useState('');
  const { data: saved = [] } = useProviderModels(p.id);
  // Null until edited: the saved list may still be loading, and an untouched list is not sent.
  const [models, setModels] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api.updateEndpoint(p.id, {
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        key: key.trim(),
        ...(models !== null ? { models: modelList(models) } : {}),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
      void qc.invalidateQueries({ queryKey: ['provider-models', origin, p.id] });
      onDone();
    },
    onError: toastError,
  });
  return (
    <View style={[styles.form, plain ? styles.formPlain : { borderColor: c.border }]}>
      <Field value={name} onChangeText={setName} accessibilityLabel={t('provider.customName')} />
      <Field
        value={baseUrl}
        onChangeText={setBaseUrl}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customUrl')}
      />
      <Field
        value={models ?? saved.join(', ')}
        onChangeText={setModels}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        accessibilityLabel={t('provider.customModelsEdit')}
        placeholder={t('provider.customModelsEdit')}
        style={styles.area}
      />
      <Field
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customKey')}
        placeholder={p.hint ? t('provider.customKeyKeep', { hint: p.hint }) : t('provider.customKey')}
      />
      <View style={styles.buttons}>
        <PillButton variant="ghost" label={t('common.cancel')} onPress={onDone} />
        <PillButton
          variant="primary"
          label={t('common.save')}
          onPress={() => save.mutate()}
          busy={save.isPending}
          disabled={!name.trim() || !baseUrl.trim()}
        />
      </View>
    </View>
  );
}

/**
 * Adds an OpenAI-compatible endpoint, such as Ollama or LM Studio on this network, or a hosted
 * service. The server asks it for its models; the key is optional and stays on the server.
 */
export function EndpointForm({ onAdded }: { onAdded?: () => void }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [models, setModels] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.addEndpoint({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(models.trim() ? { models: modelList(models) } : {}),
      }),
    onSuccess: () => {
      setName('');
      setBaseUrl('');
      setKey('');
      setModels('');
      setError(null);
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
      onAdded?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  // Model servers already running on the server's computer, offered with one tap.
  const { data: found = [] } = useQuery({
    queryKey: ['endpoint-discovery', origin],
    queryFn: api.discoverEndpoints,
    staleTime: 60_000,
  });
  const addFound = useMutation({
    mutationFn: (f: { name: string; baseUrl: string }) =>
      api.addEndpoint({ name: f.name, baseUrl: f.baseUrl }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['providers', origin] });
      void qc.invalidateQueries({ queryKey: ['endpoint-discovery', origin] });
      onAdded?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  return (
    <View style={styles.root}>
      {found.length > 0 ? (
        <View style={[styles.found, { borderColor: c.border }]}>
          <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.found')}</Text>
          {found.map((f) => (
            <View key={f.baseUrl} style={styles.foundRow}>
              <Feather name="server" size={20} color={c.mutedForeground} />
              <Text style={[styles.foundText, { color: c.foreground }]} numberOfLines={2}>
                {f.name}{' '}
                <Text style={[styles.sub, { color: c.mutedForeground }]}>
                  {t('provider.foundModels', { count: f.models.length })}
                </Text>
              </Text>
              <PillButton
                variant="secondary"
                label={t('common.add')}
                onPress={() => addFound.mutate(f)}
                disabled={addFound.isPending}
              />
            </View>
          ))}
        </View>
      ) : null}
      <Text style={[styles.sub, { color: c.mutedForeground }]}>{t('provider.customHint')}</Text>
      <Field
        value={name}
        onChangeText={setName}
        accessibilityLabel={t('provider.customName')}
        placeholder={t('provider.customName')}
      />
      <Field
        value={baseUrl}
        onChangeText={setBaseUrl}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customUrl')}
        placeholder={EXAMPLE_URL}
      />
      <Field
        value={key}
        onChangeText={setKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customKey')}
        placeholder={t('provider.customKey')}
      />
      <Field
        value={models}
        onChangeText={setModels}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel={t('provider.customModels')}
        placeholder={t('provider.customModels')}
      />
      <View style={styles.start}>
        <PillButton
          variant="primary"
          label={t('common.add')}
          onPress={() => {
            setError(null);
            add.mutate();
          }}
          busy={add.isPending}
          disabled={!name.trim() || !baseUrl.trim()}
        />
      </View>
      {error ? <Text style={[styles.sub, { color: c.destructive }]}>{error}</Text> : null}
    </View>
  );
}

/** True once a provider can be used: it has a key, or it is the person's own endpoint. */
export function useHasProvider() {
  const { data: providers = [] } = useProviders();
  return providers.some((p) => p.configured);
}

/**
 * Picks one model of a provider that has a key, as `provider/model`. Lists can be long, so the
 * model is searched by typing. With no provider yet it shows `empty`, or the key form.
 */
export function PiModelPicker({
  value,
  onChange,
  empty,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Shown while no provider can be used; the key form when left out. */
  empty?: ReactNode;
}) {
  const c = useColors();
  const { data: providers = [] } = useProviders();
  const configured = providers.filter((p) => p.configured).map((p) => p.id);
  const parts = splitPiModel(value);
  const provider = configured.includes(parts.provider) ? parts.provider : (configured[0] ?? '');
  const model = provider === parts.provider ? parts.model : '';
  const { data: models = [] } = useProviderModels(provider || null);
  if (!configured.length) return <>{empty ?? <ProviderKeyForm />}</>;
  return (
    <View style={styles.root}>
      <View style={[styles.other, { borderColor: c.border, backgroundColor: c.muted }]}>
        <ChoiceRow
          label={t('provider.provider')}
          value={provider}
          options={configured.map((id) => ({
            value: id,
            label: providers.find((p) => p.id === id)?.custom?.name ?? providerName(id),
          }))}
          onChange={(p) => onChange(`${p}/`)}
        />
      </View>
      <ModelSearch value={model} models={models} onChange={(m) => onChange(`${provider}/${m}`)} />
    </View>
  );
}

/**
 * A model name field with the provider's models under it while it has focus, narrowed to those
 * holding what is typed. A name off the list stays allowed: the provider may serve models its
 * list leaves out. Only the first few matches are shown, so the list stays on the screen.
 */
export function ModelSearch({
  value,
  models,
  onChange,
}: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
}) {
  const c = useColors();
  const box = useRef<ComponentRef<typeof View>>(null);
  const scrollTo = usePageScroll();
  const [open, setOpen] = useState(false);
  // What was typed since the field took focus; until then every model is a match.
  const [query, setQuery] = useState('');
  const q = query.toLowerCase();
  const matches = q ? models.filter((m) => m.toLowerCase().includes(q)) : models;
  const shown = matches.slice(0, SHOWN_MODELS);
  const pick = (m: string) => {
    onChange(m);
    setQuery('');
    setOpen(false);
    Keyboard.dismiss();
  };
  return (
    <View ref={box} style={styles.search}>
      <Field
        value={value}
        onFocus={() => {
          setQuery('');
          setOpen(true);
          // The list opens under the field; lift both above the keyboard.
          scrollTo(box.current);
        }}
        onBlur={() => setOpen(false)}
        onChangeText={(v) => {
          const typed = v.trim();
          onChange(typed);
          setQuery(typed);
          setOpen(true);
        }}
        selectTextOnFocus
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        accessibilityLabel={t('provider.model')}
        placeholder={models[0] ?? t('provider.model')}
        style={{ fontFamily: MONO }}
      />
      {open && (shown.length > 0 || q) ? (
        <View style={[styles.list, { borderColor: c.border, backgroundColor: c.card }]}>
          {shown.map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityState={{ selected: m === value }}
              onPress={() => pick(m)}
              style={({ pressed }) => [styles.option, pressed && { backgroundColor: c.accent }]}
            >
              <Text style={[styles.optionText, { color: c.foreground, fontFamily: MONO }]} numberOfLines={1}>
                {m}
              </Text>
              {m === value ? <Feather name="check" size={20} color={c.mutedForeground} /> : null}
            </Pressable>
          ))}
          {matches.length > shown.length ? (
            <Text style={[styles.listNote, { color: c.mutedForeground }]}>
              {t('provider.modelMore', { count: matches.length - shown.length })}
            </Text>
          ) : null}
          {shown.length === 0 ? (
            <Text style={[styles.listNote, { color: c.mutedForeground }]}>{t('provider.modelUnlisted')}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Tries a `provider/model` and stores it for new bots, or as the backup model with `backup`. */
export function useSavePiModel(onSaved?: () => void, backup = false) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (ref: string) => {
      const { provider, model } = splitPiModel(ref);
      const r = await api.testProviderModel(provider, model);
      if (!r.ok) throw new Error(r.detail);
      await api.updateSettings(backup ? { backupModel: ref } : { defaultEngine: 'pi', piModel: ref });
    },
    onMutate: () => setError(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['settings', origin] });
      onSaved?.();
    },
    onError: (e) => setError((e as Error).message),
  });
  return { save, error };
}

const styles = StyleSheet.create({
  code: { fontFamily: MONO, letterSpacing: 3, fontSize: 22 },
  root: { gap: 12 },
  plain: { borderWidth: 0, borderRadius: 0, paddingLeft: 16, paddingRight: 8, paddingVertical: 10 },
  saved: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingLeft: 14,
    paddingRight: 6,
    paddingVertical: 8,
  },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  savedText: { flex: 1, gap: 2, marginLeft: 4 },
  title: { fontSize: 17, fontWeight: '500' },
  sub: { fontSize: 15, lineHeight: 20 },
  other: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  form: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
  formPlain: { borderWidth: 0, borderRadius: 0, padding: 16 },
  area: { height: undefined, minHeight: 72, borderRadius: 12, paddingTop: 12, textAlignVertical: 'top' },
  start: { alignItems: 'flex-start' },
  search: { gap: 6 },
  list: { borderWidth: 1, borderRadius: 12, overflow: 'hidden', paddingVertical: 4 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  optionText: { flex: 1, fontSize: 15 },
  listNote: { fontSize: 15, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 8 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  found: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 12, padding: 12, gap: 8 },
  foundRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  foundText: { flex: 1, fontSize: 17 },
});
