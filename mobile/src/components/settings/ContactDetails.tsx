import type { ContactDetails as Contact, ContactPart } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type TextInputProps } from 'react-native';
import { InCard } from '@/components/card';
import { confirm, toastError } from '@/components/overlay';
import { IconButton, PillButton, Row, Section, SwitchRow } from '@/components/page';
import { Field } from '@/components/ui';
import { BotSwitches } from './more/BotSwitches';
import { Hint, Pad, Rows } from './common/controls';
import { locale, t, type MessageKey } from '@/i18n';
import { formatters } from '@/lib/format';
import { useBots, useManagesServer } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** A name for the details: the one given them, or the person's name. */
const nameOf = (c: Contact) => c.label || [c.givenName, c.familyName].filter(Boolean).join(' ');

/**
 * A name, an email, a phone and an address a bot fills into a form (a delivery address, a sign-up)
 * on a site the person agreed to. Unlike a card the person sees them whole and changes them here.
 */
export function ContactDetails() {
  const api = useApi();
  const { origin } = useServer();
  // Under the vault's key, so the vault's live refresh reaches these too.
  const { data: contacts = [] } = useQuery({
    queryKey: ['vault', origin, 'contacts'],
    queryFn: api.contacts,
  });
  // The details being edited, or 'new'.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <>
      {editing === 'new' ? <ContactForm onDone={() => setEditing(null)} /> : null}
      <Section title={t('contacts.title')} footer={t('contacts.hint')}>
        <Rows>
          {editing !== 'new' ? (
            <Row icon="plus" label={t('common.add')} onPress={() => setEditing('new')} chevron={false} />
          ) : null}
          {contacts.map((c) =>
            editing === c.id ? (
              <Pad key={c.id}>
                <ContactForm contact={c} onDone={() => setEditing(null)} />
              </Pad>
            ) : (
              <ContactRow key={c.id} contact={c} onEdit={() => setEditing(c.id)} />
            ),
          )}
        </Rows>
      </Section>
    </>
  );
}

