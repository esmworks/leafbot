import type { Group, SpaceKind } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Folder, Trash2, Users, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { personName } from '@/features/PeopleTab';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { isSpace } from '@/lib/places';
import { useBots, useGroups, useManagesServer, usePeople, useSession } from '@/lib/queries';
import { cn } from '@/lib/utils';

const KINDS: SpaceKind[] = ['open', 'closed', 'secret'];

/**
 * The team spaces and the person's own folders. A space's bots are open to its people; those who
 * look after the server open spaces and say who is in them. A folder only tidies the person's
 * Private and shares nothing.
 */
export function SpacesTab() {
  const t = useT();
  const { data: groups = [] } = useGroups();
  const manages = useManagesServer();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: (space: boolean) => api.createGroup(name.trim(), { space }),
    onSuccess: () => {
      setName('');
      void qc.invalidateQueries({ queryKey: ['groups'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const spaces = groups.filter(isSpace);
  const folders = groups.filter((g) => !isSpace(g));
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">{t('spaces.hint')}</p>
      <form
        className="mb-6 flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate(false);
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('spaces.placeholder')}
          className="min-w-48 flex-1 rounded-xl"
        />
        <Button variant="secondary" className="rounded-xl" disabled={!name.trim() || add.isPending}>
          <Folder /> {t('spaces.addFolder')}
        </Button>
        {manages && (
          <Button
            type="button"
            className="rounded-xl"
            disabled={!name.trim() || add.isPending}
            onClick={() => add.mutate(true)}
          >
            <Users /> {t('spaces.addSpace')}
          </Button>
        )}
      </form>
      <section className="mb-6">
        <h3 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{t('spaces.spaces')}</h3>
        <div className="divide-y rounded-2xl border bg-card/50">
          {spaces.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t('spaces.noSpaces')}</div>
          )}
          {spaces.map((g) => (
            <SpaceRow key={g.id} space={g} manages={manages} />
          ))}
        </div>
      </section>
      <section className="mb-6">
        <h3 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{t('spaces.folders')}</h3>
        <div className="divide-y rounded-2xl border bg-card/50">
          {folders.length === 0 && (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t('spaces.noFolders')}</div>
          )}
          {folders.map((g) => (
            <FolderRow key={g.id} folder={g} />
          ))}
        </div>
      </section>
    </>
  );
}

function useBotCount(groupId: string) {
  const { data: bots = [] } = useBots();
  return bots.filter((b) => b.groupId === groupId).length;
}

function useRemoveGroup(
  group: Group,
  ask: 'sidebarMenu.deleteSpaceConfirm' | 'sidebarMenu.deleteFolderConfirm',
) {
  const t = useT();
  const qc = useQueryClient();
  const count = useBotCount(group.id);
  const remove = useMutation({
    mutationFn: () => api.deleteGroup(group.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['groups'] });
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return () => (count === 0 || confirm(t(ask, { name: group.name }))) && remove.mutate();
}

function FolderRow({ folder }: { folder: Group }) {
  const t = useT();
  const count = useBotCount(folder.id);
  const remove = useRemoveGroup(folder, 'sidebarMenu.deleteFolderConfirm');
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <Folder className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{folder.name}</div>
        <div className="text-xs text-muted-foreground">{t('groups.count', { count })}</div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 rounded-full"
        onClick={remove}
        aria-label={t('common.delete')}
      >
        <Trash2 className="size-4" />
      </Button>
    </div>
  );
}

