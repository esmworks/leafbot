import type { PersonInfo } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, KeyRound, Mail, Pause, Play, Plus, Trash2, UserRound, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useManagesServer, usePeople, useSession } from '@/lib/queries';

/** The shortest password the server takes. */
const MIN_PASSWORD = 8;

/** A person's name as the lists show it. */
export function personName(p: Pick<PersonInfo, 'displayName' | 'username'>, owner: string) {
  return p.displayName || p.username || owner;
}

/** The name of the person with this id among `people`, or `fallback` when they are not listed. */
export function personNameOf(
  people: Pick<PersonInfo, 'id' | 'displayName' | 'username'>[],
  id: string | null | undefined,
  owner: string,
  fallback = '',
) {
  const p = people.find((x) => x.id === id);
  return p ? personName(p, owner) : fallback;
}

/**
 * The people on this server. Everyone sees who is here; those who look after the server invite,
 * change and remove them. Only the owner handles admins, and nobody changes themselves here.
 * Everyone comes in with a Leaf Bot account: someone new by an emailed invite, and someone who was
 * here before accounts by one that brings them in as the same person.
 */
export function PeopleTab() {
  const t = useT();
  const { data: people = [] } = usePeople();
  const manages = useManagesServer();
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      <p className="px-1 text-sm text-muted-foreground">{t('people.intro')}</p>
      {manages && !adding && (
        <Button className="rounded-full" onClick={() => setAdding(true)}>
          <Plus /> {t('people.invite')}
        </Button>
      )}
      {adding && <NewInvite onDone={() => setAdding(false)} />}
      {manages && <PendingInvites people={people} />}
      <div className="divide-y rounded-2xl border bg-card/50">
        {people.map((p) => (
          <PersonRow key={p.id} person={p} />
        ))}
      </div>
    </div>
  );
}

const INVITES_KEY = ['people-invites'];

