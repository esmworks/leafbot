import { PHONE_KINDS, type PhoneKind } from '@leafbot/shared';
import { Linking } from 'react-native';
import { Row, Section } from '@/components/page';
import { toast, toastError } from '@/components/overlay';
import { t } from '@/i18n';
import { usePhoneShare } from '@/lib/phone';
import { expoDevice } from '@/lib/phoneDevice';
import { useServer } from '@/lib/server';
import { CheckRow, Rows } from './common/controls';

const LABEL = {
  calendar: 'phone.calendar',
  contacts: 'phone.contacts',
  location: 'phone.location',
} as const satisfies Record<PhoneKind, string>;

/**
 * What the bots on this server may read from this phone: each kind is off until the person turns
 * it on here, which asks the phone's own permission. The server asks again on a card the first time
 * a bot reads it in a piece of work.
 */
export function PhoneShareSection() {
  const { origin } = useServer();
  const [kinds, set] = usePhoneShare(origin!, expoDevice);
  const toggle = (kind: PhoneKind) =>
    set(kind, !kinds.includes(kind)).then((r) => {
      if (r === 'denied') toast(t('phone.denied'));
    }, toastError);
  return (
    <Section title={t('phone.title')} footer={t('phone.hint')}>
      <Rows>
        {PHONE_KINDS.map((k) => (
          <CheckRow key={k} on={kinds.includes(k)} label={t(LABEL[k])} onPress={() => void toggle(k)} />
        ))}
        <Row icon="settings" label={t('phone.settings')} onPress={() => void Linking.openSettings()} />
      </Rows>
    </Section>
  );
}
