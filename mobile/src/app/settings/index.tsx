import { settingsMatch } from '@leafbot/app/src/lib/settingsMatch';
import Feather from '@expo/vector-icons/Feather';
import { Fragment, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Page, Row } from '@/components/page';
import { SECTIONS, SERVER_SECTIONS } from '@/components/settings/sections';
import { Field } from '@/components/ui';
import { t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useManagesServer, useSession } from '@/lib/queries';
import { useColors } from '@/lib/theme';

/** The list of settings sections; the box narrows it to the ones whose name or contents match. */
export default function SettingsList() {
  const c = useColors();
  const [find, setFind] = useState('');
  const manages = useManagesServer();
  // Until the session is known, every section shows, as it did with a single account.
  const known = !!useSession().data?.user;
  const shown = SECTIONS.filter(
    (s) =>
      (!known || manages || !SERVER_SECTIONS.has(s.id)) &&
      settingsMatch(find, `${t(`settings.tab.${s.id}`)} ${t(`settings.keywords.${s.id}`)}`),
  );
  return (
    <Page title={t('settings.title')}>
      <View style={styles.search}>
        <Feather name="search" size={20} color={c.mutedForeground} style={styles.icon} />
        <Field
          value={find}
          onChangeText={setFind}
          placeholder={t('settings.search')}
          accessibilityLabel={t('settings.search')}
          returnKeyType="go"
          onSubmitEditing={() => shown[0] && nav.settings(shown[0].id)}
          style={styles.input}
        />
      </View>
      {/* A plain list, without a card around it, as the web app's phone layout shows it. */}
      <View style={styles.list}>
        {shown.map((s, i) => (
          <Fragment key={s.id}>
            {s.group !== 'own' && s.group !== shown[i - 1]?.group ? (
              <Text style={[styles.group, { color: c.mutedForeground }]} accessibilityRole="header">
                {t(`settings.group.${s.group}`)}
              </Text>
            ) : null}
            <Row icon={s.icon} label={t(`settings.tab.${s.id}`)} onPress={() => nav.settings(s.id)} />
          </Fragment>
        ))}
      </View>
    </Page>
  );
}

const styles = StyleSheet.create({
  // The same search box as the vault's, so every box in settings has one shape.
  search: { marginBottom: 4, justifyContent: 'center' },
  icon: { position: 'absolute', left: 14, zIndex: 1 },
  input: { paddingLeft: 42 },
  list: { marginHorizontal: -8 },
  group: { fontSize: 14, fontWeight: '500', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4 },
});
