import type { PersonInfo } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** A person's name as the lists show it. */
function personName(p: Pick<PersonInfo, 'displayName' | 'username'>, owner: string) {
  return p.displayName || p.username || owner;
}

/**
 * The people on this server. Everyone sees who is here; those who look after the server invite,
 * change and remove them. Only the owner handles admins, and nobody changes themselves here.
 * Everyone comes in with a Leaf Bot account: someone new by an emailed invite, and someone who was
 * here before accounts by one that brings them in as the same person.
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
          <PillButton
            icon="plus"
            label={t('people.invite')}
            variant="primary"
            onPress={() => setAdding(true)}
          />
        </View>
      ) : null}
      {adding ? <NewInvite onDone={() => setAdding(false)} /> : null}
      {manages ? <PendingInvites people={people} /> : null}
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
  // Their account stops reaching the server; they stay, with what is theirs, for an invite to
  // another address to bring back.
  const unlink = useMutation({
    mutationFn: () => api.unlinkPerson(person.id),
    onSuccess: done,
    onError: toastError,
  });
  const name = personName(person, t('people.owner'));
  const inviteToAccount = async () => {
    const email = await askText({
      title: t('people.inviteToAccount'),
      message: t('people.inviteToAccountHint', { name }),
      placeholder: t('people.inviteEmail'),
      confirmLabel: t('people.send'),
    });
    if (!email?.trim()) return;
    try {
      await api.invitePerson({ email: email.trim(), personId: person.id });
      void qc.invalidateQueries({ queryKey: ['people-invites', origin] });
      toast(t('people.invited', { email: email.trim() }));
    } catch (e) {
      toastError(e);
    }
  };
  const items: SheetItem[] = [
    ...(me?.role === 'owner'
      ? (['member', 'admin'] as const).map((role) => ({
          label: t(`people.role.${role}`),
          selected: person.role === role,
          onPress: () => person.role !== role && change.mutate({ role }),
        }))
      : []),
    ...(!person.linked && !person.disabled
      ? [{ icon: 'mail' as const, label: t('people.inviteToAccount'), onPress: () => void inviteToAccount() }]
      : []),
    ...(person.linked
      ? [
          {
            icon: 'link-2' as const,
            label: t('people.unlink'),
            onPress: () =>
              void confirm({ title: t('people.confirmUnlink', { name }), destructive: true }).then(
                (ok) => ok && unlink.mutate(),
              ),
          },
        ]
      : []),
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
          {person.linked ? ` · ${t('people.linked')}` : ''}
        </Text>
      </View>
      {mayChange ? <Feather name="more-horizontal" size={20} color={c.mutedForeground} /> : null}
      <Sheet open={menu} onClose={() => setMenu(false)} title={name} items={items} />
    </Pressable>
  );
}

/** Invites that wait to be accepted, each one taken back with a tap. */
function PendingInvites({ people }: { people: PersonInfo[] }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const key = ['people-invites', origin];
  const { data } = useQuery({ queryKey: key, queryFn: api.personInvites });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: toastError,
  });
  const invites = data?.invites ?? [];
  if (!invites.length) return null;
  return (
    <Section title={t('people.pending')}>
      <Rows>
        {invites.map((i) => {
          const who = i.person
            ? personName(
                people.find((p) => p.id === i.person) ?? { displayName: null, username: null },
                t('people.owner'),
              )
            : '';
          return (
            <View key={i.id} style={styles.person}>
              <Feather name="mail" size={18} color={c.mutedForeground} />
              <View style={styles.grow}>
                <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                  {i.email ?? t('people.linkInvite')}
                </Text>
                <Text style={[styles.sub, { color: c.mutedForeground }]} numberOfLines={1}>
                  {t(`people.role.${i.role}`)}
                  {who ? ` · ${t('people.pendingFor', { name: who })}` : ''}
                  {i.undelivered ? ` · ${t('people.undelivered')}` : ''}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('people.revokeInvite')}
                hitSlop={10}
                disabled={revoke.isPending}
                onPress={() => revoke.mutate(i.id)}
              >
                <Feather name="x" size={20} color={c.mutedForeground} />
              </Pressable>
            </View>
          );
        })}
      </Rows>
    </Section>
  );
}

/** Someone new, invited by address; the owner chooses whether they come as an admin. */
function NewInvite({ onDone }: { onDone(): void }) {
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const isOwner = useSession().data?.user?.role === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const send = useMutation({
    mutationFn: () => api.invitePerson({ email: email.trim(), role }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people-invites', origin] });
      toast(t('people.invited', { email: email.trim() }));
      onDone();
    },
    onError: toastError,
  });
  return (
    <Section>
      <Rows>
        <Pad>
          <TextBox
            value={email}
            onChangeText={setEmail}
            placeholder={t('people.inviteEmail')}
            accessibilityLabel={t('people.inviteEmail')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
          />
          {isOwner ? (
            <ChipRow>
              {(['member', 'admin'] as const).map((r) => (
                <Chip key={r} on={role === r} label={t(`people.role.${r}`)} onPress={() => setRole(r)} />
              ))}
            </ChipRow>
          ) : null}
          <Hint>{t('people.inviteHint')}</Hint>
          <View style={styles.buttons}>
            <PillButton label={t('common.cancel')} variant="ghost" onPress={onDone} />
            <PillButton
              label={t('people.send')}
              variant="primary"
              busy={send.isPending}
              disabled={!email.trim()}
              onPress={() => send.mutate()}
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
