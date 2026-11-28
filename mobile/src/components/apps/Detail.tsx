import { addressKey, catalogEntry, isMailUrl, type Connection } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { askText, confirm, toast, toastError } from '@/components/overlay';
import { AppLogo } from '@/components/panel/AppLogo';
import {
  back,
  LabeledInput,
  Loading,
  Note,
  Page,
  PillButton,
  Row,
  Section,
  Sheet,
  SwitchRow,
} from '@/components/page';
import { t } from '@/i18n';
import { ordered } from '@/lib/bots';
import { nav } from '@/lib/nav';
import { useBots, useConnections } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { RequestHeaders } from './RequestHeaders';
import { openSignIn, openTo, STATUS_KEY, StatusLine, useConnectionBots, useToggleBot } from './shared';

/** One connection: its status and sign-in, accounts, which bots may use it, and its tools. */
export function Detail({ id }: { id: string }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: connections, isLoading } = useConnections();
  const conn = connections?.find((x) => x.id === id);
  const [signInUrl, setSignInUrl] = useState<string>();
  const [token, setToken] = useState('');
  const done = () => qc.invalidateQueries({ queryKey: ['connections', origin] });

  const signIn = useMutation({
    mutationFn: () => api.signInConnection(id),
    onSuccess: (r) => {
      void done();
      if (r.url) {
        setSignInUrl(r.url);
        void openSignIn(r.url, qc, origin);
      }
    },
    onError: toastError,
  });
  const signOut = useMutation({
    mutationFn: () => api.signOutConnection(id),
    onSuccess: done,
    onError: toastError,
  });
  const refresh = useMutation({
    mutationFn: () => api.refreshConnection(id),
    onSuccess: (r) => {
      void done();
      if (r.status === 'connected') toast(t('apps.refreshed', { count: r.tools.length }));
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.removeConnection(id),
    onSuccess: () => {
      void done();
      back();
    },
    onError: toastError,
  });
  const saveToken = useMutation({
    // A mail account's password goes as typed: a space at either end may be part of it.
    mutationFn: () =>
      api.updateConnection(id, conn && isMailUrl(conn.url) ? { password: token } : { token: token.trim() }),
    onSuccess: () => {
      setToken('');
      void done();
    },
    onError: toastError,
  });

  if (!conn) {
    return <Page title={t('apps.title')}>{isLoading ? <Loading /> : <Note>{t('apps.gone')}</Note>}</Page>;
  }
  const entry = catalogEntry(conn.catalogId);
  // Every account of a catalog service that signs in, this one among them.
  const accounts =
    entry && entry.auth !== 'none'
      ? (connections ?? []).filter(
          (x) => x.catalogId === conn.catalogId && addressKey(x.url) === addressKey(conn.url),
        )
      : [];
  const connected = conn.status === 'connected';
  const title = entry && accounts.length ? entry.name : conn.name;

  return (
    <Page title={title}>
      <View style={styles.head}>
        <AppLogo id={conn.catalogId} name={title} size={44} />
        <View style={styles.headText}>
          {accounts.length > 1 ? (
            <Text style={[styles.accountName, { color: c.foreground }]} numberOfLines={1}>
              {conn.name}
            </Text>
          ) : null}
          <Text style={[styles.url, { color: c.mutedForeground }]} numberOfLines={2}>
            {conn.url}
          </Text>
          <StatusLine text={t(STATUS_KEY[conn.status])} tone={connected ? 'ok' : 'warn'} />
        </View>
      </View>

      {entry && accounts.length > 0 ? (
        <Section title={t('apps.accounts')}>
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} current={a.id === conn.id} />
          ))}
          <Row
            icon="plus"
            label={t('apps.addAccount')}
            onPress={() => nav.apps({ catalogId: entry.id, connectionId: conn.id })}
          />
        </Section>
      ) : null}

      <Section>
        {conn.auth === 'oauth' && !connected ? (
          <Row
            icon="log-in"
            label={t('apps.signIn')}
            busy={signIn.isPending}
            onPress={() => signIn.mutate()}
          />
        ) : null}
        {conn.auth === 'oauth' && connected ? (
          <Row
            icon="log-out"
            label={t('apps.signOut')}
            busy={signOut.isPending}
            onPress={() => signOut.mutate()}
          />
        ) : null}
        <Row
          icon="refresh-cw"
          label={t('apps.refresh')}
          busy={refresh.isPending}
          onPress={() => refresh.mutate()}
        />
        <Row
          icon="trash-2"
          label={t('common.remove')}
          destructive
          busy={remove.isPending}
          chevron={false}
          onPress={() =>
            void confirm({
              title: t('apps.confirmRemove', { name: conn.name }),
              confirmLabel: t('common.remove'),
              destructive: true,
            }).then((ok) => ok && remove.mutate())
          }
        />
      </Section>

      {!connected && signInUrl && conn.auth === 'oauth' ? (
        <View style={[styles.callout, { backgroundColor: c.muted }]}>
          <Text style={[styles.text, { color: c.foreground }]}>
            {t('apps.waitingSignIn')}{' '}
            <Text style={styles.link} onPress={() => void Linking.openURL(signInUrl)}>
              {t('apps.openSignIn')}
            </Text>
          </Text>
        </View>
      ) : null}
      {conn.error ? (
        <View style={[styles.callout, { backgroundColor: c.destructive + '1A' }]}>
          <Text style={[styles.text, { color: c.destructive }]} selectable>
            {conn.error}
          </Text>
        </View>
      ) : null}
      {conn.auth === 'oauth' && !connected && entry?.client && !conn.clientId ? (
        <Text style={[styles.text, { color: c.mutedForeground }]}>
          {t('apps.clientNeeded', { name: conn.name })}{' '}
          <Text style={styles.link} onPress={() => void Linking.openURL(entry.client!.help)}>
            {t('apps.clientWhere')}
          </Text>
        </Text>
      ) : null}

      {conn.auth === 'token' ? (
        <View style={styles.tokenForm}>
          <LabeledInput
            label={conn.hasToken ? t('apps.newToken') : t('apps.token')}
            value={token}
            onChangeText={setToken}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            placeholder={conn.hasToken ? '••••••••' : undefined}
          />
          <View style={styles.tokenSave}>
            <PillButton
              label={t('common.save')}
              variant="primary"
              disabled={!token.trim()}
              busy={saveToken.isPending}
              onPress={() => saveToken.mutate()}
            />
          </View>
        </View>
      ) : null}

      <RequestHeaders connection={conn} />
      <BotAccess connection={conn} />
      <AppViews connection={conn} />
      <Tools connection={conn} />
    </Page>
  );
}