/** A space: its bots and people at a glance, its settings opened by those who look after the server. */
function SpaceRow({ space, manages }: { space: Group; manages: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const count = useBotCount(space.id);
  const [open, setOpen] = useState(false);
  const remove = useRemoveGroup(space, 'sidebarMenu.deleteSpaceConfirm');
  const members = space.memberIds ?? [];
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['groups'] });
    void qc.invalidateQueries({ queryKey: ['bots'] });
  };
  const fail = (e: Error) => toast.error(e.message);
  const update = useMutation({
    mutationFn: (patch: { kind?: SpaceKind; membersEdit?: boolean }) => api.updateGroup(space.id, patch),
    onSuccess: done,
    onError: fail,
  });
  const people = useMutation({
    mutationFn: (change: { add?: string[]; remove?: string[] }) => api.setSpaceMembers(space.id, change),
    onSuccess: done,
    onError: fail,
  });
  const summary = [
    t('groups.count', { count }),
    t('spaces.memberCount', { count: members.length }),
    space.kind && t(`spaces.kind.${space.kind}`),
    space.requested && t('spaces.asked'),
  ].filter(Boolean);
  return (
    <div className="px-4 py-3">
      <div className="flex min-h-8 items-center gap-3">
        <Users className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm">{space.name}</div>
          <div className="truncate text-xs text-muted-foreground">{summary.join(' · ')}</div>
        </div>
        <Membership space={space} manages={manages} />
        {manages && (
          <>
            <Button
              variant="ghost"
              className="rounded-full"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
            >
              {t('spaces.settings')}
              <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-full"
              onClick={remove}
              aria-label={t('common.delete')}
            >
              <Trash2 className="size-4" />
            </Button>
          </>
        )}
      </div>
      {manages && open && (
        <div className="mt-3 space-y-4 border-t pt-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="min-w-40 flex-1">
              <div className="text-sm">{t('spaces.kind')}</div>
              <div className="text-xs text-muted-foreground">
                {t(`spaces.kindHint.${space.kind ?? 'secret'}`)}
              </div>
            </div>
            <Select
              value={space.kind ?? 'secret'}
              onValueChange={(kind) => update.mutate({ kind: kind as SpaceKind })}
            >
              <SelectTrigger className="w-36 rounded-xl" aria-label={t('spaces.kind')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`spaces.kind.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm">{t('spaces.membersEdit')}</div>
              <div className="text-xs text-muted-foreground">{t('spaces.membersEditHint')}</div>
            </div>
            <Switch
              checked={!!space.membersEdit}
              disabled={update.isPending}
              onCheckedChange={(membersEdit) => update.mutate({ membersEdit })}
              aria-label={t('spaces.membersEdit')}
            />
          </div>
          <Members
            ids={members}
            busy={people.isPending}
            onAdd={(id) => people.mutate({ add: [id] })}
            onRemove={(id) => people.mutate({ remove: [id] })}
          />
          <p className="text-xs text-muted-foreground">{t('spaces.sharedNote')}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The person's own way in or out of a space: an open one is joined at once, a closed one is asked
 * for (those who look after the server join it at once), and leaving takes back a request too.
 */
function Membership({ space, manages }: { space: Group; manages: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useSession().data?.user?.id;
  const inSpace = !!me && !!space.memberIds?.includes(me);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['groups'] });
    void qc.invalidateQueries({ queryKey: ['bots'] });
  };
  const join = useMutation({
    mutationFn: () => api.joinSpace(space.id),
    onSuccess: (r) => {
      if (r.state === 'requested') toast.success(t('spaces.requestSent'));
      done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const leave = useMutation({
    mutationFn: () => api.leaveSpace(space.id),
    onSuccess: done,
    onError: (e) => toast.error((e as Error).message),
  });
  if (!me) return null;
  const busy = join.isPending || leave.isPending;
  if (inSpace) {
    return (
      <Button
        variant="ghost"
        className="rounded-full"
        disabled={busy}
        onClick={() => confirm(t('spaces.leaveConfirm', { name: space.name })) && leave.mutate()}
      >
        {t('spaces.leave')}
      </Button>
    );
  }
  if (space.requested) {
    return (
      <Button variant="ghost" className="rounded-full" disabled={busy} onClick={() => leave.mutate()}>
        {t('spaces.takeBack')}
      </Button>
    );
  }
  return (
    <Button variant="secondary" className="rounded-full" disabled={busy} onClick={() => join.mutate()}>
      {space.kind === 'closed' && !manages ? t('spaces.ask') : t('spaces.join')}
    </Button>
  );
}

function Members({
  ids,
  busy,
  onAdd,
  onRemove,
}: {
  ids: string[];
  busy: boolean;
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  const { data: people = [] } = usePeople();
  const owner = t('people.owner');
  const inSpace = people.filter((p) => ids.includes(p.id));
  const others = people.filter((p) => !ids.includes(p.id) && !p.disabled);
  return (
    <div>
      <div className="mb-2 text-sm">{t('spaces.members')}</div>
      <div className="flex flex-wrap items-center gap-2">
        {inSpace.length === 0 && (
          <span className="text-xs text-muted-foreground">{t('spaces.noMembers')}</span>
        )}
        {inSpace.map((p) => (
          <span
            key={p.id}
            className="flex items-center gap-1 rounded-lg border bg-background py-1 ps-2.5 pe-1 text-sm"
          >
            {personName(p, owner)}
            <Button
              variant="ghost"
              size="icon"
              className="size-6 rounded-md"
              disabled={busy}
              onClick={() => onRemove(p.id)}
              aria-label={t('spaces.removeMember', { name: personName(p, owner) })}
            >
              <X className="size-3.5" />
            </Button>
          </span>
        ))}
        {others.length > 0 && (
          <Select value="" onValueChange={onAdd} disabled={busy}>
            <SelectTrigger size="sm" className="w-40 rounded-lg" aria-label={t('spaces.addMember')}>
              <SelectValue placeholder={t('spaces.addMember')} />
            </SelectTrigger>
            <SelectContent>
              {others.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {personName(p, owner)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
