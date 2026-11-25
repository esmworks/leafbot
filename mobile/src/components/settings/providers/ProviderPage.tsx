import { newBotEngine, type ModelInfo, type ProviderInfo } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator } from 'react-native';
import { confirm, toast, toastError } from '@/components/overlay';
import { PillButton, Row, Section, Sheet, SwitchRow } from '@/components/page';
import { Field } from '@/components/ui';
import { ChoiceRow, Hint, Pad, Rows, Status, useSaveSettings } from '../common/controls';
import { ClaudeConnect } from '../connect/ClaudeConnect';
import { ModelDefaults } from '../connect/ModelDefaults';
import {
  connectionName,
  EndpointEdit,
  PLAN_ONLY,
  PLANS,
  PlanSignIn,
  useSavePiModel,
} from '../connect/ProviderConnect';
import { KeyField } from './Available';
import {
  CLAUDE,
  claudeState,
  matchesFind,
  useBotCount,
  useClaudeStatus,
  useProviderModelInfo,
  useRoleText,
} from './data';
import { t } from '@/i18n';
import { useClaudeAuth, useInfo, useProviders, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** Models shown before the rest wait for a search; a long list would make the page heavy to scroll. */
const SHOWN_MODELS = 40;

/** One provider's page: its state at the top, then its sign-in and key, and its models. */
export function ProviderPage({ id }: { id: string }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: providers = [] } = useProviders();
  const p = providers.find((x) => x.id === id);
  const claude = id === CLAUDE;
  const name = claude ? t('ai.claude') : p ? connectionName(p) : id;
  const bots = useBotCount(id);
  const roles = useRoleText(id);
  const { status } = useClaudeStatus();
  const check = useMutation({
    mutationFn: api.checkClaude,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['info', origin] }),
    onError: toastError,
  });
  return (
    <>
      <Section>
        <Rows>
          <Row
            label={name}
            detail={[roles, bots ? t('providers.bots', { count: bots }) : t('providers.noBots')]
              .filter(Boolean)
              .join(' · ')}
            right={
              <Status
                state={claude ? claudeState(status) : 'ok'}
                label={t(`connection.status.${claude ? status : 'ok'}`)}
              />
            }
          />
          {claude ? (
            <Row
              icon="refresh-cw"
              label={t('connection.check')}
              onPress={() => check.mutate()}
              busy={check.isPending}
              chevron={false}
            />
          ) : null}
        </Rows>
      </Section>
      {claude ? <ClaudePage checking={check.isPending} /> : p ? <KeyPage provider={p} /> : null}
    </>
  );
}

function ClaudePage({ checking }: { checking: boolean }) {
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
      <Section title={t('providers.signInSection')}>
        <Rows>
          {auth === null ? (
            <Row label={t('connection.claude')} detail={hint} />
          ) : (
            <Pad>
              <ClaudeConnect checking={checking} />
            </Pad>
          )}
        </Rows>
      </Section>
      {settings?.defaultModel !== undefined ? (
        <Section title={t('model.title')}>
          <Rows>
            <Pad>
              <ModelDefaults
                value={{ model: settings.defaultModel, effort: settings.effort ?? '' }}
                onChange={(v) => save.mutate({ defaultModel: v.model, effort: v.effort })}
              />
            </Pad>
            {settings.claudeCompactWindow !== undefined ? <CompactWindow /> : null}
            {settings.idleCompact !== undefined && !!settings.claudeCompactWindow ? (
              <SwitchRow
                label={t('model.idleCompact')}
                detail={t('model.idleCompactHint')}
                value={settings.idleCompact}
                onChange={(v) => save.mutate({ idleCompact: v })}
              />
            ) : null}
          </Rows>
        </Section>
      ) : null}
    </>
  );
}

/** Sizes offered, in tokens; 0 leaves it to Claude. The server starts at the recommended one. */
const COMPACT_CHOICES = [100_000, 150_000, 200_000, 300_000, 400_000, 600_000, 800_000, 1_000_000, 0];
const COMPACT_RECOMMENDED = 200_000;

/** How big a Claude bot's conversation grows before its older part is folded into a summary. */
function CompactWindow() {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const value = settings?.claudeCompactWindow ?? COMPACT_RECOMMENDED;
  // A size another client saved stays listed, so the row never shows empty.
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
    <ChoiceRow
      label={t('model.compact')}
      detail={t('model.compactHint')}
      value={String(value)}
      options={choices.map((n) => ({ value: String(n), label: label(n) }))}
      onChange={(v) => save.mutate({ claudeCompactWindow: Number(v) })}
    />
  );
}

