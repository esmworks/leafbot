import type { Locale } from '@leafbot/shared/i18n';
import { LOCALE_NAMES, LOCALES } from '@leafbot/shared/i18n';
import { useState } from 'react';
import { Keyboard, StyleSheet, Text, View } from 'react-native';
import { Loading, Row, Section } from '@/components/page';
import { ChoiceRow, Pad, Rows, useSaveSettings } from './common/controls';
import { NotificationsSection } from './NotificationsSection';
import { PhoneShareSection } from './PhoneShareSection';
import { Field } from '@/components/ui';
import { locale, t } from '@/i18n';
import { useSettings } from '@/lib/queries';
import { useColors, useTheme, useTone, type ThemeChoice } from '@/lib/theme';
import { TONES, type ToneChoice } from '@/lib/tone';

/** Used when the phone's runtime cannot list every time zone. */
const COMMON_ZONES = [
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Europe/Athens',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Tehran',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Africa/Cairo',
  'Africa/Lagos',
  'Africa/Johannesburg',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Mexico_City',
  'UTC',
];

/** Every time zone the runtime knows, for suggestions. */
const ZONES: string[] = (() => {
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
      'timeZone',
    );
    return list?.length ? [...list, 'UTC'] : COMMON_ZONES;
  } catch {
    return COMMON_ZONES;
  }
})();

const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
})();

/** The bots' time zone: typed with matching zones offered under the box; the device's zone is offered too. */
function TimeZoneField({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  const c = useColors();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const typed = (draft ?? '').trim().toLowerCase();
  const matches = typed
    ? ZONES.filter((z) => z.toLowerCase().includes(typed) && z !== value).slice(0, 6)
    : [];
  const pick = (zone: string) => {
    if (zone !== value) onChange(zone);
    setDraft(null);
    Keyboard.dismiss();
  };
  const commit = () => {
    if (draft === null) return;
    const zone = ZONES.find((z) => z.toLowerCase() === draft.trim().toLowerCase());
    if (zone) pick(zone);
    else setDraft(null);
  };
  return (
    <Pad>
      <Text style={[styles.label, { color: c.foreground }]}>{t('general.timezone')}</Text>
      <Field
        value={shown}
        onChangeText={setDraft}
        onBlur={commit}
        onSubmitEditing={commit}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="done"
        accessibilityLabel={t('general.timezone')}
      />
      {matches.length > 0 ? (
        <View style={[styles.matches, { borderColor: c.border }]}>
          <Rows>
            {matches.map((z) => (
              <Row key={z} label={z} chevron={false} onPress={() => pick(z)} />
            ))}
          </Rows>
        </View>
      ) : null}
      {deviceZone && deviceZone !== value && ZONES.includes(deviceZone) ? (
        <Text
          style={[styles.use, { color: c.mutedForeground }]}
          onPress={() => pick(deviceZone)}
          accessibilityRole="button"
        >
          {t('general.useDeviceZone', { zone: deviceZone })}
        </Text>
      ) : null}
    </Pad>
  );
}

/** The "general" settings section's content, under the section's own title bar. */
export function GeneralSection() {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [theme, setTheme] = useTheme();
  const [tone, setTone] = useTone();
  if (!settings) return <Loading />;
  return (
    <>
      <Section title={t('general.appearance')} footer={t('settings.languageHint')}>
        <Rows>
          <ChoiceRow<ThemeChoice>
            icon="moon"
            label={t('general.theme')}
            value={theme}
            options={[
              { value: 'system', label: t('general.theme.system') },
              { value: 'light', label: t('general.theme.light') },
              { value: 'dark', label: t('general.theme.dark') },
            ]}
            onChange={setTheme}
          />
          <ChoiceRow<ToneChoice>
            icon="droplet"
            label={t('general.tone')}
            value={tone}
            options={TONES.map((value) => ({ value, label: t(`general.tone.${value}`) }))}
            onChange={setTone}
          />
          <ChoiceRow<Locale>
            icon="globe"
            label={t('common.language')}
            value={settings.language ?? locale}
            options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))}
            onChange={(language) => save.mutate({ language })}
          />
        </Rows>
      </Section>
      <Section title={t('general.bots')} footer={t('general.timezoneHint')}>
        <TimeZoneField
          value={settings.timezone || 'Europe/Istanbul'}
          onChange={(timezone) => save.mutate({ timezone })}
        />
      </Section>
      <NotificationsSection />
      <PhoneShareSection />
    </>
  );
}

const styles = StyleSheet.create({
  matches: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  label: { fontSize: 17 },
  use: { fontSize: 15, paddingHorizontal: 4 },
});
