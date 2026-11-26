import type { ProviderSignIn, ServerInfo } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { useInCard } from '@/components/card';
import { PillButton } from '@/components/page';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { useClaudeAuth, useInfo } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Connects Claude: signing in with the person's Claude account first, and behind "other ways" a
 * subscription token from `claude setup-token` (run on the server's computer) or an Anthropic API
 * key. Saving a token or key tries it with one real request, so "connected" means Claude answered.
 * Used by the settings and the first-run screen.
 *
 * Props:
 * - `checking`: true while the caller runs a status check, so the line shows it as checking.
 * - `onConnected`: called once a saved credential has been accepted.
 *
 * `useClaudeState()` gives the same status as data: `{ loading, auth, connected, unknown, claude }`
 * (`auth` is null on a server older than the in-app sign-in).
 */

type Method = 'token' | 'apiKey';

/** The command that makes the subscription token; typed on the server's computer, not here. */
const SETUP_COMMAND = 'claude setup-token';

/** The Claude status as one line: which sign-in the server uses and whether it works. */
export function useClaudeState() {
  const { data: info } = useInfo();
  const { data: auth, isLoading } = useClaudeAuth();
  const claude = info?.claude;
  return {
    loading: isLoading || !info,
    /** Null: a server older than the in-app sign-in. */
    auth,
    connected: claude?.status === 'ok',
    /** Not checked since the server started. */
    unknown: !claude || claude.status === 'unknown',
    claude,
  };
}

export function ClaudeConnect({
  checking = false,
  onConnected,
}: {
  checking?: boolean;
  onConnected?: () => void;
}) {
  const c = useColors();
  const inCard = useInCard();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { loading, auth, connected, unknown, claude } = useClaudeState();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  const [method, setMethod] = useState<Method>('token');
  const [value, setValue] = useState('');
  const [gateway, setGateway] = useState('');
  const [result, setResult] = useState<ServerInfo['claude'] | null>(null);
  const refresh = () =>
    Promise.all(
      ['info', 'claude-auth', 'claude-models'].map((k) => qc.invalidateQueries({ queryKey: [k, origin] })),
    );
  const save = useMutation({
    mutationFn: () =>
      api.setClaudeAuth({
        kind: method,
        value: value.trim(),
        ...(method === 'apiKey' && gateway.trim() ? { baseUrl: gateway.trim() } : {}),
      }),
    onSuccess: (r) => {
      setResult(r);
      if (r.status === 'ok') {
        setValue('');
        setOpen(false);
        onConnected?.();
      }
      void refresh();
    },
    onError: (e) => setResult({ status: 'error', detail: (e as Error).message }),
  });
  const clear = useMutation({
    mutationFn: api.clearClaudeAuth,
    onSuccess: () => {
      setResult(null);
      void refresh();
    },
    onError: toastError,
  });

  if (auth === null)
    return <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.oldServer')}</Text>;
  if (loading) return <ActivityIndicator color={c.mutedForeground} />;

  const current =
    auth?.kind === 'token'
      ? t('claude.usingToken', { hint: auth.hint ?? '' })
      : auth?.kind === 'apiKey'
        ? auth.baseUrl
          ? t('claude.usingGateway', { hint: auth.hint ?? '', url: auth.baseUrl })
          : t('claude.usingApiKey', { hint: auth.hint ?? '' })
        : t('claude.usingLogin');
  const pending = checking || unknown;
  const showForm = open || (!connected && !pending);
  const tone = pending ? c.mutedForeground : connected ? c.success : c.amber;

  return (
    <View style={styles.root}>
      {/* On a settings card the card is the frame; on its own the status gets one. */}
      <View style={[styles.status, inCard ? styles.statusBare : { borderColor: c.border }]}>
        <View style={[styles.badge, { backgroundColor: `${tone}26` }]}>
          {checking ? (
            <ActivityIndicator size="small" color={tone} />
          ) : unknown ? (
            <View style={[styles.dot, { backgroundColor: tone }]} />
          ) : (
            <Feather name={connected ? 'check' : 'x'} size={20} color={tone} />
          )}
        </View>
        <View style={styles.statusText}>
          <Text style={[styles.title, { color: c.foreground }]}>
            {checking ? t('claude.checking') : connected || unknown ? current : t('claude.notConnected')}
          </Text>
          {!checking && (unknown || (connected && claude?.detail)) ? (
            <Text style={[styles.muted, { color: c.mutedForeground }]}>
              {unknown ? t('connection.status.unknown') : claude?.detail}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        {!checking && (connected || unknown) && !open ? (
          <PillButton variant="secondary" label={t('claude.useOther')} onPress={() => setOpen(true)} />
        ) : null}
        {auth && auth.kind !== 'login' ? (
          <PillButton
            variant="ghost"
            label={t('claude.remove')}
            onPress={() => clear.mutate()}
            busy={clear.isPending}
          />
        ) : null}
      </View>

      {showForm ? (
        <ClaudeSignIn
          onDone={() => {
            setOpen(false);
            setOther(false);
            setResult(null);
            void refresh();
            onConnected?.();
          }}
        />
      ) : null}
      {showForm && !other ? (
        <Pressable accessibilityRole="button" onPress={() => setOther(true)} hitSlop={8}>
          <Text style={[styles.muted, styles.link, { color: c.mutedForeground }]}>
            {t('claude.otherWays')}
          </Text>
        </Pressable>
      ) : null}
      {showForm && other ? (
        <View style={styles.root}>
          <View style={styles.methods}>
            {(['token', 'apiKey'] as const).map((m) => {
              const on = method === m;
              return (
                <Pressable
                  key={m}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => {
                    setMethod(m);
                    setResult(null);
                  }}
                  style={[
                    styles.method,
                    {
                      borderColor: on ? c.brand : c.border,
                      backgroundColor: on ? `${c.brand}1A` : 'transparent',
                    },
                  ]}
                >
                  <Text style={[styles.title, { color: c.foreground }]}>{t(`claude.method.${m}`)}</Text>
                  <Text style={[styles.muted, { color: c.mutedForeground }]}>
                    {t(`claude.method.${m}Hint`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {method === 'token' ? (
            <View style={styles.root}>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.tokenStep1')}</Text>
              <Text selectable style={[styles.command, { color: c.foreground, backgroundColor: c.muted }]}>
                {SETUP_COMMAND}
              </Text>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.tokenStep2')}</Text>
            </View>
          ) : (
            <View style={styles.root}>
              <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.apiKeyBody')}</Text>
              <Field
                value={gateway}
                onChangeText={(v) => {
                  setGateway(v);
                  setResult(null);
                }}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('claude.gateway')}
                placeholder={t('claude.gatewayPlaceholder')}
              />
            </View>
          )}
          <Field
            value={value}
            onChangeText={(v) => {
              setValue(v);
              setResult(null);
            }}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t(`claude.method.${method}`)}
            placeholder={t(method === 'token' ? 'claude.tokenPlaceholder' : 'claude.apiKeyPlaceholder')}
          />
          <PillButton
            variant="primary"
            label={save.isPending ? t('claude.testing') : t('claude.saveAndTest')}
            onPress={() => save.mutate()}
            busy={save.isPending}
            disabled={!value.trim()}
          />
          {result && result.status !== 'ok' ? (
            <Text style={[styles.muted, { color: c.destructive }]}>
              {result.status === 'logged-out'
                ? t('claude.invalid')
                : t('claude.failed', { detail: result.detail ?? result.reason ?? '' })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {result?.status === 'ok' && !showForm ? (
        <Text style={[styles.muted, { color: c.success }]}>{t('claude.connected')}</Text>
      ) : null}
    </View>
  );
}

/**
 * Signing in with the person's own Claude account, run on the server. The phone is never the
 * computer the server runs on, so the person opens the sign-in page here and pastes back the code
 * the page shows once they have signed in.
 */
function ClaudeSignIn({ onDone }: { onDone: () => void }) {
  const c = useColors();
  const api = useApi();
  const [session, setSession] = useState<ProviderSignIn | null>(null);
  const [pasted, setPasted] = useState('');
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  const start = useMutation({ mutationFn: api.startClaudeSignIn, onSuccess: setSession });
  const live = session && (session.status === 'starting' || session.status === 'waiting');
  const { data: polled } = useQuery({
    queryKey: ['claude-sign-in', session?.id],
    queryFn: () => api.claudeSignIn(session!.id),
    enabled: !!live,
    refetchInterval: 1500,
  });
  const now = polled && polled.id === session?.id ? polled : session;
  const done = now?.status === 'done';
  useEffect(() => {
    if (!done) return;
    toast(t('claude.signInDone'));
    doneRef.current();
  }, [done]);
  // Ends a sign-in left half-way when the form closes.
  useEffect(() => {
    const id = session?.id;
    return () => {
      if (id) void api.cancelClaudeSignIn(id).catch(() => {});
    };
  }, [session?.id, api]);
  const paste = useMutation({
    mutationFn: () => api.pasteClaudeSignIn(now!.id, pasted.trim()),
    onSuccess: (s) => {
      setSession(s);
      setPasted('');
    },
    onError: toastError,
  });
  // The in-app browser keeps this screen under it, so the code is one dismiss away from its field.
  const openPage = async (url: string) => {
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      void Linking.openURL(url);
    }
  };

  if (!now || now.status === 'cancelled' || now.status === 'error' || done) {
    const failed = now?.status === 'error' ? now.error : start.error ? (start.error as Error).message : null;
    return (
      <View style={styles.root}>
        <View style={styles.start}>
          <PillButton
            variant="primary"
            icon="log-in"
            label={t('claude.signIn')}
            onPress={() => start.mutate()}
            busy={start.isPending}
          />
        </View>
        <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.signInPhoneHint')}</Text>
        {failed ? (
          <Text style={[styles.muted, { color: c.destructive }]}>
            {t('claude.signInFailed', { detail: failed })}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={[styles.root, styles.signing, { borderColor: c.border }]}>
      {now.status === 'starting' ? (
        <View style={styles.waiting}>
          <ActivityIndicator size="small" color={c.mutedForeground} />
          <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.signInStarting')}</Text>
        </View>
      ) : (
        <Text style={[styles.muted, { color: c.foreground }]}>{t('claude.signInPhoneOpened')}</Text>
      )}
      {now.url ? (
        <View style={styles.start}>
          <PillButton
            icon="external-link"
            label={t('provider.openSignIn')}
            onPress={() => void openPage(now.url!)}
          />
        </View>
      ) : null}
      {now.needsPaste ? (
        <View style={styles.root}>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>{t('claude.signInPasteHint')}</Text>
          <Field
            value={pasted}
            onChangeText={setPasted}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t('claude.signInPastePlaceholder')}
            placeholder={t('claude.signInPastePlaceholder')}
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
          {now.message ? <Text style={[styles.muted, { color: c.amber }]}>{now.message}</Text> : null}
        </View>
      ) : null}
      <View style={styles.waiting}>
        <ActivityIndicator size="small" color={c.mutedForeground} />
        <Text style={[styles.muted, styles.fill, { color: c.mutedForeground }]}>
          {t('provider.signInWaiting')}
        </Text>
        <PillButton
          variant="ghost"
          label={t('common.cancel')}
          onPress={() => {
            void api.cancelClaudeSignIn(now.id).catch(() => {});
            setSession(null);
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  start: { alignItems: 'flex-start' },
  fill: { flex: 1 },
  link: { textDecorationLine: 'underline' },
  signing: { borderWidth: 1, borderRadius: 16, padding: 16 },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  statusBare: { borderWidth: 0, paddingHorizontal: 0, paddingVertical: 0 },
  badge: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, gap: 2 },
  title: { fontSize: 17, fontWeight: '500' },
  muted: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  methods: { gap: 8 },
  method: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12, gap: 2 },
  command: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontSize: 15,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
});