/**
 * A provider other than Claude: how it is reached (its plan, its key or its address), each
 * removable on its own, and the models it offers.
 */
function KeyPage({ provider: p }: { provider: ProviderInfo }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const plan = PLANS.find((x) => x.provider === p.id);
  const [planOpen, setPlanOpen] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const refreshProviders = () => void qc.invalidateQueries({ queryKey: ['providers', origin] });
  const removeKey = useMutation({
    mutationFn: () => api.removeProviderKey(p.id),
    onSuccess: refreshProviders,
    onError: toastError,
  });
  const signOut = useMutation({
    mutationFn: () => api.signOut(p.id),
    onSuccess: refreshProviders,
    onError: toastError,
  });
  const removeEndpoint = useMutation({
    mutationFn: () => api.removeEndpoint(p.id),
    onSuccess: refreshProviders,
    onError: toastError,
  });
  // Asks first only when the provider would be left with no way in, since its bots then stop.
  const confirmRemove = async (last: boolean, run: () => void) => {
    if (
      !last ||
      (await confirm({
        title: t('providers.removeConfirm', { provider: connectionName(p) }),
        confirmLabel: t('common.remove'),
        destructive: true,
      }))
    )
      run();
  };
  return (
    <>
      <Section title={t('providers.signInSection')}>
        <Rows>
          {p.custom && editing ? <EndpointEdit provider={p} plain onDone={() => setEditing(false)} /> : null}
          {p.custom && !editing ? (
            <Row
              label={t('provider.customUrl')}
              detail={`${p.custom.baseUrl}${p.hint ? ` · ${p.hint}` : ''}`}
            />
          ) : null}
          {p.custom && !editing ? (
            <Row
              icon="edit-2"
              label={t('provider.customEdit')}
              onPress={() => setEditing(true)}
              chevron={false}
            />
          ) : null}
          {p.custom && !editing ? (
            <Row
              icon="x"
              label={t('common.remove')}
              destructive
              chevron={false}
              busy={removeEndpoint.isPending}
              onPress={() => void confirmRemove(true, () => removeEndpoint.mutate())}
            />
          ) : null}
          {plan && p.signIn ? (
            <Row
              label={t('providers.plan', { plan: plan.name })}
              detail={p.signIn.signedIn ? t('provider.signedIn') : t('providers.planNone')}
              chevron={false}
              right={
                p.signIn.signedIn ? null : (
                  <PillButton
                    label={planOpen ? t('common.cancel') : t('providers.signIn')}
                    onPress={() => setPlanOpen(!planOpen)}
                  />
                )
              }
            />
          ) : null}
          {plan && p.signIn && !p.signIn.signedIn && planOpen ? (
            <Pad>
              <PlanSignIn plan={plan} onDone={() => setPlanOpen(false)} />
            </Pad>
          ) : null}
          {plan && p.signIn?.signedIn ? (
            <Row
              icon="log-out"
              label={t('provider.signOut')}
              destructive
              chevron={false}
              busy={signOut.isPending}
              onPress={() => void confirmRemove(!p.hint, () => signOut.mutate())}
            />
          ) : null}
          {!p.custom && !PLAN_ONLY.has(p.id) ? (
            <Row
              label={t('providers.key')}
              detail={p.hint ?? t('providers.keyNone')}
              chevron={false}
              right={
                <PillButton
                  label={
                    keyOpen ? t('common.cancel') : p.hint ? t('providers.keyChange') : t('providers.keyAdd')
                  }
                  onPress={() => setKeyOpen(!keyOpen)}
                />
              }
            />
          ) : null}
          {!p.custom && !PLAN_ONLY.has(p.id) && keyOpen ? (
            <Pad>
              <KeyField
                id={p.id}
                onSaved={() => {
                  setKeyOpen(false);
                  toast(t('providers.keySaved'));
                }}
              />
            </Pad>
          ) : null}
          {!p.custom && !PLAN_ONLY.has(p.id) && p.hint ? (
            <Row
              icon="x"
              label={t('common.remove')}
              destructive
              chevron={false}
              busy={removeKey.isPending}
              onPress={() => void confirmRemove(!p.signIn?.signedIn, () => removeKey.mutate())}
            />
          ) : null}
        </Rows>
      </Section>
      <ModelList provider={p} />
    </>
  );
}