/** One account of a service: tap to open it, the pencil renames it. */
function AccountRow({ account: a, current }: { account: Connection; current: boolean }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const rename = useMutation({
    mutationFn: (next: string) => api.updateConnection(a.id, { name: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections', origin] }),
    onError: toastError,
  });
  const edit = async () => {
    const next = await askText({ title: t('apps.accountName'), initial: a.name, maxLength: 80 });
    if (next && next.trim() && next.trim() !== a.name) rename.mutate(next.trim());
  };
  const ok = a.status === 'connected';
  return (
    <View style={[styles.account, current && { backgroundColor: c.accent }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: current }}
        disabled={current}
        onPress={() => router.replace({ pathname: '/apps', params: { connectionId: a.id } })}
        style={styles.accountMain}
      >
        <Text style={[styles.accountLabel, { color: c.foreground }]} numberOfLines={1}>
          {a.name}
        </Text>
        <StatusLine text={t(STATUS_KEY[a.status])} tone={ok ? 'ok' : 'warn'} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('apps.rename')}
        hitSlop={8}
        onPress={() => void edit()}
      >
        <Feather name="edit-2" size={20} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

/** Every bot by default; turned off, a switch per bot. */
function BotAccess({ connection: conn }: { connection: Connection }) {
  const set = useConnectionBots();
  const { data: bots = [] } = useBots();
  const live = ordered(bots);
  return (
    <Section title={t('apps.bots')}>
      <SwitchRow
        label={t('apps.allBots')}
        detail={conn.allBots ? t('apps.allBotsHint') : t('apps.someBotsHint')}
        value={conn.allBots}
        disabled={set.isPending}
        // Narrowing starts from every bot, so nothing changes until one is turned off.
        onChange={(all) => set.mutate({ c: conn, allBots: all, botIds: all ? [] : live.map((b) => b.id) })}
      />
      {!conn.allBots ? (
        live.length === 0 ? (
          <Row label={t('apps.noBots')} />
        ) : (
          live.map((b) => (
            <BotSwitch
              key={b.id}
              name={b.name}
              color={b.color}
              avatar={b.avatar}
              botId={b.id}
              connection={conn}
            />
          ))
        )
      ) : null}
    </Section>
  );
}

function BotSwitch({
  name,
  color,
  avatar,
  botId,
  connection,
}: {
  name: string;
  color: string;
  avatar: string;
  botId: string;
  connection: Connection;
}) {
  const c = useColors();
  const toggle = useToggleBot();
  return (
    <View style={styles.botRow}>
      <Avatar name={name} color={color} avatar={avatar} size={28} />
      <Text style={[styles.botName, { color: c.foreground }]} numberOfLines={1}>
        {name}
      </Text>
      <Switch
        value={openTo(connection, botId)}
        disabled={toggle.isPending}
        onValueChange={(on) => toggle.mutate({ c: connection, botId, on })}
        trackColor={{ true: c.primary, false: c.muted }}
        thumbColor={openTo(connection, botId) ? c.primaryForeground : undefined}
        accessibilityLabel={name}
      />
    </View>
  );
}

/** Whether the app's tools show their own views (MCP apps) in the conversation; only when some have one. */
function AppViews({ connection: conn }: { connection: Connection }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const set = useMutation({
    mutationFn: (on: boolean) => api.updateConnection(conn.id, { showApps: on }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections', origin] }),
    onError: toastError,
  });
  if (!conn.tools.some((x) => x.app)) return null;
  return (
    <Section>
      <SwitchRow
        label={t('apps.views')}
        detail={t('apps.viewsHint')}
        value={conn.showApps !== false}
        disabled={set.isPending}
        onChange={(on) => set.mutate(on)}
      />
    </Section>
  );
}

/** The server's tools, folded away behind a count until the person wants to change one. */
function Tools({ connection: conn }: { connection: Connection }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const reads = conn.tools.filter((x) => x.kind === 'read').length;
  const off = conn.tools.filter((x) => !x.enabled).length;
  if (conn.tools.length === 0) {
    return (
      <Section title={t('apps.tools', { count: 0 })}>
        <Row
          label={conn.status === 'connected' ? t('apps.noTools') : t('apps.toolsAfterSignIn')}
          chevron={false}
        />
      </Section>
    );
  }
  return (
    <View style={styles.tools}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.toolsHead}
      >
        <Feather name={open ? 'chevron-down' : 'chevron-right'} size={22} color={c.foreground} />
        <View style={styles.toolsText}>
          <Text style={[styles.toolsTitle, { color: c.foreground }]}>
            {t('apps.tools', { count: conn.tools.length })}
          </Text>
          <Text style={[styles.toolsSummary, { color: c.mutedForeground }]}>
            {t('apps.toolsSummary', { read: reads, write: conn.tools.length - reads })}
            {off > 0 ? ` · ${t('apps.toolsOff', { count: off })}` : ''}
          </Text>
        </View>
      </Pressable>
      {open ? (
        <>
          <Note>{t('apps.toolsHint')}</Note>
          <Section>
            {conn.tools.map((tool) => (
              <ToolRow key={tool.name} connection={conn} tool={tool} />
            ))}
          </Section>
        </>
      ) : null}
    </View>
  );
}

function ToolRow({ connection, tool }: { connection: Connection; tool: Connection['tools'][number] }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const [sheet, setSheet] = useState(false);
  const set = useMutation({
    mutationFn: (patch: { enabled?: boolean; kind?: 'read' | 'write' }) =>
      api.setConnectionTool(connection.id, tool.name, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['connections', origin] }),
    onError: toastError,
  });
  return (
    <View style={[styles.tool, !tool.enabled && { opacity: 0.6 }]}>
      <View style={styles.toolMain}>
        <Text style={[styles.toolName, { color: c.foreground }]} numberOfLines={1}>
          {tool.title ?? tool.name}
        </Text>
        {tool.description ? (
          <Text style={[styles.toolDesc, { color: c.mutedForeground }]} numberOfLines={2}>
            {tool.description}
          </Text>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('apps.toolKind')}
          onPress={() => setSheet(true)}
          style={[styles.kind, { backgroundColor: c.muted }]}
        >
          <Text style={[styles.kindText, { color: c.foreground }]}>{t(`apps.kind.${tool.kind}`)}</Text>
          <Feather name="chevron-down" size={16} color={c.mutedForeground} />
        </Pressable>
      </View>
      <Switch
        value={tool.enabled}
        onValueChange={(v) => set.mutate({ enabled: v })}
        trackColor={{ true: c.primary, false: c.muted }}
        thumbColor={tool.enabled ? c.primaryForeground : undefined}
        accessibilityLabel={t('apps.toolEnabled')}
      />
      <Sheet
        open={sheet}
        onClose={() => setSheet(false)}
        title={t('apps.toolKind')}
        items={(['read', 'write'] as const).map((k) => ({
          label: t(`apps.kind.${k}`),
          selected: tool.kind === k,
          onPress: () => set.mutate({ kind: k }),
        }))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headText: { flex: 1, gap: 3 },
  accountName: { fontSize: 17, fontWeight: '600' },
  url: { fontSize: 15 },
  callout: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  text: { fontSize: 16, lineHeight: 22 },
  link: { textDecorationLine: 'underline' },
  tokenForm: { gap: 10 },
  tokenSave: { alignItems: 'flex-end' },
  account: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  accountMain: { flex: 1, gap: 2, paddingVertical: 8 },
  accountLabel: { fontSize: 17, fontWeight: '500' },
  botRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  botName: { flex: 1, fontSize: 17 },
  tools: { gap: 8 },
  toolsHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, minHeight: 44 },
  toolsText: { flex: 1, gap: 2 },
  toolsTitle: { fontSize: 17, fontWeight: '600' },
  toolsSummary: { fontSize: 15 },
  tool: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  toolMain: { flex: 1, gap: 4 },
  toolName: { fontSize: 15, fontWeight: '600', fontFamily: 'Courier' },
  toolDesc: { fontSize: 15, lineHeight: 20 },
  kind: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 12,
    marginTop: 2,
  },
  kindText: { fontSize: 15 },
});
