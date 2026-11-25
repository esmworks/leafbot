import type { ApnsSet, ServerInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { toast, toastError } from '@/components/overlay';
import { PillButton, Row, Section } from '@/components/page';
import { Field } from '@/components/ui';
import { Pad, Rows, Status } from './common/controls';
import { deviceName } from './common/text';
import { AccountForm } from './connect/AccountSetup';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useInfo, useManagesServer } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** The "connection" settings section's content, under the section's own title bar. */
export function ConnectionSection() {
  const api = useApi();
  const { origin } = useServer();
  const { data: info } = useInfo();
  // The server's environment and the push key are for those who look after the server.
  const manages = useManagesServer();
  const qc = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  // As the bot list signs out: the server may not hear it, and this phone is signed out anyway.
  const logout = async () => {
    setLeaving(true);
    try {
      await api.logout();
    } catch {
      // The server's session ends on its own.
    }
    await qc.resetQueries();
    setLeaving(false);
    router.replace('/login');
  };
  return (
    <>
      {manages ? (
        <Section title={t('connection.environment')}>
          <Rows>
            <ShellSandboxRow sandbox={info?.shellSandbox} />
            <BrowserRow browser={info?.browser} />
          </Rows>
        </Section>
      ) : null}
      <Section title={t('connection.server')}>
        <Rows>
          <Row label={t('connection.address')} detail={origin} />
          <Row label={t('connection.version')} value={info?.version ?? '…'} />
          <AccountRow />
          <Row icon="repeat" label={t('connection.connectOther')} onPress={() => router.push('/connect')} />
          <Row
            icon="log-out"
            label={t('connection.logoutHere')}
            destructive
            chevron={false}
            busy={leaving}
            onPress={() => void logout()}
          />
        </Rows>
      </Section>
      <Devices />
      {manages ? <ApnsCard /> : null}
    </>
  );
}

function ShellSandboxRow({ sandbox }: { sandbox: ServerInfo['shellSandbox'] | undefined }) {
  const status = sandbox?.status ?? 'unknown';
  // The bwrap error itself is useful; the other reasons say all there is.
  const reason = sandbox?.reason ? t(`sandbox.reason.${sandbox.reason}`) : null;
  const detail =
    sandbox?.reason === 'bwrap-failed' && sandbox.detail
      ? `${reason} (${sandbox.detail})`
      : (reason ?? sandbox?.detail ?? '');
  return (
    <Row
      label={t('sandbox.label')}
      detail={status === 'unavailable' ? t('sandbox.unavailableHint', { detail }) : t('sandbox.okHint')}
      right={
        <Status
          state={status === 'ok' ? 'ok' : status === 'unknown' ? 'unknown' : 'problem'}
          label={t(`sandbox.status.${status}`)}
        />
      }
    />
  );
}

function BrowserRow({ browser }: { browser: ServerInfo['browser'] | undefined }) {
  if (!browser) return null;
  const ok = browser.status === 'ok';
  return (
    <Row
      label={t('browserInfo.label')}
      detail={ok ? t('browserInfo.okHint', { path: browser.detail ?? '' }) : t('browserInfo.missingHint')}
      right={
        <Status state={ok ? 'ok' : 'problem'} label={ok ? t('browserInfo.ok') : t('browserInfo.missing')} />
      }
    />
  );
}

/** The username and password browsers sign in with; hidden on servers older than accounts. */
function AccountRow() {
  const api = useApi();
  const { origin } = useServer();
  const { data, isError } = useQuery({ queryKey: ['account', origin], queryFn: api.account, retry: false });
  const [open, setOpen] = useState(false);
  if (isError || !data) return null;
  return (
    <View>
      <Row
        label={t('account.title')}
        value={data.username}
        detail={data.username ? null : t('account.none')}
        onPress={() => setOpen((v) => !v)}
      />
      {open ? (
        <Pad>
          <AccountForm
            username={data.username ?? ''}
            change={data.username !== null}
            onDone={() => {
              setOpen(false);
              toast(t('account.saved'));
            }}
          />
        </Pad>
      ) : null}
    </View>
  );
}