/** Context window as a short number: 200K, 1M. */
const shortNumber = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n);

/**
 * The models a provider offers, searchable, each of which can be made what new bots start with
 * or the backup model from here.
 */
function ModelList({ provider: p }: { provider: ProviderInfo }) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: models, isLoading, isError } = useProviderModelInfo(p.id);
  const { data: settings } = useSettings();
  const [find, setFind] = useState('');
  const [menu, setMenu] = useState<ModelInfo | null>(null);
  const newBots = useSavePiModel();
  const backup = useSavePiModel(undefined, true);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useMutation({
    mutationFn: () => api.refreshEndpoint(p.id),
    onSuccess: (list) => {
      void qc.invalidateQueries({ queryKey: ['provider-models', origin, p.id] });
      toast(t('provider.customRefreshed', { count: list.length }));
    },
    onError: toastError,
  });
  const list = models ?? [];
  const shown = list.filter((m) => matchesFind(find, `${m.name} ${m.id}`));
  const ref = (m: ModelInfo) => `${p.id}/${m.id}`;
  const target = newBotEngine(settings);
  const pick = (m: ModelInfo, as: 'new' | 'backup') => {
    const r = ref(m);
    setBusy(r);
    (as === 'new' ? newBots : backup).save.mutate(r, {
      onSuccess: () =>
        toast(
          as === 'new'
            ? t('providers.newBotsSaved', { model: m.name })
            : t('providers.backupSaved', { model: m.name }),
        ),
      onError: (e) => toast(t('provider.failed', { detail: (e as Error).message }), { tone: 'error' }),
      onSettled: () => setBusy(null),
    });
  };
  const menuItems = (m: ModelInfo) => {
    const isNew = target.engine === 'pi' && target.model === ref(m);
    const isBackup = settings?.backupModel === ref(m);
    return [
      ...(settings?.defaultEngine !== undefined
        ? [{ label: t('providers.useForNew'), selected: isNew, onPress: () => !isNew && pick(m, 'new') }]
        : []),
      ...(settings?.backupModel !== undefined
        ? [
            {
              label: t('providers.useAsBackup'),
              selected: isBackup,
              onPress: () => !isBackup && pick(m, 'backup'),
            },
          ]
        : []),
    ];
  };
  return (
    <Section title={models ? `${t('providers.models')} · ${list.length}` : t('providers.models')}>
      <Rows>
        {list.length > 8 ? (
          <Pad>
            <Field
              value={find}
              onChangeText={setFind}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('providers.modelSearch')}
              accessibilityLabel={t('providers.modelSearch')}
            />
          </Pad>
        ) : null}
        {p.custom ? (
          <Row
            icon="refresh-cw"
            label={t('provider.customRefresh')}
            onPress={() => refresh.mutate()}
            busy={refresh.isPending}
            chevron={false}
          />
        ) : null}
        {isLoading ? (
          <Pad>
            <ActivityIndicator color={c.mutedForeground} />
          </Pad>
        ) : isError || !list.length ? (
          <Pad>
            <Hint>{t('providers.modelsNone')}</Hint>
          </Pad>
        ) : !shown.length ? (
          <Pad>
            <Hint>{t('providers.noMatch', { query: find.trim() })}</Hint>
          </Pad>
        ) : (
          shown.slice(0, SHOWN_MODELS).map((m) => {
            const r = ref(m);
            const isNew = target.engine === 'pi' && target.model === r;
            const isBackup = settings?.backupModel === r;
            return (
              <Row
                key={m.id}
                label={m.name}
                detail={[
                  isNew && t('providers.role.newBots'),
                  isBackup && t('providers.role.backup'),
                  m.name !== m.id && m.id,
                  m.contextWindow ? `${t('providers.context')}: ${shortNumber(m.contextWindow)}` : '',
                  m.images && t('providers.images'),
                ]
                  .filter(Boolean)
                  .join(' · ')}
                chevron={false}
                busy={busy === r}
                disabled={!!busy || !menuItems(m).length}
                onPress={() => setMenu(m)}
              />
            );
          })
        )}
        {shown.length > SHOWN_MODELS ? (
          <Pad>
            <Hint>{t('provider.modelMore', { count: shown.length - SHOWN_MODELS })}</Hint>
          </Pad>
        ) : null}
      </Rows>
      <Sheet
        open={!!menu}
        onClose={() => setMenu(null)}
        title={menu?.name}
        items={menu ? menuItems(menu) : []}
      />
    </Section>
  );
}
