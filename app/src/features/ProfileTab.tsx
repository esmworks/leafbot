import { PROFILE_FOCUS, PROFILE_HELP, type ProfileFocus } from '@leafbot/shared';
import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { useSettings } from '@/lib/queries';
import { Chip } from './onboarding/Chip';
import { Card, Row, useSaveSettings } from './SettingsDialog';
import { SlackLinkCard } from './SlackCards';
import { TeamsLinkCard } from './TeamsCards';

/** What the person told LeafBot about themselves; every bot reads it. */
export function ProfileTab() {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  if (!settings) return null;
  // Servers older than the profile keep only the name.
  const old = settings.onboarded === undefined;
  const helpWith = settings.helpWith ?? [];
  return (
    <>
      {old && (
        <p className="mb-6 rounded-2xl bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-400">
          {t('profile.oldServer')}
        </p>
      )}
      <Card title={t('profile.section.you')}>
        <Row label={t('profile.name')} hint={t('profile.nameHint')}>
          <TextSetting
            value={settings.userName}
            max={80}
            label={t('profile.name')}
            onSave={(userName) => save.mutate({ userName })}
          />
        </Row>
        {!old && (
          <>
            <Row label={t('profile.addressAs')} hint={t('profile.addressAsHint')}>
              <TextSetting
                value={settings.addressAs ?? ''}
                max={60}
                label={t('profile.addressAs')}
                placeholder={settings.userName.trim().split(/\s+/)[0]}
                onSave={(addressAs) => save.mutate({ addressAs })}
              />
            </Row>
            <Row label={t('profile.occupation')}>
              <TextSetting
                value={settings.occupation ?? ''}
                max={200}
                label={t('profile.occupation')}
                placeholder={t('profile.occupationPlaceholder')}
                onSave={(occupation) => save.mutate({ occupation })}
              />
            </Row>
          </>
        )}
      </Card>
      {!old && (
        <>
          <Card title={t('profile.section.use')}>
            <Row label={t('profile.focus')}>
              <Select
                value={settings.focus ?? ''}
                onValueChange={(f) => save.mutate({ focus: f as ProfileFocus })}
              >
                <SelectTrigger className="w-56 rounded-full">
                  <SelectValue placeholder={t('profile.focus.unset')} />
                </SelectTrigger>
                <SelectContent>
                  {PROFILE_FOCUS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {t(`profile.focus.${f}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <div className="px-4 py-3">
              <div className="mb-3 text-sm">{t('profile.helpWith')}</div>
              <div className="flex flex-wrap gap-2">
                {PROFILE_HELP.map((h) => (
                  <Chip
                    key={h}
                    check
                    on={helpWith.includes(h)}
                    onClick={() =>
                      save.mutate({
                        helpWith: helpWith.includes(h)
                          ? helpWith.filter((x) => x !== h)
                          : PROFILE_HELP.filter((x) => x === h || helpWith.includes(x)),
                      })
                    }
                  >
                    {t(`profile.help.${h}`)}
                  </Chip>
                ))}
              </div>
            </div>
          </Card>
          <Card title={t('profile.section.about')}>
            <div className="space-y-2 px-4 py-3">
              <AboutSetting value={settings.aboutMe ?? ''} onSave={(aboutMe) => save.mutate({ aboutMe })} />
              <p className="text-xs text-muted-foreground">{t('profile.aboutHint')}</p>
            </div>
          </Card>
          {/* A server older than the suggestions does not offer them. */}
          {settings.routineSuggestions !== undefined && (
            <Card title={t('routineSuggest.setting.title')}>
              <Row label={t('routineSuggest.setting.on')} hint={t('routineSuggest.setting.hint')}>
                <Switch
                  checked={settings.routineSuggestions}
                  aria-label={t('routineSuggest.setting.on')}
                  onCheckedChange={(routineSuggestions) => save.mutate({ routineSuggestions })}
                />
              </Row>
            </Card>
          )}
        </>
      )}
      <SlackLinkCard />
      <TeamsLinkCard />
    </>
  );
}

/** A text field saved when it loses focus. */
function TextSetting({
  value,
  max,
  label,
  placeholder,
  onSave,
}: {
  value: string;
  max: number;
  label: string;
  placeholder?: string;
  onSave(v: string): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      value={draft ?? value}
      maxLength={max}
      aria-label={label}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== value) onSave(draft.trim());
        setDraft(null);
      }}
      className="h-9 w-64 rounded-full"
    />
  );
}

function AboutSetting({ value, onSave }: { value: string; onSave(v: string): void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Textarea
      value={draft ?? value}
      maxLength={2000}
      rows={4}
      aria-label={t('profile.about')}
      placeholder={t('profile.aboutPlaceholder')}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== value) onSave(draft.trim());
        setDraft(null);
      }}
      className="rounded-2xl"
    />
  );
}