/** The browsers and apps signed in to this server, each of which can be signed out from here. */
function Devices() {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: ['sessions', origin], queryFn: api.sessions });
  const end = useMutation({
    mutationFn: api.endSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', origin] }),
    onError: toastError,
  });
  if (!sessions?.length) return null;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Section title={t('devices.title')} footer={t('devices.othersHint')}>
      <Rows>
        {sessions.map((s) => {
          const { app, os } = deviceName(s.userAgent);
          const name = app && os ? t('devices.appOnOs', { app, os }) : (app ?? os ?? t('devices.unknown'));
          return (
            <Row
              key={s.id}
              label={name}
              detail={t('devices.lastSeen', { when: fmt.dayLabel(s.lastSeenAt) })}
              right={
                s.current ? (
                  <Text style={[styles.small, { color: c.mutedForeground }]}>{t('devices.this')}</Text>
                ) : (
                  <Pressable
                    accessibilityRole="button"
                    hitSlop={10}
                    onPress={() => end.mutate(s.id)}
                    disabled={end.isPending}
                    style={({ pressed }) => pressed && { opacity: 0.6 }}
                  >
                    <Text style={[styles.small, { color: c.destructive }]}>{t('devices.signOut')}</Text>
                  </Pressable>
                )
              }
            />
          );
        })}
        {others > 1 ? (
          <Row
            icon="log-out"
            label={t('devices.signOutOthers')}
            destructive
            chevron={false}
            disabled={end.isPending}
            onPress={() => end.mutate('others')}
          />
        ) : null}
      </Rows>
    </Section>
  );
}

const useApns = () => {
  const api = useApi();
  const { origin } = useServer();
  return useQuery({ queryKey: ['apns', origin], queryFn: api.apns });
};

/**
 * The Apple key that lets this server notify the iPhone app. A self-hosted server sends straight
 * to Apple, so the key belongs to whoever built and installed the app.
 */
function ApnsCard() {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: apns } = useApns();
  const [editing, setEditing] = useState(false);
  const done = (status: unknown) => {
    qc.setQueryData(['apns', origin], status);
    setEditing(false);
  };
  const clear = useMutation({ mutationFn: api.clearApns, onSuccess: done, onError: toastError });
  if (!apns) return null;
  return (
    <Section title={t('apns.title')}>
      <Rows>
        <Row
          label={t('apns.key')}
          detail={
            apns.configured
              ? t('apns.configured', {
                  team: apns.teamId ?? '',
                  key: apns.keyId ?? '',
                  bundle: apns.bundleId ?? '',
                })
              : t('apns.hint')
          }
        />
        {!editing ? (
          <Row
            icon={apns.configured ? 'edit-2' : 'plus'}
            label={apns.configured ? t('apns.change') : t('apns.add')}
            onPress={() => setEditing(true)}
          />
        ) : null}
        {!editing && apns.configured ? (
          <Row
            icon="trash-2"
            label={t('apns.remove')}
            destructive
            chevron={false}
            busy={clear.isPending}
            onPress={() => clear.mutate()}
          />
        ) : null}
        {editing ? (
          <ApnsForm
            initial={{ teamId: apns.teamId ?? '', keyId: apns.keyId ?? '', bundleId: apns.bundleId ?? '' }}
            onSaved={done}
            onCancel={() => setEditing(false)}
          />
        ) : null}
      </Rows>
    </Section>
  );
}

function ApnsForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: Omit<ApnsSet, 'key'>;
  onSaved: (status: unknown) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const [form, setForm] = useState<ApnsSet>({ ...initial, key: '' });
  const set = (k: keyof ApnsSet) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const save = useMutation({ mutationFn: () => api.setApns(form), onSuccess: onSaved, onError: toastError });
  const pickFile = async () => {
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const uri = r.assets?.[0]?.uri;
    if (r.canceled || !uri) return;
    try {
      const text = await (await fetch(uri)).text();
      setForm((s) => ({ ...s, key: text }));
    } catch (e) {
      toastError(e);
    }
  };
  const ready = !!form.teamId.trim() && !!form.keyId.trim() && !!form.bundleId.trim() && !!form.key.trim();
  return (
    <Pad>
      <Field
        value={form.teamId}
        onChangeText={set('teamId')}
        placeholder={t('apns.teamId')}
        accessibilityLabel={t('apns.teamId')}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Field
        value={form.keyId}
        onChangeText={set('keyId')}
        placeholder={t('apns.keyId')}
        accessibilityLabel={t('apns.keyId')}
        autoCapitalize="characters"
        autoCorrect={false}
      />
      <Field
        value={form.bundleId}
        onChangeText={set('bundleId')}
        placeholder={t('apns.bundleId')}
        accessibilityLabel={t('apns.bundleId')}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Field
        value={form.key}
        onChangeText={set('key')}
        placeholder={t('apns.keyPlaceholder')}
        accessibilityLabel={t('apns.keyFile')}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.area}
      />
      <View style={styles.tryRow}>
        <PillButton icon="file-plus" label={t('apns.pickFile')} onPress={() => void pickFile()} />
        <PillButton variant="ghost" label={t('common.cancel')} onPress={onCancel} />
        <PillButton
          variant="primary"
          label={t('common.save')}
          onPress={() => save.mutate()}
          busy={save.isPending}
          disabled={!ready}
        />
      </View>
    </Pad>
  );
}

const styles = StyleSheet.create({
  small: { fontSize: 15, lineHeight: 20 },
  tryRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  area: { height: undefined, minHeight: 110, paddingTop: 12, textAlignVertical: 'top' },
});
