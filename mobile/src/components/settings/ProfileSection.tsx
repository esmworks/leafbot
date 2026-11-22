import type { ProfileFocus, ProfileHelp } from '@leafbot/shared';
import { StyleSheet, Text, View } from 'react-native';
import { Loading, Section, SwitchRow } from '@/components/page';
import { CheckRow, ChoiceRow, Hint, Pad, Rows, SavedField, useSaveSettings } from './common/controls';
import { t } from '@/i18n';
import { useSettings } from '@/lib/queries';
import { useColors } from '@/lib/theme';

/** The answers the server stores; the shared lists are runtime values the phone app may not import. */
const FOCUS: ProfileFocus[] = ['work', 'personal', 'both'];
const HELP: ProfileHelp[] = ['research', 'writing', 'documents', 'web', 'planning', 'code', 'learning'];

/** The "profile" settings section's content, under the section's own title bar. */
export function ProfileSection() {
  const c = useColors();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  if (!settings) return <Loading />;
  // Servers older than the profile keep only the name.
  const old = settings.onboarded === undefined;
  const helpWith = settings.helpWith ?? [];
  return (
    <>
      {old ? (
        <View style={[styles.old, { backgroundColor: c.amberSoft }]}>
          <Text style={[styles.oldText, { color: c.amber }]}>{t('profile.oldServer')}</Text>
        </View>
      ) : null}
      <Section title={t('profile.section.you')}>
        <Rows>
          <Pad>
            <SavedField
              label={t('profile.name')}
              hint={t('profile.nameHint')}
              value={settings.userName}
              max={80}
              onSave={(userName) => save.mutate({ userName })}
            />
          </Pad>
          {!old ? (
            <Pad>
              <SavedField
                label={t('profile.addressAs')}
                hint={t('profile.addressAsHint')}
                value={settings.addressAs ?? ''}
                max={60}
                placeholder={settings.userName.trim().split(/\s+/)[0]}
                onSave={(addressAs) => save.mutate({ addressAs })}
              />
            </Pad>
          ) : null}
          {!old ? (
            <Pad>
              <SavedField
                label={t('profile.occupation')}
                value={settings.occupation ?? ''}
                max={200}
                placeholder={t('profile.occupationPlaceholder')}
                onSave={(occupation) => save.mutate({ occupation })}
              />
            </Pad>
          ) : null}
        </Rows>
      </Section>
      {!old ? (
        <>
          <Section title={t('profile.section.use')}>
            <Rows>
              <ChoiceRow
                label={t('profile.focus')}
                value={settings.focus ?? ''}
                placeholder={t('profile.focus.unset')}
                options={FOCUS.map((f) => ({ value: f, label: t(`profile.focus.${f}`) }))}
                onChange={(focus) => save.mutate({ focus })}
              />
            </Rows>
          </Section>
          <Section title={t('profile.helpWith')}>
            <Rows>
              {HELP.map((h) => (
                <CheckRow
                  key={h}
                  on={helpWith.includes(h)}
                  label={t(`profile.help.${h}`)}
                  onPress={() =>
                    save.mutate({
                      helpWith: helpWith.includes(h)
                        ? helpWith.filter((x) => x !== h)
                        : HELP.filter((x) => x === h || helpWith.includes(x)),
                    })
                  }
                />
              ))}
            </Rows>
          </Section>
          <Section title={t('profile.section.about')}>
            <Pad>
              <SavedField
                label={t('profile.about')}
                bare
                value={settings.aboutMe ?? ''}
                max={2000}
                multiline
                placeholder={t('profile.aboutPlaceholder')}
                onSave={(aboutMe) => save.mutate({ aboutMe })}
              />
              <Hint>{t('profile.aboutHint')}</Hint>
            </Pad>
          </Section>
          {/* A server older than the suggestions does not offer them. */}
          {settings.routineSuggestions !== undefined ? (
            <Section title={t('routineSuggest.setting.title')} footer={t('routineSuggest.setting.hint')}>
              <SwitchRow
                label={t('routineSuggest.setting.on')}
                value={settings.routineSuggestions}
                onChange={(routineSuggestions) => save.mutate({ routineSuggestions })}
              />
            </Section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  old: { borderRadius: 16, paddingHorizontal: 16, paddingVertical: 12 },
  oldText: { fontSize: 16, lineHeight: 22 },
});