/** Invites sent through the account that wait to be accepted, each one taken back with a click. */
function PendingInvites({ people }: { people: PersonInfo[] }) {
  const t = useT();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: INVITES_KEY, queryFn: api.personInvites });
  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: INVITES_KEY }),
    onError: (e) => toast.error((e as Error).message),
  });
  const invites = data?.invites ?? [];
  if (!invites.length) return null;
  return (
    <div className="space-y-1">
      <div className="px-1 text-xs font-medium text-muted-foreground">{t('people.pending')}</div>
      <div className="divide-y rounded-2xl border bg-card/50">
        {invites.map((i) => {
          const forWhom = i.person ? personNameOf(people, i.person, t('people.owner')) : '';
          return (
            <div key={i.id} className="flex items-center gap-3 px-4 py-2">
              <Mail className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{i.email ?? t('people.linkInvite')}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {t(`people.role.${i.role}`)}
                  {forWhom ? ` · ${t('people.pendingFor', { name: forWhom })}` : ''}
                  {i.undelivered ? ` · ${t('people.undelivered')}` : ''}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(i.id)}
                aria-label={t('people.revokeInvite')}
                title={t('people.revokeInvite')}
              >
                <X />
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PersonRow({ person }: { person: PersonInfo }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useSession().data?.user;
  const [resetting, setResetting] = useState(false);
  const [inviting, setInviting] = useState(false);
  const isMe = me?.id === person.id;
  // The owner stays as they are; admins are the owner's to change.
  const mayChange =
    !isMe &&
    person.role !== 'owner' &&
    (me?.role === 'owner' || (me?.role === 'admin' && person.role === 'member'));
  const done = () => void qc.invalidateQueries({ queryKey: ['people'] });
  const change = useMutation({
    mutationFn: (patch: Parameters<typeof api.updatePerson>[1]) => api.updatePerson(person.id, patch),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removePerson(person.id),
    onSuccess: () => {
      done();
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const name = personName(person, t('people.owner'));
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border bg-background text-muted-foreground">
          <UserRound className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {name}
            {isMe ? ` · ${t('people.you')}` : ''}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {person.username && person.displayName ? `${person.username} · ` : ''}
            {t(`people.role.${person.role}`)}
            {person.disabled ? ` · ${t('people.disabled')}` : ''}
            {person.linked ? ` · ${t('people.linked')}` : ''}
          </div>
        </div>
        {mayChange && (
          <>
            <Select
              value={person.role}
              onValueChange={(role) => change.mutate({ role: role as 'admin' | 'member' })}
              disabled={me?.role !== 'owner'}
            >
              <SelectTrigger className="w-32 rounded-full" aria-label={t('people.roleLabel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t('people.role.member')}</SelectItem>
                <SelectItem value="admin">{t('people.role.admin')}</SelectItem>
              </SelectContent>
            </Select>
            {!person.linked && !person.disabled && (
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                onClick={() => setInviting((v) => !v)}
                aria-label={t('people.inviteToAccount')}
                title={t('people.inviteToAccount')}
              >
                <Mail />
              </Button>
            )}
            {!person.linked && (
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                onClick={() => setResetting((r) => !r)}
                aria-label={t('people.resetPassword')}
                title={t('people.resetPassword')}
              >
                <KeyRound />
              </Button>
            )}
            <Button
              variant="ghost"
              className="rounded-full"
              disabled={change.isPending}
              onClick={() => {
                if (person.disabled || confirm(t('people.confirmDisable', { name })))
                  change.mutate({ disabled: !person.disabled });
              }}
            >
              {person.disabled ? t('people.enable') : t('people.disable')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="rounded-full"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm(t('people.confirmRemove', { name }))) remove.mutate();
              }}
              aria-label={t('common.delete')}
            >
              <Trash2 />
            </Button>
          </>
        )}
      </div>
      {mayChange && <PrivateBots person={person} name={name} />}
      {inviting && (
        <InviteForm
          personId={person.id}
          hint={t('people.inviteToAccountHint', { name })}
          onDone={() => setInviting(false)}
        />
      )}
      {resetting && (
        <NewPassword
          onSave={(password) => change.mutate({ password }, { onSuccess: () => setResetting(false) })}
          onCancel={() => setResetting(false)}
          pending={change.isPending}
        />
      )}
    </div>
  );
}

/**
 * How many bots the person keeps in their Private. Those who look after the server do not open
 * them; to protect the server they pause or put them all away at once.
 */
function PrivateBots({ person, name }: { person: PersonInfo; name: string }) {
  const t = useT();
  const qc = useQueryClient();
  const key = ['private-bots', person.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.privateBots(person.id) });
  const done = () => {
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['bots'] });
  };
  const fail = (e: Error) => toast.error(e.message);
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.pausePrivateBots(person.id, paused),
    onSuccess: done,
    onError: fail,
  });
  const archive = useMutation({
    mutationFn: () => api.archivePrivateBots(person.id),
    onSuccess: done,
    onError: fail,
  });
  if (!data?.count) return null;
  const allPaused = data.paused === data.count;
  const busy = pause.isPending || archive.isPending;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 ps-12 text-xs text-muted-foreground">
      <span className="me-auto">{t('people.privateBots', { count: data.count, paused: data.paused })}</span>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full"
        disabled={busy}
        onClick={() => {
          if (allPaused || confirm(t('people.pausePrivateConfirm', { name, count: data.count })))
            pause.mutate(!allPaused);
        }}
      >
        {allPaused ? <Play /> : <Pause />}
        {allPaused ? t('people.resumePrivate') : t('people.pausePrivate')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="rounded-full"
        disabled={busy}
        onClick={() =>
          confirm(t('people.archivePrivateConfirm', { name, count: data.count })) && archive.mutate()
        }
      >
        <Archive /> {t('people.archivePrivate')}
      </Button>
    </div>
  );
}

function NewPassword({
  onSave,
  onCancel,
  pending,
}: {
  onSave(password: string): void;
  onCancel(): void;
  pending: boolean;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  return (
    <form
      className="mt-3 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(password);
      }}
    >
      <Input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('people.newPassword', { min: String(MIN_PASSWORD) })}
        aria-label={t('people.resetPassword')}
        autoComplete="new-password"
        className="flex-1"
      />
      <Button type="button" variant="ghost" className="rounded-full" onClick={onCancel}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" className="rounded-full" disabled={pending || password.length < MIN_PASSWORD}>
        {t('common.save')}
      </Button>
    </form>
  );
}

/** Someone new, invited by address; the owner chooses whether they come as an admin. */
function NewInvite({ onDone }: { onDone(): void }) {
  const t = useT();
  return <InviteForm hint={t('people.inviteHint')} onDone={onDone} />;
}

/**
 * Sends an invite through the account to one address: for someone new, or, with `personId`, for
 * someone already here, who then keeps their role and what is theirs.
 */
function InviteForm({ personId, hint, onDone }: { personId?: string; hint: string; onDone(): void }) {
  const t = useT();
  const qc = useQueryClient();
  const isOwner = useSession().data?.user?.role === 'owner';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const send = useMutation({
    mutationFn: () =>
      api.invitePerson({
        email: email.trim(),
        ...(personId ? { personId } : { role }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: INVITES_KEY });
      toast.success(t('people.invited', { email: email.trim() }));
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    send.mutate();
  };
  return (
    <form onSubmit={submit} className="mt-2 space-y-2 rounded-2xl border bg-background p-3">
      <Input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t('people.inviteEmail')}
        aria-label={t('people.inviteEmail')}
        autoComplete="off"
        autoFocus
        required
      />
      {isOwner && !personId && (
        <Select value={role} onValueChange={(r) => setRole(r as 'member' | 'admin')}>
          <SelectTrigger className="w-full rounded-full" aria-label={t('people.roleLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="member">{t('people.role.member')}</SelectItem>
            <SelectItem value="admin">{t('people.role.admin')}</SelectItem>
          </SelectContent>
        </Select>
      )}
      <p className="px-1 text-xs text-muted-foreground">{hint}</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" className="rounded-full" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={send.isPending || !email.trim()}>
          {t('people.send')}
        </Button>
      </div>
    </form>
  );
}
