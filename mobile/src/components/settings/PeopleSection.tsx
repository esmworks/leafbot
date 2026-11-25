import type { PersonInfo } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { TextBox } from '@/components/dialogs/common';
import { askText, confirm, toast, toastError } from '@/components/overlay';
import { PillButton, Section, Sheet, type SheetItem } from '@/components/page';
import { Chip, ChipRow, Hint, Pad, Rows } from '@/components/settings/common/controls';
import { t } from '@/i18n';
import { useManagesServer, usePeople, useSession } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** The shortest password the server takes. */
const MIN_PASSWORD = 8;

/** A person's name as the lists show it. */
function personName(p: Pick<PersonInfo, 'displayName' | 'username'>, owner: string) {
  return p.displayName || p.username || owner;
}

/**
 * The people on this server. Everyone sees who is here; those who look after the server add,
 * change and remove them. Only the owner handles admins, and nobody changes themselves here.
 */
export function PeopleSection() {
  const { data: people = [] } = usePeople();
  const manages = useManagesServer();
  const [adding, setAdding] = useState(false);
  return (
    <>
      <Hint>{t('people.intro')}</Hint>
      {manages && !adding ? (
        <View style={styles.start}>
          <PillButton icon="plus" label={t('people.add')} variant="primary" onPress={() => setAdding(true)} />
        </View>
      ) : null}
      {adding ? <NewPerson onDone={() => setAdding(false)} /> : null}
      <Section>
        <Rows>
          {people.map((p) => (
            <PersonRow key={p.id} person={p} />
          ))}
        </Rows>
      </Section>
    </>
  );
}

function PersonRow({ person }: { person: PersonInfo }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const me = useSession().data?.user;
  const [menu, setMenu] = useState(false);
  const isMe = me?.id === person.id;
  // The owner stays as they are; admins are the owner's to change.
  const mayChange =
    !isMe &&
    person.role !== 'owner' &&
    (me?.role === 'owner' || (me?.role === 'admin' && person.role === 'member'));
  const done = () => void qc.invalidateQueries({ queryKey: ['people', origin] });
  const change = useMutation({
    mutationFn: (patch: Parameters<typeof api.updatePerson>[1]) => api.updatePerson(person.id, patch),
    onSuccess: done,
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.removePerson(person.id),
    onSuccess: () => {
      done();
      void qc.invalidateQueries({ queryKey: ['bots', origin] });
    },
    onError: toastError,
  });
  const name = personName(person, t('people.owner'));
  const resetPassword = async () => {
    const password = await askText({
      title: t('people.resetPassword'),
      placeholder: t('people.newPassword', { min: String(MIN_PASSWORD) }),
      secure: true,
      confirmLabel: t('common.save'),
    });
    if (password === null) return;
    if (password.length < MIN_PASSWORD)
      return toast(t('people.newPassword', { min: String(MIN_PASSWORD) }), { tone: 'error' });
    change.mutate({ password });
  };
  const items: SheetItem[] = [
    ...(me?.role === 'owner'
      ? (['member', 'admin'] as const).map((role) => ({
          label: t(`people.role.${role}`),
          selected: person.role === role,
          onPress: () => person.role !== role && change.mutate({ role }),
        }))
      : []),
    { icon: 'key', label: t('people.resetPassword'), onPress: () => void resetPassword() },
    {
      icon: person.disabled ? 'unlock' : 'lock',
      label: person.disabled ? t('people.enable') : t('people.disable'),
      onPress: () =>
        void (async () => {
          if (
            person.disabled ||
            (await confirm({ title: t('people.confirmDisable', { name }), destructive: true }))
          )
            change.mutate({ disabled: !person.disabled });
        })(),
    },
    {
      icon: 'trash-2',
      label: t('common.delete'),
      destructive: true,
      onPress: () =>
        void confirm({
          title: t('people.confirmRemove', { name }),
          confirmLabel: t('common.delete'),
          destructive: true,
        }).then((ok) => ok && remove.mutate()),
    },
  ];
  return (
    <Pressable
      accessibilityRole={mayChange ? 'button' : undefined}
      disabled={!mayChange}
      onPress={() => setMenu(true)}
      style={({ pressed }) => [styles.person, pressed && { backgroundColor: c.accent }]}
    >
      <View style={[styles.icon, { borderColor: c.border, backgroundColor: c.background }]}>
        <Feather name="user" size={18} color={c.mutedForeground} />
      </View>
      <View style={styles.grow}>
        <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
          {name}
          {isMe ? ` · ${t('people.you')}` : ''}
        </Text>
        <Text style={[styles.sub, { color: c.mutedForeground }]} numberOfLines={1}>
          {person.username && person.displayName ? `${person.username} · ` : ''}
          {t(`people.role.${person.role}`)}
          {person.disabled ? ` · ${t('people.disabled')}` : ''}
        </Text>
      </View>
      {mayChange ? <Feather name="more-horizontal" size={20} color={c.mutedForeground} /> : null}
      <Sheet open={menu} onClose={() => setMenu(false)} title={name} items={items} />
    </Pressable>
  );
}

function NewPerson({ onDone }: { onDone(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const isOwner = useSession().data?.user?.role === 'owner';
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const add = useMutation({
    mutationFn: () =>
      api.addPerson({
        username,
        password,
        role,
        ...(displayName.trim() && { displayName: displayName.trim() }),
      }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['people', origin] });
      toast(t('people.added', { name: personName(p, '') }));
      onDone();
    },
    onError: toastError,
  });
  return (
    <Section>
      <Rows>
        <Pad>
          <TextBox
            value={username}
            onChangeText={setUsername}
            placeholder={t('people.username')}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextBox value={displayName} onChangeText={setDisplayName} placeholder={t('people.displayName')} />
          <TextBox
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder={t('people.password', { min: String(MIN_PASSWORD) })}
            accessibilityLabel={t('people.passwordLabel')}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="newPassword"
          />
          {isOwner ? (
            <ChipRow>
              {(['member', 'admin'] as const).map((r) => (
                <Chip key={r} on={role === r} label={t(`people.role.${r}`)} onPress={() => setRole(r)} />
              ))}
            </ChipRow>
          ) : null}
          <Hint>{t('people.passwordHint')}</Hint>
          <View style={styles.buttons}>
            <PillButton label={t('common.cancel')} variant="ghost" onPress={onDone} />
            <PillButton
              label={t('people.add')}
              variant="primary"
              busy={add.isPending}
              disabled={!username.trim() || password.length < MIN_PASSWORD}
              onPress={() => add.mutate()}
            />
          </View>
        </Pad>
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  start: { flexDirection: 'row' },
  person: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  icon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grow: { flex: 1, minWidth: 0 },
  name: { fontSize: 17, fontWeight: '500' },
  sub: { fontSize: 13, marginTop: 1 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
});
