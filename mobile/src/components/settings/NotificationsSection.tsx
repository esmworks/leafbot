import type { PushLevel } from '@leafbot/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Linking } from 'react-native';
import { Row, Section, SwitchRow } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { t } from '@/i18n';
import { liveActivitiesSupported, useLiveActivityChoice } from '@/lib/liveActivity';
import { pushSupported, usePushLevel, usePushPermission, usePushToken } from '@/lib/push';
import { useApi, useServer } from '@/lib/server';
import { ChoiceRow, Rows } from './common/controls';

/**
 * Which notices reach this phone while the app is closed, whether the phone allows them, and a
 * test through the server and Apple. The server needs the Apple key (Connection) to send at all.
 */
export function NotificationsSection() {
  if (!pushSupported) return null;
  return <Notifications />;
}

function Notifications() {
  const api = useApi();
  const { origin } = useServer();
  const [level, setLevel] = usePushLevel();
  const [permission, ask] = usePushPermission();
  const token = usePushToken();
  const [live, setLive] = useLiveActivityChoice();
  const apns = useQuery({ queryKey: ['apns', origin], queryFn: api.apns });
  const test = useMutation({
    mutationFn: () => api.pushTest(token!),
    onSuccess: () => toast(t('push.testSent')),
    onError: toastError,
  });
  const footer = apns.data && !apns.data.configured ? t('push.noKey') : t('push.hint');
  return (
    <Section title={t('notify.title')} footer={footer}>
      <Rows>
        <ChoiceRow<PushLevel>
          icon="bell"
          label={t('notify.level')}
          value={level}
          options={[
            { value: 'all', label: t('notify.level.all') },
            { value: 'needsYou', label: t('notify.level.needsYou') },
            { value: 'off', label: t('notify.level.off') },
          ]}
          onChange={setLevel}
        />
        {permission === 'denied' ? (
          <Row
            icon="bell-off"
            label={t('push.blocked')}
            detail={t('push.blockedHint')}
            onPress={() => void Linking.openSettings()}
          />
        ) : null}
        {permission === 'undetermined' && level !== 'off' ? (
          <Row icon="bell" label={t('push.allow')} onPress={() => void ask().catch(toastError)} />
        ) : null}
        {permission === 'granted' && token && level !== 'off' ? (
          <Row
            icon="send"
            label={t('notify.testButton')}
            busy={test.isPending}
            disabled={test.isPending}
            onPress={() => test.mutate()}
          />
        ) : null}
        {liveActivitiesSupported() ? (
          <SwitchRow
            icon="lock"
            label={t('liveActivity.title')}
            detail={t('liveActivity.hint')}
            value={live}
            onChange={setLive}
          />
        ) : null}
      </Rows>
    </Section>
  );
}