function ContactRow({ contact: c, onEdit }: { contact: Contact; onEdit: () => void }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const colors = useColors();
  const manages = useManagesServer();
  // The team's are changed only by those who look after the server.
  const mayChange = manages || !!c.userId;
  const done = () => qc.invalidateQueries({ queryKey: ['vault', origin, 'contacts'] });
  const remove = useMutation({
    mutationFn: () => api.removeContact(c.id),
    onSuccess: done,
    onError: toastError,
  });
  const forget = useMutation({
    mutationFn: (site: string) => api.updateContact(c.id, { forgetSites: [site] }),
    onSuccess: done,
    onError: toastError,
  });
  const name = nameOf(c) || c.email || t('contacts.unnamed');
  const person = [c.givenName, c.familyName].filter(Boolean).join(' ');
  const place = [c.city, c.region, c.country].filter(Boolean).join(', ');
  return (
    <View>
      <Row
        icon="user"
        label={c.label && person ? `${name} · ${person}` : name}
        detail={
          [
            [c.email, c.phone, place].filter(Boolean).join(' · '),
            [
              c.userId === null ? t('owned.team') : t('owned.yours'),
              c.botIds ? t('vault.someBots', { count: c.botIds.length }) : null,
              c.lastUsedAt ? t('vault.lastUsed', { when: fmt.dayLabel(c.lastUsedAt) }) : null,
            ]
              .filter(Boolean)
              .join(' · '),
          ]
            .filter(Boolean)
            .join('\n') || null
        }
        right={
          mayChange ? (
            <View style={styles.actions}>
              <IconButton icon="edit-2" size={18} label={t('vault.edit')} onPress={onEdit} />
              <IconButton
                icon="trash-2"
                size={18}
                label={t('common.delete')}
                onPress={async () => {
                  if (
                    await confirm({
                      title: t('contacts.confirmDelete', { name }),
                      destructive: true,
                      confirmLabel: t('common.delete'),
                    })
                  )
                    remove.mutate();
                }}
              />
            </View>
          ) : null
        }
      />
      {c.sites.length > 0 ? (
        <View style={styles.sites}>
          <Text style={[styles.siteLead, { color: colors.mutedForeground }]}>{t('contacts.sites')}</Text>
          {c.sites.map((site) => (
            <View key={site} style={[styles.site, { borderColor: colors.border }]}>
              <Text style={[styles.siteName, { color: colors.foreground }]}>{site}</Text>
              {mayChange ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('cards.forgetSite', { site })}
                  disabled={forget.isPending}
                  hitSlop={8}
                  onPress={() => forget.mutate(site)}
                >
                  <Feather name="x" size={16} color={colors.mutedForeground} />
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The form's fields in the order a person fills them, each with the keyboard that suits it. */
const FIELDS: {
  part: ContactPart;
  input?: Pick<TextInputProps, 'keyboardType' | 'autoCapitalize' | 'textContentType'>;
}[] = [
  { part: 'givenName', input: { textContentType: 'givenName' } },
  { part: 'familyName', input: { textContentType: 'familyName' } },
  {
    part: 'email',
    input: { keyboardType: 'email-address', autoCapitalize: 'none', textContentType: 'emailAddress' },
  },
  { part: 'phone', input: { keyboardType: 'phone-pad', textContentType: 'telephoneNumber' } },
  { part: 'organization', input: { textContentType: 'organizationName' } },
  { part: 'address1', input: { textContentType: 'streetAddressLine1' } },
  { part: 'address2', input: { textContentType: 'streetAddressLine2' } },
  { part: 'city', input: { textContentType: 'addressCity' } },
  { part: 'region', input: { textContentType: 'addressState' } },
  { part: 'postalCode', input: { textContentType: 'postalCode', autoCapitalize: 'characters' } },
  { part: 'country', input: { textContentType: 'countryName' } },
];

type Values = Record<ContactPart, string>;

/** Adds details, or edits some. */
function ContactForm({ contact, onDone }: { contact?: Contact; onDone: () => void }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const c = useColors();
  const manages = useManagesServer();
  const { data: bots = [] } = useBots();
  const [label, setLabel] = useState(contact?.label ?? '');
  const [values, setValues] = useState<Values>(
    () => Object.fromEntries(FIELDS.map((f) => [f.part, contact?.[f.part] ?? ''])) as Values,
  );
  // Null: every bot may use them.
  const [botIds, setBotIds] = useState<string[] | null>(contact?.botIds ?? null);
  const [team, setTeam] = useState(contact ? contact.userId === null : false);
  const trimmed = Object.fromEntries(FIELDS.map((f) => [f.part, values[f.part].trim()])) as Values;
  const filled = FIELDS.some((f) => trimmed[f.part]);
  const save = useMutation({
    mutationFn: () =>
      contact
        ? api.updateContact(contact.id, {
            label: label.trim(),
            ...trimmed,
            botIds,
            ...(manages && { team }),
          })
        : api.addContact({ label: label.trim(), ...trimmed, botIds, ...(manages && team && { team }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vault', origin, 'contacts'] });
      onDone();
    },
    onError: toastError,
  });
  // The new-details form draws its own card; its fields take the in-card look like an edited row's.
  return (
    <InCard.Provider value>
      <View
        style={[
          styles.form,
          !contact && {
            backgroundColor: c.card,
            borderColor: c.border,
            borderWidth: StyleSheet.hairlineWidth,
            borderRadius: 16,
            padding: 16,
          },
        ]}
      >
        <Field
          value={label}
          onChangeText={setLabel}
          autoCorrect={false}
          placeholder={t('contacts.label')}
          accessibilityLabel={t('contacts.label')}
        />
        {FIELDS.map((f) => (
          <Field
            key={f.part}
            value={values[f.part]}
            onChangeText={(v) => setValues((old) => ({ ...old, [f.part]: v }))}
            autoCorrect={false}
            placeholder={t(`contacts.field.${f.part}` as MessageKey)}
            accessibilityLabel={t(`contacts.field.${f.part}` as MessageKey)}
            {...f.input}
          />
        ))}
        <View style={[styles.box, { borderColor: c.border, backgroundColor: c.muted }]}>
          <SwitchRow
            label={t('vault.allBots')}
            value={botIds === null}
            onChange={(on) => setBotIds(on ? null : [])}
          />
        </View>
        {botIds !== null && bots.length > 0 ? (
          <BotSwitches
            bots={bots}
            on={(id) => botIds.includes(id)}
            onChange={(id, on) =>
              setBotIds((ids) => (on ? [...(ids ?? []), id] : (ids ?? []).filter((x) => x !== id)))
            }
          />
        ) : null}
        {manages ? (
          <View style={[styles.box, { borderColor: c.border, backgroundColor: c.muted }]}>
            <SwitchRow label={t('owned.forTeam')} value={team} onChange={setTeam} />
            <View style={styles.teamHint}>
              <Hint>{t('owned.forTeamHint')}</Hint>
            </View>
          </View>
        ) : null}
        <View style={styles.buttons}>
          <PillButton variant="ghost" label={t('common.cancel')} onPress={onDone} />
          <PillButton
            variant="primary"
            label={t('common.save')}
            onPress={() => save.mutate()}
            busy={save.isPending}
            disabled={!filled || save.isPending}
          />
        </View>
      </View>
    </InCard.Provider>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row' },
  sites: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  siteLead: { fontSize: 14 },
  site: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  siteName: { fontSize: 14 },
  form: { gap: 10 },
  box: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  teamHint: { paddingHorizontal: 16, paddingBottom: 12 },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
