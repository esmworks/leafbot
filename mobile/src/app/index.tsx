import { useQuery } from '@tanstack/react-query';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';
import { Button, FormScreen, Hint, Mark, Title } from '@/components/ui';
import { t } from '@/i18n';
import { WEBSITE_URL } from '@/lib/account';
import { reasonKey } from '@/lib/linkText';
import { useBots, useSettings } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * Opens the right screen for where the phone stands: the connect code when signed out, the list of
 * servers when there is a choice, a word about what is wrong when the account or the server cannot
 * be reached, and once the tunnel is open the first-run questions or the bots.
 */
export default function Start() {
  const server = useServer();
  switch (server.phase) {
    case 'loading':
      return <Waiting />;
    case 'signedOut':
      return <Redirect href="/connect" />;
    case 'choose':
      return <Redirect href="/servers" />;
    case 'accountDown':
      return (
        <State title={t('start.accountDown.title')} text={t('start.accountDown.text')}>
          <Button label={t('common.retry')} onPress={server.refresh} />
          <Button label={t('bots.logout')} variant="ghost" onPress={() => void server.signOut()} />
        </State>
      );
    case 'noServers':
      return (
        <State title={t('start.noServers.title')} text={t('start.noServers.text')}>
          <Button label={t('start.noServers.open')} onPress={() => void Linking.openURL(WEBSITE_URL)} />
          <Button label={t('common.retry')} variant="ghost" onPress={server.refresh} />
          <Button label={t('bots.logout')} variant="ghost" onPress={() => void server.signOut()} />
        </State>
      );
    case 'connecting':
      return <Waiting text={t('link.connecting', { name: server.server?.name ?? '' })} />;
    case 'retrying': {
      const offline = server.reason === 'offline';
      return (
        <State
          title={t(offline ? 'link.offline.title' : 'link.retrying.title', {
            name: server.server?.name ?? '',
          })}
          text={t(reasonKey(server.reason))}
          detail={server.detail}
          busy
        >
          <Button label={t('common.retry')} onPress={server.refresh} />
          <Others />
        </State>
      );
    }
    case 'refused':
      return (
        <State
          title={t('link.refused.title', { name: server.server?.name ?? '' })}
          text={t(reasonKey(server.reason))}
          detail={server.detail}
        >
          <Button label={t('common.retry')} onPress={server.refresh} />
          <Others />
        </State>
      );
    case 'online':
      return <Authed />;
  }
}

/** Choosing another server, when the account has more than one, and signing out. */
function Others() {
  const { servers, signOut } = useServer();
  return (
    <>
      {servers.length > 1 ? (
        <Button label={t('link.otherServer')} variant="ghost" onPress={() => router.push('/servers')} />
      ) : null}
      <Button label={t('bots.logout')} variant="ghost" onPress={() => void signOut()} />
    </>
  );
}

/**
 * The tunnel is open. The server knows the person it proved; if it does not, or cannot be asked,
 * that is said. Then the first-run questions on a server that has no bots and says they were never
 * answered; otherwise the bots. Decided once, so bots made during the questions do not cut them
 * off. A server older than the questions sends no `onboarded` and goes straight to the bots.
 */
function Authed() {
  const { origin, refresh, signOut } = useServer();
  const api = useApi();
  const session = useQuery({ queryKey: ['session', origin], queryFn: api.session });
  const settings = useSettings();
  const bots = useBots();
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  if (session.isPending) return <Waiting />;
  // A failed refresh, as on coming back while the link opens again, keeps the answer it had.
  if (!session.data) {
    return (
      <State title={t('start.noAnswer.title')} text={t('start.noAnswer.text')}>
        <Button label={t('common.retry')} busy={session.isFetching} onPress={() => void session.refetch()} />
        <Button label={t('bots.logout')} variant="ghost" onPress={() => void signOut()} />
      </State>
    );
  }
  if (!session.data.authenticated) {
    return (
      <State title={t('link.refused.title', { name: '' })} text={t('link.reason.access')}>
        <Button label={t('common.retry')} onPress={refresh} />
        <Others />
      </State>
    );
  }
  if (onboarding === null) {
    const first =
      settings.isError || bots.isError
        ? false
        : settings.data && bots.data
          ? settings.data.onboarded === false && bots.data.length === 0
          : null;
    // Adjusting state while rendering: the choice is kept from the first answer on.
    if (first !== null) setOnboarding(first);
    return <Waiting />;
  }
  return <Redirect href={onboarding ? '/onboarding' : '/bots'} />;
}

function State({
  title,
  text,
  detail,
  busy,
  children,
}: {
  title: string;
  text: string;
  /** What the device's WebRTC stack said, small, for whoever is looking into it. */
  detail?: string | null;
  busy?: boolean;
  children: React.ReactNode;
}) {
  const c = useColors();
  return (
    <FormScreen>
      <Mark />
      <Title>{title}</Title>
      <Hint>{text}</Hint>
      {detail ? (
        <Text selectable style={[styles.detail, { color: c.mutedForeground }]}>
          {t('link.detail', { detail })}
        </Text>
      ) : null}
      {busy ? <ActivityIndicator color={c.mutedForeground} /> : null}
      {children}
    </FormScreen>
  );
}

function Waiting({ text }: { text?: string }) {
  const c = useColors();
  return (
    <View style={[styles.center, { backgroundColor: c.background }]}>
      <ActivityIndicator color={c.mutedForeground} />
      {text ? <Hint>{text}</Hint> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  detail: { fontSize: 12, textAlign: 'center' },
});
